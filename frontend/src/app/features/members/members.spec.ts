import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MembersComponent } from './members.component';

const CAP = 'mail.send_transactional';
const data = (o: any = {}) => ({
  canManage: true, canManageOwners: true, roles: ['Workspace Owner', 'Workspace Admin', 'Marketing Manager', 'Approver', 'Member'], invitations: [],
  grantable: [{ capability: CAP, label: 'Send transactional email (Compose)', requires: 'mail.send' }],
  members: [
    { userId: 1, email: 'own@x.io', role: 'Workspace Owner', status: 'Active', isYou: true, grants: { [CAP]: 'role' } },
    { userId: 2, email: 'mm@x.io', role: 'Marketing Manager', status: 'Active', grants: { [CAP]: 'eligible' } },
    { userId: 3, email: 'ap@x.io', role: 'Approver', status: 'Active', grants: { [CAP]: 'granted' } },
    { userId: 4, email: 'mem@x.io', role: 'Member', status: 'Active', grants: { [CAP]: 'not_eligible' } }
  ],
  ...o
});

describe('MembersComponent: permissions panel', () => {
  let fixture: ComponentFixture<MembersComponent>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const c = () => fixture.componentInstance;
  const SEND = 'mail.send';
  const permData = () => data({
    grantable: [{ capability: SEND, label: 'Send email', requires: 'mail.compose' }, { capability: CAP, label: 'Send transactional email (Compose)', requires: 'mail.send' }],
    modules: [{ key: 'leads', label: 'Leads', description: '' }], fullAccessRoles: ['Workspace Owner', 'Workspace Admin'], crmRoles: ['viewer', 'sales', 'support', 'manager'],
    members: [
      { userId: 1, email: 'own@x.io', role: 'Workspace Owner', status: 'Active', isYou: true, canCall: true, modules: { all: true, fullAccessRole: true, keys: ['leads'] }, grants: { [SEND]: 'role', [CAP]: 'role' } },
      { userId: 4, email: 'mem@x.io', role: 'Member', status: 'Active', canCall: false, callGrant: false, crmRole: null, modules: { all: true, fullAccessRole: false, keys: ['leads'] }, grants: { [SEND]: 'eligible', [CAP]: 'not_eligible' } }
    ]
  });

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MembersComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MembersComponent);
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/workspace/members')).flush(permData());
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('one Permissions column with what each member can do', () => {
    expect(el().querySelector('thead')!.textContent).toContain('Permissions');
    expect(el().querySelector('thead')!.textContent).not.toContain('CRM');
    const owner = Array.from(el().querySelectorAll('tbody tr')).find(r => r.textContent!.includes('own@x.io'))!;
    expect(owner.textContent).toContain('📞 Calls');
    expect(owner.textContent).toContain('Sends email');
  });

  it('Make calls and Send email are saved through their own APIs, only when changed', async () => {
    const m = c().data.members[1];
    c().editPermissions(m);
    fixture.detectChanges();
    // Grouped: Sections, Email, (Team Performance when offered), Calls & CRM; each group with its count.
    // One group per menu item, in the sidebar's order; each section's switch is in its header.
    const groups = Array.from(el().querySelectorAll('.pm-group h4')).map(h => h.textContent!.trim());
    expect(groups).toEqual(['CRM', 'Leads']);
    const leads = Array.from(el().querySelectorAll('.pm-group')).find(g => g.querySelector('h4')!.textContent!.trim() === 'Leads') as HTMLElement;
    expect((leads.querySelector('.pm-switch input') as HTMLInputElement).checked).toBeTrue();
    expect(leads.querySelector('.pm-state')!.textContent).toContain('On');
    // CRM: the header checkbox gives Viewer access (the level is chosen below) and removes it; calls stay visible.
    const crm = () => Array.from(el().querySelectorAll('.pm-group')).find(g => g.querySelector('h4')!.textContent!.trim() === 'CRM') as HTMLElement;
    expect((crm().querySelector('.pm-switch input') as HTMLInputElement).checked).toBeFalse();
    expect(crm().textContent).toContain('Make calls');
    (crm().querySelector('.pm-switch input') as HTMLInputElement).click();
    fixture.detectChanges();
    expect(c().perm!.crmRole).toBe('viewer');
    expect(crm().querySelector('.pm-state')!.textContent).toContain('Viewer');
    expect(crm().querySelector('select')).toBeTruthy();
    (crm().querySelector('.pm-switch input') as HTMLInputElement).click();
    fixture.detectChanges();
    expect(c().perm!.crmRole).toBeNull();
    // Ticking Make calls while CRM is off turns CRM on too (Viewer).
    const calls = Array.from(crm().querySelectorAll('.pm-list li')).find(li => li.textContent!.includes('Make calls'))!.querySelector('input') as HTMLInputElement;
    calls.click();
    fixture.detectChanges();
    expect(c().perm!.calls).toBeTrue();
    expect(c().perm!.crmRole).toBe('viewer');
    expect((crm().querySelector('.pm-switch input') as HTMLInputElement).checked).toBeTrue();
    // Unticking Make calls removes the CRM access it gave; a level chosen by hand stays.
    (Array.from(crm().querySelectorAll('.pm-list li')).find(li => li.textContent!.includes('Make calls'))!.querySelector('input') as HTMLInputElement).click();
    fixture.detectChanges();
    expect(c().perm!.calls).toBeFalse();
    expect(c().perm!.crmRole).toBeNull();
    (crm().querySelector('.pm-switch input') as HTMLInputElement).click(); fixture.detectChanges(); // CRM on by hand
    const calls2 = () => Array.from(crm().querySelectorAll('.pm-list li')).find(li => li.textContent!.includes('Make calls'))!.querySelector('input') as HTMLInputElement;
    calls2().click(); fixture.detectChanges();
    calls2().click(); fixture.detectChanges();
    expect(c().perm!.crmRole).withContext('chosen by hand: kept').toBe('viewer');
    expect(el().textContent).toContain('Make calls');
    c().perm!.crmRole = null; // back to no CRM access (the checks above turned it on)
    c().perm!.calls = true;
    c().toggleGrant(SEND);
    const done = c().savePermissions(m);
    await Promise.resolve();
    const g = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/members/4/grants/mail.send'));
    g.flush({});
    await Promise.resolve(); await Promise.resolve();
    const call = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/members/4/calling'));
    expect(call.request.body).toEqual({ enabled: true });
    call.flush({});
    await done;
    http.expectOne(r => r.url.endsWith('/workspace/members')).flush(permData());
  });
});

