const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Workspace invitations and member management. Email sending is mocked or unconfigured.
const db = () => h.db();
const PASSWORD = 'correct-horse-battery-1';
const newEmail = (p = 'u') => `${p}-${crypto.randomBytes(5).toString('hex')}@corp.io`;
const tokenOf = link => new URL(link).searchParams.get('invite');

async function register(name = 'Team', email = newEmail()) {
  const r = await h.api('POST', '/api/v1/auth/register', { body: { email, password: PASSWORD, displayName: name, workspaceName: `${name} WS` } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { email, token: r.data.token, userId: r.data.user.id, workspaceId: r.data.workspace.id };
}
const api = (who, method, path, body) => h.api(method, path, { token: who.token || who, body });
const invite = (owner, email, role = 'Member') => api(owner, 'POST', '/api/v1/workspace/invitations', { email, role });
const membership = (wsId, userId) => db().get('SELECT role, status FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [wsId, userId]);

test.before(async () => { await h.prepareDatabase(); });
test.after(() => h.shutdown());

test('migration 016: invitations table with hashed tokens, one pending invite per email, foreign keys', async () => {
  const cols = (await db().all("SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_invitations'")).map(r => r.c);
  assert.ok(cols.includes('token_hash') && cols.includes('expires_at') && cols.includes('pending_email') && !cols.includes('token'));
  const fks = (await db().all("SELECT CONSTRAINT_NAME AS n FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'workspace_invitations' AND CONSTRAINT_TYPE = 'FOREIGN KEY'")).map(r => r.n).sort();
  assert.deepEqual(fks, ['fk_workspace_invitations_acceptor', 'fk_workspace_invitations_inviter', 'fk_workspace_invitations_ws']);
});

test('an existing user is invited, sees the invitation, and joins with the link (no new account)', async () => {
  const owner = await register('Owner One');
  const guest = await register('Guest');
  const inv = await invite(owner, guest.email.toUpperCase(), 'Approver');
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  assert.equal(inv.data.invitation.email, guest.email, 'emails are normalised');
  assert.equal(inv.data.emailed, false, 'no workspace mailbox: the link is returned to the inviter');
  assert.match(inv.data.emailError, /not configured|Mail Settings/i);
  const token = tokenOf(inv.data.link);
  assert.ok(token && token.length >= 40);
  const stored = await db().get('SELECT token_hash FROM workspace_invitations WHERE id = ?', [inv.data.invitation.id]);
  assert.notEqual(stored.token_hash, token, 'only a hash is stored');
  assert.equal(stored.token_hash, crypto.createHash('sha256').update(token).digest('hex'));

  // Not a member until they accept.
  assert.equal(await membership(owner.workspaceId, guest.userId), null);
  const mine = await api(guest, 'GET', '/api/v1/invitations');
  assert.deepEqual(mine.data.invitations.map(i => [i.workspaceId, i.role]), [[owner.workspaceId, 'Approver']]);
  const prev = await api(guest, 'POST', '/api/v1/invitations/preview', { token });
  assert.equal(prev.data.canAccept, true);

  const acc = await api(guest, 'POST', '/api/v1/invitations/accept', { token });
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  assert.equal(acc.data.joined, true);
  assert.deepEqual(await membership(owner.workspaceId, guest.userId), { role: 'Approver', status: 'Active' });
  assert.equal(acc.data.session.workspace.id, owner.workspaceId);
  assert.equal((await api(acc.data.session.token, 'GET', '/api/v1/leads')).status, 200, 'the new session works in the joined workspace');
  assert.deepEqual((await api(guest, 'GET', '/api/v1/workspaces')).data.workspaces.map(w => w.id).sort(), [guest.workspaceId, owner.workspaceId].sort());
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM users WHERE email = ?', [guest.email])).n), 1);

  // Reusing the link fails; nothing is logged with the token.
  const again = await api(guest, 'POST', '/api/v1/invitations/accept', { token });
  assert.deepEqual([again.status, again.data.code], [409, 'INVITATION_USED']);
  const logs = await db().all("SELECT action, metadata_json FROM audit_logs WHERE action LIKE 'workspace.%invit%'");
  assert.ok(logs.some(l => l.action === 'workspace.member_invited') && logs.some(l => l.action === 'workspace.invitation_accepted'));
  assert.ok(logs.every(l => !String(l.metadata_json || '').includes(token)));
});

test('a new person must register with the invited email before accepting; the email alone grants nothing', async () => {
  const owner = await register('Owner Two');
  const email = newEmail('newbie');
  const inv = await invite(owner, email, 'Member');
  const token = tokenOf(inv.data.link);
  const newbie = await register('Newbie', email);
  assert.equal(await membership(owner.workspaceId, newbie.userId), null, 'registering with the email does not join the workspace');
  assert.equal((await api(newbie, 'GET', '/api/v1/invitations')).data.invitations.length, 1);
  const acc = await api(newbie, 'POST', '/api/v1/invitations/accept', { token });
  assert.equal(acc.status, 200);
  assert.deepEqual(await membership(owner.workspaceId, newbie.userId), { role: 'Member', status: 'Active' });
});

test('the link only works for the invited account, once, before it expires', async () => {
  const owner = await register('Owner Three');
  const invited = await register('Invited');
  const other = await register('Someone Else');
  const token = tokenOf((await invite(owner, invited.email)).data.link);

  const wrong = await api(other, 'POST', '/api/v1/invitations/accept', { token });
  assert.deepEqual([wrong.status, wrong.data.code], [403, 'INVITATION_EMAIL_MISMATCH']);
  assert.equal(await membership(owner.workspaceId, other.userId), null);
  const prev = await api(other, 'POST', '/api/v1/invitations/preview', { token });
  assert.equal(prev.data.canAccept, false);
  assert.match(prev.data.reason, /Sign in with that email/);

  for (const bad of ['not-a-token', crypto.randomBytes(32).toString('base64url')]) {
    const r = await api(invited, 'POST', '/api/v1/invitations/accept', { token: bad });
    assert.ok([400, 404].includes(r.status), `${bad} -> ${r.status}`);
  }

  await db().run('UPDATE workspace_invitations SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE token_hash = ?', [crypto.createHash('sha256').update(token).digest('hex')]);
  const expired = await api(invited, 'POST', '/api/v1/invitations/accept', { token });
  assert.deepEqual([expired.status, expired.data.code], [410, 'INVITATION_EXPIRED']);
  assert.equal(await membership(owner.workspaceId, invited.userId), null);

  // After expiry the email can be invited again; resending replaces the token.
  const second = await invite(owner, invited.email);
  assert.equal(second.status, 200, JSON.stringify(second.data));
  const firstLink = tokenOf(second.data.link);
  const resent = await api(owner, 'POST', `/api/v1/workspace/invitations/${second.data.invitation.id}/resend`);
  assert.equal(resent.status, 200);
  assert.equal((await api(invited, 'POST', '/api/v1/invitations/accept', { token: firstLink })).status, 404, 'the replaced link stops working');
  assert.equal((await api(invited, 'POST', '/api/v1/invitations/accept', { token: tokenOf(resent.data.link) })).status, 200);
});

test('duplicates: one pending invitation per email, none for existing members; cancel and decline', async () => {
  const owner = await register('Owner Four');
  const email = newEmail('dup');
  assert.equal((await invite(owner, email)).status, 200);
  const dup = await invite(owner, email.toUpperCase());
  assert.deepEqual([dup.status, dup.data.code], [409, 'INVITATION_EXISTS']);
  await assert.rejects(db().run("INSERT INTO workspace_invitations (workspace_id, email, role, token_hash, status, expires_at) VALUES (?, ?, 'Member', ?, 'pending', UTC_TIMESTAMP())", [owner.workspaceId, email, 'f'.repeat(64)]), /Duplicate entry/);
  const self = await invite(owner, owner.email);
  assert.deepEqual([self.status, self.data.code], [409, 'ALREADY_MEMBER']);

  const list = await api(owner, 'GET', '/api/v1/workspace/members');
  const pending = list.data.invitations.find(i => i.email === email);
  assert.equal((await api(owner, 'POST', `/api/v1/workspace/invitations/${pending.id}/cancel`)).status, 200);
  assert.equal((await api(owner, 'POST', `/api/v1/workspace/invitations/${pending.id}/cancel`)).status, 409);
  assert.equal((await invite(owner, email)).status, 200, 'a cancelled invitation does not block a new one');

  const decliner = await register('Decliner');
  const t = tokenOf((await invite(owner, decliner.email)).data.link);
  const mine = (await api(decliner, 'GET', '/api/v1/invitations')).data.invitations[0];
  assert.equal((await api(decliner, 'POST', '/api/v1/invitations/decline', { id: mine.id })).status, 200);
  const late = await api(decliner, 'POST', '/api/v1/invitations/accept', { token: t });
  assert.deepEqual([late.status, late.data.code], [409, 'INVITATION_USED']);
  assert.equal(await membership(owner.workspaceId, decliner.userId), null);
});

test('only owners and admins manage members; only owners touch the Owner role; nobody changes themselves', async () => {
  const owner = await register('Owner Five');
  const join = async (role) => {
    const u = await register(role);
    const t = tokenOf((await invite(owner, u.email, role)).data.link);
    const acc = await api(u, 'POST', '/api/v1/invitations/accept', { token: t });
    assert.equal(acc.status, 200, JSON.stringify(acc.data));
    return { ...u, wsToken: acc.data.session.token };
  };
  const admin = await join('Workspace Admin');
  const plain = await join('Member');

  const asMember = await api(plain.wsToken, 'GET', '/api/v1/workspace/members');
  assert.equal(asMember.status, 200, 'everyone sees the member list');
  assert.equal(asMember.data.canManage, false);
  assert.deepEqual(asMember.data.invitations, [], 'members do not see invitations');
  assert.equal((await invite(plain.wsToken, newEmail())).status, 403);
  assert.equal((await api(plain.wsToken, 'PATCH', `/api/v1/workspace/members/${admin.userId}`, { role: 'Member' })).status, 403);
  assert.equal((await api(plain.wsToken, 'DELETE', `/api/v1/workspace/members/${admin.userId}`)).status, 403);

  assert.equal((await invite(admin.wsToken, newEmail(), 'Workspace Owner')).status, 403, 'admins cannot invite owners');
  const demoteOwner = await api(admin.wsToken, 'PATCH', `/api/v1/workspace/members/${owner.userId}`, { role: 'Member' });
  assert.deepEqual([demoteOwner.status, demoteOwner.data.code], [403, 'OWNER_ONLY']);
  assert.equal((await api(admin.wsToken, 'PATCH', `/api/v1/workspace/members/${plain.userId}`, { role: 'Workspace Owner' })).status, 403);
  assert.equal((await api(admin.wsToken, 'PATCH', `/api/v1/workspace/members/${plain.userId}`, { role: 'Approver' })).status, 200);
  assert.deepEqual(await membership(owner.workspaceId, plain.userId), { role: 'Approver', status: 'Active' });
  assert.equal((await api(admin.wsToken, 'PATCH', `/api/v1/workspace/members/${plain.userId}`, { role: 'Superuser' })).status, 400);

  const selfChange = await api(owner, 'PATCH', `/api/v1/workspace/members/${owner.userId}`, { role: 'Member' });
  assert.deepEqual([selfChange.status, selfChange.data.code], [409, 'SELF_CHANGE']);
  assert.equal((await api(owner, 'DELETE', `/api/v1/workspace/members/${owner.userId}`)).status, 409);

  // A role change applies to the member's existing token at once.
  assert.equal((await api(owner, 'PATCH', `/api/v1/workspace/members/${plain.userId}`, { role: 'Workspace Admin' })).status, 200);
  assert.equal((await api(plain.wsToken, 'GET', '/api/v1/workspace/members')).data.canManage, true);
  // Two owners: one may demote the other, never below one owner.
  assert.equal((await api(owner, 'PATCH', `/api/v1/workspace/members/${admin.userId}`, { role: 'Workspace Owner' })).status, 200);
  assert.equal((await api(admin.wsToken, 'PATCH', `/api/v1/workspace/members/${owner.userId}`, { role: 'Workspace Admin' })).status, 200);
  const owners = await db().get("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'Workspace Owner' AND status = 'Active'", [owner.workspaceId]);
  assert.equal(Number(owners.n), 1);
});

test('removing a member revokes their tokens for that workspace at once; re-inviting restores access', async () => {
  const owner = await register('Owner Six');
  const u = await register('Leaver');
  const acc = await api(u, 'POST', '/api/v1/invitations/accept', { token: tokenOf((await invite(owner, u.email)).data.link) });
  const wsToken = acc.data.session.token;
  assert.equal((await api(wsToken, 'GET', '/api/v1/leads')).status, 200);

  assert.equal((await api(owner, 'DELETE', `/api/v1/workspace/members/${u.userId}`)).status, 200);
  assert.deepEqual(await membership(owner.workspaceId, u.userId), { role: 'Member', status: 'Removed' });
  assert.equal((await api(wsToken, 'GET', '/api/v1/leads')).status, 401, 'old token no longer works for that workspace');
  assert.equal((await api(u, 'POST', '/api/v1/auth/switch-workspace', { workspaceId: owner.workspaceId })).status, 403);
  assert.equal((await api(u, 'GET', '/api/v1/leads')).status, 200, 'their own workspace is unaffected');
  assert.ok(!(await api(u, 'GET', '/api/v1/workspaces')).data.workspaces.some(w => w.id === owner.workspaceId));

  const back = await api(u, 'POST', '/api/v1/invitations/accept', { token: tokenOf((await invite(owner, u.email, 'Approver')).data.link) });
  assert.equal(back.status, 200);
  assert.deepEqual(await membership(owner.workspaceId, u.userId), { role: 'Approver', status: 'Active' });
});

test('no cross-workspace management: ids of another workspace are not found', async () => {
  const a = await register('Owner A');
  const b = await register('Owner B');
  const bMember = await register('B Member');
  await api(bMember, 'POST', '/api/v1/invitations/accept', { token: tokenOf((await invite(b, bMember.email)).data.link) });
  const bInvite = (await invite(b, newEmail())).data.invitation.id;

  assert.equal((await api(a, 'PATCH', `/api/v1/workspace/members/${bMember.userId}`, { role: 'Approver' })).status, 404);
  assert.equal((await api(a, 'DELETE', `/api/v1/workspace/members/${bMember.userId}`)).status, 404);
  assert.equal((await api(a, 'POST', `/api/v1/workspace/invitations/${bInvite}/cancel`)).status, 404);
  assert.equal((await api(a, 'POST', `/api/v1/workspace/invitations/${bInvite}/resend`)).status, 404);
  assert.deepEqual(await membership(b.workspaceId, bMember.userId), { role: 'Member', status: 'Active' });
  const aList = await api(a, 'GET', '/api/v1/workspace/members');
  assert.ok(!aList.data.members.some(m => m.userId === bMember.userId));
  assert.ok(!aList.data.invitations.some(i => i.id === bInvite));
  assert.equal((await h.api('GET', '/api/v1/workspace/members')).status, 401);
});

test('concurrent acceptance of one invitation creates one membership', async () => {
  const owner = await register('Owner Seven');
  const u = await register('Racer');
  const token = tokenOf((await invite(owner, u.email)).data.link);
  const results = await Promise.all([1, 2, 3, 4].map(() => api(u, 'POST', '/api/v1/invitations/accept', { token })));
  const statuses = results.map(r => r.status).sort();
  assert.equal(statuses.filter(s => s === 200).length, 1, JSON.stringify(statuses));
  assert.ok(statuses.filter(s => s !== 200).every(s => s === 409));
  const n = await db().get('SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [owner.workspaceId, u.userId]);
  assert.equal(Number(n.n), 1);
});

test('with a workspace mailbox the invitation is emailed (mocked), with the link and no secrets in logs', async () => {
  const owner = await register('Mailer');
  const cfg = await api(owner, 'POST', '/api/v1/mail/config', { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: 'zepto-test', sender_email: 'team@mailer.io' });
  assert.equal(cfg.status, 200);
  const sent = [];
  const mock = h.mockFetch([{ match: u => u.startsWith('https://api.zeptomail.com/'), respond: (url, init) => { sent.push(JSON.parse(init.body)); return h.json(200, { request_id: 'r1' }); } }]);
  let inv;
  try { inv = await invite(owner, 'invitee@partner.io', 'Member'); } finally { mock.restore(); }
  assert.equal(inv.data.emailed, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to[0].email_address.address, 'invitee@partner.io');
  assert.ok(sent[0].htmlbody.includes(tokenOf(inv.data.link)), 'the email carries the link');
  const logs = await db().all("SELECT metadata_json FROM audit_logs WHERE action = 'workspace.member_invited' AND workspace_id = ?", [owner.workspaceId]);
  assert.ok(logs.every(l => !String(l.metadata_json).includes(tokenOf(inv.data.link))));
});
