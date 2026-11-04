import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { importSyncBody, importSyncProblem, newImportSync } from './import-sync';
import { ImportSyncOptionsComponent } from './import-sync-options.component';
import { LeadsToZohoComponent } from './leads-to-zoho.component';

describe('Import sync (consent + Zoho list)', () => {
  it('needs full consent details and a list choice before importing; builds the request body', () => {
    const o = newImportSync();
    expect(importSyncProblem(o)).toBe('');
    expect(importSyncBody(o)).toEqual({});
    o.consent = true;
    expect(importSyncProblem(o)).toContain('proof of consent');
    o.evidence = 'Trade show sheet';
    expect(importSyncProblem(o)).toContain('Confirm');
    o.attest = true;
    o.obtainedAt = '2999-01-01';
    expect(importSyncProblem(o)).toContain('future');
    o.obtainedAt = '2026-10-01';
    o.list = 'new';
    expect(importSyncProblem(o)).toContain('name for the new Zoho list');
    o.listName = ' Trade show ';
    expect(importSyncProblem(o)).toBe('');
    expect(importSyncBody(o)).toEqual({ consent: { method: 'web_form', obtainedAt: '2026-10-01', evidence: 'Trade show sheet', attest: true }, zohoList: { name: 'Trade show' } });
    const e = newImportSync('L1');
    expect(e.list).toBe('existing');
    expect(importSyncBody(e)).toEqual({ zohoList: { key: 'L1' } });
  });
});

describe('ImportSyncOptionsComponent', () => {
  let http: HttpTestingController;
  afterEach(() => http.verify());
  function make(canZoho: boolean): { fixture: ComponentFixture<ImportSyncOptionsComponent>; el: HTMLElement } {
    TestBed.configureTestingModule({ imports: [ImportSyncOptionsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ImportSyncOptionsComponent);
    fixture.componentInstance.sync = newImportSync();
    fixture.componentInstance.canZoho = canZoho;
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement };
  }

  it('marks consent optional (not needed for Zoho); consent shows how, when, proof and the confirmation', () => {
    const { fixture, el } = make(false);
    expect(el.textContent).toContain('Not needed for Zoho Campaigns');
    expect(el.textContent).not.toContain('Zoho Campaigns list');
    fixture.componentInstance.sync.consent = true;
    fixture.detectChanges();
    expect(el.textContent).toContain('How they agreed');
    expect(el.textContent).toContain('I confirm I hold this proof');
  });

  it("loads Zoho lists (not the ones made for campaigns); not connected → no Zoho list", () => {
    const a = make(true);
    http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ lists: [{ key: 'L1', name: 'Sydney', contacts: 3 }, { key: 'L2', name: 'Marketech campaign 1 v1 x', campaignList: true }], canAdd: true });
    a.fixture.componentInstance.sync.list = 'existing';
    a.fixture.detectChanges();
    expect(Array.from(a.el.querySelectorAll('select option')).map(o => o.textContent!.trim())).toContain('Sydney (3)');
    expect(a.el.textContent).not.toContain('Marketech campaign');
    TestBed.resetTestingModule();
    const b = make(true);
    b.fixture.componentInstance.sync.list = 'new';
    http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ error: 'Connect Zoho Campaigns first.' }, { status: 409, statusText: 'Conflict' });
    b.fixture.detectChanges();
    expect(b.fixture.componentInstance.sync.list).toBe('none');
    expect(b.el.textContent).toContain('Connect Zoho Campaigns first.');
  });
});

describe('LeadsToZohoComponent (Leads → Add to Zoho list)', () => {
  let fixture: ComponentFixture<LeadsToZohoComponent>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const btn = (t: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.trim().includes(t)) as HTMLButtonElement;
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [LeadsToZohoComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LeadsToZohoComponent);
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ lists: [{ key: 'L1', name: 'Sydney', contacts: 3 }], canAdd: true });
  });
  afterEach(() => http.verify());

  it('with no eligible leads, explains why; "All leads" shows why each cannot be added', () => {
    http.expectOne(r => r.url.endsWith('/lead-options') && r.params.get('eligibility') === 'eligible').flush({ leads: [], total: 0, eligibleCount: 0 });
    fixture.detectChanges();
    expect(el().textContent).toContain('must not have unsubscribed');
    btn('Show all leads').click();
    http.expectOne(r => r.url.endsWith('/lead-options') && !r.params.has('eligibility')).flush({
      leads: [{ id: 3, name: 'Big Red Packaging', email: 'o@b.com.au', eligible: false, reasons: ['Unsubscribed'] }], total: 1, eligibleCount: 0 });
    fixture.detectChanges();
    expect(el().textContent).toContain('Unsubscribed');
    expect((el().querySelector('.ltz-lead input') as HTMLInputElement).disabled).toBeTrue();
  });

  it('adds the ticked leads to the chosen list and offers to create a campaign', () => {
    http.expectOne(r => r.url.endsWith('/lead-options')).flush({ leads: [{ id: 7, name: 'Priya', email: 'p@a.com.au', eligible: true, reasons: [] }], total: 1, eligibleCount: 1 });
    fixture.detectChanges();
    expect(btn('Add to Zoho list').disabled).toBeTrue();
    fixture.componentInstance.listKey = 'L1';
    btn('Select all shown').click();
    fixture.detectChanges();
    btn('Add to Zoho list').click();
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/zoho-lists/L1/contacts'));
    expect(req.request.body).toEqual({ leadIds: [7], emails: [] });
    req.flush({ list: { key: 'L1', name: 'Sydney' }, added: 1, skipped: [] });
    fixture.detectChanges();
    expect(el().textContent).toContain('1 lead(s) added to “Sydney”');
    let open = 0;
    fixture.componentInstance.openCampaigns.subscribe(() => open++);
    btn('Create a campaign').click();
    expect(open).toBe(1);
  });
});
