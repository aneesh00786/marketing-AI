const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Suppression policy by email type (lib/mailSuppression.js). ZeptoMail is mocked; nothing is sent.
// Classification: Product Emails, AI Campaigns sequences and Mail Drafts are marketing; invitations
// transactional; Compose is a direct send with the marketing suppression rule until classified.
//                  unsubscribed  consent withdrawn  hard bounce  spam complaint
//   marketing      blocked       blocked            blocked      blocked
//   transactional  allowed       allowed            blocked      blocked
const db = () => h.db();
const policy = () => require('../lib/mailSuppression');
const emailService = () => require('../services/emailService');
const mailRoutes = () => require('../modules/mail/routes');
const uid = () => crypto.randomBytes(4).toString('hex');

let W; let OTHER;
const A = {}; // addresses by reason

const zeptoRoute = calls => ({
  match: u => u.startsWith('https://api.zeptomail.com/'),
  respond: (url, init) => { calls.push(JSON.parse(init.body).to[0].email_address.address); return h.json(200, { request_id: `r-${uid()}` }); }
});
async function withZepto(fn) {
  const calls = [];
  const mock = h.mockFetch([zeptoRoute(calls)]);
  try { return { result: await fn(), calls }; } finally { mock.restore(); }
}
const key = () => ({ 'Idempotency-Key': crypto.randomBytes(16).toString('hex') });
const compose = (ws, to, purpose) => h.api('POST', '/api/v1/emails/send', { token: ws.token, headers: key(), body: { recipient_email: to, subject: 'Hello', body: 'Hi', confirm: true, ...(purpose ? { purpose } : {}) } });

async function approvedDraft(ws, to, leadId = null) {
  const r = await db().run(`INSERT INTO email_drafts (workspace_id, lead_id, recipient_email, recipient_name, subject, body_html, body_text, tone, status, created_at, updated_at)
    VALUES (?, ?, ?, 'R', 'Subject', '<p>Hello</p>', 'Hello', 'Professional', 'Approved', UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [ws.workspaceId, leadId, to]);
  return r.lastID;
}

test.before(async () => {
  await h.prepareDatabase();
  W = await h.createWorkspace({ name: 'Suppression' });
  OTHER = await h.createWorkspace({ name: 'Suppression other' });
  for (const ws of [W, OTHER]) {
    const r = await h.api('POST', '/api/v1/mail/config', { token: ws.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: `z-${ws.workspaceId}`, sender_email: `news@ws${ws.workspaceId}.io`, sender_name: 'N' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  for (const reason of ['unsubscribed', 'bounced', 'complaint', 'legacy_reason']) {
    A[reason] = `${reason}-${uid()}@acme.io`;
    await db().run('INSERT INTO email_suppressions (workspace_id, email, reason, source, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())', [W.workspaceId, A[reason], reason, 'test']);
  }
  A.withdrawn = `withdrawn-${uid()}@acme.io`;
  A.withdrawnLead = (await db().run("INSERT INTO leads (workspace_id, name, email, status, marketing_consent, created_at) VALUES (?, 'Wanda', ?, 'New', 'withdrawn', UTC_TIMESTAMP())", [W.workspaceId, A.withdrawn])).lastID;
  A.clean = `clean-${uid()}@acme.io`;
});
test.after(() => h.shutdown());

test('policy matrix: each reason against each email type; unknown reasons block everything; case-insensitive; per workspace', async () => {
  const p = policy();
  const expect = {
    unsubscribed: { marketing: 'unsubscribed', transactional: null },
    withdrawn: { marketing: 'consent_withdrawn', transactional: null },
    bounced: { marketing: 'bounced', transactional: 'bounced' },
    complaint: { marketing: 'complaint', transactional: 'complaint' },
    legacy_reason: { marketing: 'other', transactional: 'other' },
    clean: { marketing: null, transactional: null }
  };
  for (const [k, byType] of Object.entries(expect)) {
    for (const [type, reason] of Object.entries(byType)) {
      const got = await p.suppressionBlock(W.workspaceId, ` ${A[k].toUpperCase()} `, type);
      assert.equal(got ? got.reason : null, reason, `${k} / ${type}`);
      if (got) assert.doesNotMatch(got.message, /@/, 'messages carry no address');
    }
    assert.equal(await p.suppressionBlock(OTHER.workspaceId, A[k], 'marketing'), null, `${k}: other workspace unaffected`);
  }
  await assert.rejects(p.suppressionBlock(W.workspaceId, A.clean, 'whatever'));
});

test('shared sender: transactional sends skip unsubscribes but never reach hard bounces or complaints; marketing cannot be loosened', async () => {
  const send = (to, extra = {}) => emailService().sendRealEmail(W.workspaceId, { to, subject: 's', html: '<p>x</p>', ...extra });
  let r = await withZepto(() => send(A.unsubscribed));
  assert.deepEqual(r.calls, [A.unsubscribed], 'transactional email to an unsubscribed address is allowed');
  r = await withZepto(() => send(A.withdrawn));
  assert.equal(r.calls.length, 1, 'withdrawn marketing consent does not block a transactional email');
  for (const k of ['bounced', 'complaint', 'legacy_reason']) {
    const calls = [];
    const mock = h.mockFetch([zeptoRoute(calls)]);
    try { await assert.rejects(send(A[k]), e => e.code === 'RECIPIENT_SUPPRESSED' && e.status === 409); } finally { mock.restore(); }
    assert.equal(calls.length, 0, `${k}: no provider call`);
  }
  for (const k of ['unsubscribed', 'withdrawn']) {
    await assert.rejects(withZepto(() => send(A[k], { suppressionPolicy: 'marketing' })), e => e.code === 'RECIPIENT_SUPPRESSED', `${k} blocked for marketing`);
  }
  // purpose 'marketing' (Product Emails) is checked as marketing even if a caller asks for transactional.
  await assert.rejects(send(A.unsubscribed, { purpose: 'marketing', suppressionPolicy: 'transactional' }), e => e.code === 'RECIPIENT_SUPPRESSED');
  assert.equal(await db().get('SELECT 1 AS x FROM mail_message_tracking WHERE workspace_id = ? AND delivery_status = ? LIMIT 1', [W.workspaceId, 'failed']) ?? null, null, 'refused before any tracking or provider attempt');
});

test('Compose & Send without a purpose gets the stricter marketing rule: every reason is refused before claiming, audited without the address', async () => {
  for (const k of ['unsubscribed', 'withdrawn', 'bounced', 'complaint']) {
    const { result: r, calls } = await withZepto(() => compose(W, A[k]));
    assert.equal(r.status, 409, `${k}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, 'RECIPIENT_SUPPRESSED');
    assert.equal(calls.length, 0);
  }
  assert.equal((await db().get("SELECT COUNT(*) AS n FROM mail_send_requests WHERE workspace_id = ?", [W.workspaceId])).n, 0, 'no idempotency claim was taken');
  const rows = await db().all("SELECT metadata_json FROM audit_logs WHERE workspace_id = ? AND action = 'mail.send_blocked'", [W.workspaceId]);
  assert.ok(rows.length >= 4);
  assert.deepEqual([...new Set(rows.map(r => JSON.parse(r.metadata_json).reason))].sort(), ['bounced', 'complaint', 'consent_withdrawn', 'unsubscribed']);
  assert.doesNotMatch(JSON.stringify(rows), /@acme\.io/, 'no addresses in the audit log');
  const ok = await withZepto(() => compose(W, A.clean, 'transactional'));
  assert.equal(ok.result.status, 200);
  assert.equal((await withZepto(() => compose(OTHER, A.bounced, 'transactional'))).result.status, 200, "another workspace's list does not apply");
});

