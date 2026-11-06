import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { importSyncBody, importSyncProblem, newImportSync } from './import-sync';
import { ImportSyncOptionsComponent } from './import-sync-options.component';
import { LeadsToListComponent } from './leads-to-list.component';

describe('Import sync (consent + contact list)', () => {
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
    expect(importSyncProblem(o)).toContain('name for the new contact list');
    o.listName = ' Trade show ';
    expect(importSyncProblem(o)).toBe('');
    expect(importSyncBody(o)).toEqual({ consent: { method: 'web_form', obtainedAt: '2026-10-01', evidence: 'Trade show sheet', attest: true }, mailList: { name: 'Trade show' } });
    const e = newImportSync('12');
    expect(e.list).toBe('existing');
    expect(importSyncBody(e)).toEqual({ mailList: { id: 12 } });
  });
});

describe('ImportSyncOptionsComponent', () => {
  let http: HttpTestingController;
  afterEach(() => http.verify());
  function make(canList: boolean): { fixture: ComponentFixture<ImportSyncOptionsComponent>; el: HTMLElement } {
    TestBed.configureTestingModule({ imports: [ImportSyncOptionsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ImportSyncOptionsComponent);
    fixture.componentInstance.sync = newImportSync();
    fixture.componentInstance.canList = canList;
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement };
  }

  it('marks consent optional; consent shows how, when, proof and the confirmation', () => {
    const { fixture, el } = make(false);
    expect(el.textContent).toContain('Campaigns go only to people with recorded consent');
    expect(el.textContent).not.toContain('Contact list');
    fixture.componentInstance.sync.consent = true;
    fixture.detectChanges();
    expect(el.textContent).toContain('How they agreed');
    expect(el.textContent).toContain('I confirm I hold this proof');
  });

  it('loads the contact lists here; if they cannot be loaded, leads only', () => {
    const a = make(true);
    http.expectOne(r => r.url.endsWith('/contact-lists')).flush({ lists: [{ id: 3, name: 'Sydney', total: 3 }] });
    a.fixture.componentInstance.sync.list = 'existing';
    a.fixture.detectChanges();
    expect(Array.from(a.el.querySelectorAll('select option')).map(o => o.textContent!.trim())).toContain('Sydney (3)');
    expect(a.el.textContent).toContain('Kept in Marketech.ai');
    TestBed.resetTestingModule();
    const b = make(true);
    b.fixture.componentInstance.sync.list = 'new';
    http.expectOne(r => r.url.endsWith('/contact-lists')).flush({ error: 'No access.' }, { status: 403, statusText: 'Forbidden' });
    b.fixture.detectChanges();
    expect(b.fixture.componentInstance.sync.list).toBe('none');
    expect(b.el.textContent).toContain('No access.');
  });
});

describe('LeadsToListComponent (Leads → Add to contact list)', () => {
  let fixture: ComponentFixture<LeadsToListComponent>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const btn = (t: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.trim().includes(t)) as HTMLButtonElement;
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [LeadsToListComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LeadsToListComponent);
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/contact-lists')).flush({ lists: [{ id: 3, name: 'Sydney', total: 3 }] });
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
    expect(btn('Add to list').disabled).toBeTrue();
    fixture.componentInstance.listKey = '3';
    btn('Select all shown').click();
    fixture.detectChanges();
    btn('Add to list').click();
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/contact-lists/3/contacts'));
    expect(req.request.body).toEqual({ leadIds: [7] });
    req.flush({ list: { id: 3, name: 'Sydney' }, added: 1, skipped: [] });
    fixture.detectChanges();
    expect(el().textContent).toContain('1 lead(s) added to “Sydney”');
    let open = 0;
    fixture.componentInstance.openCampaigns.subscribe(() => open++);
    btn('Create a campaign').click();
    expect(open).toBe(1);
  });
});
