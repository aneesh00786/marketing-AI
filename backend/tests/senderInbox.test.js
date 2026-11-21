const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Each member's own inbox ("My sender email" → Inbox): the IMAP login is the verified sender address itself,
// the password is stored encrypted, and what is synced from it is visible to that member.
// IMAP is stubbed (ImapFlow's prototype): nothing connects to a real server.
const db = () => h.db();
const ai = require('../services/aiEngine');
const fake = require('./fakeImap');

let W; let MEM; let OTHER; let SENDER_ID; let ADDR;
let imap;
const raw = (from, subject, id) => fake.rawEmail({ from, subject, id });

test.before(async () => {
  await h.prepareDatabase();
  process.env.MAIL_ALLOW_PRIVATE_HOSTS = 'true'; // no DNS lookups of the stub host
  imap = fake.install();
  ai.analyzeEmail = async () => ({ ai_summary: 'Reply', ai_priority: 'Normal', ai_replies: [] });

  W = await h.createWorkspace({ name: 'Sender inbox' });
  MEM = await h.addMember(W.workspaceId, 'Member');
  OTHER = await h.addMember(W.workspaceId, 'Member');
  ADDR = await h.verifiedSender(MEM, W.workspaceId);
  SENDER_ID = (await db().get('SELECT id FROM member_sender_addresses WHERE email = ?', [ADDR])).id;
});
test.after(() => h.shutdown());

const api = (who, method, p, body) => h.api(method, `/api/v1/mail/senders${p}`, { token: who.token, body });

