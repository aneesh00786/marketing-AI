const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Platform admin: the Owner of workspace 1. It sees across workspaces, so these tests are mostly
// about who cannot, and about what it must not be able to break.
const db = () => h.db();
let admin;
let owner;
let user;
let seq = 0;

const api = (u, method, p, body) => h.api(method, `/api/v1/platform${p}`, { token: u?.token, body });
const create = (extra = {}) => api(admin, 'POST', '/workspaces', { name: `Client ${++seq} ${Date.now()}`, ownerUserId: user.userId, ...extra });
const newUser = () => h.createWorkspace({ name: 'Someone' });

test.before(async () => {
  await h.prepareDatabase();
  await db().run("INSERT IGNORE INTO workspaces (id, name, slug, owner_email, plan, status, created_at) VALUES (1, 'Platform', 'platform-test', 'owner@example.test', 'Starter', 'Active', UTC_TIMESTAMP())");
  admin = await h.createWorkspace({ name: 'Admin home' });
  await db().run("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES (1, ?, 'Workspace Owner', 'Active') ON DUPLICATE KEY UPDATE role = 'Workspace Owner', status = 'Active'", [admin.userId]);
  owner = await h.createWorkspace({ name: 'Other owner' });
  user = await newUser();
});
test.after(() => h.shutdown());

test('only the platform admin gets in: signed-out users, other Owners and Admins do not', async () => {
  const wsAdmin = await h.addMember(owner.workspaceId, 'Workspace Admin');
  const platformMember = await h.addMember(1, 'Workspace Admin');
  const routes = [['GET', '/workspaces'], ['POST', '/workspaces', {}], ['GET', `/workspaces/${owner.workspaceId}`], ['POST', `/workspaces/${owner.workspaceId}/members`, {}], ['DELETE', `/workspaces/${owner.workspaceId}/members/1`], ['GET', '/users'], ['GET', '/activity']];
  for (const u of [owner, wsAdmin, platformMember]) {
    assert.equal((await api(u, 'GET', '/me')).data.admin, false);
    for (const [m, p, b] of routes) {
      const r = await api(u, m, p, b);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.data.code, 'PLATFORM_ADMIN_REQUIRED');
    }
  }
  assert.equal((await api(null, 'GET', '/me')).status, 401);
  assert.equal((await api(null, 'GET', '/workspaces')).status, 401);
  assert.equal((await api(admin, 'GET', '/me')).data.admin, true);
});

test('a removed Owner of workspace 1 loses access at once', async () => {
  const u = await newUser();
  await db().run("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES (1, ?, 'Workspace Owner', 'Active')", [u.userId]);
  assert.equal((await api(u, 'GET', '/users')).status, 200);
  await db().run("UPDATE workspace_members SET status = 'Removed' WHERE workspace_id = 1 AND user_id = ?", [u.userId]);
  assert.equal((await api(u, 'GET', '/users')).status, 403);
});

