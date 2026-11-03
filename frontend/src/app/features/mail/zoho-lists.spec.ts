import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ZohoListsComponent } from './zoho-lists.component';

describe('ZohoListsComponent (Zoho Campaigns → Contact lists)', () => {
  let fixture: ComponentFixture<ZohoListsComponent>;
  let comp: ZohoListsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (text: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.trim().includes(text)) as HTMLButtonElement;
  const LISTS = [
    { key: 'L1', name: 'Sydney buyers', contacts: 12, campaignList: false },
    { key: 'L2', name: 'Marketech campaign 4 v1 abc', contacts: 3, campaignList: true }
  ];

  function start(opts: { ready?: boolean; manage?: boolean; canAdd?: boolean; canRemove?: boolean } = {}): void {
    TestBed.configureTestingModule({ imports: [ZohoListsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ZohoListsComponent);
    comp = fixture.componentInstance;
    comp.zohoReady = opts.ready ?? true;
    comp.canManage = opts.manage ?? true;
    fixture.detectChanges();
    if (comp.zohoReady) http.expectOne(r => r.url.endsWith('/mail/campaigns/zoho-lists')).flush({ lists: LISTS, canAdd: opts.canAdd ?? true, canRemove: opts.canRemove ?? true });
    fixture.detectChanges();
  }
  afterEach(() => http.verify());

  it('lists Zoho lists with counts; lists made for campaigns are hidden until asked for', () => {
    start();
    const names = () => Array.from(el().querySelectorAll('.zl-row:not(.zl-th) .zl-name b')).map(b => b.textContent!.trim());
    expect(names()).toEqual(['Sydney buyers']);
    expect(el().textContent).toContain('12');
    (el().querySelector('.zl-check input') as HTMLInputElement).click(); fixture.detectChanges();
    expect(names()).toEqual(['Sydney buyers', 'Marketech campaign 4 v1 abc']);
    expect(el().textContent).toContain('Made for a campaign');
  });

  it('New list: needs a name and a contact, then creates it with the chosen leads and typed addresses', () => {
    start();
    button('New list').click(); fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/lead-options') && r.params.get('eligibility') === 'eligible')
      .flush({ leads: [{ id: 7, name: 'Priya Nair', email: 'priya@acme.com.au', company: 'Acme' }] });
    fixture.detectChanges();
    expect(button('Create list').disabled).toBeTrue();
    expect(el().textContent).toContain('Enter a list name.');
    comp.form!.name = 'Melbourne';
    fixture.detectChanges();
    expect(el().textContent).toContain('Zoho creates a list together with its first contacts');
    (el().querySelector('.zl-lead input') as HTMLInputElement).click();
    comp.form!.emails = 'a@b.com.au, A@b.com.au\nc@d.com.au';
    fixture.detectChanges();
    expect(el().textContent).toContain('3 contact(s) will be added to the new list.');
    button('Create list').click();
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/mail/campaigns/zoho-lists'));
    expect(req.request.body).toEqual({ leadIds: [7], emails: ['a@b.com.au', 'c@d.com.au'], name: 'Melbourne' });
    let msg = '';
    comp.toast.subscribe((m: string) => msg = m);
    req.flush({ list: { key: 'L9', name: 'Melbourne' }, added: 2, skipped: [{ email: 'c@d.com.au', reason: 'Unsubscribed, bounced or withdrew consent' }] });
    http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ lists: LISTS, canAdd: true, canRemove: true });
    fixture.detectChanges();
    expect(msg).toBe('List “Melbourne” created in Zoho with 2 contact(s). 1 skipped.');
    expect(el().textContent).toContain('c@d.com.au: Unsubscribed, bounced or withdrew consent');
  });

  it('Add contacts goes to that list; View contacts can remove one after confirming', () => {
    start();
    button('Add contacts').click(); fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/lead-options')).flush({ leads: [] });
    comp.form!.emails = 'new@shop.com.au'; fixture.detectChanges();
    Array.from(el().querySelectorAll('.zc-card button')).find(b => b.textContent!.trim() === 'Add contacts')!.dispatchEvent(new Event('click'));
    const add = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/zoho-lists/L1/contacts'));
    expect(add.request.body).toEqual({ leadIds: [], emails: ['new@shop.com.au'] });
    add.flush({ list: { key: 'L1', name: 'Sydney buyers' }, added: 1, skipped: [] });
    http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ lists: LISTS, canAdd: true, canRemove: true });
    fixture.detectChanges();
    expect(comp.form).toBeNull();

    button('View contacts').click(); fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/audiences/L1/contacts') && r.params.get('status') === 'subscribed').flush({ contacts: [{ email: 'x@y.com.au', name: 'Xi' }], hasMore: false });
    fixture.detectChanges();
    spyOn(window, 'confirm').and.returnValue(true);
    button('Remove').click();
    expect(window.confirm).toHaveBeenCalled();
    const rm = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/zoho-lists/L1/remove'));
    expect(rm.request.body).toEqual({ email: 'x@y.com.au' });
    rm.flush({ removed: 'x@y.com.au' });
    http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ lists: LISTS, canAdd: true, canRemove: true });
    fixture.detectChanges();
    expect(el().querySelector('.zl-email')).toBeNull();
  });

  it('Import from Excel: saves the rows as leads and adds them to a new Zoho list, with consent', () => {
    start();
    button('Import from Excel').click(); fixture.detectChanges();
    expect(el().textContent).toContain('Choose an Excel or CSV file');
    comp.importing!.rows = [{ name: 'Priya Nair', companyName: 'Acme', email: 'p@acme.com.au', phone: '', product: '', productId: '', estimatedBudget: '', notes: '' }];
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ lists: LISTS, canAdd: true, canRemove: true });
    fixture.detectChanges();
    expect(comp.importProblem).toBe('Enter a name for the new Zoho list.');
    Object.assign(comp.importing!.sync, { listName: 'Trade show', consent: true, evidence: 'Sign-up sheet', attest: true, obtainedAt: '2026-10-01' });
    fixture.detectChanges();
    Array.from(el().querySelectorAll('.zc-card button')).find(b => b.textContent!.trim() === 'Import')!.dispatchEvent(new Event('click'));
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/api/v1/leads/import-bulk'));
    expect(req.request.body.leads.length).toBe(1);
    expect(req.request.body.zohoList).toEqual({ name: 'Trade show' });
    expect(req.request.body.consent).toEqual({ method: 'web_form', obtainedAt: '2026-10-01', evidence: 'Sign-up sheet', attest: true });
    req.flush({ message: 'Imported 1 lead.', imported: 1, duplicates: [], consentRecorded: 1, zoho: { list: { name: 'Trade show' }, added: 1, skipped: 0, error: null } });
    http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ lists: LISTS, canAdd: true, canRemove: true });
    fixture.detectChanges();
    expect(el().textContent).toContain('Zoho: 1 added to “Trade show”');
  });

  it('not connected: asks to set up Zoho and loads nothing; without permissions it asks to reconnect', () => {
    start({ ready: false });
    expect(el().textContent).toContain('Connect Zoho Campaigns to see and manage your contact lists.');
    TestBed.resetTestingModule();
    start({ canRemove: false });
    expect(el().textContent).toContain('Reconnect Zoho once to remove contacts from lists');
    button('View contacts').click(); fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/audiences/L1/contacts')).flush({ contacts: [{ email: 'x@y.com.au' }], hasMore: false });
    fixture.detectChanges();
    expect(button('Remove')).toBeUndefined();
  });
});