test('connecting an inbox signs in as the sender address itself; a failed sign-in saves nothing', async () => {
  imap.fail = true;
  const bad = await api(MEM, 'PUT', `/${SENDER_ID}/inbox`, { host: 'imap.zoho.com', password: 'wrong' });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  assert.equal(bad.data.code, 'INBOX_LOGIN_FAILED');
  assert.equal((await db().get('SELECT imap_host FROM member_sender_addresses WHERE id = ?', [SENDER_ID])).imap_host, null);

  imap.fail = null; imap.logins = [];
  imap.push('INBOX', { id: 'reply-1@kimco.io', source: raw('kim@kimco.io', 'Re: Spring range', 'reply-1@kimco.io') });
  const ok = await api(MEM, 'PUT', `/${SENDER_ID}/inbox`, { host: 'imap.zoho.com', port: 993, password: 'app-pass-1' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(imap.logins.every(l => l.user === ADDR && l.host === 'imap.zoho.com'), 'login is always the sender address');
  assert.deepEqual({ connected: ok.data.sender.inbox.connected, login: ok.data.sender.inbox.login, status: ok.data.sender.inbox.status }, { connected: true, login: ADDR, status: 'connected' });
  assert.equal(JSON.stringify(ok.data).includes('app-pass-1'), false, 'the password is never returned');
  const stored = (await db().get('SELECT imap_pass FROM member_sender_addresses WHERE id = ?', [SENDER_ID])).imap_pass;
  assert.ok(stored && !stored.includes('app-pass-1'), 'stored encrypted');

  // Someone else's address, and the login field, cannot be set.
  assert.equal((await api(OTHER, 'PUT', `/${SENDER_ID}/inbox`, { host: 'imap.zoho.com', password: 'x' })).status, 404);
  assert.equal((await api(MEM, 'PUT', `/${SENDER_ID}/inbox`, { host: 'imap.zoho.com', password: 'x', user: 'other@x.io' })).status, 400);
});

test('what is synced from a member inbox is theirs to see (not other members\'); sync again adds each email once', async () => {
  const inbox = who => h.api('GET', '/api/v1/emails/inbox', { token: who.token });
  const mine = await inbox(MEM);
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.ok(mine.data.emails.some(e => e.subject === 'Re: Spring range' && e.to === ADDR));
  assert.ok(!(await inbox(OTHER)).data.emails.some(e => e.subject === 'Re: Spring range'));
  assert.ok((await inbox(W)).data.emails.some(e => e.subject === 'Re: Spring range'), 'Owners see all mail');

  imap.push('INBOX', { id: 'reply-2@kimco.io', source: raw('kim@kimco.io', 'Re: Prices', 'reply-2@kimco.io') });
  const s = await api(MEM, 'POST', '/inbox/sync');
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.fetchedCount, 1);
  const n = await db().get('SELECT COUNT(*) AS n FROM emails WHERE workspace_id = ? AND mailbox_user_id = ?', [W.workspaceId, MEM.userId]);
  assert.equal(Number(n.n), 2);
});

test('a message that cannot be saved does not stop newer ones; a sent email with the same Message-ID does not hide the received copy', async () => {
  // Sent from Marketech.ai to this mailbox: the sent row has the same Message-ID as the copy that arrives.
  await db().run("INSERT INTO emails (workspace_id, sender, sender_email, recipient_email, subject, body, status, message_id, smtp_status, sent_at) VALUES (?, 'Me', 'me@x.io', ?, 'Self test', 'x', 'Sent', 'self-1@x.io', 'Sent via SMTP', UTC_TIMESTAMP())", [W.workspaceId, ADDR]);
  const analyze = ai.analyzeEmail;
  ai.analyzeEmail = async e => { if (e.subject === 'Broken one') throw new Error('cannot analyse'); return analyze(e); };
  imap.push('INBOX', { id: 'broken-1@kimco.io', source: raw('kim@kimco.io', 'Broken one', 'broken-1@kimco.io') });
  imap.push('INBOX', { id: 'self-1@x.io', source: raw('me@x.io', 'Self test', 'self-1@x.io') });
  imap.push('INBOX', { id: 'reply-3@kimco.io', source: raw('kim@kimco.io', 'Newest reply', 'reply-3@kimco.io') });
  try {
    const s = await api(MEM, 'POST', '/inbox/sync');
    assert.equal(s.status, 200, JSON.stringify(s.data));
    assert.equal(s.data.fetchedCount, 2, 'the newest and the self-sent copy are saved; the broken one is skipped');
  } finally { ai.analyzeEmail = analyze; }
  const got = await db().all("SELECT subject FROM emails WHERE workspace_id = ? AND mailbox_user_id = ? AND status = 'Unread'", [W.workspaceId, MEM.userId]);
  const subjects = got.map(r => r.subject);
  assert.ok(subjects.includes('Newest reply') && subjects.includes('Self test') && !subjects.includes('Broken one'), subjects.join(', '));
});

test('the Inbox badge counts unread received mail the person may see', async () => {
  const unread = async who => (await h.api('GET', '/api/v1/emails/inbox/unread', { token: who.token })).data.unread;
  const mine = await unread(MEM);
  const n = await db().get("SELECT COUNT(*) AS n FROM emails WHERE workspace_id = ? AND mailbox_user_id = ? AND status = 'Unread'", [W.workspaceId, MEM.userId]);
  assert.equal(mine, Number(n.n));
  assert.ok(mine > 0);
  assert.equal(await unread(OTHER), 0, 'another member does not see it');
  const one = await db().get('SELECT id FROM emails WHERE workspace_id = ? AND mailbox_user_id = ? ORDER BY id LIMIT 1', [W.workspaceId, MEM.userId]);
  assert.equal((await h.api('PUT', `/api/v1/emails/${one.id}/read`, { token: MEM.token, body: { read: true } })).status, 200);
  assert.equal(await unread(MEM), mine - 1);
});

test('workspaces with a mailbox or a member inbox are listed for the automatic sync', async () => {
  assert.ok((await require('../services/emailService').inboxWorkspaces()).includes(W.workspaceId));
});

test('a sync failure is shown on the address; disconnect removes the saved login', async () => {
  imap.fail = true;
  const s = await api(MEM, 'POST', '/inbox/sync');
  assert.equal(s.data.failed, 1);
  const row = s.data.senders.find(x => x.id === SENDER_ID);
  assert.equal(row.inbox.status, 'error');
  assert.match(row.inbox.error, /authentication failed/i);
  imap.fail = null;
  const d = await api(MEM, 'DELETE', `/${SENDER_ID}/inbox`);
  assert.equal(d.status, 200);
  assert.equal(d.data.sender.inbox.connected, false);
  assert.equal((await db().get('SELECT imap_pass FROM member_sender_addresses WHERE id = ?', [SENDER_ID])).imap_pass, null);
});

test('an unconfirmed address cannot connect an inbox', async () => {
  const p = await db().run("INSERT INTO member_sender_addresses (workspace_id, user_id, email, status, created_at, updated_at) VALUES (?, ?, 'pending-inbox@company-mail.io', 'pending', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [W.workspaceId, MEM.userId]);
  const r = await api(MEM, 'PUT', `/${p.lastID}/inbox`, { host: 'imap.zoho.com', password: 'x' });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'NOT_VERIFIED');
});