describe('MembersComponent: Mail Center tabs', () => {
  let fixture: ComponentFixture<MembersComponent>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const c = () => fixture.componentInstance;
  const TABS = ['inbox', 'campaigns', 'deliverability', 'templates', 'logs'];
  const d = (memberTabs: string[]) => ({
    canManage: true, canManageOwners: true, roles: ['Workspace Owner', 'Member'], invitations: [], grantable: [], crmRoles: null,
    modules: [{ key: 'leads', label: 'Leads', description: '' }, { key: 'mail', label: 'Mail Center & email campaigns', description: '' }],
    mailTabs: [{ key: 'inbox', label: 'Inbox' }, { key: 'campaigns', label: 'Campaigns' }, { key: 'deliverability', label: 'Deliverability' }, { key: 'templates', label: 'Email Templates' }, { key: 'logs', label: 'Logs' }],
    fullAccessRoles: ['Workspace Owner', 'Workspace Admin'],
    members: [
      { userId: 1, email: 'own@x.io', role: 'Workspace Owner', status: 'Active', isYou: true, modules: { all: true, fullAccessRole: true, keys: ['leads', 'mail'] }, mailTabs: { all: true, fullAccessRole: true, keys: TABS }, grants: {} },
      { userId: 4, email: 'mem@x.io', role: 'Member', status: 'Active', modules: { all: true, fullAccessRole: false, keys: ['leads', 'mail'] }, mailTabs: { all: memberTabs.length === 5, fullAccessRole: false, keys: memberTabs }, grants: {} }
    ]
  });
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MembersComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MembersComponent);
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/workspace/members')).flush(d(['inbox', 'campaigns']));
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('limited tabs show in the list; the panel ticks them under Mail Center and saves only the tabs that changed', async () => {
    const row = Array.from(el().querySelectorAll('tbody tr')).find(r => r.textContent!.includes('mem@x.io'))!;
    expect(row.textContent).toContain('Mail: Inbox, Campaigns');
    const m = c().data.members[1];
    c().editPermissions(m);
    fixture.detectChanges();
    const sub = el().querySelector('.pm-sub') as HTMLElement;
    expect(sub.closest('.pm-group')!.querySelector('h4')!.textContent).toContain('Mail Center & email campaigns');
    expect(sub.textContent).toContain('Tabs');
    expect(sub.textContent).toContain('2 of 5 on');
    const boxes = Array.from(sub.querySelectorAll('.pm-chip input')) as HTMLInputElement[];
    expect(boxes.map(b => b.checked)).toEqual([true, true, false, false, false]);
    boxes[4].click(); // Logs
    fixture.detectChanges();
    const done = c().savePermissions(m);
    const req = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/members/4/modules'));
    expect(req.request.body).toEqual({ modules: ['leads', 'mail'], mailTabs: ['inbox', 'campaigns', 'logs'] });
    req.flush({});
    await done;
    http.expectOne(r => r.url.endsWith('/workspace/members')).flush(d(['inbox', 'campaigns', 'logs']));
  });

  it('a section that is off shows its permissions dimmed; ticking one turns the section on, unticking does not', () => {
    c().editPermissions(c().data.members[1]);
    fixture.detectChanges();
    const mail = () => Array.from(el().querySelectorAll('.pm-group')).find(g => g.querySelector('h4')!.textContent!.includes('Mail Center')) as HTMLElement;
    const main = () => mail().querySelector('.pm-switch input') as HTMLInputElement;
    main().click();
    fixture.detectChanges();
    expect(c().perm!.modules.has('mail')).toBeFalse();
    expect(mail().classList).toContain('closed');
    expect(mail().textContent).toContain('Ticking any permission below turns it on');
    const tabs = () => Array.from(mail().querySelectorAll('.pm-sub .pm-chip input')) as HTMLInputElement[];
    tabs()[0].click(); // untick Inbox (was on): the section stays off
    fixture.detectChanges();
    expect(c().perm!.modules.has('mail')).toBeFalse();
    tabs()[4].click(); // tick Logs: the section turns on
    fixture.detectChanges();
    expect(c().perm!.modules.has('mail')).toBeTrue();
    expect(main().checked).toBeTrue();
    expect(c().perm!.mailTabs.has('logs')).toBeTrue();
    // Unticking everything again (Clear, then the last tab) turns the section off too.
    (Array.from(mail().querySelectorAll('.pm-sub .link-btn')).find(b => b.textContent!.includes('Clear')) as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(c().perm!.mailTabs.size).toBe(0);
    expect(c().perm!.modules.has('mail')).toBeFalse();
    expect(main().checked).toBeFalse();
    // One tab back on, then off: on, then off again.
    tabs()[1].click(); fixture.detectChanges();
    expect(c().perm!.modules.has('mail')).toBeTrue();
    tabs()[1].click(); fixture.detectChanges();
    expect(c().perm!.modules.has('mail')).toBeFalse();
  });
});

