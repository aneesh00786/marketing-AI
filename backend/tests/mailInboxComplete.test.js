const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Received mail, completed: each email saved once (even with two syncs at the same time), everything new read
// (UIDs, not only the newest few), the Spam folder, read state copied back to the mailbox, attachments, replies
// that stay in the conversation (and may be transactional when answering the sender), and the domain check.
// IMAP, ZeptoMail and DNS are stand-ins: nothing is sent or looked up.
const db = () => h.db();
const fake = require('./fakeImap');
const ai = require('../services/aiEngine');
const mail = () => require('../services/emailService');
const uid = () => crypto.randomBytes(4).toString('hex');
const key = () => ({ 'Idempotency-Key': crypto.randomBytes(16).toString('hex') });

let imap; let W; let MEM; let OTHER; let MM; let SENDER_ID; let ADDR;

async function connectInbox(member, ws, addr) {
  const secretBox = require('../lib/secretBox');
  await db().run("UPDATE member_sender_addresses SET imap_host = 'imap.test.io', imap_port = 993, imap_tls = 1, imap_pass = ? WHERE workspace_id = ? AND email = ?", [secretBox.encrypt('pw'), ws, addr]);
  return (await db().get('SELECT id FROM member_sender_addresses WHERE workspace_id = ? AND email = ?', [ws, addr])).id;
}
const received = (ws, userId) => db().all("SELECT * FROM emails WHERE workspace_id = ? AND mailbox_user_id = ? AND status NOT IN ('Sent', 'Not Sent') ORDER BY id", [ws, userId]);

test.before(async () => {
  await h.prepareDatabase();
  process.env.MAIL_ALLOW_PRIVATE_HOSTS = 'true';
  imap = fake.install();
  ai.analyzeEmail = async () => ({ ai_summary: 'Reply', ai_priority: 'Normal', ai_replies: [] });
  W = await h.createWorkspace({ name: 'Inbox complete' });
  assert.equal((await h.api('POST', '/api/v1/mail/config', { token: W.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: 'zepto-W', sender_email: 'hello@inbox-co.io', sender_name: 'W' } })).status, 200);
  MEM = await h.addMember(W.workspaceId, 'Member');
  OTHER = await h.addMember(W.workspaceId, 'Member');
  MM = await h.addMember(W.workspaceId, 'Marketing Manager');
  ADDR = await h.verifiedSender(MEM, W.workspaceId);
  await h.verifiedSender(MM, W.workspaceId);
  SENDER_ID = await connectInbox(MEM, W.workspaceId, ADDR);
});
test.after(() => h.shutdown());

test('two syncs at the same time save each email once', async () => {
  for (let i = 0; i < 3; i++) imap.push('INBOX', { id: `dup-${i}@kimco.io`, source: fake.rawEmail({ subject: `Dup ${i}`, id: `dup-${i}@kimco.io` }) });
  await Promise.all([mail().syncMemberInboxes(W.workspaceId), mail().syncMemberInboxes(W.workspaceId), mail().syncMemberInboxes(W.workspaceId)]);
  const rows = await db().all("SELECT received_key, COUNT(*) AS n FROM emails WHERE workspace_id = ? AND received_key LIKE '<dup-%' GROUP BY received_key", [W.workspaceId]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => Number(r.n) === 1), JSON.stringify(rows));
});

test('after the first sync, everything new is read (not only the newest few); read mail arrives as read', async () => {
  for (let i = 0; i < 45; i++) imap.push('INBOX', { id: `bulk-${i}@kimco.io`, source: fake.rawEmail({ subject: `Bulk ${i}`, id: `bulk-${i}@kimco.io` }), flags: i === 44 ? ['\\Seen'] : [] });
  const r = await mail().syncMemberInboxes(W.workspaceId);
  assert.equal(r.fetchedCount, 45, 'all 45 arrived after the last sync');
  const seen = await db().get("SELECT is_read, status FROM emails WHERE workspace_id = ? AND received_key = '<bulk-44@kimco.io>'", [W.workspaceId]);
  assert.deepEqual([Number(seen.is_read), seen.status], [1, 'Read']);
  assert.equal((await mail().syncMemberInboxes(W.workspaceId)).fetchedCount, 0, 'nothing twice');
});

