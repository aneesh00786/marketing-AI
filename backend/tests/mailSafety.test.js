const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const h = require('./helpers');

// Mail delivery safety: verified TLS, timeouts, no second provider after an unknown outcome,
// drafts with unknown delivery held for review, idempotent direct sends, and no unresolved
// [placeholders]. ZeptoMail is mocked and SMTP is stubbed, so nothing is ever sent.
const db = () => h.db();
const emailService = require('../services/emailService');
const nodemailer = require('nodemailer');
let A;
let smtpSends;
let smtpReject = false;
const savedPrivate = process.env.MAIL_ALLOW_PRIVATE_HOSTS;

const key = () => ({ 'Idempotency-Key': crypto.randomBytes(16).toString('hex') });
const zepto = (calls, respond) => ({
  match: u => u.startsWith('https://api.zeptomail.com/'),
  respond: (url, init) => { calls.push(JSON.parse(init.body)); return respond ? respond() : h.json(200, { request_id: `req-${calls.length}` }); }
});

test.before(async () => {
  await h.prepareDatabase();
  process.env.MAIL_ALLOW_PRIVATE_HOSTS = 'true'; // no real DNS lookups of the stubbed SMTP host
  A = await h.createWorkspace({ name: 'Mail safety' });
  // ZeptoMail plus its SMTP host, so the old code would have retried a failed send over SMTP.
  const r = await h.api('POST', '/api/v1/mail/config', { token: A.token, body: { provider: 'zeptomail', smtp_host: 'smtp.zeptomail.com', smtp_user: 'emailapikey', smtp_pass: 'zepto-token', sender_email: 'news@safety-co.io', sender_name: 'Safety Co' } });
  assert.equal(r.status, 200);
  smtpSends = [];
  nodemailer.createTransport = opts => ({
    verify: async () => true,
    sendMail: async msg => {
      if (smtpReject) throw Object.assign(new Error('550 relay denied'), { code: 'EENVELOPE', responseCode: 550 });
      smtpSends.push({ opts, msg });
      return { messageId: '<smtp-1@x>', response: '250 OK', accepted: [msg.to] }; }
  });
});
test.after(() => { process.env.MAIL_ALLOW_PRIVATE_HOSTS = savedPrivate; return h.shutdown(); });

async function approvedDraft(recipient = 'dana@acme.io') {
  const g = await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { recipientName: 'Dana', recipientEmail: recipient, goal: 'Intro' } });
  const replacements = Object.fromEntries(g.data.draft.placeholders.map(p => [p, 'Jane Doe']));
  await h.api('PATCH', `/api/v1/drafts/${g.data.draft.id}`, { token: A.token, body: { replacements } });
  assert.equal((await h.api('PUT', `/api/v1/drafts/${g.data.draft.id}/approve`, { token: A.token })).status, 200);
  return g.data.draft.id;
}
const draftStatus = async id => (await db().get('SELECT status FROM email_drafts WHERE id = ?', [id])).status;

test('TLS certificates are verified and timeouts are bounded for SMTP and IMAP', () => {
  const smtp = emailService.smtpTransportOptions({ smtp_host: 'smtp.x.io', smtp_port: 587, smtp_user: 'u', smtp_pass: 'p' });
  assert.equal(smtp.tls.rejectUnauthorized, true);
  assert.equal(smtp.tls.minVersion, 'TLSv1.2');
  for (const k of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) assert.ok(smtp[k] > 0 && smtp[k] <= 60000, k);
  const imap = emailService.imapClientOptions({ imap_host: 'imap.x.io', imap_port: 993, imap_tls: 1, imap_user: 'u', imap_pass: 'p' });
  assert.equal(imap.tls.rejectUnauthorized, true);
  for (const k of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) assert.ok(imap[k] > 0 && imap[k] <= 60000, k);
  const src = fs.readFileSync(path.join(__dirname, '../services/emailService.js'), 'utf8');
  assert.doesNotMatch(src, /rejectUnauthorized:\s*false/);
  assert.match(src, /AbortSignal\.timeout\(ZEPTO_TIMEOUT_MS\)/);
});

test('SMTP errors are classified: rejections and connection failures are "not sent", mid-send failures are unknown', () => {
  const unknown = emailService.smtpOutcomeUnknown;
  assert.equal(unknown({ code: 'EENVELOPE', responseCode: 550 }), false);
  assert.equal(unknown({ code: 'EAUTH' }), false);
  assert.equal(unknown({ code: 'ETIMEDOUT', command: 'CONN' }), false);
  assert.equal(unknown({ code: 'ECONNREFUSED' }), false);
  assert.equal(unknown({ code: 'ETIMEDOUT', command: 'DATA' }), true);
  assert.equal(unknown({ code: 'ESOCKET' }), true);
});

