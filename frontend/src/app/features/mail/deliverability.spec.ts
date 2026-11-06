import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DeliverabilityComponent } from './deliverability.component';

const DATA = (over: any = {}) => ({
  days: 30,
  totals: { attempted: 104, sent: 100, delivered: 97, hardBounces: 6, softBounces: 1, complaints: 0, unsubscribes: 2, rejected: 4, unknown: 0, opened: 20, clicked: 3 },
  rates: { delivery: 97, bounce: 6, complaint: 0, unsubscribe: 2.06, rejection: 3.85, open: 20.62 },
  daily: [{ day: '2026-11-05', sent: 40, delivered: 39, bounced: 1, complaints: 0 }, { day: '2026-11-06', sent: 60, delivered: 58, bounced: 5, complaints: 0 }],
  receivers: [{ receiver: 'Gmail', sent: 70, delivered: 69, bounced: 1, complaints: 0, opened: 5, deliveryRate: 98.57, bounceRate: 1.43, complaintRate: 0, openRate: 7.25 }],
  warmups: [{ domain: 'thrivewoo.com', enabled: true, day: 2, cap: 100, sentLast24h: 60, remaining: 40, resumeAt: null }],
  health: { level: 'warning', stopped: false, message: 'Watch out: bounce rate 6% (keep it under 5%) in the last 14 days.', thresholds: { bounceWarn: 5, bounceStop: 10, complaintWarn: 0.1, complaintStop: 0.5 } },
  gmailReputation: { available: false },
  note: 'Sent means Amazon SES accepted the email. Delivered means the recipient\'s mail server accepted it: it may still be in the spam folder.',
  ...over
});

describe('DeliverabilityComponent', () => {
  let fixture: ComponentFixture<DeliverabilityComponent>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [DeliverabilityComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(DeliverabilityComponent);
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('shows the rates with their level, warm-up and the warning; delivered is never called inbox', () => {
    http.expectOne('/api/v1/mail/ses/deliverability?days=30').flush(DATA());
    fixture.detectChanges();
    const text = el().textContent || '';
    expect(text).toContain('Delivery rate');
    expect(text).toContain('97%');
    expect(text).toContain('SES rejection rate');
    expect(text).toContain('Watch out: bounce rate 6%');
    expect(el().querySelector('.dv-stat[data-level="warning"] .dv-badge')?.textContent).toContain('High');
    expect(text).toContain('Day 2: up to 100 emails in 24 hours');
    expect(text).toContain('Gmail domain reputation');
    expect(text).toContain('Not available');
    expect(text).not.toMatch(/reached the inbox|inbox rate/i);
    expect(el().querySelectorAll('.dv-bar').length).toBe(2);
  });

  it('switches range and shows the days as a table', () => {
    http.expectOne('/api/v1/mail/ses/deliverability?days=30').flush(DATA());
    fixture.componentInstance.setRange(7);
    http.expectOne('/api/v1/mail/ses/deliverability?days=7').flush(DATA({ days: 7 }));
    fixture.componentInstance.showTable = true;
    fixture.detectChanges();
    expect(el().querySelectorAll('.dv-table tbody tr').length).toBeGreaterThanOrEqual(2);
  });

  it('a paused workspace says so', () => {
    http.expectOne(r => r.url.includes('deliverability')).flush(DATA({ health: { level: 'critical', stopped: true, message: 'Sending is paused: …', thresholds: { bounceWarn: 5, bounceStop: 10, complaintWarn: 0.1, complaintStop: 0.5 } } }));
    fixture.detectChanges();
    expect(el().querySelector('.dv-banner.critical')?.textContent).toContain('Sending paused');
  });
});
