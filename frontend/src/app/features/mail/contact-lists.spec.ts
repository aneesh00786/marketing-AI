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
    { id: 1, name: 'Compiled B2B Oct 26', source: 'zoho', inZoho: true, total: 7380, reachable: 7219 },
    { id: 2, name: 'Sydney buyers', source: 'local', inZoho: false, total: 3, reachable: 3 }
  ];
  const SYNC = { status: 'succeeded', result: { lists: 4, contacts: 7387 } };

  function start(o: Partial<ContactListsComponent> = {}): void {
    TestBed.configureTestingModule({ imports: [ContactListsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ContactListsComponent);
    comp = fixture.componentInstance;
    Object.assign(comp, { zohoReady: true, canManage: true, canConfigure: true, ...o });
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/contact-lists')).flush({ lists: structuredClone(LISTS), contacts: 7390, sync: SYNC });
    if (comp.zohoReady) http.expectOne(r => r.url.endsWith('/zoho-lists')).flush({ lists: [], plan: { contactLimit: 10000, usage: { upTo: 7227, atLeast: 7219 } } });
    fixture.detectChanges();
  }
  const reload = () => http.expectOne(r => r.method === 'GET' && r.url.endsWith('/contact-lists')).flush({ lists: structuredClone(LISTS), contacts: 7390, sync: SYNC });
  afterEach(() => http.verify());

  it('shows the lists from Marketech.ai with counts, the one-time copy from Zoho, and which are also in Zoho', () => {
    start();
    expect(el().querySelector('.cl-sync')!.textContent).toContain('Copied 7,387 contacts from 4 Zoho list(s) when Zoho was connected');
    const rows = Array.from(el().querySelectorAll('.cl-row:not(.zl-th)'));
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Also in Zoho');
    expect(rows[0].textContent).toContain('7,380');
    expect(rows[1].textContent).not.toContain('Also in Zoho');
    expect(el().querySelector('.zl-plan')!.textContent).toContain('Contacts in Zoho: up to 7,227 of 10,000');
  });

  it('while the copy from Zoho runs, the lists are checked again until it is done', fakeAsync(() => {
    TestBed.configureTestingModule({ imports: [ContactListsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ContactListsComponent);
    comp = fixture.componentInstance;
    Object.assign(comp, { zohoReady: false, canManage: true });
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/contact-lists')).flush({ lists: [], contacts: 0, sync: { status: 'running' } });
    fixture.detectChanges();
    expect(el().querySelector('.cl-sync')!.textContent).toContain('Copying your Zoho lists');
    tick(3000);
    http.expectOne(r => r.url.endsWith('/contact-lists')).flush({ lists: structuredClone(LISTS), contacts: 7390, sync: SYNC });
    fixture.detectChanges();
    expect(el().querySelectorAll('.cl-row:not(.zl-th)').length).toBe(2);
    tick(10000);
    http.expectNone(r => r.url.endsWith('/contact-lists'));
  }));

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

  it('View contacts: status tabs, search, details and lead status; remove one', () => {
    start();
    button('View contacts').click(); fixture.detectChanges();
    let req = http.expectOne(r => r.url.endsWith('/contact-lists/1/contacts'));
    expect(req.request.params.get('status')).toBe('all');
    req.flush({ contacts: [{ id: 5, email: 'kim@shop.io', name: 'Kim Lee', company: 'Shop', phone: '0400', location: 'Sydney', status: 'unsubscribed', leadStatus: 'Contacted' }], page: 1, pageSize: 50, hasMore: false });
    fixture.detectChanges();
    const cells = Array.from(el().querySelectorAll('.zl-ctable tbody td')).map(td => td.textContent!.trim());
    expect(cells.slice(0, 8)).toEqual(['1', 'Kim Lee', 'Shop', 'kim@shop.io', '0400', 'Sydney', 'Unsubscribed', 'Contacted']);
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

  it('Delete: a list also in Zoho offers here / Zoho only / both (Zoho options for admins only)', () => {
    start({ canConfigure: false });
    button('Delete').click(); fixture.detectChanges();
    const dlg = () => el().querySelector('.zl-del-card') as HTMLElement;
    expect(dlg().textContent).toContain('Delete in Zoho only');
    expect((dlg().querySelector('input[value=zoho]') as HTMLInputElement).disabled).toBeTrue();
    expect(dlg().textContent).toContain('Only an Owner or Admin');
    comp.canConfigure = true; fixture.detectChanges();
    comp.deleting!.where = 'zoho';
    (dlg().querySelector('.zl-del-go') as HTMLButtonElement).click();
    const del = http.expectOne(r => r.method === 'DELETE' && r.url.endsWith('/contact-lists/1'));
    expect(del.request.body).toEqual({ where: 'zoho', confirm: true });
    del.flush({ deleted: true, where: 'zoho' });
    reload();
    // A list only here: one plain option.
    comp.openDelete(comp.lists[1]); fixture.detectChanges();
    expect(dlg().querySelector('input[value=zoho]')).toBeNull();
    expect(dlg().textContent).toContain('Delete this list');
  });
});
