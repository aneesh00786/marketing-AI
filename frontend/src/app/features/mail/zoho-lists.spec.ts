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
    if (comp.zohoReady) http.expectOne(r => r.url.endsWith('/mail/campaigns/zoho-lists')).flush({ lists: structuredClone(LISTS), canAdd: opts.canAdd ?? true, canRemove: opts.canRemove ?? true });
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
    http.expectOne(r => r.url.endsWith('/lead-options') && !r.params.has('eligibility') && r.params.get('pageSize') === '2000')
      .flush({ leads: [
        { id: 7, name: 'Priya Nair', email: 'priya@acme.com.au', company: 'Acme', eligible: true, reasons: [] },
        { id: 8, name: 'Big Red', email: 'o@bigred.com.au', eligible: false, reasons: ['Unsubscribed'] }
      ] });
    fixture.detectChanges();
    expect(button('Create list').disabled).toBeTrue();
    expect(el().textContent).toContain('Enter a list name.');
    comp.form!.name = 'Melbourne';
    fixture.detectChanges();
    expect(el().textContent).toContain('Zoho creates a list together with its first contacts');
    button('Choose leads (1 available)').click(); fixture.detectChanges();
    const picker = () => el().querySelector('.zl-picker') as HTMLElement;
    const rows = () => Array.from(picker().querySelectorAll('.zl-pick-row:not(.zl-pick-all)')) as HTMLElement[];
    expect(rows().map(r => r.querySelector('b')!.textContent)).toEqual(['Priya Nair', 'Big Red']);
    expect((rows()[1].querySelector('input') as HTMLInputElement).disabled).toBeTrue();
    expect(rows()[1].textContent).toContain('Unsubscribed');
    // The filter narrows the list as you type.
    comp.picker!.query = 'acme'; fixture.detectChanges();
    expect(rows().length).toBe(1);
    comp.picker!.query = 'zzz'; fixture.detectChanges();
    expect(picker().textContent).toContain('No leads match');
    comp.picker!.query = ''; fixture.detectChanges();
    // Cancel keeps nothing; ticking and Done adds the lead.
    (picker().querySelector('.zl-pick-all input') as HTMLInputElement).click(); fixture.detectChanges();
    expect(picker().textContent).toContain('1 selected');
    button('Cancel').click(); fixture.detectChanges();
    expect(comp.picker).toBeNull();
    expect(comp.form!.picked.size).toBe(0);
    button('Choose leads').click(); fixture.detectChanges();
    (rows()[0].querySelector('input') as HTMLInputElement).click(); fixture.detectChanges();
    button('Done').click(); fixture.detectChanges();
    expect(el().querySelector('.zl-picked-count')!.textContent).toContain('1 lead(s) selected');
    expect(el().querySelector('.zl-chip')).toBeNull();
    expect(button('Change selected leads')).toBeTruthy();
    comp.form!.emails = 'a@b.com.au, A@b.com.au\nc@d.com.au';
    fixture.detectChanges();
    expect(el().textContent).toContain('3 contact(s) will be added to the new list.');
    button('Create list').click();
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/mail/campaigns/zoho-lists'));
    expect(req.request.body).toEqual({ leadIds: [7], emails: ['a@b.com.au', 'c@d.com.au'], name: 'Melbourne' });
    let msg = '';
    comp.toast.subscribe((m: string) => msg = m);
    req.flush({ list: { key: 'L9', name: 'Melbourne' }, added: 2, skipped: [{ email: 'c@d.com.au', reason: 'Unsubscribed, bounced or withdrew consent' }] });
    http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ lists: structuredClone(LISTS), canAdd: true, canRemove: true });
    fixture.detectChanges();
    expect(msg).toBe('List “Melbourne” created in Zoho with 2 contact(s). 1 skipped.');
    expect(el().textContent).toContain('c@d.com.au: Unsubscribed, bounced or withdrew consent');
  });

  it('Add a contact: typed details are saved as a lead, then added to the list with the chosen leads', () => {
    start();
    button('Add contacts').click(); fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/lead-options')).flush({ leads: [] });
    fixture.detectChanges();
    const add = () => button('+ Add');
    expect(add().disabled).toBeTrue();
    Object.assign(comp.form!.draft, { name: 'Kim Lee', company: 'Shop Pty Ltd', email: 'bad', phone: '0400 000 000' });
    fixture.detectChanges();
    expect(el().textContent).toContain('Enter a valid email address.');
    comp.form!.draft.email = ' Kim@Shop.com.au ';
    fixture.detectChanges();
    add().click(); fixture.detectChanges();
    expect(el().querySelector('.zl-manual-list')!.textContent).toContain('kim@shop.com.au');
    expect(comp.form!.draft.email).toBe('');
    Object.assign(comp.form!.draft, { email: 'kim@shop.com.au', name: 'Again' });
    fixture.detectChanges();
    expect(add().disabled).toBeTrue();
    comp.form!.draft = { name: '', company: '', email: '', phone: '' };
    fixture.detectChanges();
    expect(el().textContent).toContain('1 contact(s) will be added.');
    Array.from(el().querySelectorAll('.zc-card button')).find(b => b.textContent!.trim() === 'Add contacts')!.dispatchEvent(new Event('click'));
    const imp = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/api/v1/leads/import-bulk'));
    expect(imp.request.body).toEqual({ leads: [{ name: 'Kim Lee', companyName: 'Shop Pty Ltd', email: 'kim@shop.com.au', phone: '0400 000 000' }] });
    imp.flush({ imported: 1, leadIds: [21], duplicates: [] });
    http.expectOne(r => r.url.endsWith('/lead-options')).flush({ leads: [] });
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/zoho-lists/L1/contacts'));
    expect(req.request.body).toEqual({ leadIds: [21], emails: [] });
    req.flush({ list: { key: 'L1', name: 'Sydney buyers' }, added: 1, skipped: [] });
    http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ lists: structuredClone(LISTS), canAdd: true, canRemove: true });
    expect(comp.form).toBeNull();
  });

  it('plan limit: shows contacts against the limit; admins set it; adding past it warns', () => {
    TestBed.configureTestingModule({ imports: [ZohoListsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ZohoListsComponent);
    comp = fixture.componentInstance;
    Object.assign(comp, { zohoReady: true, canManage: true, canConfigure: true });
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ lists: structuredClone(LISTS), canAdd: true, canRemove: true, plan: { contactLimit: null, usage: { upTo: 950, atLeast: 600 } } });
    fixture.detectChanges();
    expect(el().querySelector('.zl-plan')!.textContent).toContain('Contacts in Zoho: up to 950');
    button('Set plan limit').click(); fixture.detectChanges();
    comp.limitEdit = '1,000';
    (el().querySelector('.zl-plan-edit') as HTMLFormElement).dispatchEvent(new Event('submit'));
    const put = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/zoho-plan'));
    expect(put.request.body).toEqual({ contactLimit: 1000 });
    put.flush({ contactLimit: 1000 });
    fixture.detectChanges();
    expect(el().querySelector('.zl-plan')!.textContent).toContain('up to 950 of 1,000');
    expect(comp.limitWarning(50)).toBe('');
    expect(comp.limitWarning(100)).toContain('may go over it');
    button('New list').click(); fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/lead-options')).flush({ leads: [] });
    comp.form!.emails = Array.from({ length: 60 }, (_, i) => `p${i}@a.io`).join('\n');
    fixture.detectChanges();
    expect(el().querySelector('.zl-limit-warn')!.textContent).toContain('Adding 60 may go over it');
  });

  it('Add contacts goes to that list; View contacts can remove one after confirming', () => {
    start();
    button('Add contacts').click(); fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/lead-options')).flush({ leads: [{ id: 8, name: 'Big Red', email: 'o@bigred.com.au', eligible: false, reasons: ['Unsubscribed'] }] });
    fixture.detectChanges();
    expect(el().textContent).toContain('None of your 1 lead(s) can be added:');
    expect(button('Choose leads (0 available)')).toBeTruthy();
    comp.form!.emails = 'new@shop.com.au'; fixture.detectChanges();
    Array.from(el().querySelectorAll('.zc-card button')).find(b => b.textContent!.trim() === 'Add contacts')!.dispatchEvent(new Event('click'));
    const add = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/zoho-lists/L1/contacts'));
    expect(add.request.body).toEqual({ leadIds: [], emails: ['new@shop.com.au'] });
    add.flush({ list: { key: 'L1', name: 'Sydney buyers' }, added: 1, skipped: [] });
    http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ lists: structuredClone(LISTS), canAdd: true, canRemove: true });
    fixture.detectChanges();
    expect(comp.form).toBeNull();

    button('View contacts').click(); fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/audiences/L1/contacts') && r.params.get('status') === 'subscribed').flush({ contacts: [{ email: 'x@y.com.au', name: 'Xi' }], hasMore: false });
    fixture.detectChanges();
    expect(el().querySelector('.zl-range')!.textContent).toContain('Showing 1–1 of 1 subscribed');
    const cells = Array.from(el().querySelectorAll('.zl-ctable tbody tr:first-child td')).map(td => td.textContent!.trim());
    expect(cells.slice(0, 8)).toEqual(['1', 'Xi', '—', 'x@y.com.au', '—', '—', 'Not in Leads', '—']);
    expect(Array.from(el().querySelectorAll('.zl-ctable th')).map(th => th.textContent!.trim()).slice(0, 8)).toEqual(['#', 'Contact', 'Business', 'Email', 'Phone', 'Product', 'Lead status', 'Added']);
    expect(comp.viewing!.list.contacts).toBe(1, "Zoho's stale count (12) is corrected to what the list really holds");
    fixture.detectChanges();
    spyOn(window, 'confirm').and.returnValue(true);
    button('Remove').click();
    expect(window.confirm).toHaveBeenCalled();
    const rm = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/zoho-lists/L1/remove'));
    expect(rm.request.body).toEqual({ email: 'x@y.com.au' });
    rm.flush({ removed: 'x@y.com.au' });
    http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ lists: structuredClone(LISTS), canAdd: true, canRemove: true });
    fixture.detectChanges();
    expect(el().querySelector('.zl-email')).toBeNull();
  });

  it('Import from Excel: saves the rows as leads and adds them to a new Zoho list, with consent', () => {
    start();
    button('Import from Excel').click(); fixture.detectChanges();
    expect(el().textContent).toContain('Choose an Excel or CSV file');
    comp.importing!.rows = [{ name: 'Priya Nair', companyName: 'Acme', email: 'p@acme.com.au', phone: '', product: '', productId: '', estimatedBudget: '', notes: '' }];
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ lists: structuredClone(LISTS), canAdd: true, canRemove: true });
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
    http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ lists: structuredClone(LISTS), canAdd: true, canRemove: true });
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
