const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Multi-workspace support: list, create, switch; membership checks; isolation after switching.
const db = () => h.db();
const PASSWORD = 'correct-horse-battery-1';
const aiDown = { match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) };
const email = () => `ws-user-${crypto.randomBytes(5).toString('hex')}@corp.io`;

async function register(name = 'First Workspace') {
  const e = email();
  const r = await h.api('POST', '/api/v1/auth/register', { body: { email: e, password: PASSWORD, displayName: 'Owner', workspaceName: name, industry: 'Retail' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { email: e, ...r.data };
}
async function addLead(token, name) {
  const mock = h.mockFetch([aiDown]);
  try {
    const r = await h.api('POST', '/api/v1/leads', { token, body: { name } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.lead.id;
  } finally { mock.restore(); }
}
const leadNames = async token => (await h.api('GET', '/api/v1/leads?limit=200', { token })).data.leads.map(l => l.name);

test.before(async () => { await h.prepareDatabase(); });
test.after(() => h.shutdown());

test('migration 015: memberships are unique per workspace and user, indexed and linked', async () => {
  const idx = await db().all("SELECT INDEX_NAME AS i, NON_UNIQUE AS u FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_members' GROUP BY INDEX_NAME, NON_UNIQUE");
  assert.ok(idx.some(x => x.i === 'uq_workspace_members_ws_user' && Number(x.u) === 0));
  assert.ok(idx.some(x => x.i === 'idx_workspace_members_user'));
  const fks = await db().all("SELECT CONSTRAINT_NAME AS n FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_members' AND CONSTRAINT_TYPE = 'FOREIGN KEY'");
  assert.deepEqual(fks.map(f => f.n).sort(), ['fk_workspace_members_user', 'fk_workspace_members_ws']);

  const ws = await h.createWorkspace({ name: 'Dup check' });
  await assert.rejects(
    db().run("INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at) VALUES (?, ?, 'Member', 'Active', UTC_TIMESTAMP())", [ws.workspaceId, ws.userId]),
    /Duplicate entry/
  );
});

test('registration and login keep working; the session lists the user\'s workspaces', async () => {
  const r = await register('Alpha Traders');
  assert.ok(r.token);
  assert.equal(r.workspace.name, 'Alpha Traders');
  assert.equal(r.role, 'Workspace Owner');
  assert.deepEqual(r.workspaces.map(w => w.name), ['Alpha Traders']);

  const login = await h.api('POST', '/api/v1/auth/login', { body: { email: r.email, password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.equal(login.data.workspace.id, r.workspace.id, 'without a choice the first workspace is used, as before');
  assert.equal((await h.api('POST', '/api/v1/auth/login', { body: { email: r.email, password: 'wrong-password-123' } })).status, 401);
  assert.equal((await h.api('POST', '/api/v1/auth/register', { body: { email: r.email, password: PASSWORD, workspaceName: 'Again' } })).status, 400, 'duplicate email still refused');

  const me = await h.api('GET', '/api/v1/auth/me', { token: r.token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.workspaces.map(w => w.id), [r.workspace.id]);
  const plan = await db().get("SELECT id FROM plans WHERE plan_key = 'starter'");
  if (plan) assert.equal(me.data.subscriptionStatus, 'Active');
});

test('"me" never invents a subscription: none is reported as none', async () => {
  const ws = await h.createWorkspace({ name: 'No plan' });
  const me = await h.api('GET', '/api/v1/auth/me', { token: ws.token });
  assert.equal(me.data.subscription, null);
  assert.equal(me.data.subscriptionStatus, 'none');
});

test('create a second workspace, switch between them, and data stays separate in both directions', async () => {
  const r = await register('Home Workspace');
  const leadA = await addLead(r.token, 'Lead in Home');

  const created = await h.api('POST', '/api/v1/workspaces', { token: r.token, body: { name: 'Second Brand', industry: 'Logistics' } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const B = created.data;
  assert.equal(B.workspace.name, 'Second Brand');
  assert.equal(B.role, 'Workspace Owner');
  assert.notEqual(B.workspace.id, r.workspace.id);
  assert.deepEqual(B.workspaces.map(w => w.name), ['Home Workspace', 'Second Brand']);
  assert.ok(await db().get('SELECT id FROM business_profiles WHERE workspace_id = ?', [B.workspace.id]));

  // The new token works in the new workspace and sees none of the first workspace's data.
  assert.deepEqual(await leadNames(B.token), []);
  assert.equal((await h.api('GET', `/api/v1/leads/${leadA}`, { token: B.token })).status, 404);
  const leadB = await addLead(B.token, 'Lead in Second');

  const list = await h.api('GET', '/api/v1/workspaces', { token: B.token });
  assert.equal(list.data.currentWorkspaceId, B.workspace.id);
  assert.deepEqual(list.data.workspaces.map(w => w.id), [r.workspace.id, B.workspace.id]);

  const back = await h.api('POST', '/api/v1/auth/switch-workspace', { token: B.token, body: { workspaceId: r.workspace.id } });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.workspace.id, r.workspace.id);
  assert.deepEqual(await leadNames(back.data.token), ['Lead in Home']);
  assert.equal((await h.api('GET', `/api/v1/leads/${leadB}`, { token: back.data.token })).status, 404);

  // Each token stays bound to its own workspace.
  assert.deepEqual(await leadNames(r.token), ['Lead in Home']);
  assert.deepEqual(await leadNames(B.token), ['Lead in Second']);

  // Login can pick a workspace the user belongs to.
  const pick = await h.api('POST', '/api/v1/auth/login', { body: { email: r.email, password: PASSWORD, workspaceId: B.workspace.id } });
  assert.equal(pick.data.workspace.id, B.workspace.id);
  assert.deepEqual(await leadNames(pick.data.token), ['Lead in Second']);
});

test('switching or logging in to a workspace without an active membership is refused', async () => {
  const r = await register('Mine');
  const other = await h.createWorkspace({ name: 'Not mine' });
  const tries = [
    [{ workspaceId: other.workspaceId }, 403, 'NOT_A_MEMBER'],
    [{ workspaceId: 999999999 }, 403, 'NOT_A_MEMBER'],
    [{ workspaceId: 'abc' }, 400, 'VALIDATION_ERROR'],
    [{}, 400, 'VALIDATION_ERROR']
  ];
  for (const [body, status, code] of tries) {
    const res = await h.api('POST', '/api/v1/auth/switch-workspace', { token: r.token, body });
    assert.deepEqual([res.status, res.data.code], [status, code], JSON.stringify(body));
  }
  const login = await h.api('POST', '/api/v1/auth/login', { body: { email: r.email, password: PASSWORD, workspaceId: other.workspaceId } });
  assert.deepEqual([login.status, login.data.code], [403, 'NOT_A_MEMBER']);
  assert.ok(!login.data.token);

  // A disabled membership no longer counts, and its existing token stops working.
  const second = (await h.api('POST', '/api/v1/workspaces', { token: r.token, body: { name: 'Will be disabled' } })).data;
  await db().run("UPDATE workspace_members SET status = 'Disabled' WHERE workspace_id = ? AND user_id = ?", [second.workspace.id, r.user.id]);
  const res = await h.api('POST', '/api/v1/auth/switch-workspace', { token: r.token, body: { workspaceId: second.workspace.id } });
  assert.equal(res.status, 403);
  assert.equal((await h.api('GET', '/api/v1/leads', { token: second.token })).status, 401);
  assert.deepEqual((await h.api('GET', '/api/v1/workspaces', { token: r.token })).data.workspaces.map(w => w.name), ['Mine']);

  assert.equal((await h.api('GET', '/api/v1/workspaces')).status, 401);
  assert.equal((await h.api('POST', '/api/v1/workspaces', { body: { name: 'Anon' } })).status, 401);
});

test('workspace-1-only modules stay closed in other workspaces; the workspace list says so', async () => {
  const r = await register('Elsewhere');
  const appts = await h.api('GET', '/api/appointments', { token: r.token });
  assert.deepEqual([appts.status, appts.data.code], [403, 'MODULE_NOT_TENANT_AWARE']);
  const created = (await h.api('POST', '/api/v1/workspaces', { token: r.token, body: { name: 'Another' } })).data;
  assert.equal((await h.api('GET', '/api/appointments', { token: created.token })).status, 403);
  const list = await h.api('GET', '/api/v1/workspaces', { token: created.token });
  assert.equal(list.status, 200, 'the workspace list itself works in every workspace');
  assert.ok(list.data.workspaces.every(w => w.legacyModules === false));
  assert.equal(r.workspace.legacyModules, false, 'registration tells the UI too');
  // In workspace 1 the same modules work and are flagged as available.
  const main = await h.addMember(1, 'Member');
  assert.notEqual((await h.api('GET', '/api/appointments', { token: main.token })).status, 403);
  const mainList = await h.api('GET', '/api/v1/workspaces', { token: main.token });
  assert.deepEqual(mainList.data.workspaces.map(w => [w.id, w.legacyModules]), [[1, true]]);
});

test('creating workspaces is validated and limited', async () => {
  const r = await register('Limits');
  for (const [body, msg] of [[{}, /name/], [{ name: 'x' }, /at least 2/], [{ name: 'Ok name', workspaceId: 1 }, /Unrecognized key/]]) {
    const res = await h.api('POST', '/api/v1/workspaces', { token: r.token, body });
    assert.equal(res.status, 400);
    assert.match(res.data.error, msg);
  }
  process.env.MAX_OWNED_WORKSPACES = '2';
  try {
    assert.equal((await h.api('POST', '/api/v1/workspaces', { token: r.token, body: { name: 'Second' } })).status, 200);
    const third = await h.api('POST', '/api/v1/workspaces', { token: r.token, body: { name: 'Third' } });
    assert.deepEqual([third.status, third.data.code], [409, 'WORKSPACE_LIMIT']);
  } finally { delete process.env.MAX_OWNED_WORKSPACES; }
});

test('registration and workspace creation are all-or-nothing', async () => {
  // Test database only: make the business profile insert fail for one marker name. Trigger DDL
  // needs a plain (non-prepared) query, so it uses its own connection to the test database.
  assert.match(process.env.DB_NAME, /_test$/);
  const mysql = require('mysql2/promise');
  const raw = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: parseInt(process.env.DB_PORT || '3306', 10), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME });
  await raw.query('DROP TRIGGER IF EXISTS test_fail_profile');
  await raw.query(`CREATE TRIGGER test_fail_profile BEFORE INSERT ON business_profiles FOR EACH ROW
    BEGIN IF NEW.business_name = 'FAIL ATOMIC' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced failure'; END IF; END`);
  try {
    const e = email();
    const bad = await h.api('POST', '/api/v1/auth/register', { body: { email: e, password: PASSWORD, workspaceName: 'FAIL ATOMIC' } });
    assert.equal(bad.status, 400);
    assert.equal(await db().get('SELECT id FROM users WHERE email = ?', [e]), null, 'no user left behind');
    assert.equal(await db().get("SELECT id FROM workspaces WHERE name = 'FAIL ATOMIC'"), null, 'no workspace left behind');

    const r = await register('Atomic Owner');
    const before = Number((await db().get('SELECT COUNT(*) AS n FROM workspace_members WHERE user_id = ?', [r.user.id])).n);
    const failed = await h.api('POST', '/api/v1/workspaces', { token: r.token, body: { name: 'FAIL ATOMIC' } });
    assert.ok(failed.status >= 500);
    assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM workspace_members WHERE user_id = ?', [r.user.id])).n), before);
    assert.equal(await db().get("SELECT id FROM workspaces WHERE name = 'FAIL ATOMIC'"), null);
  } finally {
    await raw.query('DROP TRIGGER IF EXISTS test_fail_profile');
    await raw.end();
  }
});
