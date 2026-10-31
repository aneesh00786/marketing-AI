import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ZohoListContactsComponent } from './zoho-list-contacts.component';

describe('ZohoListContactsComponent', () => {
  let fixture: ComponentFixture<ZohoListContactsComponent>;
  let comp: ZohoListContactsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (t: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes(t)) as HTMLButtonElement;
  const contacts = () => http.expectOne(r => r.url.endsWith('/mail/campaigns/audiences/L%2F1/contacts'));

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ZohoListContactsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ZohoListContactsComponent);
    comp = fixture.componentInstance;
    comp.listKey = 'L/1';
    comp.listName = 'Customers';
    comp.total = 120;
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('shows the contacts in a read-only table, with — for missing details', () => {
    contacts().flush({ contacts: [{ email: 'kim@client.io', name: 'Kim Lee', company: 'Acme', phone: '+1 555' }, { email: 'x@client.io', name: null, company: null, phone: null }], page: 1, hasMore: false });
    fixture.detectChanges();
    const cells = (i: number) => Array.from(el().querySelectorAll('tbody tr')[i].querySelectorAll('td')).map(c => c.textContent!.trim());
    expect(cells(0)).toEqual(['kim@client.io', 'Kim Lee', 'Acme', '+1 555']);
    expect(cells(1)).toEqual(['x@client.io', '—', '—', '—']);
    expect(el().textContent).toContain('120 in this list');
    expect(el().textContent).toContain('Read-only');
    expect(el().querySelector('input, [contenteditable]')).toBeNull();
  });

  it('filters by status and pages through the list', () => {
    contacts().flush({ contacts: [{ email: 'a@b.io' }], page: 1, hasMore: true });
    fixture.detectChanges();
    button('Next').click();
    expect(contacts().request.params.get('page')).toBe('2');
    button('Unsubscribed').click();
    const req = contacts();
    expect([req.request.params.get('status'), req.request.params.get('page')]).toEqual(['unsubscribed', '1']);
    req.flush({ contacts: [], page: 1, hasMore: false });
    fixture.detectChanges();
    expect(el().textContent).toContain('No unsubscribed contacts in this list.');
  });

  it('shows Zoho errors with a retry; Escape and the backdrop close it', () => {
    contacts().flush({ error: 'Zoho: limit reached' }, { status: 429, statusText: 'x' });
    fixture.detectChanges();
    expect(el().querySelector('[role=alert]')!.textContent).toContain('limit reached');
    button('Try again').click();
    contacts().flush({ contacts: [], page: 1, hasMore: false });
    let closed = 0;
    comp.closed.subscribe(() => closed++);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    (el().querySelector('.zc-backdrop') as HTMLElement).click();
    expect(closed).toBe(2);
  });

  describe('selecting contacts for a campaign', () => {
    const PAGE = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `c${i}@client.io` }));
    const boxes = () => Array.from(el().querySelectorAll('tbody input')) as HTMLInputElement[];
    const selectAll = () => el().querySelector('.zc-all input') as HTMLInputElement;
    const open = () => {
      comp.selectable = true;
      comp.campaignId = 5;
      contacts().flush({ contacts: PAGE(3), page: 1, hasMore: true });
      fixture.detectChanges();
    };

    it('stays read-only unless selecting is allowed', () => {
      contacts().flush({ contacts: PAGE(2), page: 1, hasMore: false });
      fixture.detectChanges();
      expect(el().querySelector('input')).toBeNull();
      expect(button('Add to campaign')).toBeUndefined();
    });

    it('Select all ticks this page and toggles back off; ticks are kept per page', () => {
      open();
      selectAll().click();
      fixture.detectChanges();
      expect(boxes().every(b => b.checked)).toBeTrue();
      expect(el().textContent).toContain('3 selected');
      button('Next').click();
      contacts().flush({ contacts: [{ email: 'next@client.io' }], page: 2, hasMore: false });
      fixture.detectChanges();
      expect(selectAll().checked).toBeFalse();
      boxes()[0].click();
      fixture.detectChanges();
      expect(el().textContent).toContain('4 selected');
      button('Previous').click();
      contacts().flush({ contacts: PAGE(3), page: 1, hasMore: true });
      fixture.detectChanges();
      expect(selectAll().checked).toBeTrue();
      selectAll().click();
      fixture.detectChanges();
      expect(el().textContent).toContain('1 selected');
    });

    it('contacts already on the campaign show ticked and are not sent again', () => {
      comp.selectedContacts = [{ email: 'C0@client.io' }];
      open();
      expect(boxes()[0].checked).toBeTrue();
      expect(boxes()[0].disabled).toBeTrue();
      selectAll().click();
      fixture.detectChanges();
      expect(selectAll().checked).toBeTrue();
      button('Add to campaign').click();
      const req = http.expectOne(r => r.method === 'POST');
      expect(req.request.body.pages[0].emails).toEqual(['c1@client.io', 'c2@client.io']);
      req.flush({ added: 2, refused: 0, contacts: [], campaign: { id: 5 } });
    });

    it('only subscribed contacts can be selected', () => {
      open();
      button('Bounced').click();
      contacts().flush({ contacts: PAGE(2), page: 1, hasMore: false });
      fixture.detectChanges();
      expect(el().querySelector('tbody input')).toBeNull();
    });

    it('Add to campaign sends the pages to verify, then reports back and closes', () => {
      open();
      boxes()[1].click();
      fixture.detectChanges();
      let result: any = null;
      let closed = 0;
      comp.added.subscribe(r => result = r);
      comp.closed.subscribe(() => closed++);
      button('Add to campaign').click();
      const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/campaigns/5/contacts/zoho'));
      expect(req.request.body).toEqual({ listKey: 'L/1', pages: [{ page: 1, emails: ['c1@client.io'] }] });
      req.flush({ added: 1, refused: 0, contacts: [], campaign: { id: 5 } });
      expect(result.added).toBe(1);
      expect(closed).toBe(1);
    });

    it('a refused addition is shown and the window stays open', () => {
      open();
      boxes()[0].click();
      fixture.detectChanges();
      button('Add to campaign').click();
      http.expectOne(r => r.method === 'POST').flush({ error: 'A campaign can have up to 1000 selected contacts.' }, { status: 400, statusText: 'x' });
      fixture.detectChanges();
      expect(el().querySelector('[role=alert]')!.textContent).toContain('up to 1000');
    });
  });
});
