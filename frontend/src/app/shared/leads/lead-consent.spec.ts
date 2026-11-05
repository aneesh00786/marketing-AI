import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { LeadConsentComponent, consentLabel } from './lead-consent.component';

describe('LeadConsentComponent (Leads → Consent…)', () => {
  let fixture: ComponentFixture<LeadConsentComponent>;
  let comp: LeadConsentComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [LeadConsentComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LeadConsentComponent);
    comp = fixture.componentInstance;
    comp.lead = { id: 7, name: 'Kerala Traders', email: 'info@kt.in', marketingConsent: 'unknown' };
    comp.ngOnChanges();
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('labels consent the way campaigns use it', () => {
    expect(consentLabel({ marketingConsent: 'granted', marketingConsentProven: true })).toBe('Given');
    expect(consentLabel({ marketingConsent: 'granted', marketingConsentProven: false })).toBe('Given (no evidence)');
    expect(consentLabel({ marketingConsent: 'withdrawn' })).toBe('Withdrawn');
    expect(consentLabel({ marketingConsent: 'unknown' })).toBe('Not recorded');
  });

  it('granting needs how, when, evidence and the confirmation; then it is saved for this lead', () => {
    expect(el().textContent).toContain('Now: Not recorded');
    expect(comp.ready).toBeFalse();
    comp.obtainedAt = '2026-10-01';
    comp.evidence = 'Form #4411';
    expect(comp.ready).withContext('not without confirming the evidence is held').toBeFalse();
    comp.attest = true;
    comp.obtainedAt = '2999-01-01';
    expect(comp.ready).withContext('not in the future').toBeFalse();
    comp.obtainedAt = '2026-10-01';
    expect(comp.ready).toBeTrue();
    let saved: any = null;
    comp.saved.subscribe(v => saved = v);
    comp.save();
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/api/v1/leads/consent'));
    expect(req.request.body).toEqual({ leadIds: [7], status: 'granted', method: 'web_form', obtainedAt: '2026-10-01', evidence: 'Form #4411', attest: true });
    req.flush({ updated: 1, status: 'granted' });
    expect(saved).toEqual({ leadId: 7, status: 'granted' });
  });

  it('withdrawing needs no evidence; a refusal from the server is shown', () => {
    comp.status = 'withdrawn';
    comp.note = 'Asked by phone';
    fixture.detectChanges();
    expect(comp.ready).toBeTrue();
    comp.save();
    const req = http.expectOne(r => r.url.endsWith('/api/v1/leads/consent'));
    expect(req.request.body).toEqual({ leadIds: [7], status: 'withdrawn', note: 'Asked by phone' });
    req.flush({ error: 'Not allowed' }, { status: 403, statusText: 'Forbidden' });
    fixture.detectChanges();
    expect(el().querySelector('.lc-error')!.textContent).toContain('Not allowed');
  });
});
