const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Joining from an invitation with a new password, landing in the last workspace, forgot/reset and
// change password. Email sending is replaced by a recorder; nothing is sent.
const db = () => h.db();
const PASSWORD = 'correct-horse-battery-1';
const newEmail = (p = 'p') => `${p}-${crypto.randomBytes(5).toString('hex')}@corp.io`;
const api = (who, method, path, body) => h.api(method, path, { token: who && (who.token || who), body });
const login = (email, password) => h.api('POST', '/api/v1/auth/login', { body: { email, password } });

async function register(name, email = newEmail()) {
  const r = await h.api('POST', '/api/v1/auth/register', { body: { email, password: PASSWORD, displayName: name, workspaceName: `${name} WS` } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { email, token: r.data.token, userId: r.data.user.id, workspaceId: r.data.workspace.id };
}

const sent = [];
let realSend;
test.before(async () => {
  await h.prepareDatabase();
  const emailService = require('../services/emailService');
  realSend = emailService.sendRealEmail;
  emailService.sendRealEmail = async (workspaceId, msg) => {
    sent.push({ workspaceId, ...msg });
    if (msg.subject && msg.subject.startsWith('Invitation')) throw Object.assign(new Error('Mail is not configured'), { code: 'MAIL_NOT_CONFIGURED' });
    return { success: true, emailId: null };
  };
});
test.after(() => { require('../services/emailService').sendRealEmail = realSend; return h.shutdown(); });

const linkToken = (text, param) => new URL(text.match(/https?:\/\/\S+/)[0]).searchParams.get(param);

test('a new person joins from the invitation link by setting a password; no workspace of their own is created', async () => {
  const owner = await register('Inviter');
  const email = newEmail('joiner');
  const inv = await api(owner, 'POST', '/api/v1/workspace/invitations', { email, role: 'Marketing Manager', modules: ['social', 'mail'] });
  const token = new URL(inv.data.link).searchParams.get('invite');

  const prev = await h.api('POST', '/api/v1/invitations/public-preview', { body: { token } });
  assert.equal(prev.status, 200, JSON.stringify(prev.data));
  assert.equal(prev.data.valid, true);
  assert.equal(prev.data.accountExists, false);
  assert.equal(prev.data.invitation.email, email);
  assert.equal(prev.data.invitation.role, 'Marketing Manager');
  assert.match(prev.data.invitation.workspaceName, /Inviter WS/);

  assert.equal((await h.api('POST', '/api/v1/invitations/signup', { body: { token, password: 'short' } })).status, 400, 'password rules apply');
  const join = await h.api('POST', '/api/v1/invitations/signup', { body: { token, password: PASSWORD, displayName: 'Joiner' } });
  assert.equal(join.status, 200, JSON.stringify(join.data));
  assert.equal(join.data.workspace.id, owner.workspaceId);
  assert.equal(join.data.role, 'Marketing Manager');
  assert.deepEqual(join.data.workspaces.map(w => w.id), [owner.workspaceId], 'only the invited workspace');
  const me = (await api(join.data.token, 'GET', '/api/v1/auth/me')).data;
  assert.deepEqual(me.modules, ['mail', 'social'], 'the sections chosen on the invitation');

  assert.equal((await h.api('POST', '/api/v1/invitations/signup', { body: { token, password: PASSWORD } })).status, 409, 'the link works once');
  const again = await h.api('POST', '/api/v1/invitations/public-preview', { body: { token } });
  assert.equal(again.data.valid, false);
  assert.equal((await h.api('POST', '/api/v1/invitations/public-preview', { body: { token: 'x'.repeat(43) } })).data.valid, false);

  const signIn = await login(email, PASSWORD);
  assert.equal(signIn.status, 200);
  assert.equal(signIn.data.workspace.id, owner.workspaceId);
});

test('an invited email that already has an account must sign in and accept', async () => {
  const owner = await register('Inviter Two');
  const existing = await register('Existing');
  const inv = await api(owner, 'POST', '/api/v1/workspace/invitations', { email: existing.email, role: 'Member' });
  const token = new URL(inv.data.link).searchParams.get('invite');
  assert.equal((await h.api('POST', '/api/v1/invitations/public-preview', { body: { token } })).data.accountExists, true);
  const r = await h.api('POST', '/api/v1/invitations/signup', { body: { token, password: PASSWORD } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'ACCOUNT_EXISTS');
  assert.equal((await db().get("SELECT status FROM workspace_invitations WHERE email = ? AND workspace_id = ?", [existing.email, owner.workspaceId])).status, 'pending', 'still usable after signing in');
});

test('signing in opens the workspace the user last used', async () => {
  const owner = await register('Team Owner');
  const person = await register('Two Workspaces');
  const inv = await api(owner, 'POST', '/api/v1/workspace/invitations', { email: person.email, role: 'Member' });
  const acc = await api(person, 'POST', '/api/v1/invitations/accept', { token: new URL(inv.data.link).searchParams.get('invite') });
  assert.equal(acc.status, 200);
  assert.equal((await login(person.email, PASSWORD)).data.workspace.id, owner.workspaceId, 'accepting switched them there');
  const back = await api(acc.data.session.token, 'POST', '/api/v1/auth/switch-workspace', { workspaceId: person.workspaceId });
  assert.equal(back.status, 200);
  assert.equal((await login(person.email, PASSWORD)).data.workspace.id, person.workspaceId);
  // No longer a member of the last workspace: back to the first one.
  await api(acc.data.session.token, 'POST', '/api/v1/auth/switch-workspace', { workspaceId: owner.workspaceId });
  await db().run("UPDATE workspace_members SET status = 'Removed' WHERE workspace_id = ? AND user_id = ?", [owner.workspaceId, person.userId]);
  assert.equal((await login(person.email, PASSWORD)).data.workspace.id, person.workspaceId);
});

test('forgot password: same answer for any email; a single-use, expiring link resets it and signs out everywhere', async () => {
  const u = await register('Forgetful');
  const unknown = await h.api('POST', '/api/v1/auth/forgot-password', { body: { email: newEmail('nobody') } });
  const known = await h.api('POST', '/api/v1/auth/forgot-password', { body: { email: u.email.toUpperCase() } });
  assert.equal(unknown.status, 200);
  assert.equal(known.status, 200);
  assert.equal(unknown.data.message, known.data.message, 'does not reveal whether an account exists');

  const mail = sent.filter(m => m.to === u.email).pop();
  assert.ok(mail, 'reset email sent');
  assert.equal(mail.record, false, 'not saved in the platform workspace\'s Sent mail');
  const token = linkToken(mail.text, 'reset');
  const stored = await db().get('SELECT token_hash FROM password_resets WHERE user_id = ? ORDER BY id DESC LIMIT 1', [u.userId]);
  assert.notEqual(stored.token_hash, token);

  // A second request cancels the first link.
  await h.api('POST', '/api/v1/auth/forgot-password', { body: { email: u.email } });
  const token2 = linkToken(sent.filter(m => m.to === u.email).pop().text, 'reset');
  assert.equal((await h.api('POST', '/api/v1/auth/reset-password', { body: { token, password: 'a-brand-new-password' } })).status, 400);

  assert.equal((await h.api('POST', '/api/v1/auth/reset-password', { body: { token: token2, password: 'short' } })).status, 400);
  const ok = await h.api('POST', '/api/v1/auth/reset-password', { body: { token: token2, password: 'a-brand-new-password' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await h.api('POST', '/api/v1/auth/reset-password', { body: { token: token2, password: 'another-new-password' } })).status, 400, 'used once');
  assert.equal((await api(u, 'GET', '/api/v1/auth/me')).status, 401, 'old sessions end');
  assert.equal((await login(u.email, PASSWORD)).status, 401);
  assert.equal((await login(u.email, 'a-brand-new-password')).status, 200);

  // Expired link.
  await h.api('POST', '/api/v1/auth/forgot-password', { body: { email: u.email } });
  const token3 = linkToken(sent.filter(m => m.to === u.email).pop().text, 'reset');
  await db().run('UPDATE password_resets SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE user_id = ? AND used_at IS NULL', [u.userId]);
  assert.equal((await h.api('POST', '/api/v1/auth/reset-password', { body: { token: token3, password: 'expired-link-password' } })).status, 400);
});

test('change password: needs the current one; other sessions end, this one continues', async () => {
  const u = await register('Changer');
  const other = (await login(u.email, PASSWORD)).data.token;
  assert.equal((await api(u, 'POST', '/api/v1/auth/change-password', { currentPassword: 'wrong-password!!', newPassword: 'new-password-123' })).status, 400);
  assert.equal((await api(u, 'POST', '/api/v1/auth/change-password', { currentPassword: PASSWORD, newPassword: PASSWORD })).data.code, 'SAME_PASSWORD');
  assert.equal((await api(u, 'POST', '/api/v1/auth/change-password', { currentPassword: PASSWORD, newPassword: 'short' })).status, 400);
  const r = await api(u, 'POST', '/api/v1/auth/change-password', { currentPassword: PASSWORD, newPassword: 'new-password-123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.workspace.id, u.workspaceId);
  assert.equal((await api(other, 'GET', '/api/v1/auth/me')).status, 401, 'other devices are signed out');
  assert.equal((await api(r.data.token, 'GET', '/api/v1/auth/me')).status, 200, 'this device gets a fresh session');
  assert.equal((await login(u.email, 'new-password-123')).status, 200);
  assert.equal((await h.api('POST', '/api/v1/auth/change-password', { body: { currentPassword: 'x', newPassword: 'y' } })).status, 401, 'signed-in only');
});
