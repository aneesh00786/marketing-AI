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
    expect(el().textContent).toContain('📞 Make calls');
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