test('the Spam folder is synced, kept out of the Inbox and its badge, and listed under Spam', async () => {
  imap.junk = 'Spam';
  imap.push('Spam', { id: 'junk-1@spammy.io', source: fake.rawEmail({ from: 'win@spammy.io', subject: 'You won', id: 'junk-1@spammy.io' }) });
  await mail().syncMemberInboxes(W.workspaceId);
  const row = await db().get("SELECT is_spam, mailbox_user_id FROM emails WHERE workspace_id = ? AND received_key = '<junk-1@spammy.io>'", [W.workspaceId]);
  assert.equal(Number(row.is_spam), 1);
  const list = folder => h.api('GET', `/api/v1/emails/inbox${folder ? `?folder=${folder}` : ''}`, { token: MEM.token });
  assert.ok(!(await list()).data.emails.some(e => e.subject === 'You won'));
  const spam = await list('spam');
  assert.ok(spam.data.emails.some(e => e.subject === 'You won' && e.spam));
  const badge = (await h.api('GET', '/api/v1/emails/inbox/unread', { token: MEM.token })).data.unread;
  const unreadInbox = await db().get("SELECT COUNT(*) AS n FROM emails WHERE workspace_id = ? AND mailbox_user_id = ? AND is_spam = 0 AND is_read = 0 AND status <> 'Read'", [W.workspaceId, MEM.userId]);
  assert.equal(badge, Number(unreadInbox.n));
});

test('marking an email read in Mail Center marks it read in the mailbox too', async () => {
  const e = (await received(W.workspaceId, MEM.userId)).find(x => x.received_key === '<dup-0@kimco.io>');
  imap.flagOps = [];
  assert.equal((await h.api('PUT', `/api/v1/emails/${e.id}/read`, { token: MEM.token, body: { read: true } })).status, 200);
  for (let i = 0; i < 50 && !imap.flagOps.length; i++) await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(imap.flagOps[0], { folder: 'INBOX', uid: Number(e.imap_uid), add: ['\\Seen'] });
});

test('attachments are kept and downloaded only by people who may see the email; risky types download as files', async () => {
  imap.push('INBOX', { id: 'files-1@kimco.io', source: fake.rawEmail({ subject: 'Invoice', id: 'files-1@kimco.io', attachment: { filename: 'invoice.pdf', contentType: 'application/pdf', content: '%PDF-1.4 test' } }) });
  imap.push('INBOX', { id: 'files-2@kimco.io', source: fake.rawEmail({ subject: 'Page', id: 'files-2@kimco.io', attachment: { filename: 'page.html', contentType: 'text/html', content: '<script>alert(1)</script>' } }) });
  await mail().syncMemberInboxes(W.workspaceId);
  const rows = await received(W.workspaceId, MEM.userId);
  const inv = rows.find(x => x.subject === 'Invoice');
  const detail = await h.api('GET', `/api/v1/emails/${inv.id}`, { token: MEM.token });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.email.attachments.length, 1);
  const a = detail.data.email.attachments[0];
  assert.deepEqual([a.filename, a.stored], ['invoice.pdf', true]);
  const url = `/api/v1/emails/${inv.id}/attachments/${a.id}`;
  const dl = await h.api('GET', url, { token: MEM.token });
  assert.equal(dl.status, 200);
  assert.equal(dl.data, '%PDF-1.4 test');
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.equal((await h.api('GET', url, { token: OTHER.token })).status, 404, 'another member cannot');
  const page = rows.find(x => x.subject === 'Page');
  const pa = (await h.api('GET', `/api/v1/emails/${page.id}`, { token: MEM.token })).data.email.attachments[0];
  const raw = await h.api('GET', `/api/v1/emails/${page.id}/attachments/${pa.id}`, { token: MEM.token });
  assert.equal(raw.headers.get('content-type'), 'application/octet-stream');
  assert.match(raw.headers.get('content-disposition'), /^attachment;/);
  const inList = (await h.api('GET', '/api/v1/emails/inbox', { token: MEM.token })).data.emails.find(e => e.subject === 'Invoice');
  assert.equal(inList.attachments, 1);
});