describe('MembersComponent: section access', () => {
  let fixture: ComponentFixture<MembersComponent>;
  let http: HttpTestingController;
  const MODULES = [{ key: 'leads', label: 'Leads', description: '' }, { key: 'social', label: 'Social media & social campaigns', description: '' }];
  const full = { all: true, fullAccessRole: true, keys: ['leads', 'social'] };
  const d = () => ({
    canManage: true, canManageOwners: true, roles: ['Workspace Owner', 'Workspace Admin', 'Member'], invitations: [], grantable: [],
    modules: MODULES, fullAccessRoles: ['Workspace Owner', 'Workspace Admin'], crmRoles: null,
    members: [
      { userId: 1, email: 'own@x.io', role: 'Workspace Owner', status: 'Active', isYou: true, modules: full },
      { userId: 2, email: 'mem@x.io', role: 'Member', status: 'Active', modules: { all: false, fullAccessRole: false, keys: ['social'] } }
    ]
  });

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MembersComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MembersComponent);
    fixture.detectChanges();
    http.expectOne(r => r.url.endsWith('/workspace/members')).flush(d());
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('shows each member\'s sections and invites with the chosen sections', () => {
    const c = fixture.componentInstance;
    expect(c.accessText(c.data.members[0].modules)).toBe('All sections (role)');
    expect(c.accessText(c.data.members[1].modules)).toBe('Social media & social campaigns');
    c.inviteForm = { email: 'new@x.io', role: 'Member' };
    c.toggle(c.inviteModules, 'leads');
    c.invite();
    const req = http.expectOne(r => r.url.endsWith('/workspace/invitations'));
    expect(req.request.body).toEqual({ email: 'new@x.io', role: 'Member', modules: ['social'] });
    req.flush({ invitation: { email: 'new@x.io' }, link: 'x', emailed: true });
    http.expectOne(r => r.url.endsWith('/workspace/members')).flush(d());
  });

  it('Admins are invited without a section list; editing a member saves the selection', () => {
    const c = fixture.componentInstance;
    c.inviteForm = { email: 'adm@x.io', role: 'Workspace Admin' };
    c.invite();
    const inv = http.expectOne(r => r.url.endsWith('/workspace/invitations'));
    expect(inv.request.body.modules).toBeUndefined();
    inv.flush({ invitation: { email: 'adm@x.io' }, link: 'x', emailed: true });
    http.expectOne(r => r.url.endsWith('/workspace/members')).flush(d());

    const m = c.data.members[1];
    c.editAccess(m);
    c.toggle(c.editing!.modules, 'leads');
    c.saveAccess(m);
    const put = http.expectOne(r => r.url.endsWith('/members/2/modules'));
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ modules: ['leads', 'social'] });
    put.flush({ success: true });
    http.expectOne(r => r.url.endsWith('/workspace/members')).flush(d());
  });
});
