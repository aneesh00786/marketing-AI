const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Compose & Send purpose: declared by the sender, validated by the server (lib/mailPurpose.js).
// ZeptoMail is mocked and SMTP stubbed; nothing is sent.
const db = () => h.db();
const purpose = () => require('../lib/mailPurpose');
const uid = () => crypto.randomBytes(4).toString('hex');
const key = () => ({ 'Idempotency-Key': crypto.randomBytes(16).toString('hex') });

let Z;  // ZeptoMail only (transactional/direct allowed; no marketing mailbox)
let S;  // SMTP mailbox approved for marketing
let OTHER;
const T = {}; // templates

const RECEIPT = { subject: 'Your order #1042 has shipped', body: 'Hi Kim, your order #1042 shipped today. Tracking number: 1Z999. A discount of $5 was applied.' };
const PROMO = { subject: 'Spring sale', body: 'Hi Kim, our spring sale is on: 30% off everything for a limited time. Shop now!' };
const PROMO_TEMPLATE_HTML = '<h1>Spring collection is here for every customer</h1><p>Discover our brand new spring collection with fresh colours and styles for the whole family.</p><p>Visit our stores this weekend to see everything that arrived this season.</p>';

const zeptoRoute = calls => ({ match: u => u.startsWith('https://api.zeptomail.com/'), respond: (u, init) => { calls.push(JSON.parse(init.body)); return h.json(200, { request_id: `r-${uid()}` }); } });
async function send(ws, body, { smtp = [], zepto = [], smtpRespond, headers } = {}) {
  const mock = h.mockFetch([zeptoRoute(zepto), h.smtpRoute(m => smtp.push(m), smtpRespond)]);
  try { return await h.api('POST', body.html_body ? '/api/v1/emails/send-html' : '/api/v1/emails/send', { token: ws.token, headers: headers || key(), body: { recipient_email: `kim-${uid()}@client.io`, confirm: true, ...body } }); } finally { mock.restore(); }
}

test.before(async () => {
  await h.prepareDatabase();
  process.env.APP_BASE_URL = 'https://app.marketech.test';
  Z = await h.createWorkspace({ name: 'Purpose ZeptoMail' });
  S = await h.createWorkspace({ name: 'Purpose SMTP' });
  OTHER = await h.createWorkspace({ name: 'Purpose other' });
  assert.equal((await h.api('POST', '/api/v1/mail/config', { token: Z.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: 'zepto-Z', sender_email: 'hello@z-co.io', sender_name: 'Z' } })).status, 200);
  await h.useMarketingSmtp(S, 'news@s-co.io');
  const mk = async (ws, name, category, html) => (await h.api('POST', '/api/v1/mail/templates', { token: ws.token, body: { name, category, html } })).data.template.id;
  T.promo = await mk(S, 'Spring', 'Promotion', PROMO_TEMPLATE_HTML);
  T.receipt = await mk(S, 'Receipt', 'Transactional', '<p>Your receipt</p>');
  T.zPromo = await mk(Z, 'Z spring', 'Newsletter', PROMO_TEMPLATE_HTML);
  T.other = await mk(OTHER, 'Other', 'Transactional', '<p>x</p>');
});
test.after(() => h.shutdown());

test('classifier: transactional only when declared and nothing points to marketing', async () => {
  const c = (declared, msg, templateId, ws = S) => purpose().classify(ws.workspaceId, { declared, subject: msg.subject, html: msg.html || null, text: msg.body, templateId });
  assert.deepEqual(await c(undefined, RECEIPT), { purpose: 'marketing', declared: null, reasons: ['purpose_missing'], reclassified: false });
  assert.equal((await c('transactional', RECEIPT)).purpose, 'transactional', 'one promotional word ("discount") in a receipt is not enough');
  assert.deepEqual((await c('transactional', PROMO)).reasons, ['promotional_phrases']);
  assert.ok((await c('transactional', PROMO)).reclassified);
  assert.deepEqual((await c('transactional', { subject: 'Update', body: 'News. To unsubscribe, reply STOP.' })).reasons, ['unsubscribe_wording']);
  assert.deepEqual((await c('transactional', { subject: 'Hi', html: '<a href="$[LI:UNSUBSCRIBE]$">x</a>', body: '' })).reasons.includes('zoho_merge_tags'), true);
  assert.deepEqual((await c('transactional', RECEIPT, T.promo)).reasons, ['template_marketing_category']);
  assert.equal((await c('transactional', RECEIPT, T.receipt)).purpose, 'transactional');
  assert.deepEqual((await c('transactional', RECEIPT, T.other)).reasons, ['template_unknown'], "another workspace's template is not trusted");
  assert.deepEqual((await c('transactional', { subject: 'Hello', html: `<div>Hi Kim,</div>${PROMO_TEMPLATE_HTML}`, body: '' })).reasons, ['matches_marketing_template'], 'pasted without a template id');
  assert.equal((await c('marketing', RECEIPT)).purpose, 'marketing');
});

