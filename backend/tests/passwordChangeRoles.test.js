const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// "Change password" for every kind of account: Owner, Admin, Member, Marketing Manager, Approver,
// someone limited to a few sections, and the platform admin (also while viewing another workspace).
const db = () => h.db();
const OLD = 'correct-horse-battery';
const login = (email, password) => h.api('POST', '/api/v1/auth/login', { body: { email, password } });
const change = (token, currentPassword, newPassword) => h.api('POST', '/api/v1/auth/change-password', { token, body: { currentPassword, newPassword } });
const emailOf = async userId => (await db().get('SELECT email FROM users WHERE id = ?', [userId])).email;

test.before(async () => { await h.prepareDatabase(); });
test.after(() => h.shutdown());

async function checkChange(who, label) {
  const email = await emailOf(who.userId);
  const signIn = await login(email, OLD);
  assert.equal(signIn.status, 200, `${label}: can sign in`);
  const other = signIn.data.token; // another device
  const next = `new-pass-${crypto.randomBytes(4).toString('hex')}`;
  assert.equal((await change(who.token, 'wrong-password-x', next)).status, 400, `${label}: wrong current password refused`);
  const r = await change(who.token, OLD, next);
  assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.data)}`);
  assert.ok(r.data.token, `${label}: gets a fresh session`);
  assert.equal((await h.api('GET', '/api/v1/auth/me', { token: r.data.token })).status, 200, `${label}: stays signed in here`);
  assert.equal((await h.api('GET', '/api/v1/auth/me', { token: other })).status, 401, `${label}: other devices signed out`);
  assert.equal((await login(email, OLD)).status, 401, `${label}: old password no longer works`);
  assert.equal((await login(email, next)).status, 200, `${label}: new password works`);
  return r.data;
}

test('every workspace role can change their own password', async () => {
  const owner = await h.createWorkspace({ name: 'Roles' });
  await checkChange(owner, 'Workspace Owner');
  for (const role of ['Workspace Admin', 'Marketing Manager', 'Approver', 'Member']) {
    const m = await h.addMember(owner.workspaceId, role);
    const r = await checkChange(m, role);
    assert.equal(r.workspace.id, owner.workspaceId, `${role}: stays in the same workspace`);
    assert.equal(r.role, role);
  }
});

test('a member limited to some sections can still change their password', async () => {
  const owner = await h.createWorkspace({ name: 'Limited' });
  const m = await h.addMember(owner.workspaceId, 'Member');
  await db().run('UPDATE workspace_members SET module_access_json = ? WHERE workspace_id = ? AND user_id = ?', ['[]', owner.workspaceId, m.userId]);
  await checkChange(m, 'Member with no sections');
});

test('the platform admin can change their password, also while viewing another workspace', async () => {
  await db().run("INSERT IGNORE INTO workspaces (id, name, slug, owner_email, plan, status, created_at) VALUES (1, 'Platform', 'platform-test', 'owner@example.test', 'Starter', 'Active', UTC_TIMESTAMP())");
  const admin = await h.createWorkspace({ name: 'Admin home' });
  await db().run("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES (1, ?, 'Workspace Owner', 'Active') ON DUPLICATE KEY UPDATE role = 'Workspace Owner', status = 'Active'", [admin.userId]);
  await checkChange(admin, 'Platform admin');

  // Viewing a workspace they are not a member of (Platform Admin → Open workspace).
  const email = await emailOf(admin.userId);
  const pw = `admin-pass-${crypto.randomBytes(4).toString('hex')}`;
  await db().run('UPDATE users SET password_hash = ? WHERE id = ?', [require('../services/authService').hashPassword(pw), admin.userId]);
  const session = (await login(email, pw)).data.token;
  const other = await h.createWorkspace({ name: 'Customer' });
  const opened = await h.api('POST', `/api/v1/platform/workspaces/${other.workspaceId}/open`, { token: session, body: {} });
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  const r = await change(opened.data.token, pw, 'admin-final-password');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.workspace.id, other.workspaceId, 'stays in the workspace they were viewing');
  assert.equal(r.data.workspace.adminAccess, true);
  assert.equal((await h.api('GET', '/api/v1/auth/me', { token: r.data.token })).status, 200);
  assert.equal((await login(email, 'admin-final-password')).status, 200);
  await db().run("UPDATE workspace_members SET status = 'Removed' WHERE workspace_id = 1 AND user_id = ?", [admin.userId]);
});
