import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PlatformAdminComponent } from './platform-admin.component';

describe('PlatformAdminComponent', () => {
  let fixture: ComponentFixture<PlatformAdminComponent>;
  let comp: PlatformAdminComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (t: string) => Array.from(el().querySelectorAll('button')).find(b => b.textContent!.includes(t)) as HTMLButtonElement;
  const url = (s: string, method = 'GET') => http.expectOne(r => r.method === method && r.url.endsWith(`/api/v1/platform${s}`));
  const USERS = [
    { id: 2, name: 'Ann', email: 'ann@x.io', status: 'Active', createdAt: '2026-10-01T00:00:00Z', lastActivity: null, workspaces: [{ id: 5, name: 'Acme', role: 'Workspace Owner' }] },
    { id: 3, name: 'Bo', email: 'bo@x.io', status: 'Active', createdAt: '2026-10-01T00:00:00Z', lastActivity: null, workspaces: [] },
    { id: 4, name: 'Cy', email: 'cy@x.io', status: 'Suspended', createdAt: '2026-10-01T00:00:00Z', lastActivity: null, workspaces: [] }
  ];
  const ROLES = ['Workspace Owner', 'Workspace Admin', 'Member'];
  const WS = { id: 5, name: 'Acme', plan: 'Starter', status: 'Active', owners: 'Ann', memberCount: 1, leadCount: 12, campaignCount: 3, lastActivity: null, createdAt: '2026-10-01T00:00:00Z', protected: false };
  const MEMBERS = [{ userId: 2, name: 'Ann', email: 'ann@x.io', role: 'Workspace Owner', joinedAt: '2026-10-01T00:00:00Z' }];

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [PlatformAdminComponent], providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PlatformAdminComponent);
    comp = fixture.componentInstance;
    fixture.detectChanges();
    url('/users').flush({ users: USERS });
    url('/workspaces').flush({ workspaces: [WS], roles: ROLES, truncated: false });
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  function openWorkspace(ws: any = WS, members: any[] = MEMBERS): void {
    button('Acme').click();
    url('/workspaces/5').flush({ workspace: ws, members, roles: ROLES });
    fixture.detectChanges();
  }

  it('lists workspaces with owner and counts', () => {
    const row = el().querySelector('tbody tr')!.textContent!;
    for (const t of ['Acme', 'Ann', '12', '3']) expect(row).toContain(t);
  });

  it('creates a workspace for a chosen active user, and requires one', () => {
    button('New workspace').click();
    fixture.detectChanges();
    expect(Array.from(el().querySelectorAll('[name=owner] option')).map(o => o.textContent)).not.toContain('Cy (cy@x.io)');
    comp.form.name = 'New Co';
    comp.create();
    expect(comp.formError).toContain('Choose the user');
    comp.form.ownerUserId = 3;
    comp.create();
    const req = url('/workspaces', 'POST');
    expect(req.request.body).toEqual({ name: 'New Co', industry: null, ownerUserId: 3 });
    req.flush({ workspace: { ...WS, id: 6, name: 'New Co' }, members: MEMBERS, roles: ROLES });
    url('/users').flush({ users: USERS });
    url('/workspaces').flush({ workspaces: [WS], roles: ROLES });
    fixture.detectChanges();
    expect(el().querySelector('h3')!.textContent).toBe('New Co');
  });

  it('a refused creation stays in the form with the reason', () => {
    comp.openForm();
    comp.form.name = 'New Co';
    comp.form.ownerUserId = 3;
    comp.create();
    url('/workspaces', 'POST').flush({ error: 'This user account is not active.' }, { status: 400, statusText: 'x' });
    expect(comp.formError).toContain('not active');
    expect(comp.form).toBeTruthy();
  });

  it('assigns a user with a role, offering only active non-members', () => {
    openWorkspace();
    expect(comp.assignable.map(u => u.id)).toEqual([3]);
    comp.assign = { userId: 3, role: 'Workspace Admin' };
    fixture.detectChanges();
    button('Assign').click();
    const req = url('/workspaces/5/members', 'POST');
    expect(req.request.body).toEqual({ userId: 3, role: 'Workspace Admin' });
    req.flush({ members: [...MEMBERS, { userId: 3, name: 'Bo', email: 'bo@x.io', role: 'Workspace Admin', joinedAt: '2026-10-02T00:00:00Z' }] });
    url('/users').flush({ users: USERS });
    fixture.detectChanges();
    expect(el().textContent).toContain('bo@x.io');
    expect(comp.assign.userId).toBeNull();
  });

  it('removing a user asks first', () => {
    openWorkspace();
    const ask = spyOn(window, 'confirm').and.returnValue(false);
    button('Remove').click();
    http.expectNone(r => r.method === 'DELETE');
    ask.and.returnValue(true);
    button('Remove').click();
    url('/workspaces/5/members/2', 'DELETE').flush({ members: [] });
    url('/users').flush({ users: USERS });
  });

  it('a refused role change shows why and reloads the real roles', () => {
    openWorkspace();
    const toasts: string[] = [];
    comp.toast.subscribe(t => toasts.push(t));
    comp.setRole(2, 'Member');
    url('/workspaces/5/members', 'POST').flush({ error: 'A workspace must keep at least one Owner.' }, { status: 409, statusText: 'x' });
    expect(toasts[0]).toContain('at least one Owner');
    url('/workspaces/5').flush({ workspace: WS, members: MEMBERS, roles: ROLES });
  });

  it('the platform workspace cannot have its Owner changed from here', () => {
    openWorkspace({ ...WS, protected: true });
    expect(el().textContent).toContain('is the platform admin');
    expect(button('Remove')).toBeUndefined();
    expect(el().querySelector('tbody select')).toBeNull();
    expect(comp.rolesFor()).not.toContain('Workspace Owner');
  });

  it('users shows each person\'s workspaces and leads to their activity', () => {
    button('Users').click();
    url('/users').flush({ users: USERS });
    fixture.detectChanges();
    expect(el().querySelector('tbody')!.textContent).toContain('Workspace Owner');
    expect(el().querySelector('tbody')!.textContent).toContain('Suspended');
    comp.showActivity({ userId: 2 });
    const req = http.expectOne(r => r.url.endsWith('/platform/activity'));
    expect(req.request.params.get('userId')).toBe('2');
    req.flush({ activity: [], page: 1, hasMore: false });
    fixture.detectChanges();
    expect(el().textContent).toContain('No activity found.');
  });

  it('activity reads clearly, filters on the server and pages', () => {
    button('Activity').click();
    http.expectOne(r => r.url.endsWith('/platform/activity')).flush({
      activity: [{ id: 1, action: 'mail.campaign_created', createdAt: '2026-10-01T10:00:00Z', userName: 'Ann', workspaceName: 'Acme' }, { id: 2, action: 'crm.access_granted', actorType: 'system', createdAt: '2026-10-01T10:00:00Z', userName: null, workspaceName: null }],
      page: 1, hasMore: true
    });
    fixture.detectChanges();
    const text = el().querySelector('tbody')!.textContent!;
    for (const t of ['Mail: campaign created', 'Ann', 'Acme', 'System', 'Platform']) expect(text).toContain(t);
    comp.filters.from = '2026-10-01';
    button('Older').click();
    const req = http.expectOne(r => r.url.endsWith('/platform/activity'));
    expect([req.request.params.get('page'), req.request.params.get('from')]).toEqual(['2', '2026-10-01']);
    req.flush({ activity: [], page: 2, hasMore: false });
  });

  it('Open goes into a workspace with the session the server gives', () => {
    let session: any = null;
    comp.opened.subscribe(s => session = s);
    button('Open').click();
    url('/workspaces/5/open', 'POST').flush({ token: 't', workspace: { id: 5, adminAccess: true } });
    expect(session.workspace.adminAccess).toBeTrue();
  });

  it('a refused open says why and stays here', () => {
    const toasts: string[] = [];
    comp.toast.subscribe(t => toasts.push(t));
    comp.enter(5);
    url('/workspaces/5/open', 'POST').flush({ error: 'Not allowed' }, { status: 403, statusText: 'x' });
    expect(toasts).toEqual(['Not allowed']);
  });

  describe('managing a user\'s workspaces', () => {
    const WS2 = { ...WS, id: 6, name: 'Beta' };

    beforeEach(() => { comp.allWorkspaces = [WS, WS2]; comp.roles = ROLES; });

    it('shows their workspaces and offers only the others', () => {
      button('Users').click();
      url('/users').flush({ users: USERS });
      fixture.detectChanges();
      comp.manage(USERS[0]);
      fixture.detectChanges();
      expect(el().querySelector('[role=dialog]')!.textContent).toContain('Acme');
      expect(comp.addable.map(w => w.id)).toEqual([6]);
    });

    it('assigns a workspace and refreshes the user', () => {
      button('Users').click();
      url('/users').flush({ users: USERS });
      fixture.detectChanges();
      comp.manage(USERS[1]);
      comp.manageAdd = { workspaceId: 6, role: 'Member' };
      comp.addToWorkspace();
      const req = url('/workspaces/6/members', 'POST');
      expect(req.request.body).toEqual({ userId: 3, role: 'Member' });
      req.flush({ members: [] });
      url('/users').flush({ users: [{ ...USERS[1], workspaces: [{ id: 6, name: 'Beta', role: 'Member' }] }] });
      expect(comp.managing.workspaces.length).toBe(1);
    });

    it('removing a workspace asks first, and refusals are shown', () => {
      button('Users').click();
      url('/users').flush({ users: USERS });
      fixture.detectChanges();
      comp.manage(USERS[0]);
      const ask = spyOn(window, 'confirm').and.returnValue(false);
      comp.removeFromWorkspace(USERS[0].workspaces[0]);
      http.expectNone(r => r.method === 'DELETE');
      ask.and.returnValue(true);
      const toasts: string[] = [];
      comp.toast.subscribe(t => toasts.push(t));
      comp.removeFromWorkspace(USERS[0].workspaces[0]);
      url('/workspaces/5/members/2', 'DELETE').flush({ error: 'A workspace must keep at least one Owner.' }, { status: 409, statusText: 'x' });
      expect(toasts).toEqual(['A workspace must keep at least one Owner.']);
    });
  });

  it('search waits for typing to stop, and errors offer a retry', fakeAsync(() => {
    comp.q = 'ac';
    comp.onSearch();
    comp.q = 'acm';
    comp.onSearch();
    tick(300);
    const req = http.expectOne(r => r.url.endsWith('/platform/workspaces'));
    expect(req.request.params.get('q')).toBe('acm');
    req.flush({ error: 'Down' }, { status: 500, statusText: 'x' });
    fixture.detectChanges();
    expect(el().querySelector('[role=alert]')!.textContent).toContain('Down');
  }));

  it('delete: only after typing the name; shows when it will be erased; restore brings it back', () => {
    openWorkspace();
    button('Delete workspace…').click(); fixture.detectChanges();
    const go = () => Array.from(el().querySelectorAll('.pa-confirm button')).find(b => b.textContent!.includes('Delete workspace')) as HTMLButtonElement;
    expect(go().disabled).toBeTrue();
    expect(el().querySelector('.pa-confirm')!.textContent).toContain('erase all of its data on the 30th day');
    comp.deleting!.name = 'acme '; comp.deleting!.reason = 'Client left'; fixture.detectChanges();
    expect(go().disabled).toBeFalse();
    let toast = '';
    comp.toast.subscribe(t => toast = t);
    go().click();
    const del = url('/workspaces/5/delete', 'POST');
    expect(del.request.body).toEqual({ confirmName: 'acme', reason: 'Client left' });
    del.flush({ deleted: true, purgeAfter: '2026-12-05T10:00:00Z', restoreDays: 30, stopped: {} });
    expect(toast).toContain('can be restored until 5 Dec 2026');
    const gone = { ...WS, status: 'Deleted', deletedAt: '2026-11-05T10:00:00Z', deletedBy: 'Admin', deleteReason: 'Client left', purgeAfter: '2026-12-05T10:00:00Z' };
    url('/workspaces/5').flush({ workspace: gone, members: MEMBERS, roles: ROLES });
    fixture.detectChanges();
    expect(el().querySelector('.pa-deleted')!.textContent).toContain('Dec 5, 2026');
    expect(el().querySelector('.pa-deleted')!.textContent).toContain('Reason: Client left');
    expect(button('Open workspace')).toBeUndefined();
    expect(el().textContent).not.toContain('Assign a user');
    spyOn(window, 'confirm').and.returnValue(true);
    button('Restore workspace').click();
    url('/workspaces/5/restore', 'POST').flush({ restored: true, note: 'Members can sign in again.' });
    url('/workspaces/5').flush({ workspace: WS, members: MEMBERS, roles: ROLES });
    fixture.detectChanges();
    expect(toast).toContain('Workspace restored');
    expect(button('Open workspace')).toBeTruthy();
  });

  it('the platform workspace has no delete option; a deleted one in the list cannot be opened', () => {
    openWorkspace({ ...WS, protected: true });
    expect(button('Delete workspace')).toBeUndefined();
    button('← Workspaces').click();
    url('/workspaces').flush({ workspaces: [{ ...WS, status: 'Deleted', purgeAfter: '2026-12-05T10:00:00Z' }], roles: ROLES });
    fixture.detectChanges();
    const row = el().querySelector('tbody tr')!;
    expect(row.textContent).toContain('Erased on Dec 5, 2026 unless restored');
    expect(Array.from(row.querySelectorAll('button')).some(b => b.textContent!.trim() === 'Open')).toBeFalse();
  });

  it('clear data: pick kinds of data (with counts), type the name, then only those are erased; also for the platform workspace', () => {
    openWorkspace({ ...WS, protected: true });
    expect(button('Delete workspace')).toBeUndefined();
    button('Clear data…').click();
    url('/workspaces/5/clear-options').flush({ categories: [{ key: 'leads', label: 'Leads and AI Lead Discovery searches', count: 49, warn: null },
      { key: 'stopList', label: 'Unsubscribes and bounces (stop-list)', count: 3, warn: 'Anyone who unsubscribed could be emailed again.' }], kept: 'Connections are kept.' });
    fixture.detectChanges();
    const box = el().querySelector('.pa-confirm') as HTMLElement;
    expect(box.textContent).toContain('Leads and AI Lead Discovery searches');
    expect(box.textContent).toContain('49');
    const go = () => box.querySelector('.pa-clear-go') as HTMLButtonElement;
    expect(go().disabled).toBeTrue();
    comp.toggleClear('leads'); comp.clearing!.name = 'Acme'; fixture.detectChanges();
    expect(go().disabled).toBeFalse();
    expect(go().textContent).toContain('Erase selected (49 records)');
    expect(box.textContent).not.toContain('could be emailed again');
    comp.toggleClear('stopList'); fixture.detectChanges();
    expect(box.textContent).toContain('could be emailed again');
    comp.toggleClear('stopList');
    spyOn(window, 'confirm').and.returnValue(true);
    let cleared = 0; let toast = '';
    comp.cleared.subscribe(id => cleared = id); comp.toast.subscribe(t => toast = t);
    go().click();
    const req = url('/workspaces/5/clear', 'POST');
    expect(req.request.body).toEqual({ categories: ['leads'], confirmName: 'Acme' });
    req.flush({ cleared: { leads: 49 }, total: 49 });
    url('/workspaces/5').flush({ workspace: { ...WS, protected: true, leadCount: 0 }, members: MEMBERS, roles: ROLES });
    expect(toast).toBe('Cleared 49 record(s).');
    expect(cleared).toBe(5);
  });
});