test('transactional/direct: sent through ZeptoMail, no marketing headers, transactional suppression; audited with the purpose', async () => {
  const zepto = [];
  const r = await send(Z, { ...RECEIPT, purpose: 'transactional' }, { zepto });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.purpose, 'transactional');
  assert.equal(zepto.length, 1);
  assert.equal(zepto[0].mime_headers, undefined);
  const a = await db().get("SELECT metadata_json FROM audit_logs WHERE workspace_id = ? AND action = 'mail.sent' AND resource_id = ?", [Z.workspaceId, String(r.data.emailId)]);
  assert.deepEqual(JSON.parse(a.metadata_json).purpose, { declared: 'transactional', applied: 'transactional', reasons: [] });
});

test('promotional content declared transactional is treated as marketing: never through ZeptoMail; refused without a marketing mailbox, nothing recorded', async () => {
  for (const body of [{ ...PROMO, purpose: 'transactional' }, { ...RECEIPT, purpose: 'transactional', templateId: T.zPromo }, { ...RECEIPT }, { subject: 'Hi', html_body: PROMO_TEMPLATE_HTML, purpose: 'transactional' }]) {
    const zepto = [];
    const smtp = [];
    const before = (await db().get('SELECT COUNT(*) AS n FROM mail_send_requests WHERE workspace_id = ?', [Z.workspaceId])).n;
    const r = await send(Z, body, { zepto, smtp });
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.code, 'MARKETING_PROVIDER_BLOCKED');
    assert.match(r.data.error, /treated as marketing/);
    assert.equal(zepto.length + smtp.length, 0, 'nothing sent, no ZeptoMail fallback');
    assert.equal((await db().get('SELECT COUNT(*) AS n FROM mail_send_requests WHERE workspace_id = ?', [Z.workspaceId])).n, before, 'no idempotency claim');
  }
  assert.equal((await db().get('SELECT COUNT(*) AS n FROM email_drafts WHERE workspace_id = ?', [Z.workspaceId])).n, 0, 'no draft recorded');
  const blocked = await db().all("SELECT metadata_json FROM audit_logs WHERE workspace_id = ? AND action = 'mail.send_blocked'", [Z.workspaceId]);
  assert.ok(blocked.length >= 4);
  assert.ok(blocked.every(b => JSON.parse(b.metadata_json).purpose.applied === 'marketing'));
});

test('marketing (declared or reclassified) with an approved mailbox: sent through SMTP as a recorded marketing draft with unsubscribe link and footer', async () => {
  const smtp = [];
  const r = await send(S, { ...PROMO, purpose: 'marketing' }, { smtp });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.purpose, 'marketing');
  assert.equal(smtp.length, 1);
  assert.match(smtp[0].headers['List-Unsubscribe'], /\/api\/v1\/mail\/unsubscribe\/[a-f0-9]{40}>/);
  assert.match(smtp[0].html, /To stop these emails, reply &quot;unsubscribe&quot;/);
  const d = await db().get("SELECT status, tone, unsubscribe_token, email_id FROM email_drafts WHERE workspace_id = ? AND email_id = ?", [S.workspaceId, r.data.emailId]);
  assert.deepEqual([d.status, d.tone], ['Sent', 'Direct (Compose)']);
  assert.match(d.unsubscribe_token, /^[a-f0-9]{40}$/);

  const smtp2 = [];
  const re = await send(S, { ...PROMO, purpose: 'transactional' }, { smtp: smtp2 });
  assert.equal(re.status, 200);
  assert.equal(re.data.purpose, 'marketing');
  assert.equal(re.data.reclassified, true);
  assert.match(re.data.message, /sent as marketing because it contains promotional wording/);
  assert.ok(await db().get("SELECT 1 AS x FROM audit_logs WHERE workspace_id = ? AND action = 'mail.purpose_reclassified' AND resource_id = ?", [S.workspaceId, String(re.data.emailId)]));
});

