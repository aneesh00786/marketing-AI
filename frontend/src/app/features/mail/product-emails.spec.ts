import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ProductEmailsComponent } from './product-emails.component';
import { apiRoot } from '../../core/api-base';

const BASE = `${apiRoot()}/api/v1/mail/product-emails`;
const LEADS = [
  { id: 1, name: 'Dana Smith', email: 'dana@fleetco.io', company: 'FleetCo', status: 'New', consent: 'granted', eligible: true, reasons: [] },
  { id: 2, name: 'Kim Park', email: 'kim@cargo.io', company: 'Cargo', status: 'New', consent: 'unknown', eligible: false, reasons: ['Marketing consent not recorded'] },
  { id: 3, name: 'Lee Wong', email: 'lee@shipit.io', company: null, status: 'Qualified', consent: 'granted', eligible: true, reasons: [] }
];

describe('ProductEmailsComponent', () => {
  let fixture: ComponentFixture<ProductEmailsComponent>;
  let comp: ProductEmailsComponent;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ProductEmailsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ProductEmailsComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne(`${apiRoot()}/api/v1/mail/zoho/status`).flush({ canCompose: true, canSend: true, canConfigure: true });
    http.expectOne(`${apiRoot()}/api/v1/mail/marketing`).flush({ marketing: { allowed: true, code: null, reason: null, provider: 'custom_smtp' } });
    http.expectOne(`${apiRoot()}/api/v1/products`).flush({ products: [{ id: 5, name: 'RouteKit' }] });
    comp.productId = 5;
    comp.chooseProduct();
    const req = http.expectOne(r => r.url === `${BASE}/recipients`);
    expect(req.request.params.get('productId')).toBe('5');
    req.flush({ product: { id: 5, name: 'RouteKit', tagline: 'Plan routes', features: ['Driver app'] }, leads: LEADS, total: 3, eligibleIds: [1, 3], maxBatch: 100 });
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('loads the product details and selects no leads by default', () => {
    expect(fixture.nativeElement.textContent).toContain('Driver app');
    expect(comp.selected.size).toBe(0);
    const boxes = fixture.nativeElement.querySelectorAll('tbody input[type=checkbox]') as NodeListOf<HTMLInputElement>;
    expect(boxes.length).toBe(3);
    expect(Array.from(boxes).some(b => b.checked)).toBeFalse();
  });

  it('shows why a lead is ineligible and does not allow selecting it', () => {
    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows[1].textContent).toContain('Marketing consent not recorded');
    expect((rows[1].querySelector('input') as HTMLInputElement).disabled).toBeTrue();
    comp.toggle(LEADS[1]);
    expect(comp.selected.has(2)).toBeFalse();
  });

  it('"Select all eligible" selects only eligible leads; individual toggling works', () => {
    comp.selectAllEligible();
    expect([...comp.selected].sort()).toEqual([1, 3]);
    comp.toggle(LEADS[2]);
    expect([...comp.selected]).toEqual([1]);
  });

  it('prepares personalized emails for the selection, previews them sandboxed, and sends only after confirmation', () => {
    comp.selectAllEligible();
    comp.form.goal = 'Show {{company}} RouteKit';
    comp.form.senderName = 'Jane';
    comp.generate();
    const create = http.expectOne(r => r.method === 'POST' && r.url === `${BASE}/batches`);
    expect(create.request.body).toEqual(jasmine.objectContaining({ productId: 5, leadIds: [1, 3], senderName: 'Jane', goal: 'Show {{company}} RouteKit' }));
    create.flush({ batch: { id: 9, productName: 'RouteKit', status: 'draft' }, drafts: [
      { id: 21, recipientEmail: 'dana@fleetco.io', recipientName: 'Dana Smith', subject: 'RouteKit for FleetCo', status: 'Approved', placeholders: [], bodyHtml: '<p id="mail-body">Hi Dana</p><script>window.__x = 1</script>' },
      { id: 22, recipientEmail: 'lee@shipit.io', recipientName: 'Lee Wong', subject: 'RouteKit', status: 'Draft', placeholders: ['{{company}}'], bodyHtml: '<p>Hi Lee</p>' }
    ], skipped: [] });
    fixture.detectChanges();
    const frame = fixture.nativeElement.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(fixture.nativeElement.querySelector('#mail-body')).toBeNull();
    expect((window as any).__x).toBeUndefined();
    expect(fixture.nativeElement.textContent).toContain('Fill {{company}}');

    const confirmSpy = spyOn(window, 'confirm').and.returnValue(false);
    comp.send();
    expect(confirmSpy).toHaveBeenCalled();
    http.expectNone(`${BASE}/batches/9/send`);
    confirmSpy.and.returnValue(true);
    comp.send();
    const send = http.expectOne(`${BASE}/batches/9/send`);
    expect(send.request.body).toEqual({ confirm: true });
    send.flush({ queued: true, batch: { id: 9, status: 'done' }, drafts: [{ id: 21, recipientEmail: 'dana@fleetco.io', status: 'Sent', outcome: 'sent', placeholders: [] }] });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Sent');
  });

  it('blocks sending when marketing delivery is not allowed, and lets an Owner/Admin approve the SMTP mailbox', () => {
    comp.delivery = { allowed: false, code: 'MARKETING_NOT_APPROVED', reason: 'This SMTP mailbox is not approved for marketing email yet.', provider: 'custom_smtp' };
    comp['setBatch']({ batch: { id: 9, productName: 'RouteKit', status: 'approved' }, drafts: [{ id: 21, recipientEmail: 'dana@fleetco.io', status: 'Approved', outcome: null, placeholders: [], bodyHtml: '<p>Hi</p>' }] });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Sending is blocked');
    const sendBtn = Array.from(fixture.nativeElement.querySelectorAll('.actions .btn-primary') as NodeListOf<HTMLButtonElement>).find(b => /Send/.test(b.textContent || ''));
    expect(sendBtn?.disabled).toBeTrue();
    comp.send();
    http.expectNone(`${BASE}/batches/9/send`);
    comp.approveMarketing();
    http.expectNone(`${apiRoot()}/api/v1/mail/marketing`, 'needs the confirmation first');
    comp.approveMarketingConfirm = true;
    comp.approveMarketing();
    const req = http.expectOne(`${apiRoot()}/api/v1/mail/marketing`);
    expect(req.request.body).toEqual(jasmine.objectContaining({ approved: true, confirm: true }));
    req.flush({ marketing: { allowed: true, code: null, reason: null, provider: 'custom_smtp' } });
    expect(comp.delivery?.allowed).toBeTrue();
  });

  it('records consent only with method, date, evidence and an explicit confirmation', () => {
    comp.recordConsent(LEADS[1]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('A note alone is not consent');
    expect(comp.consentReady).toBeFalse();
    comp.consentForm.obtainedAt = '2026-09-10';
    comp.consentForm.evidence = 'Form submission #8812';
    expect(comp.consentReady).withContext('the attestation is required').toBeFalse();
    comp.consentForm.attest = true;
    expect(comp.consentReady).toBeTrue();
    comp.saveConsent();
    const req = http.expectOne(`${BASE}/consent`);
    expect(req.request.body).toEqual({ leadIds: [2], status: 'granted', method: 'web_form', obtainedAt: '2026-09-10', evidence: 'Form submission #8812', attest: true });
    req.flush({ updated: 1, status: 'granted' });
    http.expectOne(r => r.url === `${BASE}/recipients`).flush({ product: null, leads: [], total: 0, eligibleIds: [], maxBatch: 100 });
  });
});
