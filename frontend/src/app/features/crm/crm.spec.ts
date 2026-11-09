import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CrmComponent } from './crm.component';
import { CrmActivitiesComponent } from './crm-activities.component';
import { CrmCompaniesComponent } from './crm-companies.component';
import { CrmContactsComponent } from './crm-contacts.component';
import { CrmCallsComponent } from './crm-calls.component';
import { CrmDealsComponent } from './crm-deals.component';
import { CrmOverviewComponent } from './crm-overview.component';
import { CrmSupportComponent } from './crm-support.component';
import { crmSectionFromLink, statusTone } from './crm-api.service';
import { COUNTRY_CODES, CrmPhoneInputComponent, splitPhone, phoneProblem } from './crm-phone-input.component';

describe('Global CRM', () => {
  let http: HttpTestingController;
  const TEAM = { team: [{ id: 3, name: 'Sam' }] };
  const url = (s: string, method = 'GET') => http.expectOne(r => r.method === method && r.url.endsWith(`/api/v1/global-crm${s}`));

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [CrmComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  function make<T>(type: new (...a: any[]) => T, inputs: Record<string, any> = {}): { f: ComponentFixture<T>; c: T; el: HTMLElement } {
    const f = TestBed.createComponent(type);
    for (const [k, v] of Object.entries(inputs)) f.componentRef.setInput(k, v);
    f.detectChanges();
    return { f, c: f.componentInstance, el: f.nativeElement };
  }
  const button = (el: HTMLElement, t: string) => Array.from(el.querySelectorAll('button')).find(b => b.textContent!.includes(t)) as HTMLButtonElement;

  it('deep links and tag tones', () => {
    expect(crmSectionFromLink('crm', 'support')).toBe('support');
    expect(crmSectionFromLink('crm', 'nope')).toBe('dashboard');
    expect(crmSectionFromLink('mail', 'deals')).toBeNull();
    expect(['Won', 'Lost', 'High', 'In Progress', 'Open', 'Closed'].map(statusTone)).toEqual(['good', 'bad', 'bad', 'warn', 'info', '']);
  });

  describe('phone input', () => {
    const input = (el: HTMLElement) => el.querySelector('input') as HTMLInputElement;
    const select = (el: HTMLElement) => el.querySelector('select') as HTMLSelectElement;

    it('splits saved numbers by country code, the longest code first', () => {
      expect(splitPhone('+91 98765 43210')).toEqual({ code: '91', number: '98765 43210' });
      expect(splitPhone('+1 (555) 010-0100')).toEqual({ code: '1', number: '(555) 010-0100' });
      expect(splitPhone('+18685550100')).toEqual({ code: '1868', number: '5550100' });
      expect(splitPhone('+971501234567').code).toBe('971');
      expect(splitPhone('')).toEqual({ code: '', number: '' }, 'no country is assumed');
      expect(splitPhone('0412 345 678')).toEqual({ code: '', number: '0412 345 678' });
      expect(splitPhone(null).code).toBe('');
    });

    it('lists every country once, with India and the common codes present', () => {
      const names = COUNTRY_CODES.map(c => c.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names.length).toBeGreaterThan(190);
      const code = (n: string) => COUNTRY_CODES.find(c => c.name === n)!.code;
      expect([code('India'), code('United States'), code('United Kingdom'), code('United Arab Emirates'), code('Australia')]).toEqual(['91', '1', '44', '971', '61']);
      expect(COUNTRY_CODES.every(c => /^[1-9]\d{0,3}$/.test(c.code))).toBeTrue();
    });

    it('needs a country code: none is assumed; a typed +code fills the picker; joins code and number', fakeAsync(() => {
      const { f, c, el } = make(CrmPhoneInputComponent, { value: '' });
      tick();
      f.detectChanges();
      let out: string | null = null;
      c.valueChange.subscribe(v => out = v);
      expect(c.code).toBe('');
      input(el).value = '98765 43210';
      input(el).dispatchEvent(new Event('input'));
      f.detectChanges();
      expect(out as any).toBe('98765 43210');
      expect(phoneProblem(out)).toContain('country code');
      expect(el.textContent).toContain('Choose the country code');
      select(el).value = '91';
      select(el).dispatchEvent(new Event('change'));
      expect(out as any).toBe('+91 98765 43210');
      expect(phoneProblem(out)).toBe('');
      input(el).value = '+61 412 345 678';
      input(el).dispatchEvent(new Event('input'));
      expect(c.code).toBe('61');
      expect(out as any).toBe('+61 412 345 678');
      select(el).value = '971';
      select(el).dispatchEvent(new Event('change'));
      expect(out as any).toBe('+971 412 345 678');
      input(el).value = '  ';
      input(el).dispatchEvent(new Event('input'));
      expect(out as any).toBe('');
    }));

    it('opens a saved number on its own country code', fakeAsync(() => {
      const { f, c, el } = make(CrmPhoneInputComponent, { value: '+44 20 7946 0958' });
      tick();
      f.detectChanges();
      tick();
      expect([c.code, c.number]).toEqual(['44', '20 7946 0958']);
      expect(select(el).value).toBe('44');
      expect(el.querySelector('.cp-shown')!.textContent).toBe('+44');
      expect(input(el).value).toBe('20 7946 0958');
    }));

    it('the contact and company forms use it', () => {
      const m = make(CrmContactsComponent, { canManage: true });
      http.expectOne(r => r.url.endsWith('/global-crm/contacts')).flush({ contacts: [], total: 0, statuses: ['Prospect'] });
      url('/team').flush(TEAM);
      m.c.openForm();
      m.f.detectChanges();
      http.expectOne(r => r.url.endsWith('/global-crm/companies')).flush({ companies: [] });
      expect(m.el.querySelector('[role=dialog] app-crm-phone-input')).toBeTruthy();
      const co = make(CrmCompaniesComponent, { canManage: true });
      url('/companies').flush({ companies: [], truncated: false });
      co.c.openForm();
      co.f.detectChanges();
      expect(co.el.querySelector('[role=dialog] app-crm-phone-input')).toBeTruthy();
    });
  });

  describe('page', () => {
    it('without a grant it says so and asks the server for nothing', () => {
      const { el } = make(CrmComponent, { access: null });
      expect(el.textContent).toContain('You do not have access to the CRM');
      expect(el.querySelector('[role=tablist]')).toBeNull();
    });

    it('sections are tabs; a viewer gets no write actions', () => {
      const { f, c, el } = make(CrmComponent, { access: { role: 'viewer', capabilities: ['crm.view'] } });
      url('/overview').flush({ totalContacts: 0, totalCompanies: 0, activeDeals: 0, pipelineValue: 0, openTickets: 0, recentActivities: [] });
      f.detectChanges();
      expect(Array.from(el.querySelectorAll('[role=tab]')).map(t => t.textContent!.trim())).toEqual(['Dashboard', 'Contacts', 'Companies', 'Deals', 'Support', 'Calls']);
      let section = '';
      c.sectionChange.subscribe(s => section = s);
      button(el, 'Support').click();
      f.detectChanges();
      expect(section).toBe('support');
      http.expectOne(r => r.url.endsWith('/global-crm/tickets')).flush({ tickets: [], statuses: [], priorities: [], truncated: false });
      url('/team').flush(TEAM);
      f.detectChanges();
      expect(button(el, 'New ticket')).toBeUndefined();
    });

    it('activity on the dashboard opens its record', () => {
      const { f, c } = make(CrmComponent, { access: { role: 'manager', capabilities: ['crm.view', 'crm.support'] } });
      url('/overview').flush({ totalContacts: 0, totalCompanies: 0, activeDeals: 0, pipelineValue: 0, openTickets: 0, recentActivities: [] });
      c.openActivity({ ticketId: 7 });
      f.detectChanges();
      url('/tickets/7').flush({ ticket: { id: 7, subject: 'Login', description: 'x', status: 'Open', priority: 'High' } });
      http.expectOne(r => r.url.endsWith('/global-crm/tickets')).flush({ tickets: [], statuses: ['Open'], priorities: ['High'], truncated: false });
      url('/team').flush(TEAM);
      f.detectChanges();
      url('/tickets/7/activities').flush({ activities: [] });
      expect(c.section).toBe('support');
    });
  });

  describe('dashboard', () => {
    it('shows real figures including open tickets', () => {
      const { f, c, el } = make(CrmOverviewComponent);
      url('/overview').flush({ totalContacts: 1200, totalCompanies: 40, activeDeals: 3, pipelineValue: 2500.5, openTickets: 6, recentActivities: [{ id: 1, type: 'change', body: 'Status changed', ticketId: 9, subject: 'Login', createdBy: null, createdAt: '2026-10-01T10:00:00Z' }] });
      f.detectChanges();
      for (const t of ['1,200', '40', '2,500.5', 'Open tickets', 'Update', 'Former team member']) expect(el.textContent).toContain(t);
      let opened: any = null;
      c.openRecord.subscribe(a => opened = a);
      button(el, 'Login').click();
      expect(opened.ticketId).toBe(9);
    });

    it('shows an empty state, and errors offer a retry', () => {
      const { f, el } = make(CrmOverviewComponent);
      url('/overview').flush({ error: 'Down' }, { status: 500, statusText: 'x' });
      f.detectChanges();
      expect(el.querySelector('[role=alert]')!.textContent).toContain('Down');
      button(el, 'Try again').click();
      url('/overview').flush({ totalContacts: 0, totalCompanies: 0, activeDeals: 0, pipelineValue: 0, openTickets: 0, recentActivities: [] });
      f.detectChanges();
      expect(el.querySelector('.mx-empty')!.textContent).toContain('No activity yet');
    });
  });

  describe('contacts', () => {
    const ANN = { id: 9, fullName: 'Ann Lee', email: 'ann@client.io', phone: '555', companyId: 4, companyName: 'Acme', status: 'Customer', assignedTo: 3, assigneeName: 'Sam', notes: 'Hello', createdAt: '2026-10-01T10:00:00Z' };
    const STATUSES = ['Prospect', 'Customer', 'Inactive'];
    const start = (inputs: any = { canManage: true, canDeals: true, canSupport: true }) => {
      const m = make(CrmContactsComponent, inputs);
      http.expectOne(r => r.url.endsWith('/global-crm/contacts')).flush({ contacts: [ANN], total: 1, statuses: STATUSES });
      url('/team').flush(TEAM);
      m.f.detectChanges();
      return m;
    };
    const openForm = (m: any) => {
      button(m.el, 'New contact').click();
      http.expectOne(r => r.url.endsWith('/global-crm/companies')).flush({ companies: [{ id: 4, name: 'Acme' }] });
      m.f.detectChanges();
    };

    it('lists contacts, and search asks the server once typing stops', fakeAsync(() => {
      const { f, c, el } = start();
      expect(el.textContent).toContain('ann@client.io');
      c.q = 'an';
      c.onSearch();
      c.q = 'ann';
      c.onSearch();
      tick(300);
      const req = http.expectOne(r => r.url.endsWith('/global-crm/contacts'));
      expect(req.request.params.get('q')).toBe('ann');
      req.flush({ contacts: [], total: 0, statuses: STATUSES });
      f.detectChanges();
      expect(el.textContent).toContain('No contacts match.');
    }));

    it('a possible duplicate is shown; the user can open it or save anyway', () => {
      const m = start();
      openForm(m);
      m.c.form.fullName = 'Bo';
      m.c.form.email = 'ann@client.io';
      m.c.save();
      url('/contacts', 'POST').flush({ error: 'x', code: 'DUPLICATE_CONTACT', details: { matches: [{ id: 9, fullName: 'Ann Lee', email: 'ann@client.io' }] } }, { status: 409, statusText: 'x' });
      m.f.detectChanges();
      expect(m.el.querySelector('[role=dialog]')!.textContent).toContain('Ann Lee');
      button(m.el, 'Save anyway').click();
      const req = url('/contacts', 'POST');
      expect(req.request.body.allowDuplicate).toBeTrue();
      req.flush({ contact: { id: 10 }, deals: [], tickets: [] });
      http.expectOne(r => r.url.endsWith('/global-crm/contacts')).flush({ contacts: [], total: 0, statuses: STATUSES });
      m.f.detectChanges();
      expect(m.el.querySelector('[role=dialog]')).toBeNull();
    });

    it('a name is required, and other refusals are shown in the form', () => {
      const m = start();
      openForm(m);
      m.c.save();
      expect(m.c.formError).toBe('Enter a name.');
      m.c.form.fullName = 'Bo';
      m.c.save();
      url('/contacts', 'POST').flush({ error: 'Enter a valid email address.' }, { status: 400, statusText: 'x' });
      expect(m.c.formError).toContain('valid email');
    });

    it('the detail page shows deals, tickets and activity, and has no email action', () => {
      const m = start();
      button(m.el, 'Ann Lee').click();
      url('/contacts/9').flush({ contact: ANN, deals: [{ id: 2, name: 'Licence', stage: 'Won' }], tickets: [{ id: 5, subject: 'Login fails', status: 'Open' }] });
      m.f.detectChanges();
      url('/contacts/9/activities').flush({ activities: [] });
      for (const t of ['Licence', 'Login fails', 'Acme']) expect(m.el.textContent).toContain(t);
      expect(button(m.el, 'Send email')).toBeUndefined();
      let deal: any = null;
      let ticket: any = null;
      m.c.newDeal.subscribe(v => deal = v);
      m.c.newTicket.subscribe(v => ticket = v);
      button(m.el, 'New deal').click();
      button(m.el, 'New ticket').click();
      expect([deal.id, ticket.id]).toEqual([9, 9]);
    });

    it('each action follows its own permission', () => {
      const m = start({ canManage: false, canDeals: true, canSupport: false });
      expect(button(m.el, 'New contact')).toBeUndefined();
      button(m.el, 'Ann Lee').click();
      url('/contacts/9').flush({ contact: ANN, deals: [], tickets: [] });
      m.f.detectChanges();
      url('/contacts/9/activities').flush({ activities: [] });
      expect(button(m.el, 'Edit')).toBeUndefined();
      expect(button(m.el, 'New ticket')).toBeUndefined();
      expect(button(m.el, 'New deal')).toBeTruthy();
    });
  });

  describe('companies', () => {
    const CO = { id: 4, name: 'Acme', website: 'https://acme.io', industry: 'Food', email: 'hi@acme.io', phone: '555', contactCount: 2 };

    it('lists, opens with contacts, deals and tickets, and edits', () => {
      const m = make(CrmCompaniesComponent, { canManage: true });
      url('/companies').flush({ companies: [CO], truncated: false });
      m.f.detectChanges();
      expect(m.el.querySelector('a')!.getAttribute('rel')).toContain('noopener');
      button(m.el, 'Acme').click();
      url('/companies/4').flush({ company: CO, contacts: [{ id: 9, fullName: 'Ann', email: 'a@b.io', status: 'Customer' }], deals: [{ id: 2, name: 'Licence', stage: 'New' }], tickets: [{ id: 5, subject: 'Login', status: 'Open' }] });
      m.f.detectChanges();
      url('/companies/4/activities').flush({ activities: [] });
      for (const t of ['Ann', 'Licence', 'Login', 'hi@acme.io']) expect(m.el.textContent).toContain(t);
      button(m.el, 'Edit').click();
      m.f.detectChanges();
      m.c.form.name = 'Acme Group';
      m.c.save();
      const req = url('/companies/4', 'PATCH');
      expect(req.request.body.name).toBe('Acme Group');
      req.flush({ company: { ...CO, name: 'Acme Group' }, contacts: [], deals: [], tickets: [] });
      m.f.detectChanges();
      expect(m.el.querySelector('h3')!.textContent).toBe('Acme Group');
    });

    it('shows a duplicate name in the form, and an empty state', () => {
      const m = make(CrmCompaniesComponent, { canManage: true });
      url('/companies').flush({ companies: [], truncated: false });
      m.f.detectChanges();
      expect(m.el.textContent).toContain('No companies yet');
      m.c.openForm();
      m.c.form.name = 'Acme';
      m.c.save();
      url('/companies', 'POST').flush({ error: 'A company with this name already exists.' }, { status: 409, statusText: 'x' });
      expect(m.c.formError).toContain('already exists');
    });
  });

  describe('deals', () => {
    const STAGES = ['New', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost'];
    const D1 = { id: 1, name: 'Licence', stage: 'New', value: 1000, contactId: 9, contactName: 'Ann', companyName: 'Acme', assignedTo: 3, assigneeName: 'Sam', expectedCloseDate: '2026-12-31', notes: 'Renewal' };
    const D2 = { id: 2, name: 'Pilot', stage: 'Won', value: 500, contactId: null, contactName: null, companyName: null, assignedTo: null, assigneeName: null, expectedCloseDate: null, notes: null };
    const start = (canDeals = true, deals: any[] = [D1, D2]) => {
      const m = make(CrmDealsComponent, { canDeals });
      http.expectOne(r => r.url.endsWith('/global-crm/deals')).flush({ deals, stages: STAGES, truncated: false });
      url('/team').flush(TEAM);
      m.f.detectChanges();
      return m;
    };

    it('the pipeline has a column per stage, with deals and totals', () => {
      const { el } = start();
      const cols = Array.from(el.querySelectorAll('.crm-column'));
      expect(cols.map(c => c.querySelector('.mx-tag')!.textContent)).toEqual(STAGES);
      expect(cols[0].textContent).toContain('Licence');
      expect(cols[0].querySelector('header')!.textContent).toContain('1,000');
    });

    it('moving a deal saves its stage; a refusal puts it back and says why', () => {
      const { f, c, el } = start();
      const toasts: string[] = [];
      c.toast.subscribe(t => toasts.push(t));
      c.move(c.deals[0], 'Proposal');
      expect(c.dealsIn('Proposal').length).toBe(1);
      const req = url('/deals/1', 'PATCH');
      expect(req.request.body).toEqual({ stage: 'Proposal' });
      req.flush({ deal: { ...D1, stage: 'Proposal' } });
      c.move(c.deals[0], 'Won');
      url('/deals/1', 'PATCH').flush({ error: 'Not allowed' }, { status: 403, statusText: 'x' });
      f.detectChanges();
      expect(c.deals[0].stage).toBe('Proposal');
      expect(toasts.pop()).toBe('Not allowed');
      expect(el.querySelectorAll('.crm-column')[3].textContent).toContain('Licence');
    });

    it('dropping a card moves it; the same column does nothing', () => {
      const { c } = start();
      const ev = { preventDefault: () => {}, dataTransfer: { setData: () => {} } } as any;
      c.onDragStart(ev, c.deals[0]);
      c.onDrop(ev, 'New');
      http.expectNone(r => r.method === 'PATCH');
      c.onDragStart(ev, c.deals[0]);
      c.onDrop(ev, 'Qualified');
      url('/deals/1', 'PATCH').flush({ deal: { ...D1, stage: 'Qualified' } });
      expect(c.deals[0].stage).toBe('Qualified');
    });

    it('without crm.deals the pipeline is read-only', () => {
      const { c, el } = start(false);
      expect(el.querySelector('.crm-card select')).toBeNull();
      expect(el.querySelector('.crm-card')!.getAttribute('draggable')).toBe('false');
      expect(button(el, 'New deal')).toBeUndefined();
      c.move(c.deals[0], 'Won');
      http.expectNone(r => r.method === 'PATCH');
    });

    it('the list view shows the same deals', () => {
      const { f, el } = start();
      button(el, 'List').click();
      f.detectChanges();
      expect(el.querySelector('.crm-pipeline')).toBeNull();
      expect(el.querySelector('table')!.textContent).toContain('Licence');
    });

    it('a new deal for a contact leaves the company to the server, and sends no display-only fields', () => {
      const m = start();
      m.c.openForm(null, { id: 9, fullName: 'Ann', companyId: null, assignedTo: null });
      m.f.detectChanges();
      http.expectOne(r => r.url.endsWith('/global-crm/companies')).flush({ companies: [] });
      http.expectOne(r => r.url.endsWith('/global-crm/contacts')).flush({ contacts: [{ id: 9, fullName: 'Ann', email: 'a@b.io' }], total: 1 });
      m.c.form.name = 'New one';
      m.c.save();
      const req = url('/deals', 'POST');
      expect(req.request.body.contactId).toBe(9);
      expect('companyId' in req.request.body).toBeFalse();
      expect('contactName' in req.request.body).toBeFalse();
      req.flush({ deal: { id: 3 } });
      http.expectOne(r => r.url.endsWith('/global-crm/deals')).flush({ deals: [], stages: STAGES, truncated: false });
    });

    it('typed text that matches no contact is refused', () => {
      const m = start();
      m.c.openForm();
      m.c.form.name = 'x';
      m.c.contactUnmatched = true;
      m.c.save();
      expect(m.c.formError).toContain('Choose a contact');
      http.expectOne(r => r.url.endsWith('/global-crm/companies')).flush({ companies: [] });
    });

    it('deleting a deal asks first', () => {
      const m = start();
      m.c.open(1);
      url('/deals/1').flush({ deal: D1 });
      m.f.detectChanges();
      url('/deals/1/activities').flush({ activities: [] });
      expect(m.el.textContent).toContain('Renewal');
      const ask = spyOn(window, 'confirm').and.returnValue(false);
      button(m.el, 'Delete').click();
      http.expectNone(r => r.method === 'DELETE');
      ask.and.returnValue(true);
      button(m.el, 'Delete').click();
      url('/deals/1', 'DELETE').flush({ deleted: true });
      http.expectOne(r => r.url.endsWith('/global-crm/deals')).flush({ deals: [], stages: STAGES, truncated: false });
    });
  });

  describe('support', () => {
    const T = { id: 7, subject: 'Login fails', description: 'Error at login', contactId: 9, contactName: 'Ann', contactEmail: 'a@b.io', contactPhone: '555', companyId: 4, companyName: 'Acme', priority: 'High', status: 'Open', assignedTo: 3, assigneeName: 'Sam', createdBy: 'Pat', createdAt: '2026-10-01T10:00:00Z' };
    const LISTS = { statuses: ['Open', 'In Progress', 'Resolved', 'Closed'], priorities: ['Low', 'Medium', 'High'], truncated: false };
    const start = (canSupport = true, tickets: any[] = [T]) => {
      const m = make(CrmSupportComponent, { canSupport });
      http.expectOne(r => r.url.endsWith('/global-crm/tickets')).flush({ tickets, ...LISTS });
      url('/team').flush(TEAM);
      m.f.detectChanges();
      return m;
    };
    const openTicket = (m: any) => {
      button(m.el, 'Login fails').click();
      url('/tickets/7').flush({ ticket: T });
      m.f.detectChanges();
      url('/tickets/7/activities').flush({ activities: [{ id: 1, type: 'change', body: 'Status changed from Open to In Progress.', done: false, createdBy: 'Pat', createdAt: '2026-10-02T10:00:00Z' }] });
      m.f.detectChanges();
    };

    it('lists tickets with status and priority, and filters on the server', () => {
      const { c, el } = start();
      expect(el.querySelector('tbody')!.textContent).toContain('High');
      c.priority = 'Low';
      c.status = 'Closed';
      c.load();
      const req = http.expectOne(r => r.url.endsWith('/global-crm/tickets'));
      expect([req.request.params.get('priority'), req.request.params.get('status')]).toEqual(['Low', 'Closed']);
      req.flush({ tickets: [], ...LISTS });
    });

    it('clicking anywhere on a row opens the ticket once, and the row has a visible Open button', () => {
      const m = start();
      expect(button(m.el, 'Open →')).toBeTruthy();
      (m.el.querySelector('tbody tr td:nth-child(5)') as HTMLElement).click();
      url('/tickets/7').flush({ ticket: T });
      m.f.detectChanges();
      url('/tickets/7/activities').flush({ activities: [] });
      m.c.back();
      http.expectOne(r => r.url.endsWith('/global-crm/tickets')).flush({ tickets: [T], ...LISTS });
      m.f.detectChanges();
      button(m.el, 'Open →').click();
      url('/tickets/7').flush({ ticket: T });
      m.f.detectChanges();
      url('/tickets/7/activities').flush({ activities: [] });
    });

    it('Close ticket closes it, and a closed ticket offers Reopen', () => {
      const m = start();
      openTicket(m);
      button(m.el, 'Close ticket').click();
      const req = url('/tickets/7', 'PATCH');
      expect(req.request.body).toEqual({ status: 'Closed' });
      req.flush({ ticket: { ...T, status: 'Closed' } });
      m.f.detectChanges();
      url('/tickets/7/activities').flush({ activities: [] });
      expect(button(m.el, 'Close ticket')).toBeUndefined();
      button(m.el, 'Reopen ticket').click();
      const again = url('/tickets/7', 'PATCH');
      expect(again.request.body).toEqual({ status: 'Open' });
      again.flush({ ticket: T });
      m.f.detectChanges();
      url('/tickets/7/activities').flush({ activities: [] });
    });

    it('an empty list has an empty state', () => {
      expect(start(true, []).el.textContent).toContain('No support tickets yet.');
    });

    it('the ticket page shows the contact, company, issue and history', () => {
      const m = start();
      openTicket(m);
      for (const t of ['Ann', 'a@b.io', '555', 'Acme', 'Error at login', 'High priority', 'Update', 'Status changed from Open to In Progress.']) expect(m.el.textContent).toContain(t);
    });

    it('changing status saves it and reloads the history; a refusal keeps the old value', () => {
      const m = start();
      openTicket(m);
      m.c.update({ status: 'Resolved' });
      url('/tickets/7', 'PATCH').flush({ ticket: { ...T, status: 'Resolved' } });
      m.f.detectChanges();
      expect(m.c.detail.status).toBe('Resolved');
      url('/tickets/7/activities').flush({ activities: [] });
      const toasts: string[] = [];
      m.c.toast.subscribe(t => toasts.push(t));
      m.c.update({ priority: 'Low' });
      expect(m.c.detail.priority).toBe('Low');
      url('/tickets/7', 'PATCH').flush({ error: 'Not allowed' }, { status: 403, statusText: 'x' });
      expect(m.c.detail.priority).toBe('High');
      expect(toasts).toEqual(['Not allowed']);
    });

    it('creates a ticket: subject and issue are required, and it opens afterwards', () => {
      const m = start();
      m.c.openForm({ id: 9, fullName: 'Ann', companyId: null });
      m.f.detectChanges();
      http.expectOne(r => r.url.endsWith('/global-crm/companies')).flush({ companies: [] });
      http.expectOne(r => r.url.endsWith('/global-crm/contacts')).flush({ contacts: [{ id: 9, fullName: 'Ann' }], total: 1 });
      m.c.save();
      expect(m.c.formError).toBe('Enter a subject.');
      m.c.form.subject = 'Broken';
      m.c.save();
      expect(m.c.formError).toBe('Describe the issue.');
      m.c.form.description = 'It broke';
      m.c.save();
      const req = url('/tickets', 'POST');
      expect(req.request.body).toEqual({ subject: 'Broken', description: 'It broke', contactId: 9, priority: 'Medium', assignedTo: null });
      req.flush({ ticket: T });
      http.expectOne(r => r.url.endsWith('/global-crm/tickets')).flush({ tickets: [T], ...LISTS });
      m.f.detectChanges();
      url('/tickets/7/activities').flush({ activities: [] });
      expect(m.el.querySelector('h3')!.textContent).toBe('Login fails');
    });

    it('without crm.support a ticket is read-only', () => {
      const m = start(false);
      expect(button(m.el, 'New ticket')).toBeUndefined();
      openTicket(m);
      expect(m.el.querySelector('.crm-ticket-controls')).toBeNull();
      expect(button(m.el, 'Close ticket')).toBeUndefined();
      expect(m.el.querySelector('app-crm-activities form')).toBeNull();
    });
  });

  describe('calls', () => {
    const CALL = { id: 3, phone: '+919876543210', name: 'Ann', contactId: 9, callerName: 'Sam', answered: true, durationSeconds: 125, transcribed: true, transcriptStatus: 'done', startedAt: '2026-10-31T10:00:00Z' };
    const start = (canManage = true, calls: any[] = [CALL]) => {
      const m = make(CrmCallsComponent, { canManage });
      http.expectOne(r => r.url.endsWith('/global-crm/calls')).flush({ calls, total: calls.length });
      m.f.detectChanges();
      return m;
    };
    const open = (m: any, call: any) => {
      m.c.open(3);
      url('/calls/3').flush({ call });
      m.f.detectChanges();
    };

    it('lists calls with who, duration and transcript state, and has an empty state', () => {
      const { el } = start();
      for (const t of ['Ann', '+919876543210', 'Sam', '02:05', 'Transcript']) expect(el.querySelector('tbody')!.textContent).toContain(t);
      expect(start(true, []).el.textContent).toContain('No calls yet.');
    });

    it('an unanswered call says so', () => {
      expect(start(true, [{ ...CALL, answered: false, transcriptStatus: 'none' }]).el.querySelector('tbody')!.textContent).toContain('Not answered');
    });

    it('shows the conversation with who said what, marked as possibly imperfect', () => {
      const m = start();
      open(m, { ...CALL, transcript: [{ speaker: 'agent', start: 0, text: 'Hello.' }, { speaker: 'customer', start: 2, text: 'Hi there.' }] });
      const lines = Array.from(m.el.querySelectorAll('.cl-line')).map(l => l.textContent!.trim());
      expect(lines).toEqual(['SamHello.', 'AnnHi there.']);
      expect(m.el.querySelector('.cl-line')!.classList.contains('agent')).toBeTrue();
      expect(m.el.textContent).toContain('may contain mistakes');
    });

    it('explains each transcript state instead of showing an empty box', () => {
      const m = start();
      open(m, { ...CALL, transcriptStatus: 'none', transcript: [] });
      expect(m.el.textContent).toContain('This call was not transcribed.');
      open(m, { ...CALL, transcriptStatus: 'failed', transcript: [] });
      expect(m.el.querySelector('[role=alert]')!.textContent).toContain('could not be made');
      open(m, { ...CALL, transcriptStatus: 'done', transcript: [] });
      expect(m.el.textContent).toContain('No speech was found');
    });

    it('a transcript can be deleted after confirming; read-only users cannot', () => {
      const m = start();
      open(m, { ...CALL, transcript: [{ speaker: 'agent', start: 0, text: 'Hello.' }] });
      const ask = spyOn(window, 'confirm').and.returnValue(false);
      button(m.el, 'Delete transcript').click();
      http.expectNone(r => r.method === 'DELETE');
      ask.and.returnValue(true);
      button(m.el, 'Delete transcript').click();
      url('/calls/3/transcript', 'DELETE').flush({ call: { ...CALL, transcriptStatus: 'none', transcript: [] } });
      m.f.detectChanges();
      expect(m.el.textContent).toContain('This call was not transcribed.');
      const ro = start(false);
      open(ro, { ...CALL, transcript: [{ speaker: 'agent', start: 0, text: 'Hello.' }] });
      expect(button(ro.el, 'Delete transcript')).toBeUndefined();
    });
  });

  describe('activities', () => {
    const NOTE = { id: 1, type: 'note', body: 'Called', dueDate: null, done: false, createdBy: 'Sam', createdAt: '2026-10-01T10:00:00Z' };
    const TASK = { id: 2, type: 'task', body: 'Send pricing', dueDate: '2026-11-15', done: false, createdBy: null, createdAt: '2026-10-02T10:00:00Z' };
    const start = (canManage = true, parent = 'deals') => {
      const m = make(CrmActivitiesComponent, { parent, parentId: 5, canManage });
      url(`/${parent}/5/activities`).flush({ activities: [NOTE, TASK] });
      m.f.detectChanges();
      return m;
    };

    it('shows type, date, author and follow-up date, in order', () => {
      const { el } = start();
      const items = Array.from(el.querySelectorAll('.ca-item')).map(i => i.textContent);
      expect(items[0]).toContain('Note');
      expect(items[0]).toContain('Sam');
      expect(items[1]).toContain('Follow-up task');
      expect(items[1]).toContain('Follow up by Nov 15, 2026');
    });

    it('notes on a ticket are called internal', () => {
      expect(start(true, 'tickets').el.textContent).toContain('Internal note');
    });

    it('adds a task and completes it', () => {
      const m = start();
      button(m.el, 'Follow-up task').click();
      m.c.body = 'Call back';
      m.c.dueDate = '2026-12-01';
      m.c.add();
      const req = url('/deals/5/activities', 'POST');
      expect(req.request.body).toEqual({ type: 'task', body: 'Call back', dueDate: '2026-12-01' });
      req.flush({ activity: { ...TASK, id: 3, body: 'Call back' } });
      expect(m.c.activities.length).toBe(3);
      expect(m.c.body).toBe('');
      m.f.detectChanges();
      (m.el.querySelector('.ca-item input') as HTMLInputElement).click();
      const done = url('/activities/2', 'PATCH');
      expect(done.request.body).toEqual({ done: true });
      done.flush({ activity: { ...TASK, done: true } });
      expect(m.c.activities.find(a => a.id === 2).done).toBeTrue();
    });

    it('read-only users cannot add or complete', () => {
      const { el } = start(false);
      expect(el.querySelector('form')).toBeNull();
      expect((el.querySelector('.ca-item input') as HTMLInputElement).disabled).toBeTrue();
    });
  });
});
