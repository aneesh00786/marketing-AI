const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Every send in this file goes to a mocked ZeptoMail endpoint; unmatched requests fail loudly.
let A;
let B;
let C;
let D; // SMTP mailbox approved for marketing: Mail Drafts are marketing email (never ZeptoMail)

/** Stubbed SMTP: records { auth (SMTP user), from, to, html, text, headers }; respond(msg) may return a status to reject. */
const nodemailer = require('nodemailer');
function smtpRoute(calls, status = 200) {
  const original = nodemailer.createTransport;
  const hosts = process.env.MAIL_ALLOW_PRIVATE_HOSTS;
  process.env.MAIL_ALLOW_PRIVATE_HOSTS = 'true'; // only while stubbed: no DNS lookups of the fake SMTP host
  nodemailer.createTransport = opts => ({
    sendMail: async m => {
      calls.push({ auth: opts?.auth?.user, from: m.from, to: m.to, html: m.html, text: m.text, headers: m.headers || {} });
      if (status >= 400) throw Object.assign(new Error(`Recipient rejected (${status})`), { code: 'EENVELOPE', responseCode: 550 });
      return { messageId: `<m${calls.length}@d-co.io>`, response: '250 OK', accepted: [m.to] };
    }
  });
  return { restore: () => { nodemailer.createTransport = original; if (hosts === undefined) delete process.env.MAIL_ALLOW_PRIVATE_HOSTS; else process.env.MAIL_ALLOW_PRIVATE_HOSTS = hosts; } };
}

const zeptoRoute = (calls, status = 200) => ({
  match: u => u.startsWith('https://api.zeptomail.com/'),
  respond: (url, init) => { calls.push({ auth: init.headers.Authorization, body: JSON.parse(init.body) }); return status === 200 ? h.json(200, { request_id: `req-${calls.length}` }) : h.json(status, { error: 'rejected' }); }
});

