import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CampaignContactsComponent } from './campaign-contacts.component';

describe('CampaignContactsComponent', () => {
  let fixture: ComponentFixture<CampaignContactsComponent>;
  let comp: CampaignContactsComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (t: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes(t)) as HTMLButtonElement;
  const rowCheck = () => el().querySelector('.cc-check input') as HTMLInputElement;
  const selectAll = () => el().querySelector('.cc-all input') as HTMLInputElement;
  const rowBox = (i: number) => el().querySelectorAll('tbody input')[i] as HTMLInputElement;
  const SELECTED = { contacts: [
    { id: 1, leadId: 7, email: 'a@client.io', name: 'Ann', source: 'lead', eligible: true, reasons: [] },
    { id: 2, leadId: null, email: 'z@client.io', name: null, source: 'zoho_list', sourceListKey: 'L1', eligible: false, reasons: ['Unsubscribed, bounced or invalid'] }
  ], total: 2, eligible: 1, max: 1000 };
  const LEADS = {
    leads: [
      { id: 7, name: 'Ann', email: 'a@client.io', company: 'Acme', eligible: true, reasons: [] },
      { id: 8, name: 'Bo', email: 'b@client.io', company: null, eligible: true, reasons: [] },
      { id: 9, name: 'Cy', email: 'c@client.io', company: null, eligible: false, reasons: ['Marketing consent not recorded'] }
    ],
    total: 3, eligibleIds: [7, 8, 99], truncated: false
  };

  function create(editable = true): void {
    fixture = TestBed.createComponent(CampaignContactsComponent);
    comp = fixture.componentInstance;
    fixture.componentRef.setInput('campaignId', 5);
    fixture.componentRef.setInput('editable', editable);
    fixture.detectChanges();
    http.expectOne(r => r.method === 'GET' && r.url.endsWith('/campaigns/5/contacts')).flush(SELECTED);
    fixture.detectChanges();
  }

  function openPicker(): void {
    button('Choose leads').click();
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/lead-options')).flush(LEADS);
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [CampaignContactsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('lists the selection, with the reason a contact will be skipped', () => {
    create();
    expect(el().textContent).toContain('2 selected');
    expect(el().textContent).toContain('1 can be emailed');
    expect(el().textContent).toContain('Will be skipped: Unsubscribed, bounced or invalid');
    expect(el().textContent).toContain('Added to a new Zoho list automatically when you send.');
  });

  it('a contact picked from a Zoho list belongs to that list\'s row, not to Leads', () => {
    create();
    let sent: any[] = [];
    comp.contactsChange.subscribe(l => sent = l);
    fixture.componentRef.setInput('zohoLists', [{ key: 'L1', name: 'Customers' }]);
    fixture.detectChanges();
    expect(el().textContent).toContain('(1 selected)');
    expect(el().textContent).not.toContain('z@client.io');
    spyOn(window, 'confirm').and.returnValue(true);
    rowCheck().click();
    const req = http.expectOne(r => r.url.endsWith('/contacts/remove'));
    expect(req.request.body).withContext('only the Leads row is cleared').toEqual({ ids: [1] });
    req.flush({ ...SELECTED, campaign: { id: 5 } });
    expect(sent.length).toBe(2);
  });

  it('with only Zoho picks the Leads row stays unticked', () => {
    create();
    fixture.componentRef.setInput('zohoLists', [{ key: 'L1', name: 'Customers' }]);
    comp.apply({ contacts: [SELECTED.contacts[1]], eligible: 0 });
    fixture.detectChanges();
    expect(rowCheck().checked).toBeFalse();
  });

  it('is read-only once the campaign cannot change', () => {
    create(false);
    expect(el().textContent).toContain('a@client.io');
    expect(button('Choose leads')).toBeUndefined();
    expect(el().querySelector('.cc-remove')).toBeNull();
  });

  it('asks to reconnect when the Zoho connection cannot add contacts', () => {
    create();
    let asked = 0;
    comp.reconnect.subscribe(() => asked++);
    fixture.componentRef.setInput('canSync', false);
    fixture.componentRef.setInput('canReconnect', true);
    fixture.detectChanges();
    button('Reconnect Zoho').click();
    expect(asked).toBe(1);
  });

  it('opens with the selected leads ticked; a lead that cannot be emailed cannot be ticked', () => {
    create();
    openPicker();
    expect(rowBox(0).checked).toBeTrue();
    expect(rowBox(1).checked).toBeFalse();
    expect(rowBox(2).disabled).toBeTrue();
    expect(el().textContent).toContain('Marketing consent not recorded');
  });

  it('Select all takes every lead that can be emailed on all pages, and toggles back off', () => {
    create();
    openPicker();
    expect(selectAll().indeterminate).toBeTrue();
    selectAll().click();
    fixture.detectChanges();
    expect(selectAll().checked).toBeTrue();
    expect([...comp.chosen].sort()).toEqual([7, 8, 99]);
    expect(el().textContent).toContain('3 selected');
    selectAll().click();
    fixture.detectChanges();
    expect(comp.chosen.size).toBe(0);
  });

  it('Save selection stores the leads and reports the changed campaign', () => {
    create();
    openPicker();
    rowBox(1).click();
    let campaign: any = null;
    let toast = '';
    comp.changed.subscribe(c => campaign = c);
    comp.toast.subscribe(t => toast = t);
    button('Save selection').click();
    const req = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/campaigns/5/contacts/leads'));
    expect(req.request.body).toEqual({ leadIds: [7, 8] });
    req.flush({ ...SELECTED, added: 2, refused: 0, campaign: { id: 5, status: 'draft', version: 2 } });
    fixture.detectChanges();
    expect(campaign.version).toBe(2);
    expect(toast).toContain('Approve the campaign before sending');
    expect(el().querySelector('[role=dialog]')).toBeNull();
  });

  it('the row checkbox opens the picker when empty', () => {
    create();
    comp.apply({ contacts: [], eligible: 0 });
    fixture.detectChanges();
    expect(rowCheck().checked).toBeFalse();
    rowCheck().click();
    fixture.detectChanges();
    expect(rowCheck().checked).withContext('ticked only once contacts are saved').toBeFalse();
    http.expectOne(r => r.url.endsWith('/lead-options')).flush(LEADS);
    fixture.detectChanges();
    expect(el().querySelector('[role=dialog]')).toBeTruthy();
  });

  it('removing a contact and unticking the row (after confirming) use the server', () => {
    spyOn(window, 'confirm').and.returnValue(false);
    create();
    (el().querySelector('.cc-remove') as HTMLButtonElement).click();
    const one = http.expectOne(r => r.url.endsWith('/contacts/remove'));
    expect(one.request.body).toEqual({ ids: [1] });
    one.flush({ ...SELECTED, campaign: { id: 5 } });
    fixture.detectChanges();
    rowCheck().click();
    expect(rowCheck().checked).withContext('stays ticked after Cancel').toBeTrue();
    http.expectNone(r => r.url.endsWith('/contacts/remove'));
    (window.confirm as jasmine.Spy).and.returnValue(true);
    rowCheck().click();
    const all = http.expectOne(r => r.url.endsWith('/contacts/remove'));
    expect(all.request.body).toEqual({ ids: [1, 2] });
    all.flush({ contacts: [], total: 0, eligible: 0, campaign: { id: 5 } });
  });

  it('search and the filter ask the server, and a late answer cannot replace a newer one', () => {
    create();
    openPicker();
    button('Can be emailed').click();
    const slow = http.expectOne(r => r.url.endsWith('/lead-options') && r.params.get('eligibility') === 'eligible');
    button('Cannot be emailed').click();
    http.expectOne(r => r.params.get('eligibility') === 'ineligible').flush({ leads: [], total: 0, eligibleIds: [] });
    slow.flush(LEADS);
    fixture.detectChanges();
    expect(comp.leads.length).toBe(0);
    expect(el().textContent).toContain('No leads match.');
  });
});