test('suppression follows the applied purpose: unsubscribed blocks marketing only; hard bounces and complaints block both', async () => {
  const addr = reason => `${reason}-${uid()}@client.io`;
  const sup = async (email, reason) => db().run("INSERT INTO email_suppressions (workspace_id, email, reason, source, created_at) VALUES (?, ?, ?, 'test', UTC_TIMESTAMP())", [S.workspaceId, email, reason]);
  const u = addr('unsub'); await sup(u, 'unsubscribed');
  assert.equal((await send(S, { ...RECEIPT, purpose: 'transactional', recipient_email: u })).status, 200, 'genuine transactional mail ignores a marketing opt-out');
  const m = await send(S, { ...RECEIPT, purpose: 'marketing', recipient_email: u });
  assert.equal(m.data.code, 'RECIPIENT_SUPPRESSED');
  const sneaky = await send(S, { ...PROMO, purpose: 'transactional', recipient_email: u });
  assert.equal(sneaky.data.code, 'RECIPIENT_SUPPRESSED', 'promotional content declared transactional cannot reach an unsubscribed address');
  assert.match(sneaky.data.error, /treated as marketing/);
  for (const reason of ['bounced', 'complaint']) {
    const a = addr(reason); await sup(a, reason);
    for (const p of ['transactional', 'marketing']) {
      const smtp = [];
      const r = await send(S, { ...RECEIPT, purpose: p, recipient_email: a }, { smtp });
      assert.equal(r.data.code, 'RECIPIENT_SUPPRESSED', `${reason}/${p}`);
      assert.equal(smtp.length, 0);
    }
  }
});