test('a reply stays in the conversation, and answering the sender may be transactional without the extra permission', async () => {
  const inId = (await db().run("INSERT INTO emails (workspace_id, sender, sender_email, recipient_email, subject, body, status, message_id, received_key, references_header, smtp_status, received_at, mailbox_user_id) VALUES (?, 'Kim', 'kim@kimco.io', 'mm@x.io', 'Question', 'Hi?', 'Unread', '<q-1@kimco.io>', '<q-1@kimco.io>', '<root-1@x.io>', 'Received via IMAP', UTC_TIMESTAMP(), ?)", [W.workspaceId, MM.userId])).lastID;
  const zepto = [];
  const send = async body => {
    const mock = h.mockFetch([{ match: u => u.startsWith('https://api.zeptomail.com/'), respond: (u, init) => { zepto.push(JSON.parse(init.body)); return h.json(200, { request_id: `r-${uid()}` }); } }]);
    try { return await h.api('POST', '/api/v1/emails/send', { token: MM.token, headers: key(), body: { confirm: true, subject: 'Re: Question', body: 'Here is the answer to your question about the order.', purpose: 'transactional', ...body } }); } finally { mock.restore(); }
  };
  const r = await send({ recipient_email: 'kim@kimco.io', reply_to_email_id: inId });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.purpose, 'transactional');
  assert.deepEqual(zepto[0].mime_headers, { 'In-Reply-To': '<q-1@kimco.io>', References: '<root-1@x.io> <q-1@kimco.io>' });
  assert.equal(Number((await db().get('SELECT reply_to_email_id FROM emails WHERE id = ?', [r.data.emailId])).reply_to_email_id), inId);
  // Forwarding it to someone else is not a reply to the sender: still needs the permission.
  const fwd = await send({ recipient_email: `other-${uid()}@client.io`, reply_to_email_id: inId });
  assert.equal(fwd.status, 403);
  assert.equal(fwd.data.code, 'TRANSACTIONAL_NOT_PERMITTED');
  // Someone else's received email cannot be used.
  const theirs = (await received(W.workspaceId, MEM.userId)).find(x => x.sender_email === 'win@spammy.io');
  assert.equal((await send({ recipient_email: theirs.sender_email, reply_to_email_id: theirs.id })).status, 404);
});

test('a received reply is linked to the email of ours it answers, and its sender (a member) sees it', async () => {
  const out = (await db().run("INSERT INTO emails (workspace_id, sender, sender_email, recipient_email, subject, body, status, message_id, header_message_id, smtp_status, sent_at, sent_by_user_id) VALUES (?, 'O', 'o@x.io', 'lee@leeco.io', 'Offer', 'x', 'Sent', 'req-1', '<out-1@x.io>', 'Sent via SMTP', UTC_TIMESTAMP(), ?)", [W.workspaceId, OTHER.userId])).lastID;
  imap.push('INBOX', { id: 'ans-1@leeco.io', source: fake.rawEmail({ from: 'someone-new@leeco.io', subject: 'Re: Offer', id: 'ans-1@leeco.io', inReplyTo: '<out-1@x.io>', references: '<out-1@x.io>' }) });
  await mail().syncMemberInboxes(W.workspaceId);
  const row = await db().get("SELECT id, reply_to_email_id FROM emails WHERE workspace_id = ? AND received_key = '<ans-1@leeco.io>'", [W.workspaceId]);
  assert.equal(Number(row.reply_to_email_id), out);
  const d = await h.api('GET', `/api/v1/emails/${row.id}`, { token: OTHER.token });
  assert.equal(d.status, 200, 'the member who sent the email sees the reply');
  assert.equal(d.data.email.inReplyTo.subject, 'Offer');
});

test('domain check: two SPF records are an error with one merged record to set; DMARC and MX are reported', async () => {
  const check = require('../lib/mailDomainCheck');
  const zones = {
    'bad.io': { txt: [['v=spf1 include:zohomail.com ~all'], ['v=spf1 include:zcsend.net ~all'], ['google-site-verification=x']], mx: [{ exchange: 'mx.zoho.com', priority: 10 }] },
    '_dmarc.bad.io': { txt: [] },
    'good.io': { txt: [['v=spf1 include:zohomail.com ~all']], mx: [{ exchange: 'mx.zoho.com', priority: 10 }] },
    '_dmarc.good.io': { txt: [['v=DMARC1; p=none; rua=mailto:d@good.io']] }
  };
  const nx = () => Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  check.setResolverForTests(() => ({
    resolveTxt: async n => { if (!zones[n]?.txt) throw nx(); return zones[n].txt; },
    resolveMx: async n => { if (!zones[n]?.mx) throw nx(); return zones[n].mx; }
  }));
  const bad = await check.checkDomain('bad.io', { smtpHost: 'smtp.zoho.com' });
  assert.equal(bad.status, 'error');
  assert.equal(bad.spf.status, 'error');
  assert.equal(bad.spf.fix, 'v=spf1 include:zohomail.com include:zcsend.net ~all');
  assert.equal(bad.dmarc.status, 'warn');
  assert.equal(bad.mx.status, 'ok');
  const good = await check.checkDomain('good.io', { smtpHost: 'smtp.zoho.com' });
  assert.deepEqual([good.spf.status, good.dmarc.status, good.dmarc.policy], ['ok', 'ok', 'none']);
  const r = await h.api('GET', '/api/v1/mail/ses/domains', { token: MEM.token });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(Array.isArray(r.data.domains));
});