test('ZeptoMail messages carry the plain-text part', async () => {
  const calls = [];
  const mock = h.mockFetch([zepto(calls)]);
  try {
    const r = await h.api('POST', '/api/v1/emails/send-html', { token: A.token, headers: key(), body: { recipient_email: 'kim@client.io', subject: 'Hello', html_body: '<p>Hi <b>Kim</b></p>', body_text: 'Hi Kim', confirm: true } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  } finally { mock.restore(); }
  assert.equal(calls[0].textbody, 'Hi Kim');
  assert.match(calls[0].htmlbody, /<b>Kim<\/b>/);
});

test('an unknown ZeptoMail outcome (5xx or timeout) never falls back to SMTP; the draft is held for review', async () => {
  for (const respond of [() => h.json(503, { error: 'busy' }), () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })]) {
    const id = await approvedDraft();
    smtpSends.length = 0;
    const calls = [];
    const mock = h.mockFetch([zepto(calls, respond)]);
    let r;
    try { r = await h.api('POST', `/api/v1/drafts/${id}/send`, { token: A.token, body: { confirm: true } }); } finally { mock.restore(); }
    assert.equal(r.status, 502);
    assert.equal(r.data.code, 'MAIL_OUTCOME_UNKNOWN');
    assert.equal(calls.length, 1);
    assert.equal(smtpSends.length, 0, 'no second copy through SMTP');
    assert.equal(await draftStatus(id), 'Needs Review');

    // Not resent, not re-approved, not edited until a person resolves it.
    const again = await h.api('POST', `/api/v1/drafts/${id}/send`, { token: A.token, body: { confirm: true } });
    assert.equal(again.data.code, 'NEEDS_REVIEW');
    assert.equal((await h.api('PUT', `/api/v1/drafts/${id}/approve`, { token: A.token })).data.code, 'NEEDS_REVIEW');
    assert.equal((await h.api('PATCH', `/api/v1/drafts/${id}`, { token: A.token, body: { subject: 'x' } })).status, 409);
    const audit = await db().get("SELECT metadata_json FROM audit_logs WHERE action = 'mail.draft_outcome_unknown' AND resource_id = ? ORDER BY id DESC LIMIT 1", [String(id)]);
    assert.ok(audit);
  }
});

test('a clear "not sent" failure may still use the SMTP fallback (unchanged behaviour)', async () => {
  const id = await approvedDraft();
  smtpSends.length = 0;
  const calls = [];
  const mock = h.mockFetch([zepto(calls, () => h.json(422, { error: 'sender not verified' }))]);
  let r;
  try { r = await h.api('POST', `/api/v1/drafts/${id}/send`, { token: A.token, body: { confirm: true } }); } finally { mock.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(smtpSends.length, 1);
  assert.equal(smtpSends[0].opts.tls.rejectUnauthorized, true);
  assert.equal(await draftStatus(id), 'Sent');
});

test('resolving an unknown or stuck send: approvers only, explicit, and only for review/stale states', async () => {
  const id = await approvedDraft();
  await db().run("UPDATE email_drafts SET status = 'Needs Review' WHERE id = ?", [id]);
  const member = await h.addMember(A.workspaceId, 'Member');
  assert.equal((await h.api('POST', `/api/v1/drafts/${id}/resolve`, { token: member.token, body: { outcome: 'sent', confirm: true } })).status, 403);
  assert.equal((await h.api('POST', `/api/v1/drafts/${id}/resolve`, { token: A.token, body: { outcome: 'sent' } })).status, 400, 'confirm required');
  const notSent = await h.api('POST', `/api/v1/drafts/${id}/resolve`, { token: A.token, body: { outcome: 'not_sent', confirm: true } });
  assert.equal(notSent.status, 200);
  assert.equal(await draftStatus(id), 'Approved');
  assert.equal((await h.api('POST', `/api/v1/drafts/${id}/resolve`, { token: A.token, body: { outcome: 'sent', confirm: true } })).data.code, 'NOT_NEEDS_REVIEW');

  // A send stuck in "Sending": not resolvable while fresh, resolvable once stale.
  await db().run("UPDATE email_drafts SET status = 'Sending', updated_at = UTC_TIMESTAMP() WHERE id = ?", [id]);
  assert.equal((await h.api('POST', `/api/v1/drafts/${id}/resolve`, { token: A.token, body: { outcome: 'sent', confirm: true } })).status, 409);
  await db().run("UPDATE email_drafts SET updated_at = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE id = ?", [id]);
  assert.equal((await h.api('POST', `/api/v1/drafts/${id}/resolve`, { token: A.token, body: { outcome: 'sent', confirm: true } })).status, 200);
  assert.equal(await draftStatus(id), 'Sent');
});

test('direct sends: a key is required, a repeated key never sends twice, and a reused key with other content is refused', async () => {
  const msg = { recipient_email: 'lee@client.io', subject: 'Order update', body: 'Your order shipped.', confirm: true };
  assert.equal((await h.api('POST', '/api/v1/emails/send', { token: A.token, body: msg })).data.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const calls = [];
  const mock = h.mockFetch([zepto(calls)]);
  const k = key();
  let first;
  let repeat;
  let other;
  try {
    first = await h.api('POST', '/api/v1/emails/send', { token: A.token, headers: k, body: msg });
    repeat = await h.api('POST', '/api/v1/emails/send', { token: A.token, headers: k, body: msg });
    other = await h.api('POST', '/api/v1/emails/send', { token: A.token, headers: k, body: { ...msg, subject: 'Different' } });
  } finally { mock.restore(); }
  assert.equal(first.status, 200);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.data.duplicate, true);
  assert.equal(repeat.data.emailId, first.data.emailId);
  assert.equal(other.status, 422);
  assert.equal(calls.length, 1, 'sent exactly once');
});

test('direct sends: concurrent double-submits send once; an unknown outcome blocks the key; a clear failure may retry', async () => {
  const msg = { recipient_email: 'sam@client.io', subject: 'Invoice', body: 'Attached.', confirm: true };
  let calls = [];
  let mock = h.mockFetch([zepto(calls, () => new Promise(r => setTimeout(() => r(h.json(200, { request_id: 'slow' })), 150)))]);
  const k = key();
  let results;
  try { results = await Promise.all([1, 2, 3].map(() => h.api('POST', '/api/v1/emails/send', { token: A.token, headers: k, body: msg }))); } finally { mock.restore(); }
  assert.equal(calls.length, 1, 'one send for three simultaneous submits');
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.ok(results.filter(r => r.status !== 200).every(r => r.data.code === 'SEND_IN_PROGRESS'));

  const k2 = key();
  calls = [];
  mock = h.mockFetch([zepto(calls, () => h.json(500, {}))]);
  let unknown;
  let retry;
  try {
    unknown = await h.api('POST', '/api/v1/emails/send', { token: A.token, headers: k2, body: { ...msg, subject: 'Unknown' } });
    retry = await h.api('POST', '/api/v1/emails/send', { token: A.token, headers: k2, body: { ...msg, subject: 'Unknown' } });
  } finally { mock.restore(); }
  assert.equal(unknown.data.code, 'MAIL_OUTCOME_UNKNOWN');
  assert.equal(retry.data.code, 'MAIL_OUTCOME_UNKNOWN');
  assert.equal(calls.length, 1, 'not retried');

  const k3 = key();
  calls = [];
  let n = 0;
  mock = h.mockFetch([zepto(calls, () => (++n === 1 ? h.json(400, { error: 'bad sender' }) : h.json(200, { request_id: 'ok' })))]);
  let failed;
  let ok;
  smtpReject = true; // both providers clearly refuse the first attempt
  try {
    failed = await h.api('POST', '/api/v1/emails/send', { token: A.token, headers: k3, body: { ...msg, subject: 'Retry' } });
    smtpReject = false;
    ok = await h.api('POST', '/api/v1/emails/send', { token: A.token, headers: k3, body: { ...msg, subject: 'Retry' } });
  } finally { mock.restore(); smtpReject = false; }
  assert.equal(failed.status, 502);
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 2);
});

