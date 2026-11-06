import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ContactListsComponent } from './contact-lists.component';

describe('ContactListsComponent (lists kept in Marketech.ai)', () => {
  let fixture: ComponentFixture<ContactListsComponent>;
  let comp: ContactListsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (text: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.trim().includes(text)) as HTMLButtonElement;
  const LISTS = [
    { id: 1, name: 'Compiled B2B Oct 26', source: 'zoho', total: 7380, reachable: 7219 },
    { id: 2, name: 'Sydney buyers', source: 'local', total: 3, reachable: 2, noConsent: 1 }
  ];

  function start(o: Partial<ContactListsComponent> = {}): void {
    TestBed.configureTestingModule({ imports: [ContactListsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ContactListsComponent);
    comp = fixture.componentInstance;
    Object.assign(comp, { canManage: true, ...o });
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/contact-lists')).flush({ lists: structuredClone(LISTS), contacts: 7390 });
    fixture.detectChanges();
  }
  const reload = () => http.expectOne(r => r.method === 'GET' && r.url.endsWith('/contact-lists')).flush({ lists: structuredClone(LISTS), contacts: 7390 });
  afterEach(() => http.verify());

  it('shows the lists from Marketech.ai with their counts', () => {
    start();
    const rows = Array.from(el().querySelectorAll('.cl-row:not(.zl-th)'));
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('7,380');
    expect(el().textContent).not.toContain('Zoho');
  });

  it('New list: created here with chosen leads, typed contacts and pasted addresses (an empty list is fine)', () => {
    start();
    button('New list').click(); fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/lead-options')).flush({ leads: [{ id: 7, name: 'Priya', email: 'p@a.io', eligible: true }] });
    fixture.detectChanges();
    expect(el().textContent).toContain('Enter a list name.');
    comp.form!.name = 'Trade show';
    fixture.detectChanges();
    expect(el().textContent).toContain('An empty list can be filled later.');
    comp.form!.picked.set(7, { id: 7, name: 'Priya', email: 'p@a.io' });
    Object.assign(comp.form!.draft, { name: 'Kim Lee', company: 'Shop', email: 'kim@shop.io', phone: '0400' });
    comp.addManual();
    comp.form!.emails = 'a@b.io, A@b.io';
    fixture.detectChanges();
    expect(el().textContent).toContain('3 contact(s) will be added.');
    button('Create list').click();
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/contact-lists'));
    expect(req.request.body).toEqual({ name: 'Trade show', leadIds: [7], emails: ['a@b.io'], contacts: [{ name: 'Kim Lee', company: 'Shop', email: 'kim@shop.io', phone: '0400' }] });
    req.flush({ list: { id: 3, name: 'Trade show' }, added: 3, alreadyIn: 0, skipped: [] });
    reload();
    expect(comp.form).toBeNull();
  });

  it('Choose leads: filter by country (or leads without one) together with the search', () => {
    start();
    button('New list').click(); fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/lead-options')).flush({
      leads: [{ id: 7, name: 'Priya', email: 'p@a.io', country: 'India', address: '12 MG Road, Ernakulam 682016', eligible: true }, { id: 8, name: 'Sam', email: 's@a.io', country: 'Australia', eligible: true },
        { id: 9, name: 'Pat', email: 'pat@a.io', country: null, eligible: true }],
      countries: [{ country: 'Australia', count: 1 }, { country: 'India', count: 1 }, { country: null, count: 1 }] });
    fixture.detectChanges();
    comp.openPicker(); fixture.detectChanges();
    const sel = el().querySelector('.zl-picker app-country-filter select') as HTMLSelectElement;
    expect(Array.from(sel.options).map(o => o.textContent!.trim())).toEqual(['All countries', 'Australia (1)', 'India (1)', 'No country (1)']);
    expect(el().querySelector('.zl-picker')!.textContent).toContain('p@a.io · India');
    sel.value = 'India'; sel.dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(comp.pickerLeads.map(l => l.id)).toEqual([7]);
    expect(el().querySelector('.zl-pick-all')!.textContent).toContain('Select all shown (1)');
    comp.picker!.country = 'none'; fixture.detectChanges();
    expect(comp.pickerLeads.map(l => l.id)).toEqual([9]);
    comp.picker!.country = 'Australia'; comp.picker!.query = 'priya'; fixture.detectChanges();
    expect(el().querySelector('.zl-pick-none')!.textContent).toContain('No leads match “priya” in Australia.');
    // The search matches the address too, and each lead shows it.
    comp.picker!.country = ''; comp.picker!.query = 'ernakulam'; fixture.detectChanges();
    expect(comp.pickerLeads.map(l => l.id)).toEqual([7]);
    expect(el().querySelector('.zl-pick-addr')!.textContent).toContain('12 MG Road, Ernakulam 682016');
  });

  it('View contacts: status tabs, search, details and lead status; remove one', () => {
    start();
    button('View contacts').click(); fixture.detectChanges();
    let req = http.expectOne(r => r.url.endsWith('/contact-lists/1/contacts'));
    expect(req.request.params.get('status')).toBe('all');
    req.flush({ contacts: [{ id: 5, email: 'kim@shop.io', name: 'Kim Lee', company: 'Shop', phone: '0400', location: 'Sydney', status: 'unsubscribed', consent: 'none', leadStatus: 'Contacted' }], page: 1, pageSize: 50, hasMore: false });
    fixture.detectChanges();
    const cells = Array.from(el().querySelectorAll('.zl-ctable tbody td')).map(td => td.textContent!.trim());
    expect(cells.slice(0, 9)).toEqual(['1', 'Kim Lee', 'Shop', 'kim@shop.io', '0400', 'Sydney', 'Unsubscribed', 'Not recorded', 'Contacted']);
    expect(['granted', 'withdrawn', 'none'].map(x => comp.consentLabel(x))).toEqual(['Given', 'Withdrawn', 'Not recorded']);
    comp.viewing!.q = 'kim';
    comp.view(comp.viewing!.list, 'subscribed', 1, 'kim');
    req = http.expectOne(r => r.url.endsWith('/contact-lists/1/contacts') && r.params.get('status') === 'subscribed' && r.params.get('q') === 'kim');
    req.flush({ contacts: [{ id: 5, email: 'kim@shop.io', status: 'subscribed' }], page: 1, pageSize: 50, hasMore: false });
    fixture.detectChanges();
    spyOn(window, 'confirm').and.returnValue(true);
    button('Remove').click();
    const rm = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/contact-lists/1/remove'));
    expect(rm.request.body).toEqual({ contactIds: [5] });
    rm.flush({ removed: 1 });
    reload();
  });

  it('Import from Excel goes into a list here (not Leads)', () => {
    start();
    button('Import from Excel').click(); fixture.detectChanges();
    const imp = comp.importing!;
    imp.rows = [{ name: 'Kim', companyName: 'Shop', email: 'kim@shop.io', phone: '1', product: '', productId: '', estimatedBudget: '', notes: '' } as any,
      { name: 'No mail', companyName: '', email: '', phone: '', product: '', productId: '', estimatedBudget: '', notes: '' } as any];
    imp.newName = 'Fair';
    fixture.detectChanges();
    (Array.from(el().querySelectorAll('.zc-card button')).find(b => b.textContent!.trim() === 'Import') as HTMLButtonElement).click();
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/contact-lists'));
    expect(req.request.body).toEqual({ name: 'Fair', contacts: [{ name: 'Kim', company: 'Shop', email: 'kim@shop.io', phone: '1' }] });
    req.flush({ list: { id: 4, name: 'Fair' }, added: 1, alreadyIn: 0, skipped: [] });
    reload();
    fixture.detectChanges();
    expect(el().textContent).toContain('1 row(s) without an email skipped');
  });

  it('Delete asks first, then removes the list (people stay in contacts)', () => {
    start();
    button('Delete').click(); fixture.detectChanges();
    const dlg = () => el().querySelector('.zl-del-card') as HTMLElement;
    expect(dlg().textContent).toContain('the people stay in your contacts');
    (dlg().querySelector('.zl-del-go') as HTMLButtonElement).click();
    const del = http.expectOne(r => r.method === 'DELETE' && r.url.endsWith('/contact-lists/1'));
    expect(del.request.body).toEqual({ confirm: true });
    del.flush({ deleted: true });
    reload();
  });
});