async function configure(ws, token, sender) {
  const r = await h.api('POST', '/api/v1/mail/config', { token: ws.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: token, sender_email: sender, sender_name: 'Sender ' + sender } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

/** Fills the draft's [placeholders] (as a person would) so it can be approved. */
async function fill(ws, draft) {
  const replacements = Object.fromEntries((draft.placeholders || []).map(p => [p, 'Jane Doe']));
  const r = await h.api('PATCH', `/api/v1/drafts/${draft.id}`, { token: ws.token, body: { replacements } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.draft.placeholders, []);
  return r.data.draft;
}

const key = () => ({ 'Idempotency-Key': require('crypto').randomBytes(16).toString('hex') });

async function newDraft(ws, body = {}) {
  const r = await h.api('POST', '/api/v1/drafts/generate', { token: ws.token, body: { recipientName: 'Dana', recipientEmail: 'dana@acme.io', goal: 'Intro', ...body } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.draft;
}

test.before(async () => {
  await h.prepareDatabase();
  A = await h.createWorkspace({ name: 'Mail A' });
  B = await h.createWorkspace({ name: 'Mail B' });
  C = await h.createWorkspace({ name: 'Mail C (unconfigured)' });
  await configure(A, 'zepto-token-A', 'news@a-co.io');
  await configure(B, 'zepto-token-B', 'hello@b-co.io');
  D = await h.createWorkspace({ name: 'Mail D (SMTP, marketing approved)' });
  assert.equal((await h.api('POST', '/api/v1/mail/config', { token: D.token, body: { provider: 'custom_smtp', smtp_host: 'smtp.d-co.io', smtp_port: 587, smtp_user: 'news@d-co.io', smtp_pass: 'pw', sender_email: 'news@d-co.io', sender_name: 'D Co' } })).status, 200);
  assert.equal((await h.api('POST', '/api/v1/mail/marketing', { token: D.token, body: { approved: true, confirm: true, note: 'Provider allows marketing (test)' } })).status, 200);
});
test.after(() => h.shutdown());

test('mail settings are per workspace and never expose secrets', async () => {
  const a = (await h.api('GET', '/api/v1/mail/config', { token: A.token })).data.config;
  const b = (await h.api('GET', '/api/v1/mail/config', { token: B.token })).data.config;
  assert.equal(a.sender_email, 'news@a-co.io');
  assert.equal(b.sender_email, 'hello@b-co.io');
  assert.equal(a.smtp_pass, '••••••••');
  assert.ok(!JSON.stringify(a).includes('zepto-token'));
  const row = await h.db().get('SELECT smtp_pass FROM mail_configurations WHERE workspace_id = ?', [A.workspaceId]);
  assert.match(row.smtp_pass, /^enc:/, 'stored encrypted');

  // A workspace without settings inherits nothing from the server or other workspaces.
  const c = (await h.api('GET', '/api/v1/mail/config', { token: C.token })).data.config;
  assert.equal(c.status, 'Not Configured');
  assert.equal(c.sender_email, null);
  assert.equal(c.has_smtp_auth, false);
  assert.doesNotMatch(JSON.stringify(c), /thrivewoo|zoho|zeptomail\.com/i);

  // A workspace_id in the body is ignored: saving only ever touches the caller's row.
  await h.api('POST', '/api/v1/mail/config', { token: B.token, body: { workspace_id: A.workspaceId, sender_name: 'B renamed' } });
  assert.equal((await h.api('GET', '/api/v1/mail/config', { token: A.token })).data.config.sender_name, 'Sender news@a-co.io');
});

test('drafts of another workspace cannot be listed, viewed, edited, rewritten, approved, sent or deleted', async () => {
  const d = await newDraft(A, { workspace_id: B.workspaceId });
  assert.equal(Number((await h.db().get('SELECT workspace_id FROM email_drafts WHERE id = ?', [d.id])).workspace_id), A.workspaceId, 'body workspace_id ignored');

  const list = await h.api('GET', '/api/v1/drafts', { token: B.token });
  assert.equal(list.status, 200);
  assert.ok(!list.data.drafts.some(x => x.id === d.id));
  assert.ok(list.data.drafts.every(x => Number(x.workspace_id) === B.workspaceId));

  const calls = [];
  const mock = h.mockFetch([zeptoRoute(calls), { match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) }]);
  try {
    const attempts = [
      ['GET', `/api/v1/drafts/${d.id}`],
      ['PATCH', `/api/v1/drafts/${d.id}`, { recipient_email: 'attacker@evil.io' }],
      ['POST', `/api/v1/drafts/${d.id}/rewrite`, { instruction: 'Short' }],
      ['PUT', `/api/v1/drafts/${d.id}/approve`],
      ['POST', `/api/v1/drafts/${d.id}/send`, { confirm: true }],
      ['DELETE', `/api/v1/drafts/${d.id}`],
      ['DELETE', `/api/drafts/${d.id}`]
    ];
    for (const [method, path, body] of attempts) {
      const r = await h.api(method, path, { token: B.token, body });
      assert.equal(r.status, 404, `${method} ${path} -> ${r.status}`);
    }
  } finally { mock.restore(); }
  assert.equal(calls.length, 0, 'nothing sent');
  const row = await h.db().get('SELECT recipient_email, status FROM email_drafts WHERE id = ?', [d.id]);
  assert.equal(row.recipient_email, 'dana@acme.io');
  assert.equal(row.status, 'Draft');
});

test('emails of another workspace stay private', async () => {
  const { run } = h.db();
  const inbound = await run(
    "INSERT INTO emails (workspace_id, sender, sender_email, recipient_email, recipient_name, subject, body, status, is_urgent, is_read, received_at) VALUES (?, 'Kim', 'kim@client.io', 'news@a-co.io', 'A', 'A private thread', 'secret', 'Unread', 1, 0, UTC_TIMESTAMP())",
    [A.workspaceId]
  );
  for (const path of ['/api/v1/emails', '/api/emails', '/api/tools/get_emails']) {
    const r = await h.api('GET', path, { token: B.token });
    assert.equal(r.status, 200, path);
    assert.ok(!JSON.stringify(r.data).includes('A private thread'), `${path} leaks A mail`);
  }
  const own = await h.api('GET', '/api/v1/emails', { token: A.token });
  assert.ok(own.data.emails.some(e => e.id === inbound.lastID));
  const analyze = await h.api('POST', `/api/v1/emails/${inbound.lastID}/ai-analyze`, { token: B.token });
  assert.equal(analyze.status, 404);
});

test('permissions: members draft, approvers send, only owners/admins configure', async () => {
  const member = await h.addMember(A.workspaceId, 'Member');
  const approver = await h.addMember(A.workspaceId, 'Approver');
  assert.equal((await h.api('GET', '/api/v1/drafts', { token: member.token })).status, 200);
  const md = await h.api('POST', '/api/v1/drafts/generate', { token: member.token, body: { recipientEmail: 'lee@acme.io', goal: 'Hi' } });
  assert.equal(md.status, 200);
  const id = md.data.draft.id;
  await fill(member, md.data.draft);
  assert.equal((await h.api('PUT', `/api/v1/drafts/${id}/approve`, { token: member.token })).status, 403);
  assert.equal((await h.api('POST', `/api/v1/drafts/${id}/send`, { token: member.token, body: { confirm: true } })).status, 403);
  assert.equal((await h.api('POST', '/api/v1/emails/send', { token: member.token, body: { recipient_email: 'lee@acme.io', subject: 's', body: 'b', confirm: true } })).status, 403);
  for (const [m, p] of [['GET', '/api/v1/mail/config'], ['POST', '/api/v1/mail/config'], ['POST', '/api/v1/mail/test-smtp']]) {
    const body = m === 'GET' ? undefined : {};
    assert.equal((await h.api(m, p, { token: member.token, body })).status, 403, `member ${m} ${p}`);
    assert.equal((await h.api(m, p, { token: approver.token, body })).status, 403, `approver ${m} ${p}`);
  }
  assert.equal((await h.api('POST', '/api/v1/drafts/generate', { token: approver.token, body: {} })).status, 403);
  assert.equal((await h.api('PUT', `/api/v1/drafts/${id}/approve`, { token: approver.token })).status, 200);
  assert.equal((await h.api('GET', '/api/v1/drafts')).status, 401);
  assert.equal((await h.api('POST', '/api/v1/emails/send', { body: { recipient_email: 'lee@acme.io', subject: 's', confirm: true } })).status, 401);
});

test('sending needs a valid recipient, approval and explicit confirmation, and uses only the caller mailbox', async () => {
  // Placeholder or malformed recipients are rejected up front.
  for (const bad of ['x@example.com', 'not-an-email', 'a@foo.test']) {
    assert.equal((await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { recipientEmail: bad } })).status, 400, bad);
  }
  const noRecipient = await newDraft(A, { recipientEmail: '' });
  assert.equal((await h.api('PUT', `/api/v1/drafts/${noRecipient.id}/approve`, { token: A.token })).status, 400);

  // Mail Drafts are marketing email: sent only through the workspace's SMTP mailbox approved for marketing.
  const d = await fill(D, await newDraft(D));
  const calls = [];
  const zepto = [];
  const mock = smtpRoute(calls);
  const zmock = h.mockFetch([zeptoRoute(zepto)]);
  try {
    assert.equal((await h.api('POST', `/api/v1/drafts/${d.id}/send`, { token: D.token, body: {} })).status, 400, 'no confirm');
    assert.equal((await h.api('POST', `/api/v1/drafts/${d.id}/send`, { token: D.token, body: { confirm: false } })).status, 400, 'confirm false');
    const unapproved = await h.api('POST', `/api/v1/drafts/${d.id}/send`, { token: D.token, body: { confirm: true } });
    assert.equal(unapproved.status, 409);
    assert.equal(unapproved.data.code, 'NOT_APPROVED');
    assert.equal(calls.length, 0);

    assert.equal((await h.api('PUT', `/api/v1/drafts/${d.id}/approve`, { token: D.token })).status, 200);
    const sent = await h.api('POST', `/api/v1/drafts/${d.id}/send`, { token: D.token, body: { confirm: true } });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    const again = await h.api('POST', `/api/v1/drafts/${d.id}/send`, { token: D.token, body: { confirm: true } });
    assert.equal(again.status, 409, 'never sent twice');
  } finally { mock.restore(); zmock.restore(); }
  assert.equal(calls.length, 1);
  assert.equal(zepto.length, 0, 'never through ZeptoMail');
  assert.equal(calls[0].auth, 'news@d-co.io', "D's own mailbox, never another workspace's or the server's");
  assert.match(calls[0].from, /news@d-co\.io/);
  assert.equal(calls[0].to, 'dana@acme.io');
  assert.match(calls[0].headers['List-Unsubscribe'] || '', /mailto:news@d-co\.io\?subject=unsubscribe/, 'marketing: List-Unsubscribe');
  assert.match(calls[0].html, /To stop these emails, reply &quot;unsubscribe&quot;/, 'marketing: visible opt-out in the body');
  const { get } = h.db();
  assert.equal((await get('SELECT status FROM email_drafts WHERE id = ?', [d.id])).status, 'Sent');
  const rec = await get("SELECT workspace_id, sender_email FROM emails WHERE workspace_id = ? AND recipient_email = 'dana@acme.io' ORDER BY id DESC LIMIT 1", [D.workspaceId]);
  assert.equal(rec.sender_email, 'news@d-co.io');

  // A workspace that only has ZeptoMail cannot send drafts (marketing): refused, nothing sent, draft kept Approved.
  const z = await fill(A, await newDraft(A));
  assert.equal((await h.api('PUT', `/api/v1/drafts/${z.id}/approve`, { token: A.token })).status, 200);
  const zcalls = [];
  const zm = h.mockFetch([zeptoRoute(zcalls)]);
  let blocked;
  try { blocked = await h.api('POST', `/api/v1/drafts/${z.id}/send`, { token: A.token, body: { confirm: true } }); } finally { zm.restore(); }
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'MARKETING_PROVIDER_BLOCKED');
  assert.equal(zcalls.length, 0, 'no ZeptoMail fallback for marketing');
  assert.equal((await get('SELECT status FROM email_drafts WHERE id = ?', [z.id])).status, 'Approved');

  // Direct send from Mail Center: same rules.
  const direct = [];
  const mock2 = h.mockFetch([zeptoRoute(direct)]);
  try {
    const msg = { recipient_email: 'kim@client.io', subject: 'Hello', body: 'Hi Kim', purpose: 'transactional' };
    assert.equal((await h.api('POST', '/api/v1/emails/send', { token: B.token, body: msg })).status, 400, 'no confirm');
    assert.equal((await h.api('POST', '/api/v1/emails/send', { token: B.token, body: { ...msg, recipient_email: 'kim@example.com', confirm: true } })).status, 400);
    const ok = await h.api('POST', '/api/v1/emails/send', { token: B.token, body: { ...msg, confirm: true }, headers: key() });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
  } finally { mock2.restore(); }
  assert.equal(direct.length, 1);
  assert.equal(direct[0].auth, 'zepto-token-B');
});

test('failures are reported and nothing is recorded as sent', async () => {
  const { get } = h.db();
  const d = await fill(D, await newDraft(D, { recipientEmail: 'fail@acme.io' }));
  await h.api('PUT', `/api/v1/drafts/${d.id}/approve`, { token: D.token });
  const calls = [];
  // A clear rejection by the SMTP server: nothing was sent. (A dropped connection is an unknown outcome; see mailSafety.test.js.)
  const mock = smtpRoute(calls, 550);
  let r;
  try {
    r = await h.api('POST', `/api/v1/drafts/${d.id}/send`, { token: D.token, body: { confirm: true } });
  } finally { mock.restore(); }
  assert.equal(r.status, 502, JSON.stringify(r.data));
  assert.equal((await get('SELECT status FROM email_drafts WHERE id = ?', [d.id])).status, 'Approved', 'back to Approved, not Sent');
  assert.equal(Number((await get("SELECT COUNT(*) AS c FROM emails WHERE recipient_email = 'fail@acme.io'")).c), 0);

  // An unconfigured workspace never falls back to the server mailbox, even when .env has a token.
  const saved = process.env.ZEPTOMAIL_TOKEN;
  process.env.ZEPTOMAIL_TOKEN = 'server-env-token';
  const leaked = [];
  const mock2 = h.mockFetch([zeptoRoute(leaked)]);
  let c;
  try {
    c = await h.api('POST', '/api/v1/emails/send', { token: C.token, body: { recipient_email: 'kim@client.io', subject: 'Hi', body: 'x', purpose: 'transactional', confirm: true }, headers: key() });
  } finally { mock2.restore(); process.env.ZEPTOMAIL_TOKEN = saved; }
  assert.equal(c.status, 503);
  assert.equal(c.data.code, 'MAIL_NOT_CONFIGURED');
  assert.equal(leaked.length, 0);
});

test('tool and Roger "send" commands only create drafts', async () => {
  const calls = [];
  const mock = h.mockFetch([zeptoRoute(calls), { match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) }]);
  let tool;
  let roger;
  const W1 = await h.addMember(1, 'Workspace Owner');
  try {
    tool = await h.api('POST', '/api/tools/send_email', { token: A.token, body: { recipient_email: 'tool@acme.io', subject: 'From tool', body: 'Hello <b>there</b>' } });
    roger = await h.api('POST', '/api/v1/assistant/chat', { token: W1.token, body: { message: 'send email to roger-target@acme.io saying Thanks for the call today' } });
  } finally { mock.restore(); }
  assert.equal(tool.status, 200, JSON.stringify(tool.data));
  assert.equal(tool.data.sent, false);
  const draft = await h.db().get('SELECT workspace_id, status, body_html FROM email_drafts WHERE id = ?', [tool.data.draftId]);
  assert.equal(Number(draft.workspace_id), A.workspaceId);
  assert.equal(draft.status, 'Draft');
  assert.match(draft.body_html, /&lt;b&gt;there&lt;\/b&gt;/);
  assert.match(roger.data.reply, /have not sent it yet/);
  assert.equal(calls.length, 0);
});