test('unresolved [placeholders] block approval and sending; filling them works and escapes HTML', async () => {
  const g = await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { recipientEmail: 'pat@client.io' } });
  const d = g.data.draft;
  assert.ok(d.placeholders.length >= 1, JSON.stringify(d.placeholders));
  const blocked = await h.api('PUT', `/api/v1/drafts/${d.id}/approve`, { token: A.token });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.data.code, 'UNRESOLVED_PLACEHOLDERS');

  assert.equal((await h.api('PATCH', `/api/v1/drafts/${d.id}`, { token: A.token, body: { replacements: { 'not a placeholder': 'x' } } })).status, 400);
  assert.equal((await h.api('PATCH', `/api/v1/drafts/${d.id}`, { token: A.token, body: { replacements: { [d.placeholders[0]]: 'see [details]' } } })).status, 400);
  const replacements = Object.fromEntries(d.placeholders.map(p => [p, 'Jo <Sales> & Co']));
  const filled = await h.api('PATCH', `/api/v1/drafts/${d.id}`, { token: A.token, body: { replacements } });
  assert.equal(filled.status, 200);
  assert.deepEqual(filled.data.draft.placeholders, []);
  assert.match(filled.data.draft.body_html, /Jo &lt;Sales&gt; &amp; Co/);
  assert.match(filled.data.draft.body_text, /Jo <Sales> & Co/);
  assert.equal((await h.api('PUT', `/api/v1/drafts/${d.id}/approve`, { token: A.token })).status, 200);

  // Direct sends are checked too; Outlook conditional comments are not placeholders.
  const calls = [];
  const mock = h.mockFetch([zepto(calls)]);
  let bad;
  let okHtml;
  try {
    bad = await h.api('POST', '/api/v1/emails/send', { token: A.token, headers: key(), body: { recipient_email: 'kim@client.io', subject: 'Hi [Company]', body: 'x', confirm: true } });
    okHtml = await h.api('POST', '/api/v1/emails/send-html', { token: A.token, headers: key(), body: { recipient_email: 'kim@client.io', subject: 'Hi', html_body: '<!--[if mso]><table><![endif]--><p>Hello</p><style>a[href]{color:red}</style>', confirm: true } });
  } finally { mock.restore(); }
  assert.equal(bad.data.code, 'UNRESOLVED_PLACEHOLDERS');
  assert.equal(okHtml.status, 200, JSON.stringify(okHtml.data));
  assert.equal(calls.length, 1);
});