test('the admin creates a workspace for a user, who owns it and can open it; the admin is not added', async () => {
  const name = `Acme ${Date.now()}`;
  const r = await create({ name, industry: 'Food' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const w = r.data.workspace;
  assert.deepEqual([w.name, w.status, w.memberCount], [name, 'Active', 1]);
  assert.deepEqual(r.data.members.map(m => [m.userId, m.role]), [[user.userId, 'Workspace Owner']]);
  const mine = await h.api('GET', '/api/v1/workspaces', { token: user.token });
  assert.ok(mine.data.workspaces.some(x => x.id === w.id), 'it appears in their workspace switcher');
  const sw = await h.api('POST', '/api/v1/auth/switch-workspace', { token: user.token, body: { workspaceId: w.id } });
  assert.equal(sw.status, 200, JSON.stringify(sw.data));
  assert.equal((await h.api('GET', '/api/v1/leads', { token: sw.data.token })).status, 200);
  const switchAdmin = await h.api('POST', '/api/v1/auth/switch-workspace', { token: admin.token, body: { workspaceId: w.id } });
  assert.equal(switchAdmin.status, 403, 'creating it does not make the admin a member');
});

test('the self-service limit on owned workspaces does not stop the admin', async () => {
  const prev = process.env.MAX_OWNED_WORKSPACES;
  process.env.MAX_OWNED_WORKSPACES = '1';
  try {
    assert.equal((await create()).status, 200);
  } finally {
    if (prev === undefined) delete process.env.MAX_OWNED_WORKSPACES; else process.env.MAX_OWNED_WORKSPACES = prev;
  }
});

test('bad input is refused', async () => {
  for (const body of [{ ownerUserId: user.userId }, { name: 'x', ownerUserId: user.userId }, { name: 'Fine name' }, { name: 'Fine name', ownerUserId: 'me' }, { name: 'Fine name', ownerUserId: user.userId, plan: 'Enterprise' }]) {
    assert.equal((await api(admin, 'POST', '/workspaces', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await create({ ownerUserId: 99999999 })).data.code, 'INVALID_USER');
  const off = await newUser();
  await db().run("UPDATE users SET status = 'Suspended' WHERE id = ?", [off.userId]);
  assert.equal((await create({ ownerUserId: off.userId })).data.code, 'INVALID_USER');
  const w = (await create()).data.workspace;
  assert.equal((await api(admin, 'POST', `/workspaces/${w.id}/members`, { userId: owner.userId, role: 'King' })).status, 400);
  assert.equal((await api(admin, 'POST', '/workspaces/99999999/members', { userId: owner.userId, role: 'Member' })).status, 404);
  assert.equal((await api(admin, 'GET', '/workspaces/abc')).status, 400);
  assert.equal((await api(admin, 'GET', '/activity?from=yesterday')).status, 400);
});

test('assigning: add a user, change their role, remove them, and bring them back', async () => {
  const w = (await create()).data.workspace;
  const u = await newUser();
  const added = await api(admin, 'POST', `/workspaces/${w.id}/members`, { userId: u.userId, role: 'Member' });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.ok(added.data.members.some(m => m.userId === u.userId && m.role === 'Member'));
  const sw = await h.api('POST', '/api/v1/auth/switch-workspace', { token: u.token, body: { workspaceId: w.id } });
  const scoped = { token: sw.data.token };
  assert.equal((await h.api('GET', '/api/v1/leads', scoped)).status, 200);
  const changed = await api(admin, 'POST', `/workspaces/${w.id}/members`, { userId: u.userId, role: 'Approver' });
  assert.ok(changed.data.members.some(m => m.userId === u.userId && m.role === 'Approver'));
  assert.equal((await h.api('POST', '/api/v1/leads', { ...scoped, body: { name: 'x' } })).status, 403, 'the new role applies at once');
  assert.equal((await api(admin, 'DELETE', `/workspaces/${w.id}/members/${u.userId}`)).status, 200);
  assert.equal((await h.api('GET', '/api/v1/leads', scoped)).status, 401, 'removal applies at once');
  assert.equal((await api(admin, 'POST', `/workspaces/${w.id}/members`, { userId: u.userId, role: 'Member' })).status, 200, 'a former member can come back');
  assert.equal((await api(admin, 'DELETE', `/workspaces/${w.id}/members/99999999`)).status, 404);
});

test('a change of role or removal clears extra capability grants', async () => {
  const w = (await create()).data.workspace;
  const u = await newUser();
  await api(admin, 'POST', `/workspaces/${w.id}/members`, { userId: u.userId, role: 'Marketing Manager' });
  await db().run("INSERT INTO workspace_member_capability_grants (workspace_id, user_id, capability) VALUES (?, ?, 'mail.send_transactional')", [w.id, u.userId]);
  await api(admin, 'DELETE', `/workspaces/${w.id}/members/${u.userId}`);
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM workspace_member_capability_grants WHERE workspace_id = ? AND user_id = ?', [w.id, u.userId])).n), 0);
});

test('a workspace always keeps an Owner, and a second Owner makes the first removable', async () => {
  const w = (await create()).data.workspace;
  assert.equal((await api(admin, 'DELETE', `/workspaces/${w.id}/members/${user.userId}`)).data.code, 'LAST_OWNER');
  assert.equal((await api(admin, 'POST', `/workspaces/${w.id}/members`, { userId: user.userId, role: 'Member' })).data.code, 'LAST_OWNER');
  const second = await newUser();
  assert.equal((await api(admin, 'POST', `/workspaces/${w.id}/members`, { userId: second.userId, role: 'Workspace Owner' })).status, 200);
  assert.equal((await api(admin, 'DELETE', `/workspaces/${w.id}/members/${user.userId}`)).status, 200);
});

test('nobody becomes or stops being platform admin from this screen', async () => {
  const u = await newUser();
  assert.equal((await api(admin, 'POST', '/workspaces/1/members', { userId: u.userId, role: 'Workspace Owner' })).data.code, 'PROTECTED_WORKSPACE');
  assert.equal((await api(u, 'GET', '/users')).status, 403);
  assert.equal((await api(admin, 'POST', '/workspaces/1/members', { userId: admin.userId, role: 'Member' })).data.code, 'PROTECTED_WORKSPACE');
  assert.equal((await api(admin, 'DELETE', `/workspaces/1/members/${admin.userId}`)).data.code, 'PROTECTED_WORKSPACE');
  assert.equal((await api(admin, 'POST', '/workspaces/1/members', { userId: u.userId, role: 'Member' })).status, 200, 'other roles are fine');
  assert.equal((await api(u, 'GET', '/users')).status, 403);
  assert.equal((await api(admin, 'GET', '/workspaces/1')).data.workspace.protected, true);
});

test('the admin sees every workspace and user, with owners, counts and memberships', async () => {
  const name = `Listed ${Date.now()}`;
  const w = (await create({ name })).data.workspace;
  await db().run("INSERT INTO leads (workspace_id, name) VALUES (?, 'A lead')", [w.id]);
  const list = (await api(admin, 'GET', `/workspaces?q=${encodeURIComponent(name)}`)).data;
  assert.equal(list.workspaces.length, 1);
  assert.equal(list.workspaces[0].leadCount, 1);
  assert.match(list.workspaces[0].owners, /User /);
  assert.ok(list.roles.includes('Workspace Owner'));
  const all = (await api(admin, 'GET', '/workspaces')).data.workspaces;
  assert.ok(all.some(x => x.id === owner.workspaceId) && all.some(x => x.id === admin.workspaceId));
  const found = (await api(admin, 'GET', `/users?q=${encodeURIComponent(user.email)}`)).data.users;
  assert.deepEqual(found.map(u => u.id), [user.userId]);
  assert.ok(found[0].workspaces.some(x => x.id === w.id && x.role === 'Workspace Owner'));
  assert.ok(!JSON.stringify(found).includes('password'));
  assert.ok(!JSON.stringify((await api(admin, 'GET', '/users')).data).includes('password_hash'));
});

test('activity across workspaces, filtered by workspace, user and date, without stored details', async () => {
  const lead = await h.api('POST', '/api/v1/leads', { token: owner.token, body: { name: 'Tracked' } });
  assert.equal(lead.status, 200);
  const r = (await api(admin, 'GET', `/activity?workspaceId=${owner.workspaceId}`)).data;
  assert.ok(r.activity.some(a => a.action === 'leads.created' && a.userId === owner.userId && a.workspaceName && a.userName));
  assert.ok(r.activity.every(a => a.workspaceId === owner.workspaceId));
  assert.ok(!('metadata_json' in r.activity[0]) && !('metadata' in r.activity[0]));
  assert.ok((await api(admin, 'GET', `/activity?userId=${owner.userId}`)).data.activity.every(a => a.userId === owner.userId));
  assert.equal((await api(admin, 'GET', `/activity?workspaceId=${owner.workspaceId}&from=2001-01-01&to=2001-01-02`)).data.activity.length, 0);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok((await api(admin, 'GET', `/activity?workspaceId=${owner.workspaceId}&from=${today}&to=${today}`)).data.activity.length > 0);
});

test('admin changes and views land in the affected workspace\'s own log', async () => {
  const w = (await create()).data.workspace;
  const u = await newUser();
  await api(admin, 'POST', `/workspaces/${w.id}/members`, { userId: u.userId, role: 'Member' });
  await api(admin, 'DELETE', `/workspaces/${w.id}/members/${u.userId}`);
  await api(admin, 'GET', `/workspaces/${w.id}`);
  const rows = await db().all('SELECT action, actor_user_id FROM audit_logs WHERE workspace_id = ? ORDER BY id', [w.id]);
  const actions = rows.map(r => r.action);
  for (const a of ['platform.workspace_created', 'platform.member_assigned', 'platform.member_removed', 'platform.workspace_viewed']) assert.ok(actions.includes(a), a);
  assert.ok(rows.filter(r => r.action.startsWith('platform.')).every(r => r.actor_user_id === admin.userId));
});

// ------------------------------------------------------------------ open workspace

const openIn = async (workspaceId, u = admin) => (await api(u, 'POST', `/workspaces/${workspaceId}/open`, {})).data;

test('the admin can open any workspace with full rights, without joining it', async () => {
  const lead = (await h.api('POST', '/api/v1/leads', { token: owner.token, body: { name: 'Their lead' } })).data.lead;
  const s = await openIn(owner.workspaceId);
  assert.ok(s.token);
  assert.deepEqual([s.workspace.id, s.workspace.adminAccess, s.role], [owner.workspaceId, true, 'Workspace Owner']);
  const inside = { token: s.token };
  assert.equal((await h.api('GET', `/api/v1/leads/${lead.id}`, inside)).data.lead.name, 'Their lead');
  assert.equal((await h.api('PATCH', `/api/v1/leads/${lead.id}`, { ...inside, body: { phone: '+61 400 123 456' } })).status, 200);
  const me = await h.api('GET', '/api/v1/auth/me', inside);
  assert.ok(['leads.manage', 'mail.configure', 'members.manage', 'billing.manage'].every(c => me.data.capabilities.includes(c)), 'every capability');
  assert.equal((await db().get('SELECT 1 AS x FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [owner.workspaceId, admin.userId])) ?? null, null, 'not added as a member');
  const members = await h.api('GET', '/api/v1/workspace/members', inside);
  assert.ok(!members.data.members.some(m => m.userId === admin.userId), 'not shown among its members');
  assert.equal((await api({ token: s.token }, 'GET', '/users')).status, 200, 'still the admin while inside');
});

test('what the admin does inside is in that workspace\'s log under their own name', async () => {
  const s = await openIn(owner.workspaceId);
  await h.api('POST', '/api/v1/leads', { token: s.token, body: { name: 'Added by admin' } });
  const rows = await db().all("SELECT action, actor_user_id, workspace_id FROM audit_logs WHERE workspace_id = ? AND actor_user_id = ? AND action IN ('platform.workspace_entered', 'leads.created')", [owner.workspaceId, admin.userId]);
  assert.deepEqual([...new Set(rows.map(r => r.action))].sort(), ['leads.created', 'platform.workspace_entered']);
});

test('nobody else can open a workspace, and a forged or stale claim gets nothing', async () => {
  for (const u of [owner, user]) assert.equal((await api(u, 'POST', `/workspaces/${admin.workspaceId}/open`, {})).status, 403);
  const { createToken } = require('../services/authService');
  const forged = createToken({ userId: owner.userId, email: owner.email, workspaceId: admin.workspaceId, role: 'Workspace Owner', platformAccess: true });
  assert.equal((await h.api('GET', '/api/v1/leads', { token: forged })).status, 401, 'the claim alone proves nothing');
  const tampered = owner.token.replace(/^([^.]+)\.[^.]+\./, (m, head) => `${head}.${Buffer.from(JSON.stringify({ userId: owner.userId, workspaceId: admin.workspaceId, platformAccess: true })).toString('base64url')}.`);
  assert.equal((await h.api('GET', '/api/v1/leads', { token: tampered })).status, 401);
  assert.equal((await api(admin, 'POST', '/workspaces/99999999/open', {})).status, 404);
});

test('admin access ends the moment the person stops being the admin', async () => {
  const u = await newUser();
  await db().run("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES (1, ?, 'Workspace Owner', 'Active')", [u.userId]);
  const s = await openIn(owner.workspaceId, u);
  assert.equal((await h.api('GET', '/api/v1/leads', { token: s.token })).status, 200);
  await db().run("UPDATE workspace_members SET status = 'Removed' WHERE workspace_id = 1 AND user_id = ?", [u.userId]);
  assert.equal((await h.api('GET', '/api/v1/leads', { token: s.token })).status, 401);
});

test('a suspended admin account loses access inside a workspace', async () => {
  const u = await newUser();
  await db().run("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES (1, ?, 'Workspace Owner', 'Active')", [u.userId]);
  const s = await openIn(owner.workspaceId, u);
  await db().run("UPDATE users SET status = 'Suspended' WHERE id = ?", [u.userId]);
  assert.equal((await h.api('GET', '/api/v1/leads', { token: s.token })).status, 401);
  await db().run("UPDATE workspace_members SET status = 'Removed' WHERE workspace_id = 1 AND user_id = ?", [u.userId]);
});

test('the admin can get back to their own workspace, and work done inside can be carried out', async () => {
  const s = await openIn(owner.workspaceId);
  const back = await h.api('POST', '/api/v1/auth/switch-workspace', { token: s.token, body: { workspaceId: admin.workspaceId } });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.workspace.id, admin.workspaceId);
  assert.equal(back.data.workspace.adminAccess, undefined);
  const { workerAuthorizationProblem } = require('../lib/workerAuthorization');
  assert.equal(await workerAuthorizationProblem(owner.workspaceId, admin.userId, 'mail.send'), null, 'an approval by the admin stays valid');
  const other = await newUser();
  assert.ok(await workerAuthorizationProblem(owner.workspaceId, other.userId, 'mail.send'), 'others still must be members');
});

test('normal workspace isolation is unchanged', async () => {
  const lead = (await h.api('POST', '/api/v1/leads', { token: owner.token, body: { name: 'Private' } })).data.lead;
  assert.equal((await h.api('GET', `/api/v1/leads/${lead.id}`, { token: user.token })).status, 404);
  assert.equal((await h.api('GET', `/api/v1/leads/${lead.id}`, { token: admin.token })).status, 404, 'the admin has no back door into a workspace\'s records');
});
