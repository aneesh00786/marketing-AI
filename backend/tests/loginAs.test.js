const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// "Log in as user" (Members): Owners/Admins open the workspace as a lower-role member without the member's
// password. The opener is signed out; the session is marked, limited to the workspace and an hour, audited,
// and cannot change the member's account. The member's password is never touched.
const db = () => h.db();
const authService = () => require('../services/authService');
let OWNER; let ADMIN; let MEM; let OTHER;
// A fresh session for each attempt: a successful one signs the opener out (by design).
const fresh = who => authService().createToken({ userId: who.userId, workspaceId: who.ctx.auth.workspaceId, role: who.ctx.auth.role });
const loginAs = (who, target) => h.api('POST', `/api/v1/workspace/members/${target.userId}/login-as`, { token: fresh(who) });
const asToken = r => r.data.token; // API clients (no browser header) get the token in the body

test.before(async () => {
  await h.prepareDatabase();
  OWNER = await h.createWorkspace({ name: 'Login as' });
  ADMIN = await h.addMember(OWNER.workspaceId, 'Workspace Admin');
  MEM = await h.addMember(OWNER.workspaceId, 'Member');
  OTHER = await h.createWorkspace({ name: 'Login as other' });
});
test.after(() => h.shutdown());

test("an Owner logs in as a member: their own session ends, the member's password is unchanged, it is audited", async () => {
  const before = await db().get('SELECT password_hash FROM users WHERE id = ?', [MEM.userId]);
  // A fresh owner session (signed out by this).
  const own = (await h.api('POST', '/api/v1/auth/login', { body: { email: OWNER.email, password: 'correct-horse-battery' } })).data.token;
  const r = await h.api('POST', `/api/v1/workspace/members/${MEM.userId}/login-as`, { token: own });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.id, MEM.userId);
  assert.equal(r.data.role, 'Member');
  assert.equal((await h.api('GET', '/api/v1/auth/me', { token: own })).status, 401, 'the owner was signed out');
  const me = await h.api('GET', '/api/v1/auth/me', { token: asToken(r) });
  assert.equal(me.status, 200);
  assert.equal(me.data.role, 'Member');
  assert.equal(me.data.impersonatedBy.email, OWNER.email);
  const p = authService().verifyToken(asToken(r));
  assert.ok(p.exp - p.iat <= 3600, 'an hour at most');
  assert.equal((await db().get('SELECT password_hash FROM users WHERE id = ?', [MEM.userId])).password_hash, before.password_hash, 'password untouched');
  const a = await db().get("SELECT actor_user_id, resource_id FROM audit_logs WHERE workspace_id = ? AND action = 'auth.login_as_started' ORDER BY id DESC LIMIT 1", [OWNER.workspaceId]);
  assert.deepEqual([Number(a.actor_user_id), a.resource_id], [OWNER.userId, String(MEM.userId)]);
});

test('while logged in as someone: no password change, sign-out everywhere, workspace switch or another login-as; actions are recorded with the opener', async () => {
  const r = await loginAs(OWNER, MEM);
  const t = asToken(r);
  for (const [m, p, body] of [
    ['POST', '/api/v1/auth/change-password', { currentPassword: 'x', newPassword: 'whatever-New-2026' }],
    ['POST', '/api/v1/auth/logout-all', {}],
    ['POST', '/api/v1/auth/switch-workspace', { workspaceId: OTHER.workspaceId }],
    ['POST', '/api/v1/workspaces', { name: 'Mine' }],
    ['POST', '/api/v1/invitations/accept', { token: crypto.randomBytes(16).toString('hex') }]
  ]) {
    const res = await h.api(m, p, { token: t, body });
    assert.equal(res.status, 403, `${m} ${p}`);
    assert.equal(res.data.code, 'IMPERSONATION_BLOCKED', `${m} ${p}`);
  }
  // Normal work goes through and is recorded as an impersonation by the opener.
  const lead = await h.api('POST', '/api/v1/leads', { token: t, body: { name: `Acme ${crypto.randomBytes(3).toString('hex')}`, email: 'kim@acme-co.io' } });
  assert.ok([200, 201].includes(lead.status), JSON.stringify(lead.data));
  const a = await db().get("SELECT actor_user_id, actor_type, metadata_json FROM audit_logs WHERE workspace_id = ? AND actor_type = 'impersonation' ORDER BY id DESC LIMIT 1", [OWNER.workspaceId]);
  assert.ok(a, 'audited as impersonation');
  assert.equal(Number(a.actor_user_id), MEM.userId);
  assert.equal(JSON.parse(a.metadata_json).impersonatedBy, OWNER.userId);
});

test('who may log in as whom: lower roles only, same workspace, never themselves or the platform admin', async () => {
  assert.equal((await loginAs(ADMIN, MEM)).status, 200, 'an Admin opens a Member');
  assert.equal((await loginAs(ADMIN, OWNER)).status, 403, 'not an Owner');
  const admin2 = await h.addMember(OWNER.workspaceId, 'Workspace Admin');
  assert.equal((await loginAs(ADMIN, admin2)).data.code, 'ROLE_TOO_HIGH', 'not another Admin');
  assert.equal((await loginAs(OWNER, ADMIN)).status, 200, 'an Owner opens an Admin');
  assert.equal((await loginAs(OWNER, OWNER)).status, 409, 'not themselves');
  assert.equal((await loginAs(MEM, ADMIN)).status, 403, 'a Member cannot');
  const outsider = await h.addMember(OTHER.workspaceId, 'Member');
  assert.equal((await loginAs(OWNER, outsider)).status, 404, 'another workspace');
});

test('the session ends when the opener stops being an Owner/Admin', async () => {
  const admin3 = await h.addMember(OWNER.workspaceId, 'Workspace Admin');
  const t = asToken(await loginAs(admin3, MEM));
  assert.equal((await h.api('GET', '/api/v1/auth/me', { token: t })).status, 200);
  await db().run("UPDATE workspace_members SET role = 'Member' WHERE workspace_id = ? AND user_id = ?", [OWNER.workspaceId, admin3.userId]);
  assert.equal((await h.api('GET', '/api/v1/auth/me', { token: t })).status, 401);
});
