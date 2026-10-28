import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { EmailTrackingComponent } from './email-tracking.component';

const base = (o: any = {}) => ({
  tracked: true, provider: 'smtp', deliveryStatus: 'accepted', deliveryReporting: 'not_supported',
  acceptedAt: '2026-10-27T10:00:00Z', deliveredAt: null, bouncedAt: null, complainedAt: null, failure: null,
  opens: { mode: 'pixel', firstAt: null, lastAt: null, totalEvents: 0, uniqueOpened: false },
  clicks: { mode: 'links', totalEvents: 0, firstAt: null, lastAt: null, links: [] },
  events: [{ type: 'queued', occurredAt: '2026-10-27T10:00:00Z' }, { type: 'accepted', occurredAt: '2026-10-27T10:00:01Z' }],
  ...o
});

describe('EmailTrackingComponent', () => {
  let fixture: ComponentFixture<EmailTrackingComponent>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;

  function show(tracking: any, by: 'email' | 'draft' = 'email'): void {
    fixture = TestBed.createComponent(EmailTrackingComponent);
    if (by === 'email') fixture.componentInstance.emailId = 5; else fixture.componentInstance.draftId = 9;
    fixture.componentInstance.ngOnChanges();
    http.expectOne(r => r.url.endsWith(by === 'email' ? '/mail/tracking/emails/5' : '/mail/tracking/drafts/9')).flush({ tracking });
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [EmailTrackingComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('an accepted SMTP email is "Accepted by provider", and delivery is "Not supported by provider", not a date or 0', () => {
    show(base());
    expect(el().textContent).toContain('Accepted by provider');
    expect(el().textContent).toContain('not proof of delivery');
    expect(el().textContent).toContain('Not supported by provider (SMTP servers do not report delivery)');
    expect(el().querySelector('.et-badge')!.textContent).toBe('Accepted by provider');
  });

  it('ZeptoMail without a connected webhook: delivery, opens and clicks are unavailable, not zero', () => {
    show(base({ provider: 'zeptomail', deliveryReporting: 'webhook_not_connected', opens: { mode: 'not_reported', totalEvents: null }, clicks: { mode: 'not_reported', totalEvents: null, links: [] } }), 'draft');
    expect(el().textContent).toContain('Unavailable (ZeptoMail delivery events are not connected)');
    expect(el().textContent).toContain('Unavailable (provider events are not connected)');
    expect(el().querySelector('.et-table')).toBeNull();
  });

  it('opens are labelled as an estimate; ZeptoMail totals are "Not supported by provider"', () => {
    show(base({ provider: 'zeptomail', deliveryStatus: 'delivered', deliveredAt: '2026-10-27T10:01:00Z', deliveryReporting: 'provider_webhook',
      opens: { mode: 'provider', firstAt: '2026-10-27T11:00:00Z', lastAt: '2026-10-27T11:00:00Z', totalEvents: null, uniqueOpened: true } }));
    expect(el().querySelector('.et-badge')!.textContent).toBe('Delivered');
    expect(el().textContent).toContain('estimate');
    expect(el().textContent).toContain('first open only');
    expect(el().textContent).toContain('Opened (unique)Yes');
    expect(el().textContent).toContain('Open events (total)Not supported by provider');
  });

  it('tracking turned off shows "Not tracked"; clicked links are listed with counts', () => {
    show(base({ opens: { mode: 'off' }, clicks: { mode: 'links', totalEvents: 2, links: [{ url: 'shop.io/spring', clicks: 2, firstAt: '2026-10-27T12:00:00Z', lastAt: '2026-10-27T12:05:00Z' }] } }));
    expect(el().textContent).toContain('Not tracked');
    const row = el().querySelector('.et-table tbody tr')!;
    expect(row.textContent).toContain('shop.io/spring');
    expect(row.textContent).toContain('2');
  });

  it('a bounce shows the reason; an unknown outcome is shown as unknown, never as failed or delivered', () => {
    show(base({ deliveryStatus: 'bounced', bouncedAt: '2026-10-27T10:02:00Z', failure: { code: 'No such user', reason: 'Mailbox does not exist' } }));
    expect(el().textContent).toContain('Bounced');
    expect(el().textContent).toContain('Mailbox does not exist');
    fixture.destroy();
    show(base({ deliveryStatus: 'unknown' }));
    expect(el().textContent).toContain('Outcome unknown');
    expect(el().textContent).toContain('never resent automatically');
  });

  it('untracked emails and errors are explained', () => {
    show({ tracked: false });
    expect(el().textContent).toContain('Not tracked.');
    fixture.destroy();
    fixture = TestBed.createComponent(EmailTrackingComponent);
    fixture.componentInstance.emailId = 5;
    fixture.componentInstance.ngOnChanges();
    http.expectOne(r => r.url.endsWith('/mail/tracking/emails/5')).flush({ error: 'x' }, { status: 403, statusText: 'x' });
    fixture.detectChanges();
    expect(el().textContent).toContain('cannot view email tracking');
  });
});
