import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ContactPickerComponent, PickedContact } from './contact-picker.component';

const lead = (o: any = {}) => ({ id: 1, name: 'Priya Shah', email: 'priya@acme.io', hasValidEmail: true, companyName: 'Acme', ...o });

describe('ContactPickerComponent', () => {
  let fixture: ComponentFixture<ContactPickerComponent>;
  let comp: ContactPickerComponent;
  let http: HttpTestingController;
  let picked: PickedContact[];
  const el = () => fixture.nativeElement as HTMLElement;
  const leadsReq = (q?: string) => http.expectOne(r => r.url.includes('/leads') && r.method === 'GET' && (q === undefined || r.params.get('q') === q));

  function init(leads: any[] = [lead(), lead({ id: 2, name: 'No Mail', email: null, hasValidEmail: false, companyName: null })]): void {
    fixture = TestBed.createComponent(ContactPickerComponent);
    comp = fixture.componentInstance;
    picked = [];
    comp.picked.subscribe(c => picked.push(c));
    fixture.detectChanges();
    leadsReq('').flush({ leads });
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ContactPickerComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('lists contacts with name, email and company; contacts without email cannot be chosen; Select needs a choice', () => {
    init();
    const items = el().querySelectorAll('.cp-item');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain('priya@acme.io');
    expect(items[0].textContent).toContain('Acme');
    expect((items[1] as HTMLButtonElement).disabled).toBeTrue();
    const select = Array.from(el().querySelectorAll('button')).find(b => b.textContent!.trim() === 'Select') as HTMLButtonElement;
    expect(select.disabled).toBeTrue();
    (items[0] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(select.disabled).toBeFalse();
    select.click();
    expect(picked).toEqual([{ id: 1, name: 'Priya Shah', email: 'priya@acme.io', company: 'Acme', productId: null }]);
  });

  it('searches by the typed text (debounced) and shows empty and error states', fakeAsync(() => {
    init([]);
    expect(el().textContent).toContain('No contacts yet');
    comp.query = 'zzz';
    comp.search();
    tick(300);
    leadsReq('zzz').flush({ leads: [] });
    fixture.detectChanges();
    expect(el().textContent).toContain('No contacts match');
    comp.search(true);
    leadsReq('zzz').flush({ error: 'nope' }, { status: 403, statusText: 'x' });
    fixture.detectChanges();
    expect(el().textContent).toContain('cannot view contacts');
  }));

  it('adding a contact validates name and email before calling the server', () => {
    init([]);
    comp.openCreate();
    comp.draft = { name: '', email: 'x@y.io', company: '', assignProduct: true };
    comp.create();
    expect(comp.createError).toContain('name');
    comp.draft = { name: 'Ken', email: 'not-an-email', company: '', assignProduct: true };
    comp.create();
    expect(comp.createError).toContain('valid email');
  });

  it('an existing contact with the same email is offered instead of creating a duplicate', () => {
    init([]);
    comp.openCreate();
    comp.draft = { name: 'Priya S', email: 'PRIYA@acme.io', company: '', assignProduct: true };
    comp.create();
    leadsReq('PRIYA@acme.io').flush({ leads: [lead()] });
    http.expectNone(r => r.method === 'POST');
    fixture.detectChanges();
    expect(el().textContent).toContain('already uses this email address');
    comp.useExisting(comp.duplicate);
    expect(picked[0].id).toBe(1);
  });

  it('a same-name contact asks once; "create anyway" creates through the Leads API and selects the new contact', () => {
    init([]);
    comp.openCreate();
    comp.draft = { name: 'Priya Shah', email: 'priya.new@acme.io', company: 'Acme 2', assignProduct: true };
    comp.create();
    leadsReq('priya.new@acme.io').flush({ leads: [] });
    leadsReq('Priya Shah').flush({ leads: [lead()] });
    http.expectNone(r => r.method === 'POST');
    expect(comp.sameName).toBeTruthy();
    comp.createAnyway();
    leadsReq('priya.new@acme.io').flush({ leads: [] });
    leadsReq('Priya Shah').flush({ leads: [lead()] });
    const post = http.expectOne(r => r.method === 'POST' && r.url.includes('/leads'));
    expect(post.request.body).toEqual({ name: 'Priya Shah', email: 'priya.new@acme.io', companyName: 'Acme 2' });
    expect(post.request.body.marketingConsent).toBeUndefined();
    post.flush({ lead: { id: 77, name: 'Priya Shah', email: 'priya.new@acme.io', companyName: 'Acme 2' } });
    expect(picked).toEqual([{ id: 77, name: 'Priya Shah', email: 'priya.new@acme.io', company: 'Acme 2', productId: null }]);
  });

  it('a failed creation shows the server message and selects nothing', () => {
    init([]);
    comp.openCreate();
    comp.draft = { name: 'Ken', email: 'ken@ito.jp', company: '', assignProduct: true };
    comp.create();
    leadsReq('ken@ito.jp').flush({ leads: [] });
    leadsReq('Ken').flush({ leads: [] });
    http.expectOne(r => r.method === 'POST').flush({ error: 'Your role cannot add leads.' }, { status: 403, statusText: 'x' });
    fixture.detectChanges();
    expect(el().textContent).toContain('cannot add contacts');
    expect(picked.length).toBe(0);
  });

  it('a typed address is a separate, explicit choice and is validated', () => {
    init([]);
    comp.allowManual = true;
    const manual: any[] = [];
    comp.manual.subscribe(m => manual.push(m));
    comp.mode = 'manual';
    comp.manualForm = { name: 'X', email: 'bad' };
    comp.useManual();
    expect(manual.length).toBe(0);
    comp.manualForm = { name: 'X', email: 'x@y.io' };
    comp.useManual();
    expect(manual).toEqual([{ name: 'X', email: 'x@y.io' }]);
  });

  it('without the leads.manage capability, Add New Contact is disabled', () => {
    init([]);
    comp.canCreate = false;
    fixture.detectChanges();
    const add = Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes('Add New Contact')) as HTMLButtonElement;
    expect(add.disabled).toBeTrue();
  });
  // ---- product-aware selection ----
  function initFiltered(productId: number | null, leads: any[]): void {
    fixture = TestBed.createComponent(ContactPickerComponent);
    comp = fixture.componentInstance;
    comp.products = [{ id: 7, name: 'BusTrack' }, { id: 8, name: 'FleetPro' }];
    comp.productId = productId;
    picked = [];
    comp.picked.subscribe(c => picked.push(c));
    fixture.detectChanges();
    const req = leadsReq('');
    if (productId === null) expect(req.request.params.has('productId')).toBeFalse();
    else expect(req.request.params.get('productId')).toBe(String(productId));
    req.flush({ leads });
    fixture.detectChanges();
  }

  it('starts filtered by the given product (Leads CRM productId filter) and refreshes when the filter changes', () => {
    initFiltered(7, [lead({ productId: 7 })]);
    expect(el().textContent).toContain('Showing contacts linked to BusTrack');
    comp.setProductFilter('all');
    const all = leadsReq('');
    expect(all.request.params.has('productId')).toBeFalse();
    all.flush({ leads: [lead({ productId: 7 }), lead({ id: 3, name: 'Fleet Person', email: 'f@fleet.io', productId: 8 })] });
    fixture.detectChanges();
    expect(el().querySelectorAll('.cp-item')[1].textContent).toContain('FleetPro');
    comp.setProductFilter('none');
    expect(leadsReq('').request.params.get('productId')).toBe('none');
  });

  it('search keeps the product filter, and the choice is cleared when the filter changes', fakeAsync(() => {
    initFiltered(7, [lead({ productId: 7 })]);
    (el().querySelector('.cp-item') as HTMLButtonElement).click();
    expect(comp.choice).toBeTruthy();
    comp.query = 'priya';
    comp.search();
    tick(300);
    const req = leadsReq('priya');
    expect(req.request.params.get('productId')).toBe('7');
    req.flush({ leads: [lead({ productId: 7 })] });
    comp.setProductFilter(8);
    expect(comp.choice).toBeNull();
    leadsReq('priya').flush({ leads: [] });
    fixture.detectChanges();
    expect(el().textContent).toContain('for this product');
  }));

  it('explains why a contact cannot be chosen (placeholder, invalid, missing) and warns when none can be', () => {
    initFiltered(null, [
      lead({ id: 1, email: 'a@example.com', hasValidEmail: false, emailIssue: 'placeholder' }),
      lead({ id: 2, email: 'bad@@x', hasValidEmail: false, emailIssue: 'invalid' }),
      lead({ id: 3, email: null, hasValidEmail: false, emailIssue: 'missing' })
    ]);
    const items = Array.from(el().querySelectorAll('.cp-item')) as HTMLButtonElement[];
    expect(items.every(i => i.disabled)).toBeTrue();
    expect(items[0].textContent).toContain('placeholder address');
    expect(items[1].textContent).toContain('not a valid email address');
    expect(items[2].textContent).toContain('No email address');
    expect(el().textContent).toContain('none can be selected');
    comp.choose(comp.results[0]);
    expect(comp.choice).toBeNull();
    const select = Array.from(el().querySelectorAll('button')).find(b => b.textContent!.trim() === 'Select') as HTMLButtonElement;
    expect(select.disabled).toBeTrue();
  });

  it('a valid contact is chosen with Enter, emitted once, with its product', () => {
    initFiltered(7, [lead({ productId: 7 })]);
    const item = el().querySelector('.cp-item') as HTMLButtonElement;
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    comp.confirm();
    expect(picked).toEqual([{ id: 1, name: 'Priya Shah', email: 'priya@acme.io', company: 'Acme', productId: 7 }]);
  });

  it('Add New Contact links the filtered product through the Leads API only when asked', () => {
    initFiltered(7, []);
    comp.openCreate();
    fixture.detectChanges();
    expect(el().textContent).toContain('Link this contact to BusTrack');
    comp.draft = { name: 'Ken', email: 'ken@ito.jp', company: '', assignProduct: true };
    comp.create();
    leadsReq('ken@ito.jp').flush({ leads: [] });
    leadsReq('Ken').flush({ leads: [] });
    let post = http.expectOne(r => r.method === 'POST');
    expect(post.request.body.productId).toBe(7);
    post.flush({ error: 'x' }, { status: 500, statusText: 'x' });
    comp.draft = { name: 'Ken', email: 'ken@ito.jp', company: '', assignProduct: false };
    comp.create();
    leadsReq('ken@ito.jp').flush({ leads: [] });
    leadsReq('Ken').flush({ leads: [] });
    post = http.expectOne(r => r.method === 'POST');
    expect(post.request.body.productId).toBeUndefined();
    post.flush({ error: 'x' }, { status: 500, statusText: 'x' });
  });
});
