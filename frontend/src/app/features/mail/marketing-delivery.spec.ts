import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MarketingDeliveryComponent } from './marketing-delivery.component';

const NOT_APPROVED = { allowed: false, code: 'MARKETING_NOT_APPROVED', reason: 'This SMTP mailbox is not approved for marketing email yet.', provider: 'custom_smtp', approvedAt: null };

describe('MarketingDeliveryComponent', () => {
  let fixture: ComponentFixture<MarketingDeliveryComponent>;
  let comp: MarketingDeliveryComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (t: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes(t)) as HTMLButtonElement | undefined;

  function init(status: any, caps: string[]): void {
    fixture = TestBed.createComponent(MarketingDeliveryComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/mail/marketing') && r.method === 'GET').flush({ marketing: status });
    http.expectOne(r => r.url.endsWith('/auth/me')).flush({ capabilities: caps });
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MarketingDeliveryComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('Owners/Admins approve an SMTP mailbox for marketing after confirming the provider allows it', () => {
    init(NOT_APPROVED, ['mail.view', 'mail.configure']);
    expect(el().textContent).toContain('Not ready');
    expect(button('Approve for marketing')!.disabled).withContext('needs the confirmation first').toBeTrue();
    comp.confirmed = true;
    fixture.detectChanges();
    button('Approve for marketing')!.click();
    const req = http.expectOne(r => r.url.endsWith('/mail/marketing') && r.method === 'POST');
    expect(req.request.body).toEqual({ approved: true, confirm: true, note: 'Confirmed in Mail Center' });
    req.flush({ marketing: { ...NOT_APPROVED, allowed: true, code: null, reason: null, approvedAt: '2026-10-28T10:00:00Z' } });
    fixture.detectChanges();
    expect(el().textContent).toContain('Ready');
    expect(el().textContent).toContain('approved for marketing email');
  });

  it('other roles see the reason but cannot approve', () => {
    init(NOT_APPROVED, ['mail.view', 'mail.send']);
    expect(button('Approve for marketing')).toBeUndefined();
    expect(el().textContent).toContain('A workspace Owner or Admin can approve it here');
  });

  it('a ZeptoMail-only workspace is told to add an SMTP mailbox (no approve button)', () => {
    init({ allowed: false, code: 'MARKETING_PROVIDER_BLOCKED', reason: 'Marketing emails cannot be sent through ZeptoMail.', provider: 'zeptomail', approvedAt: null }, ['mail.configure']);
    expect(button('Approve for marketing')).toBeUndefined();
    expect(el().textContent).toContain('Enter your own SMTP mailbox above and save');
  });

  it('an approved mailbox can be withdrawn after confirming', () => {
    init({ allowed: true, code: null, reason: null, provider: 'custom_smtp', approvedAt: '2026-10-01T00:00:00Z' }, ['mail.configure']);
    spyOn(window, 'confirm').and.returnValue(true);
    button('Withdraw approval')!.click();
    const req = http.expectOne(r => r.url.endsWith('/mail/marketing') && r.method === 'POST');
    expect(req.request.body).toEqual({ approved: false, confirm: true });
    req.flush({ marketing: NOT_APPROVED });
  });

  it('reloads when the mail settings are saved (a new SMTP account clears the approval)', () => {
    init({ allowed: true, code: null, reason: null, provider: 'custom_smtp', approvedAt: '2026-10-01T00:00:00Z' }, ['mail.configure']);
    comp.refreshKey = 1;
    comp.ngOnChanges({ refreshKey: { firstChange: false, currentValue: 1, previousValue: null, isFirstChange: () => false } as any });
    http.expectOne(r => r.url.endsWith('/mail/marketing') && r.method === 'GET').flush({ marketing: NOT_APPROVED });
    fixture.detectChanges();
    expect(el().textContent).toContain('Not ready');
  });
});