test('Compose & Send declared transactional: unsubscribes and withdrawn consent are allowed; hard bounces and complaints stay blocked', async () => {
  assert.equal((await withZepto(() => compose(W, A.unsubscribed, 'transactional'))).result.status, 200);
  assert.equal((await withZepto(() => compose(W, A.withdrawn, 'transactional'))).result.status, 200);
  for (const k of ['bounced', 'complaint']) {
    const { result, calls } = await withZepto(() => compose(W, A[k], 'transactional'));
    assert.equal(result.data.code, 'RECIPIENT_SUPPRESSED', k);
    assert.equal(calls.length, 0);
  }
});

test('Mail Drafts use the stricter rule: approval and sending refuse every reason, including a linked contact who withdrew consent; the draft stays Approved', async () => {
  assert.equal(mailRoutes().SUPPRESSION_POLICY.draft, 'marketing');
  for (const k of ['unsubscribed', 'bounced', 'complaint']) {
    const id = await approvedDraft(W, A[k]);
    const { result, calls } = await withZepto(() => h.api('POST', `/api/v1/drafts/${id}/send`, { token: W.token, body: { confirm: true } }));
    assert.equal(result.status, 409, k);
    assert.equal(calls.length, 0);
    assert.equal((await db().get('SELECT status FROM email_drafts WHERE id = ?', [id])).status, 'Approved');
  }
  const linked = await approvedDraft(W, A.withdrawn, A.withdrawnLead);
  assert.match((await withZepto(() => h.api('POST', `/api/v1/drafts/${linked}/send`, { token: W.token, body: { confirm: true } }))).result.data.error, /withdrawn marketing consent/);
  await db().run("UPDATE email_drafts SET status = 'Draft' WHERE id = ?", [linked]);
  assert.equal((await h.api('PUT', `/api/v1/drafts/${linked}/approve`, { token: W.token })).status, 409, 'cannot be approved either');
  const unlinked = await approvedDraft(W, A.withdrawn);
  assert.equal((await withZepto(() => h.api('POST', `/api/v1/drafts/${unlinked}/send`, { token: W.token, body: { confirm: true } }))).result.status, 409, 'withdrawn consent found by address too');
});

test('Mail Drafts are always marketing: even if the route-level classification were loosened, the shared sender refuses unsubscribed or withdrawn recipients', async () => {
  const P = mailRoutes().SUPPRESSION_POLICY;
  P.draft = 'transactional';
  try {
    for (const k of ['unsubscribed', 'withdrawn']) {
      const id = await approvedDraft(W, A[k]);
      const { result, calls } = await withZepto(() => h.api('POST', `/api/v1/drafts/${id}/send`, { token: W.token, body: { confirm: true } }));
      assert.equal(result.status, 409, k);
      assert.equal(result.data.code, 'RECIPIENT_SUPPRESSED', `${k}: blocked inside the sender`);
      assert.equal(calls.length, 0);
      assert.equal((await db().get('SELECT status FROM email_drafts WHERE id = ?', [id])).status, 'Approved');
    }
  } finally { P.draft = 'marketing'; }
});

test('workspace invitations are transactional: sent to an unsubscribed address, not to a hard-bounced one (the link is still shown)', async () => {
  const inv = email => h.api('POST', '/api/v1/workspace/invitations', { token: W.token, body: { email, role: 'Member' } });
  const u = await withZepto(() => inv(A.unsubscribed));
  assert.equal(u.result.status, 200, JSON.stringify(u.result.data));
  assert.equal(u.result.data.emailed, true);
  const b = await withZepto(() => inv(A.bounced));
  assert.equal(b.result.data.emailed, false);
  assert.equal(b.calls.length, 0);
  assert.match(b.result.data.emailError, /bounced/);
});