test('idempotency: the same key never sends twice; reusing it with another purpose is refused', async () => {
  const headers = key();
  const body = { ...PROMO, purpose: 'marketing', recipient_email: `idem-${uid()}@client.io` };
  const smtp = [];
  const first = await send(S, body, { smtp, headers });
  const again = await send(S, body, { smtp, headers });
  assert.equal(first.status, 200);
  assert.equal(again.data.duplicate, true);
  assert.equal(smtp.length, 1);
  const other = await send(S, { ...body, purpose: 'transactional' }, { smtp, headers });
  assert.equal(other.status, 422);
  assert.equal(other.data.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('a marketing send that fails leaves no draft behind; an unknown outcome is held for review and never retried', async () => {
  const to = `fail-${uid()}@client.io`;
  const smtp = [];
  const r = await send(S, { ...PROMO, purpose: 'marketing', recipient_email: to }, { smtp, smtpRespond: () => h.json(422, { error: '550 5.1.1 mailbox unavailable' }) });
  assert.equal(r.status, 502);
  assert.equal(await db().get('SELECT 1 AS x FROM email_drafts WHERE workspace_id = ? AND recipient_email = ?', [S.workspaceId, to]) ?? null, null);

  const to2 = `unknown-${uid()}@client.io`;
  const headers = key();
  const smtp2 = [];
  const u = await send(S, { ...PROMO, purpose: 'marketing', recipient_email: to2 }, { smtp: smtp2, smtpRespond: () => h.json(503, {}), headers });
  assert.equal(u.data.code, 'MAIL_OUTCOME_UNKNOWN');
  assert.equal((await db().get('SELECT status FROM email_drafts WHERE workspace_id = ? AND recipient_email = ?', [S.workspaceId, to2])).status, 'Needs Review');
  const retry = await send(S, { ...PROMO, purpose: 'marketing', recipient_email: to2 }, { smtp: smtp2, headers });
  assert.equal(retry.data.code, 'MAIL_OUTCOME_UNKNOWN');
  assert.equal(smtp2.length, 1, 'not sent again');
});

test('the API refuses an invalid purpose and another workspace cannot use the endpoint on this workspace\'s data', async () => {
  assert.equal((await send(S, { ...RECEIPT, purpose: 'newsletter' })).status, 400);
  const member = await h.addMember(S.workspaceId, 'Member');
  assert.equal((await send(member, { ...RECEIPT, purpose: 'transactional' })).status, 403, 'mail.send is still required');
});

test('a reply "unsubscribe" to a one-to-one marketing email suppresses the address (not only product email batches)', async () => {
  const to = `reply-${uid()}@client.io`;
  const r = await send(S, { ...PROMO, purpose: 'marketing', recipient_email: to });
  assert.equal(r.status, 200);
  await db().run("UPDATE email_drafts SET sent_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE workspace_id = ? AND recipient_email = ?", [S.workspaceId, to]);
  await db().run("INSERT INTO emails (workspace_id, sender, sender_email, recipient_email, recipient_name, subject, body, status, smtp_status, received_at) VALUES (?, 'Kim', ?, 'news@s-co.io', 'S', 'Re: Spring sale', 'Please unsubscribe me', 'Received', 'Received (IMAP)', UTC_TIMESTAMP())", [S.workspaceId, to]);
  assert.ok((await require('../modules/mail/productEmails/service').monitoredWorkspaces()).includes(S.workspaceId));
  await require('../modules/mail/productEmails/service').detectUnsubscribeReplies({ workspaceId: S.workspaceId });
  assert.equal((await db().get('SELECT reason FROM email_suppressions WHERE workspace_id = ? AND email = ?', [S.workspaceId, to])).reason, 'unsubscribed');
});

// ------------------------------------------------------------------ transactional permission (mail.send_transactional)

test('roles: only Owners and Admins hold mail.send_transactional (least privilege)', () => {
  const { capabilitiesForRole } = require('../lib/permissions');
  assert.equal(capabilitiesForRole('Workspace Owner').has('mail.send_transactional'), true);
  assert.equal(capabilitiesForRole('Workspace Admin').has('mail.send_transactional'), true);
  for (const r of ['Marketing Manager', 'Approver', 'Member']) assert.equal(capabilitiesForRole(r).has('mail.send_transactional'), false, r);
});

test('without mail.send_transactional a transactional Compose send is refused (server-side), audited, nothing claimed or sent; marketing still works', async () => {
  const admin = await h.addMember(S.workspaceId, 'Workspace Admin');
  for (const role of ['Marketing Manager', 'Approver']) {
    const m = await h.addMember(S.workspaceId, role);
    const before = (await db().get('SELECT COUNT(*) AS n FROM mail_send_requests WHERE workspace_id = ?', [S.workspaceId])).n;
    const smtp = [];
    const r = await send(m, { ...RECEIPT, purpose: 'transactional' }, { smtp });
    assert.equal(r.status, 403, `${role}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, 'TRANSACTIONAL_NOT_PERMITTED');
    assert.equal(smtp.length, 0);
    assert.equal((await db().get('SELECT COUNT(*) AS n FROM mail_send_requests WHERE workspace_id = ?', [S.workspaceId])).n, before, 'no idempotency claim');
    const a = await db().get("SELECT metadata_json FROM audit_logs WHERE workspace_id = ? AND action = 'mail.send_blocked' AND actor_user_id = ? ORDER BY id DESC LIMIT 1", [S.workspaceId, m.userId]);
    assert.equal(JSON.parse(a.metadata_json).reason, 'transactional_not_permitted');
    // The same person can send it as marketing (marketing safeguards apply)...
    const mk = await send(m, { ...RECEIPT, purpose: 'marketing' }, { smtp });
    assert.equal(mk.status, 200, JSON.stringify(mk.data));
    assert.equal(mk.data.purpose, 'marketing');
    // ...and promotional content they declare transactional is treated as marketing, not refused.
    const promo = await send(m, { ...PROMO, purpose: 'transactional' }, { smtp });
    assert.equal(promo.status, 200);
    assert.equal(promo.data.purpose, 'marketing');
  }
  const ok = await send(admin, { ...RECEIPT, purpose: 'transactional' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.purpose, 'transactional');
});

test('the capability is reported to the signed-in member (for the Compose screen)', async () => {
  const appr = await h.addMember(S.workspaceId, 'Approver');
  const meOwner = await h.api('GET', '/api/v1/auth/me', { token: S.token });
  const meAppr = await h.api('GET', '/api/v1/auth/me', { token: appr.token });
  assert.ok(meOwner.data.capabilities.includes('mail.send_transactional'));
  assert.ok(!meAppr.data.capabilities.includes('mail.send_transactional'));
});