test('mail hosts cannot point at private or metadata addresses', async () => {
  for (const host of ['127.0.0.1', '169.254.169.254', 'localhost', '10.0.0.5']) {
    const r = await h.api('POST', '/api/v1/mail/test-smtp', { token: A.token, body: { config: { provider: 'custom_smtp', smtp_host: host, smtp_port: 25, smtp_user: 'u@a-co.io', smtp_pass: 'p' } } });
    assert.equal(r.status, 200);
    assert.equal(r.data.success, false, host);
    assert.match(r.data.error, /not allowed/i, host);
  }
});

test('editing a draft body: sanitized, text regenerated, approval reset, locked once sent, other workspaces refused', async () => {
  const d = await fill(A, await newDraft(A));
  const approved = await h.api('PUT', `/api/v1/drafts/${d.id}/approve`, { token: A.token });
  assert.equal(approved.data.draft.status, 'Approved');

  const r = await h.api('PATCH', `/api/v1/drafts/${d.id}`, { token: A.token, body: { body_html: '<p>Hello <b>Dana</b></p><script>alert(1)</script><img src=x onerror="alert(2)">' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.draft.status, 'Draft', 'an edited draft must be approved again');
  assert.match(r.data.draft.body_html, /Hello <b>Dana<\/b>/);
  assert.doesNotMatch(r.data.draft.body_html, /<script|onerror/i);
  assert.match(r.data.draft.body_text, /Hello Dana/);

  const empty = await h.api('PATCH', `/api/v1/drafts/${d.id}`, { token: A.token, body: { body_html: '<script>x</script>' } });
  assert.equal(empty.status, 400, 'a body that sanitizes to nothing is refused');
  assert.equal((await h.api('PATCH', `/api/v1/drafts/${d.id}`, { token: B.token, body: { body_html: '<p>x</p>' } })).status, 404);

  await h.db().run("UPDATE email_drafts SET status = 'Sent' WHERE id = ?", [d.id]);
  const locked = await h.api('PATCH', `/api/v1/drafts/${d.id}`, { token: A.token, body: { body_html: '<p>Too late</p>' } });
  assert.equal(locked.status, 409);
  assert.equal(locked.data.code, 'DRAFT_SENT');
});

async function newLead(ws, body) {
  const r = await h.api('POST', '/api/v1/leads', { token: ws.token, body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.lead;
}

test('a draft is addressed to a contact (lead): recipient comes from the lead, changes need re-approval, other workspaces refused', async () => {
  const lead = await newLead(A, { name: 'Priya Shah', email: `priya.${Date.now()}@acme.io`, companyName: 'Acme' });
  const d = await fill(A, await newDraft(A));
  await h.api('PUT', `/api/v1/drafts/${d.id}/approve`, { token: A.token });

  const linked = await h.api('PATCH', `/api/v1/drafts/${d.id}`, { token: A.token, body: { lead_id: lead.id, recipient_name: 'Ignored' } });
  assert.equal(linked.status, 400, 'a contact and a typed address cannot be mixed');
  const r = await h.api('PATCH', `/api/v1/drafts/${d.id}`, { token: A.token, body: { lead_id: lead.id } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.draft.lead_id, lead.id);
  assert.equal(r.data.draft.recipient_email, lead.email);
  assert.equal(r.data.draft.recipient_name, 'Priya Shah');
  assert.equal(r.data.draft.status, 'Draft', 'changing the recipient revokes the approval');
  assert.deepEqual(r.data.draft.contact, { id: lead.id, name: 'Priya Shah', email: lead.email, company: 'Acme', productId: null });
  const listed = (await h.api('GET', '/api/v1/drafts', { token: A.token })).data.drafts.find(x => x.id === d.id);
  assert.equal(listed.contact.company, 'Acme');

  const foreign = await newLead(B, { name: 'Other WS', email: `o.${Date.now()}@b.io` });
  assert.equal((await h.api('PATCH', `/api/v1/drafts/${d.id}`, { token: A.token, body: { lead_id: foreign.id } })).status, 404);
  const noEmail = await newLead(A, { name: 'No Email' });
  const ne = await h.api('PATCH', `/api/v1/drafts/${d.id}`, { token: A.token, body: { lead_id: noEmail.id } });
  assert.equal(ne.status, 400);
  assert.equal(ne.data.code, 'LEAD_NO_EMAIL');

  const manual = await h.api('PATCH', `/api/v1/drafts/${d.id}`, { token: A.token, body: { recipient_email: 'someone@else.io', recipient_name: 'Someone' } });
  assert.equal(manual.data.draft.lead_id, null, 'a typed address is not linked to the previous contact');
  assert.equal(manual.data.draft.contact, null);
});

test('approval and sending re-check the contact: deleted, email changed, consent withdrawn, unsubscribed or bounced are refused and nothing is sent', async () => {
  const calls = [];
  const mock = h.mockFetch([zeptoRoute(calls)]);
  try {
    const mk = async (suffix) => {
      const lead = await newLead(A, { name: `Contact ${suffix}`, email: `c${suffix}.${Date.now()}@acme.io` });
      const d = await fill(A, await newDraft(A));
      await h.api('PATCH', `/api/v1/drafts/${d.id}`, { token: A.token, body: { lead_id: lead.id } });
      await h.api('PUT', `/api/v1/drafts/${d.id}/approve`, { token: A.token });
      return { lead, d };
    };
    const send = (d) => h.api('POST', `/api/v1/drafts/${d.id}/send`, { token: A.token, body: { confirm: true }, headers: key() });

    const changed = await mk('changed');
    await h.db().run('UPDATE leads SET email = ? WHERE id = ?', [`moved.${Date.now()}@acme.io`, changed.lead.id]);
    let r = await send(changed.d);
    assert.equal(r.status, 409);
    assert.match(r.data.error, /email address changed/);

    const withdrawn = await mk('withdrawn');
    await h.db().run("UPDATE leads SET marketing_consent = 'withdrawn' WHERE id = ?", [withdrawn.lead.id]);
    r = await send(withdrawn.d);
    assert.equal(r.data.code, 'RECIPIENT_INELIGIBLE');

    const unsub = await mk('unsub');
    await h.db().run("INSERT INTO email_suppressions (workspace_id, email, reason, source, created_at) VALUES (?, ?, 'unsubscribed', 'test', UTC_TIMESTAMP())", [A.workspaceId, unsub.lead.email.toLowerCase()]);
    r = await send(unsub.d);
    assert.match(r.data.error, /unsubscribed/);

    const gone = await mk('gone');
    await h.db().run('DELETE FROM leads WHERE id = ?', [gone.lead.id]);
    r = await send(gone.d);
    assert.match(r.data.error, /was deleted/);
    const reapprove = await h.api('PUT', `/api/v1/drafts/${gone.d.id}/approve`, { token: A.token });
    assert.equal(reapprove.status, 409, 'approval is refused too');

    assert.equal(calls.length, 0, 'no email was sent');
    for (const x of [changed, withdrawn, unsub, gone]) {
      assert.equal((await h.db().get('SELECT status FROM email_drafts WHERE id = ?', [x.d.id])).status, 'Approved', 'refused before claiming: the draft stays Approved');
    }
  } finally { mock.restore(); }
});
