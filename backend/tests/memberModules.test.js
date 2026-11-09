const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Section ("module") access per member: chosen on invite, edited by Owners/Admins, enforced by the server.
const db = () => h.db();
const PASSWORD = 'correct-horse-battery-1';
const newEmail = () => `m-${crypto.randomBytes(5).toString('hex')}@corp.io`;
const api = (who, method, path, body) => h.api(method, path, { token: who.token || who, body });

async function register(name, email = newEmail()) {
  const r = await h.api('POST', '/api/v1/auth/register', { body: { email, password: PASSWORD, displayName: name, workspaceName: `${name} WS` } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { email, token: r.data.token, userId: r.data.user.id, workspaceId: r.data.workspace.id };
}

test.before(async () => { await h.prepareDatabase(); });
test.after(() => h.shutdown());

let owner;
let guest;
let guestSession;

test('an invitation can limit the sections; the invitee gets exactly those, enforced by the server', async () => {
  owner = await register('Section Owner');
  guest = await register('Social Person');
  const inv = await api(owner, 'POST', '/api/v1/workspace/invitations', { email: guest.email, role: 'Marketing Manager', modules: ['social', 'nonsense', 'social'] });
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  assert.deepEqual(inv.data.invitation.modules.keys, ['social'], 'unknown keys dropped, no duplicates');
  const pending = (await api(owner, 'GET', '/api/v1/workspace/members')).data.invitations[0];
  assert.deepEqual(pending.modules.keys, ['social']);

  const token = new URL(inv.data.link).searchParams.get('invite');
  const acc = await api(guest, 'POST', '/api/v1/invitations/accept', { token });
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  guestSession = acc.data.session.token;

  const me = (await api(guestSession, 'GET', '/api/v1/auth/me')).data;
  assert.deepEqual(me.modules, ['social']);

  // Allowed: social, the overview dashboard, and reading products (needed to pick one in a campaign).
  assert.equal((await api(guestSession, 'GET', '/api/v1/social/accounts')).status, 200);
  assert.equal((await api(guestSession, 'GET', '/api/v1/social/dashboard')).status, 200);
  assert.equal((await api(guestSession, 'GET', '/api/v1/products')).status, 200);
  // Refused: other sections, and editing products.
  for (const [method, path] of [['GET', '/api/v1/leads'], ['GET', '/api/leads'], ['GET', '/api/v1/mail/campaigns'], ['GET', '/api/v1/emails'], ['GET', '/api/v1/command/programs'], ['POST', '/api/v1/products']]) {
    const r = await api(guestSession, method, path, method === 'POST' ? { name: 'X' } : undefined);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.data.code, 'MODULE_ACCESS_REQUIRED');
  }
});

test('Owners/Admins change a member\'s sections and it applies at once; the change is audited', async () => {
  const list = (await api(owner, 'GET', '/api/v1/workspace/members')).data;
  assert.ok(list.modules.some(m => m.key === 'leads'));
  assert.deepEqual(list.fullAccessRoles, ['Workspace Owner', 'Workspace Admin']);
  assert.equal(list.crmRoles, null, 'only the platform admin sees CRM assignment');
  const m = list.members.find(x => x.userId === guest.userId);
  assert.deepEqual(m.modules.keys, ['social']);

  const put = await api(owner, 'PUT', `/api/v1/workspace/members/${guest.userId}/modules`, { modules: ['leads', 'social'] });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual(put.data.modules.keys, ['leads', 'social']);
  assert.equal((await api(guestSession, 'GET', '/api/v1/leads')).status, 200, 'same session, new access');

  const none = await api(owner, 'PUT', `/api/v1/workspace/members/${guest.userId}/modules`, { modules: [] });
  assert.deepEqual(none.data.modules.keys, []);
  assert.equal((await api(guestSession, 'GET', '/api/v1/social/accounts')).status, 403);

  const all = await api(owner, 'PUT', `/api/v1/workspace/members/${guest.userId}/modules`, { modules: null });
  assert.equal(all.data.modules.all, true);
  assert.equal((await api(guestSession, 'GET', '/api/v1/mail/campaigns')).status, 200);

  const audits = await db().all("SELECT action FROM audit_logs WHERE workspace_id = ? AND action = 'workspace.member_modules_changed'", [owner.workspaceId]);
  assert.equal(audits.length, 3);
});

test('existing members keep every section; Owners/Admins always have all; only managers can change access', async () => {
  const ws = await h.createWorkspace({ name: 'Old members' });
  const old = await h.addMember(ws.workspaceId, 'Member');
  const admin = await h.addMember(ws.workspaceId, 'Workspace Admin');
  assert.equal((await api(old, 'GET', '/api/v1/leads')).status, 200, 'no list stored = all sections');
  assert.equal((await api(old, 'GET', '/api/v1/auth/me')).data.modules.length, 7);

  const forAdmin = await api(ws, 'PUT', `/api/v1/workspace/members/${admin.userId}/modules`, { modules: ['social'] });
  assert.equal(forAdmin.status, 409);
  assert.equal(forAdmin.data.code, 'FULL_ACCESS_ROLE');
  // A stored list is ignored once someone becomes Admin.
  await db().run('UPDATE workspace_members SET module_access_json = ? WHERE user_id = ? AND workspace_id = ?', ['[]', admin.userId, ws.workspaceId]);
  assert.equal((await api(admin, 'GET', '/api/v1/leads')).status, 200);

  assert.equal((await api(old, 'PUT', `/api/v1/workspace/members/${admin.userId}/modules`, { modules: [] })).status, 403, 'a Member cannot change access');
  assert.equal((await api(ws, 'PUT', `/api/v1/workspace/members/${guest.userId}/modules`, { modules: [] })).status, 404, 'not a member of this workspace');
  assert.equal((await api(ws, 'PUT', `/api/v1/workspace/members/${ws.userId}/modules`, { modules: [] })).status, 409, 'not your own access');
});

test('CRM access can be assigned only by the platform admin', async () => {
  assert.equal((await api(owner, 'PUT', `/api/v1/workspace/members/${guest.userId}/crm`, { role: 'viewer' })).status, 403);

  await db().run("INSERT IGNORE INTO workspaces (id, name, slug, owner_email, plan, status, created_at) VALUES (1, 'Platform', 'platform-test', 'owner@example.test', 'Starter', 'Active', UTC_TIMESTAMP())");
  const { createToken } = require('../services/authService');
  const adminUser = await h.createWorkspace({ name: 'Platform admin' });
  await db().run("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES (1, ?, 'Workspace Owner', 'Active') ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'Active'", [adminUser.userId]);
  const admin = { token: createToken({ userId: adminUser.userId, workspaceId: 1, email: adminUser.email, role: 'Workspace Owner' }) };
  const teammate = await h.addMember(1, 'Member');

  const list = (await api(admin, 'GET', '/api/v1/workspace/members')).data;
  assert.deepEqual(list.crmRoles, ['viewer', 'sales', 'support', 'manager']);
  assert.equal(list.members.find(m => m.userId === teammate.userId).crmRole, null);

  assert.equal((await api(teammate, 'GET', '/api/v1/global-crm/contacts')).status, 403);
  const g = await api(admin, 'PUT', `/api/v1/workspace/members/${teammate.userId}/crm`, { role: 'sales' });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.equal((await api(teammate, 'GET', '/api/v1/global-crm/contacts')).status, 200);
  assert.equal((await api(admin, 'GET', '/api/v1/workspace/members')).data.members.find(m => m.userId === teammate.userId).crmRole, 'sales');
  assert.equal((await api(admin, 'PUT', `/api/v1/workspace/members/${teammate.userId}/crm`, { role: 'superuser' })).status, 400);
  assert.equal((await api(admin, 'PUT', `/api/v1/workspace/members/${teammate.userId}/crm`, { role: null })).status, 200);
  assert.equal((await api(teammate, 'GET', '/api/v1/global-crm/contacts')).status, 403);

  await db().run("UPDATE workspace_members SET status = 'Removed' WHERE workspace_id = 1 AND user_id IN (?, ?)", [adminUser.userId, teammate.userId]);
});
