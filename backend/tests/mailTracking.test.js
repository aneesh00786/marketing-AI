const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Email tracking. ZeptoMail and SMTP are mocked (nothing is sent); ZeptoMail webhooks are
// simulated with locally signed requests; Zoho is stubbed at the service boundary. These tests do
// NOT show that real provider events arrive in this format (see the final report).
const db = () => h.db();
const tracking = () => require('../modules/mail/tracking/trackingService');
const links = () => require('../modules/mail/tracking/links');
const zw = () => require('../modules/mail/tracking/zeptoWebhook');
const nodemailer = require('nodemailer');

let A; let B; let SM; // A, B: ZeptoMail workspaces; SM: SMTP workspace
const KEY_A = 'zepto-webhook-key-A-0123456789';
const KEY_B = 'zepto-webhook-key-B-0123456789';
const uid = () => crypto.randomBytes(4).toString('hex');

const zeptoRoute = (calls) => ({
  match: u => u.startsWith('https://api.zeptomail.com/'),
  respond: (url, init) => { const b = JSON.parse(init.body); calls.push(b); return h.json(200, { request_id: `zr-${uid()}` }); }
});

function smtpMock(calls, respond) {
  const original = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async m => {
      calls.push(m);
      const out = respond ? respond(m) : null;
      if (out === 'unknown') throw Object.assign(new Error('Connection closed during DATA'), { code: 'ETIMEDOUT', command: 'DATA' });
      return { messageId: `<m${calls.length}@acme-mail.io>`, response: '250 OK', accepted: [m.to] };
    }
  });
  return { restore: () => { nodemailer.createTransport = original; } };
}

const key = () => ({ 'Idempotency-Key': crypto.randomBytes(16).toString('hex') });

async function sendDirect(ws, body, mockRoutes) {
  const r = await h.api('POST', '/api/v1/emails/send-html', { token: ws.token, headers: key(), body: { recipient_email: `dana-${uid()}@acme.io`, subject: 'Hello', html_body: '<p>Hi</p>', purpose: 'transactional', confirm: true, ...body } });
  return r;
}

const trackingRow = emailId => db().get('SELECT * FROM mail_message_tracking WHERE email_id = ?', [emailId]);

/** A ZeptoMail-style webhook request signed the documented way (HMAC-SHA256 of the body, base64, URL-encoded). */
function signed(body, keyValue, { ts = Date.now(), alter } = {}) {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', keyValue).update(alter ? alter(raw) : raw).digest('base64');
  return { body, headers: { 'producer-signature': `ts=${ts};s=${encodeURIComponent(sig)};s-algorithm=HmacSHA256` } };
}
const zeptoEvent = (name, requestId, details, extra = {}) => ({
  event_name: [name],
  event_message: [{ request_id: requestId, email_info: { client_reference: extra.clientReference }, event_data: [{ details }] }],
  mailagent_key: 'agent', webhook_request_id: extra.webhookId || `wh-${uid()}`
});
async function postWebhook(endpointToken, payload, keyValue, opts) {
  const s = signed(payload, keyValue, opts);
  return h.api('POST', `/api/v1/mail/t/webhooks/zeptomail/${endpointToken}`, { body: s.body, headers: s.headers });
}

async function enableWebhook(ws, keyValue) {
  const r = await h.api('PUT', '/api/v1/mail/tracking/zeptomail-webhook', { token: ws.token, body: { authKey: keyValue, enabled: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.settings.zeptomail.endpoint.url.split('/').pop();
}

test.before(async () => {
  await h.prepareDatabase();
  process.env.APP_BASE_URL = 'https://app.marketech.test';
  process.env.MAIL_ALLOW_PRIVATE_HOSTS = 'true';
  delete process.env.ZEPTOMAIL_WEBHOOKS_ENABLED;
  A = await h.createWorkspace({ name: 'Track A' });
  B = await h.createWorkspace({ name: 'Track B' });
  SM = await h.createWorkspace({ name: 'Track SMTP' });
  for (const [ws, t] of [[A, 'za'], [B, 'zb']]) {
    const r = await h.api('POST', '/api/v1/mail/config', { token: ws.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: `${t}-${ws.workspaceId}`, sender_email: `news@ws${ws.workspaceId}.io`, sender_name: 'N' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const r = await h.api('POST', '/api/v1/mail/config', { token: SM.token, body: { provider: 'custom_smtp', smtp_host: 'smtp.acme-mail.io', smtp_port: 587, smtp_user: 'news@acme-mail.io', smtp_pass: 'pw', sender_email: 'news@acme-mail.io', sender_name: 'Acme' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test.after(async () => {
  delete process.env.ZEPTOMAIL_WEBHOOKS_ENABLED;
  await h.shutdown();
});

// ------------------------------------------------------------------ migration and settings

test('migration 024 adds the tracking tables; tracking is off by default', async () => {
  for (const t of ['mail_message_tracking', 'mail_tracked_links', 'mail_events', 'mail_webhook_endpoints']) {
    assert.ok(await db().get('SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]), t);
  }
  assert.ok(await db().get("SELECT 1 AS x FROM schema_migrations WHERE id = '024_mail_tracking'"));
  const s = await h.api('GET', '/api/v1/mail/tracking/settings', { token: A.token });
  assert.equal(s.status, 200);
  assert.equal(s.data.settings.trackOpens, false);
  assert.equal(s.data.settings.trackClicks, false);
  assert.equal(s.data.settings.zeptomail.serverAllowsWebhook, false);
});

test('only roles with mail.configure can change tracking; a workspace without mail settings is refused', async () => {
  const member = await h.addMember(A.workspaceId, 'Member');
  const approver = await h.addMember(A.workspaceId, 'Approver');
  for (const m of [member, approver]) {
    assert.equal((await h.api('PUT', '/api/v1/mail/tracking/settings', { token: m.token, body: { trackOpens: true, trackClicks: true } })).status, 403);
    assert.equal((await h.api('PUT', '/api/v1/mail/tracking/zeptomail-webhook', { token: m.token, body: { authKey: KEY_A } })).status, 403);
  }
  assert.equal((await h.api('GET', '/api/v1/mail/tracking/settings', { token: member.token })).status, 200, 'members can see the settings');
  const empty = await h.createWorkspace({ name: 'No mail' });
  assert.equal((await h.api('PUT', '/api/v1/mail/tracking/settings', { token: empty.token, body: { trackOpens: true, trackClicks: false } })).data.code, 'MAIL_NOT_CONFIGURED');
  const bad = await h.api('PUT', '/api/v1/mail/tracking/settings', { token: A.token, body: { trackOpens: 'yes' } });
  assert.equal(bad.status, 400);
});

// ------------------------------------------------------------------ ZeptoMail sends

test('ZeptoMail sends carry our reference and explicit tracking flags; a successful send is "accepted", never "delivered"', async () => {
  const calls = [];
  const mock = h.mockFetch([zeptoRoute(calls)]);
  let r;
  try { r = await sendDirect(A); } finally { mock.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(calls.length, 1);
  assert.match(calls[0].client_reference, /^[a-f0-9]{32}$/);
  assert.equal(calls[0].track_opens, false, 'off by default');
  assert.equal(calls[0].track_clicks, false);
  const t = await trackingRow(r.data.emailId);
  assert.equal(t.provider, 'zeptomail');
  assert.equal(t.provider_message_id, r.data.messageId);
  assert.equal(t.delivery_status, 'accepted');
  assert.equal(t.delivered_at, null);
  assert.ok(t.accepted_at);
  const view = await h.api('GET', `/api/v1/mail/tracking/emails/${r.data.emailId}`, { token: A.token });
  assert.equal(view.data.tracking.deliveryStatus, 'accepted');
  assert.equal(view.data.tracking.deliveryReporting, 'webhook_not_connected');
  assert.equal(view.data.tracking.opens.mode, 'off');
  assert.deepEqual(view.data.tracking.events.map(e => e.type), ['queued', 'accepted']);
});

test('with tracking on but no working ZeptoMail webhook, ZeptoMail is not asked to track (nothing could be reported)', async () => {
  await h.api('PUT', '/api/v1/mail/tracking/settings', { token: A.token, body: { trackOpens: true, trackClicks: true } });
  const calls = [];
  const mock = h.mockFetch([zeptoRoute(calls)]);
  let r;
  try { r = await sendDirect(A); } finally { mock.restore(); }
  assert.equal(calls[0].track_opens, false);
  assert.equal(calls[0].track_clicks, false);
  const view = await h.api('GET', `/api/v1/mail/tracking/emails/${r.data.emailId}`, { token: A.token });
  assert.equal(view.data.tracking.opens.mode, 'not_reported');
  assert.equal(view.data.tracking.opens.totalEvents, null, 'shown as unavailable, not 0');
  assert.equal(view.data.tracking.clicks.totalEvents, null);
});

test('AI Campaigns sequences (and any send without track) are not tracked', async () => {
  const calls = [];
  const mock = h.mockFetch([zeptoRoute(calls)]);
  let res;
  try { res = await require('../services/emailService').sendRealEmail(A.workspaceId, { to: `x-${uid()}@acme.io`, subject: 's', html: '<p>x</p>' }); } finally { mock.restore(); }
  assert.equal(calls[0].client_reference, undefined);
  assert.equal(calls[0].track_opens, undefined, 'payload unchanged for untracked sends');
  assert.equal(await trackingRow(res.emailId) ?? null, null, 'no tracking row');
});

// ------------------------------------------------------------------ ZeptoMail webhook

test('the ZeptoMail webhook stays off until the server allows it; enabling needs a key', async () => {
  const r = await h.api('PUT', '/api/v1/mail/tracking/zeptomail-webhook', { token: A.token, body: { authKey: KEY_A, enabled: true } });
  assert.equal(r.data.code, 'WEBHOOKS_NOT_ALLOWED');
  const s = await h.api('GET', '/api/v1/mail/tracking/settings', { token: A.token });
  const token = s.data.settings.zeptomail.endpoint.url.split('/').pop();
  assert.match(s.data.settings.zeptomail.endpoint.url, /^https:\/\/app\.marketech\.test\/api\/v1\/mail\/t\/webhooks\/zeptomail\/[a-f0-9]{32}$/);
  assert.equal(s.data.settings.zeptomail.endpoint.hasKey, true);
  assert.doesNotMatch(JSON.stringify(s.data), new RegExp(KEY_A), 'the key is never returned');
  const row = await db().get("SELECT secret_ciphertext FROM mail_webhook_endpoints WHERE workspace_id = ?", [A.workspaceId]);
  assert.match(row.secret_ciphertext, /^enc:v1:/, 'stored encrypted');
  assert.equal((await postWebhook(token, zeptoEvent('delivered', 'zr-x', [{ time: Date.now() }]), KEY_A)).status, 404, 'server switch off: 404');

  process.env.ZEPTOMAIL_WEBHOOKS_ENABLED = '1';
  const noKey = await h.api('PUT', '/api/v1/mail/tracking/zeptomail-webhook', { token: B.token, body: { enabled: true } });
  assert.equal(noKey.data.code, 'WEBHOOK_KEY_REQUIRED');
  await enableWebhook(A, KEY_A);
  await enableWebhook(B, KEY_B);
  assert.ok(await db().get("SELECT 1 AS x FROM audit_logs WHERE action = 'mail.zeptomail_webhook_updated' AND workspace_id = ?", [A.workspaceId]));
  assert.doesNotMatch(JSON.stringify(await db().all("SELECT metadata_json FROM audit_logs WHERE action = 'mail.zeptomail_webhook_updated'")), new RegExp(KEY_A));
});

async function zeptoSent(ws) {
  const calls = [];
  const mock = h.mockFetch([zeptoRoute(calls)]);
  let r;
  try { r = await sendDirect(ws); } finally { mock.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { emailId: r.data.emailId, requestId: r.data.messageId, call: calls[0] };
}
const endpointOf = async ws => (await db().get("SELECT endpoint_token FROM mail_webhook_endpoints WHERE workspace_id = ?", [ws.workspaceId])).endpoint_token;

test('webhook authentication: missing, wrong, stale, tampered or wrong-algorithm signatures are rejected; unknown endpoints are 404', async () => {
  const s = await zeptoSent(A);
  const ep = await endpointOf(A);
  const payload = zeptoEvent('delivered', s.requestId, [{ time: Date.now() }]);
  assert.equal((await h.api('POST', `/api/v1/mail/t/webhooks/zeptomail/${ep}`, { body: payload })).status, 401, 'no signature');
  assert.equal((await postWebhook(ep, payload, 'wrong-key-wrong-key-wrong')).status, 401, 'wrong key');
  assert.equal((await postWebhook(ep, payload, KEY_A, { ts: Date.now() - 10 * 60 * 1000 })).status, 401, 'stale timestamp');
  assert.equal((await postWebhook(ep, payload, KEY_A, { alter: raw => raw.replace('delivered', 'hardbounce') })).status, 401, 'body changed after signing');
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', KEY_A).update(raw).digest('base64');
  assert.equal((await h.api('POST', `/api/v1/mail/t/webhooks/zeptomail/${ep}`, { body: payload, headers: { 'producer-signature': `ts=${Date.now()};s=${encodeURIComponent(sig)};s-algorithm=HmacSHA1` } })).status, 401, 'algorithm');
  assert.equal((await postWebhook('0'.repeat(32), payload, KEY_A)).status, 404);
  assert.equal((await postWebhook(await endpointOf(B), payload, KEY_A)).status, 401, "A's key does not work on B's endpoint");
  assert.equal((await trackingRow(s.emailId)).delivery_status, 'accepted', 'nothing applied');
});

test('a form-encoded webhook (as in ZeptoMail\'s sample code) is verified and applied; future-dated or replayed requests are not', async () => {
  const s = await zeptoSent(A);
  const ep = await endpointOf(A);
  const json = JSON.stringify(zeptoEvent('delivered', s.requestId, [{ time: Date.now() }], { webhookId: `wh-form-${uid()}` }));
  // Signed over the decoded value of the single form field, as ZeptoMail's sample code does.
  const send = async (ts, body) => {
    const sig = crypto.createHmac('sha256', KEY_A).update(json).digest('base64');
    return h.api('POST', `/api/v1/mail/t/webhooks/zeptomail/${ep}`, { rawBody: body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'producer-signature': `ts=${ts};s=${encodeURIComponent(sig)};s-algorithm=HmacSHA256` } });
  };
  const form = `payload=${encodeURIComponent(json)}`;
  const future = await send(Date.now() + 10 * 60 * 1000, form);
  assert.equal(future.status, 401, 'a timestamp far in the future is refused');
  const ok = await send(Date.now(), form);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.applied, 1);
  assert.equal((await trackingRow(s.emailId)).delivery_status, 'delivered');
  const replay = await send(Date.now(), form);
  assert.equal(replay.data.duplicates, 1, 'a replayed request inside the time window changes nothing');
});

test('malformed or unrecognized payloads are rejected without changes', async () => {
  const ep = await endpointOf(A);
  assert.equal((await postWebhook(ep, { hello: 'world' }, KEY_A)).status, 400);
  assert.equal((await postWebhook(ep, { event_name: ['something_new'], event_message: [{ request_id: 'zr-1' }] }, KEY_A)).status, 400);
  assert.equal((await postWebhook(ep, { event_name: ['delivered'], event_message: [{ email_info: {} }] }, KEY_A)).status, 400, 'no identifier');
  const unknownEmail = await postWebhook(ep, zeptoEvent('delivered', 'zr-not-ours', [{ time: Date.now() }]), KEY_A);
  assert.equal(unknownEmail.status, 200);
  assert.equal(unknownEmail.data.ignored, 1);
  assert.equal(unknownEmail.data.applied, 0);
});

test('delivered is recorded once: a repeated webhook is a duplicate', async () => {
  const s = await zeptoSent(A);
  const ep = await endpointOf(A);
  const payload = zeptoEvent('delivered', s.requestId, [{ time: Date.now() }], { webhookId: 'wh-fixed-1' });
  const first = await postWebhook(ep, payload, KEY_A);
  assert.equal(first.data.applied, 1);
  const again = await postWebhook(ep, payload, KEY_A);
  assert.equal(again.data.duplicates, 1);
  assert.equal(again.data.applied, 0);
  const t = await trackingRow(s.emailId);
  assert.equal(t.delivery_status, 'delivered');
  assert.ok(t.delivered_at);
  assert.equal((await db().get("SELECT COUNT(*) AS n FROM mail_events WHERE tracking_id = ? AND event_type = 'delivered'", [t.id])).n, 1);
});

test('events out of order: a later hard bounce wins over delivered, an earlier "delivered" arriving late does not undo it', async () => {
  const s = await zeptoSent(A);
  const ep = await endpointOf(A);
  const t0 = Date.now() - 60000;
  await postWebhook(ep, zeptoEvent('hardbounce', s.requestId, [{ time: t0 + 30000, reason: 'Mailbox does not exist', diagnostic_message: `550 5.1.1 <${'x'}@acme.io> user unknown` }]), KEY_A);
  await postWebhook(ep, zeptoEvent('delivered', s.requestId, [{ time: t0 }]), KEY_A);
  const t = await trackingRow(s.emailId);
  assert.equal(t.delivery_status, 'bounced');
  assert.ok(t.delivered_at, 'the delivered event is kept in history');
  assert.ok(t.bounced_at);
  assert.match(t.failure_reason, /Mailbox does not exist/);
  assert.doesNotMatch(t.failure_reason, /@/, 'addresses are not stored in explanations');
  // History keeps both, in the order they happened (not the order they arrived).
  const types = (await db().all("SELECT event_type FROM mail_events WHERE tracking_id = ? AND event_type IN ('delivered', 'hard_bounce') ORDER BY occurred_at", [t.id])).map(e => e.event_type);
  assert.deepEqual(types, ['delivered', 'hard_bounce']);
});

test('soft bounce then delivered ends delivered; a soft bounce after delivery does not move it back', async () => {
  const s1 = await zeptoSent(A);
  const ep = await endpointOf(A);
  const now = Date.now();
  await postWebhook(ep, zeptoEvent('softbounce', s1.requestId, [{ time: now - 5000, reason: 'Mailbox full' }]), KEY_A);
  assert.equal((await trackingRow(s1.emailId)).delivery_status, 'deferred');
  await postWebhook(ep, zeptoEvent('delivered', s1.requestId, [{ time: now }]), KEY_A);
  assert.equal((await trackingRow(s1.emailId)).delivery_status, 'delivered');
  const s2 = await zeptoSent(A);
  await postWebhook(ep, zeptoEvent('delivered', s2.requestId, [{ time: now - 5000 }]), KEY_A);
  await postWebhook(ep, zeptoEvent('softbounce', s2.requestId, [{ time: now }]), KEY_A);
  assert.equal((await trackingRow(s2.emailId)).delivery_status, 'delivered');
});

test('a verified hard bounce or spam complaint suppresses the address once (idempotent, audited)', async () => {
  const s = await zeptoSent(A);
  const ep = await endpointOf(A);
  const address = s.call.to[0].email_address.address;
  const r1 = await postWebhook(ep, zeptoEvent('hardbounce', s.requestId, [{ time: Date.now() - 1000, reason: 'No such user' }]), KEY_A);
  assert.equal(r1.data.suppressed, 1);
  const r2 = await postWebhook(ep, zeptoEvent('hardbounce', s.requestId, [{ time: Date.now(), reason: 'No such user' }]), KEY_A);
  assert.equal(r2.data.suppressed, 0, 'already suppressed');
  const sup = await db().all('SELECT reason, source FROM email_suppressions WHERE workspace_id = ? AND email = ?', [A.workspaceId, address]);
  assert.deepEqual(sup.map(x => [x.reason, x.source]), [['bounced', 'zeptomail_webhook']]);
  const t = await trackingRow(s.emailId);
  assert.equal((await db().get("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'mail.recipient_suppressed' AND resource_id = ?", [String(t.id)])).n, 1);

  const c = await zeptoSent(A);
  const complaint = await postWebhook(ep, zeptoEvent('feedback_loop', c.requestId, [{ time: Date.now() }]), KEY_A);
  assert.equal(complaint.data.suppressed, 1);
  assert.equal((await db().get('SELECT reason FROM email_suppressions WHERE workspace_id = ? AND email = ?', [A.workspaceId, c.call.to[0].email_address.address])).reason, 'complaint');
  assert.equal((await trackingRow(c.emailId)).delivery_status, 'accepted', 'a complaint does not change the delivery status');
  // Suppression applies to this workspace only.
  assert.equal(await db().get('SELECT 1 AS x FROM email_suppressions WHERE workspace_id = ? AND email = ?', [B.workspaceId, address]) ?? null, null);
});

test('workspace isolation: another workspace\'s endpoint cannot touch this workspace\'s email, and tracking views are scoped', async () => {
  const s = await zeptoSent(A);
  const r = await postWebhook(await endpointOf(B), zeptoEvent('hardbounce', s.requestId, [{ time: Date.now() }], { clientReference: s.call.client_reference }), KEY_B);
  assert.equal(r.status, 200);
  assert.equal(r.data.ignored, 1);
  assert.equal((await trackingRow(s.emailId)).delivery_status, 'accepted');
  assert.equal((await h.api('GET', `/api/v1/mail/tracking/emails/${s.emailId}`, { token: B.token })).status, 404);
});

test('ZeptoMail opens and clicks (with the webhook working and tracking on) are reported; first open only', async () => {
  const s = await zeptoSent(A);
  assert.equal(s.call.track_opens, true, 'now reportable, so ZeptoMail is asked to track');
  assert.equal(s.call.track_clicks, true);
  const ep = await endpointOf(A);
  await postWebhook(ep, zeptoEvent('email_open', null, [{ time: Date.now() - 2000 }], { clientReference: s.call.client_reference }), KEY_A);
  await postWebhook(ep, zeptoEvent('email_link_click', s.requestId, [{ time: Date.now(), clicked_link: 'https://shop.example.io/spring?utm=x&email=dana@acme.io' }]), KEY_A);
  const v = (await h.api('GET', `/api/v1/mail/tracking/emails/${s.emailId}`, { token: A.token })).data.tracking;
  assert.equal(v.deliveryStatus, 'accepted', 'opens and clicks do not imply delivery');
  assert.equal(v.opens.mode, 'provider');
  assert.equal(v.opens.uniqueOpened, true);
  assert.equal(v.opens.totalEvents, null, 'ZeptoMail reports the first open only: no total');
  assert.ok(v.opens.firstAt);
  assert.deepEqual(v.clicks.links.map(l => l.url), ['shop.example.io/spring'], 'host and path only, no query');
});

test('tracking never resends or touches drafts, approvals or send requests', async () => {
  const s = await zeptoSent(A);
  const req = await db().get('SELECT status FROM mail_send_requests WHERE email_id = ?', [s.emailId]);
  const calls = [];
  const mock = h.mockFetch([zeptoRoute(calls)]);
  try {
    await postWebhook(await endpointOf(A), zeptoEvent('hardbounce', s.requestId, [{ time: Date.now() }]), KEY_A);
  } finally { mock.restore(); }
  assert.equal(calls.length, 0, 'no provider call');
  assert.equal((await db().get('SELECT status FROM mail_send_requests WHERE email_id = ?', [s.emailId])).status, req.status);
});

// ------------------------------------------------------------------ SMTP (first-party pixel and links)

test('SMTP with tracking off: the email is sent unchanged; delivery is reported as not supported', async () => {
  const calls = [];
  const m = smtpMock(calls);
  let r;
  try { r = await sendDirect(SM, { html_body: '<p>Hi <a href="https://shop.example.io/a">Shop</a></p>' }); } finally { m.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(calls[0].html, '<p>Hi <a href="https://shop.example.io/a">Shop</a></p>');
  const v = (await h.api('GET', `/api/v1/mail/tracking/emails/${r.data.emailId}`, { token: SM.token })).data.tracking;
  assert.equal(v.provider, 'smtp');
  assert.equal(v.deliveryStatus, 'accepted');
  assert.equal(v.deliveryReporting, 'not_supported');
});

const SMTP_HTML = '<html><body><p>Hi</p>'
  + '<a href="https://shop.example.io/spring?utm_source=mail&amp;ref=1">Shop</a>'
  + '<a href="https://app.example.io/reset-password?user=1">Reset</a>'
  + '<a href="https://app.example.io/welcome?token=abc">Magic</a>'
  + '<a href="https://u:p@evil.example.io/x">Creds</a>'
  + '<a href="mailto:help@acme.io">Mail us</a>'
  + '<a href="https://app.marketech.test/api/v1/mail/unsubscribe/' + 'a'.repeat(40) + '">Settings</a>'
  + '<a href="javascript:alert(1)">JS</a>'
  + '<a data-no-track href="https://shop.example.io/private">Private</a>'
  + '</body></html>';

test('SMTP with tracking on: safe links are rewritten to opaque click URLs, sensitive ones left alone, and a pixel is added', async () => {
  await h.api('PUT', '/api/v1/mail/tracking/settings', { token: SM.token, body: { trackOpens: true, trackClicks: true } });
  const calls = [];
  const m = smtpMock(calls);
  let r;
  try { r = await sendDirect(SM, { html_body: SMTP_HTML }); } finally { m.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sentHtml = calls[0].html;
  const clickUrls = sentHtml.match(/https:\/\/app\.marketech\.test\/api\/v1\/mail\/t\/c\/[a-f0-9]{32}/g) || [];
  assert.equal(clickUrls.length, 1, 'only the shop link is tracked');
  for (const kept of ['reset-password?user=1', 'welcome?token=abc', 'u:p@evil.example.io', 'mailto:help@acme.io', '/api/v1/mail/unsubscribe/', 'javascript:alert(1)', 'shop.example.io/private']) {
    assert.ok(sentHtml.includes(kept), `left unchanged: ${kept}`);
  }
  assert.match(sentHtml, /<img src="https:\/\/app\.marketech\.test\/api\/v1\/mail\/t\/o\/[a-f0-9]{32}\.gif"[^>]*><\/body>/);
  const stored = await db().get('SELECT html_body FROM emails WHERE id = ?', [r.data.emailId]);
  assert.equal(stored.html_body, SMTP_HTML, 'the saved copy has no tracking added');

  // Open pixel: recorded once per minute; always answers with the same GIF.
  const pixel = sentHtml.match(/\/api\/v1\/mail\/t\/o\/[a-f0-9]{32}\.gif/)[0];
  const p1 = await h.api('GET', pixel);
  assert.equal(p1.status, 200);
  assert.equal(p1.headers.get('content-type'), 'image/gif');
  assert.match(p1.headers.get('cache-control'), /no-store/);
  await h.api('GET', pixel);
  // Click: recorded, then redirected to the stored destination.
  const clickPath = clickUrls[0].replace('https://app.marketech.test', '');
  const c = await h.api('GET', clickPath, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  assert.equal(c.status, 302);
  assert.equal(c.headers.get('location'), 'https://shop.example.io/spring?utm_source=mail&ref=1');
  const v = (await h.api('GET', `/api/v1/mail/tracking/emails/${r.data.emailId}`, { token: SM.token })).data.tracking;
  assert.equal(v.opens.mode, 'pixel');
  assert.equal(v.opens.totalEvents, 1, 'repeated pixel hits within a minute count once');
  assert.equal(v.clicks.totalEvents, 1);
  assert.deepEqual(v.clicks.links.map(l => [l.url, l.clicks]), [['shop.example.io/spring', 1]]);
  assert.equal(v.deliveryStatus, 'accepted', 'an open does not make it delivered');
  const ev = await db().all("SELECT client_hint, detail FROM mail_events WHERE tracking_id = (SELECT id FROM mail_message_tracking WHERE email_id = ?) AND event_type IN ('opened','clicked')", [r.data.emailId]);
  assert.ok(ev.every(e => !/Mozilla|\d+\.\d+\.\d+\.\d+/.test(JSON.stringify(e))), 'no user agent or IP stored');
});

test('click and pixel tokens never redirect anywhere else; unknown tokens give 404 and a plain pixel', async () => {
  const c = await h.api('GET', `/api/v1/mail/t/c/${'f'.repeat(32)}`);
  assert.equal(c.status, 404);
  assert.equal(c.headers.get('location'), null);
  assert.equal((await h.api('GET', `/api/v1/mail/t/c/not-a-token?url=https://evil.example`)).status, 401, 'not a public path');
  const p = await h.api('GET', `/api/v1/mail/t/o/${'e'.repeat(32)}.gif`);
  assert.equal(p.status, 200, 'same pixel whether tracked or not');
});

test('a stored destination that is no longer a safe URL is not followed', async () => {
  const row = await db().get('SELECT id FROM mail_message_tracking WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [SM.workspaceId]);
  const tok = 'b'.repeat(32);
  await db().run('INSERT INTO mail_tracked_links (workspace_id, tracking_id, link_token, url, url_hash, position) VALUES (?, ?, ?, ?, ?, 9)', [SM.workspaceId, row.id, tok, 'javascript:alert(1)', 'x'.repeat(64)]);
  assert.equal((await h.api('GET', `/api/v1/mail/t/c/${tok}`)).status, 404);
});

test('an unknown SMTP outcome is recorded as unknown, never retried, and stays for review', async () => {
  const calls = [];
  const m = smtpMock(calls, () => 'unknown');
  let r;
  try { r = await sendDirect(SM); } finally { m.restore(); }
  assert.equal(calls.length, 1, 'not retried');
  assert.notEqual(r.status, 200);
  const t = await db().get('SELECT * FROM mail_message_tracking WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [SM.workspaceId]);
  assert.equal(t.delivery_status, 'unknown');
  assert.equal((await db().get('SELECT status FROM mail_send_requests WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [SM.workspaceId])).status, 'needs_review');
});

// ------------------------------------------------------------------ units

test('trackableUrl refuses non-http, credentials, sensitive paths and parameters, placeholders and our own URLs', () => {
  const { trackableUrl, safeRedirectTarget } = links();
  const own = 'https://app.marketech.test';
  assert.equal(trackableUrl('https://shop.io/a?b=1&amp;c=2').url, 'https://shop.io/a?b=1&c=2');
  for (const u of ['mailto:a@b.io', 'tel:+1', 'ftp://x.io/a', '/relative', '#top', 'javascript:x', 'https://u:p@x.io', 'https://x.io/reset/abc', 'https://x.io/login', 'https://x.io/a?access_token=1', 'https://x.io/a?code=1', 'https://x.io/{{name}}', '$[LI:UNSUBSCRIBE]$', 'https://x.io/' + 'a'.repeat(2100)]) {
    assert.equal(trackableUrl(u).ok, false, u);
  }
  assert.equal(trackableUrl(`${own}/api/v1/mail/assets/x`, { ownOrigin: own }).ok, false);
  assert.equal(safeRedirectTarget('https://shop.io/x'), 'https://shop.io/x');
  for (const u of ['javascript:alert(1)', 'data:text/html,x', 'https://u:p@x.io', '//evil.io', 'not a url']) assert.equal(safeRedirectTarget(u), null, u);
});

test('signature parsing follows the documented header; ts must be recent', () => {
  const { verifySignature, parseSignatureHeader } = zw();
  assert.deepEqual(parseSignatureHeader('ts=1596109465823;s=dN0yVozgabP5NPlxMDfP1r5u65bVO9kTGEZMIQlqI2o%3D;s-algorithm=HmacSHA256'),
    { ts: '1596109465823', s: 'dN0yVozgabP5NPlxMDfP1r5u65bVO9kTGEZMIQlqI2o%3D', alg: 'HmacSHA256' });
  const body = 'payload=' + encodeURIComponent('{"a":1}');
  const sig = crypto.createHmac('sha256', 'k'.repeat(20)).update('{"a":1}').digest('base64');
  const header = `ts=${Date.now()};s=${encodeURIComponent(sig)};s-algorithm=HmacSHA256`;
  assert.equal(verifySignature({ header, rawBody: Buffer.from(body), contentType: 'application/x-www-form-urlencoded', key: 'k'.repeat(20) }).ok, true, 'form body: decoded value signed (documented sample code)');
  assert.equal(verifySignature({ header, rawBody: Buffer.from(body), contentType: 'application/json', key: 'k'.repeat(20) }).ok, false);
  assert.equal(verifySignature({ header: '', rawBody: Buffer.from(body), key: 'k' }).reason, 'missing_signature');
});

test('retention removes old events and links; summaries stay', async () => {
  const row = await db().get('SELECT id, open_events FROM mail_message_tracking WHERE workspace_id = ? AND open_events > 0 LIMIT 1', [SM.workspaceId]);
  await db().run("UPDATE mail_events SET received_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 500 DAY) WHERE tracking_id = ?", [row.id]);
  await db().run("UPDATE mail_tracked_links SET created_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 500 DAY) WHERE tracking_id = ?", [row.id]);
  const out = await tracking().purgeExpired();
  assert.ok(out.events >= 1 && out.links >= 1);
  assert.equal((await db().get('SELECT COUNT(*) AS n FROM mail_events WHERE tracking_id = ?', [row.id])).n, 0);
  assert.equal((await db().get('SELECT open_events FROM mail_message_tracking WHERE id = ?', [row.id])).open_events, row.open_events);
});

// ------------------------------------------------------------------ Zoho per-recipient activity

test('Zoho per-recipient activity: mail.send roles only, read on demand, nothing stored, unsent campaigns say so', async () => {
  const zsvc = require('../modules/mail/zoho/zohoService');
  const original = zsvc.readCall;
  const seen = [];
  zsvc.readCall = async (wsId, endpoint, params) => {
    seen.push({ wsId, endpoint, params });
    if (params.action === 'clickedcontacts') return { list_of_details: [] };
    return { list_of_details: [{ contact_email: 'ann@acme.io', firstname: 'Ann', lastname: 'Lee', secret_field: 'x' }, { contact_email: 'bo@acme.io' }] };
  };
  try {
    const sent = await db().run("INSERT INTO mail_campaigns (workspace_id, name, status, zoho_campaign_key, created_at, updated_at) VALUES (?, 'Spring', 'submitted', 'zk-1', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [A.workspaceId]);
    const draft = await db().run("INSERT INTO mail_campaigns (workspace_id, name, status, created_at, updated_at) VALUES (?, 'Draft', 'draft', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [A.workspaceId]);
    const member = await h.addMember(A.workspaceId, 'Member');
    const approver = await h.addMember(A.workspaceId, 'Approver');
    const mm = await h.addMember(A.workspaceId, 'Marketing Manager');
    assert.equal((await h.api('GET', `/api/v1/mail/campaigns/${sent.lastID}/recipients?activity=opened`, { token: member.token })).status, 403);
    for (const who of [A, approver, mm]) {
      const r = await h.api('GET', `/api/v1/mail/campaigns/${sent.lastID}/recipients?activity=opened`, { token: who.token });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.deepEqual(r.data.recipients.map(x => [x.email, x.name, x.leadId]), [['ann@acme.io', 'Ann Lee', null], ['bo@acme.io', null, null]]);
      assert.equal(r.data.recipients[0].secret_field, undefined, 'only known fields are passed on');
    }
    assert.deepEqual(seen[0], { wsId: A.workspaceId, endpoint: 'getcampaignrecipientsdata', params: { campaignkey: 'zk-1', action: 'openedcontacts', fromindex: '1', range: '50' } });
    const clicked = await h.api('GET', `/api/v1/mail/campaigns/${sent.lastID}/recipients?activity=clicked&page=2`, { token: A.token });
    assert.equal(seen.at(-1).params.fromindex, '51');
    assert.deepEqual(clicked.data.recipients, []);
    const notSent = await h.api('GET', `/api/v1/mail/campaigns/${draft.lastID}/recipients?activity=opened`, { token: A.token });
    assert.equal(notSent.data.available, false);
    assert.equal(notSent.data.reason, 'not_sent');
    assert.equal((await h.api('GET', `/api/v1/mail/campaigns/${sent.lastID}/recipients?activity=everything`, { token: A.token })).status, 400);
    assert.equal((await h.api('GET', `/api/v1/mail/campaigns/${sent.lastID}/recipients?activity=opened`, { token: B.token })).status, 404, 'other workspace');
    assert.ok(await db().get("SELECT 1 AS x FROM audit_logs WHERE action = 'mail.campaign_recipients_viewed' AND resource_id = ?", [String(sent.lastID)]));
    assert.doesNotMatch(JSON.stringify(await db().all("SELECT metadata_json FROM audit_logs WHERE action = 'mail.campaign_recipients_viewed'")), /ann@acme\.io/, 'addresses not stored');
  } finally { zsvc.readCall = original; }
});

test('Zoho per-recipient activity: full details as Zoho returns them, matched to the lead', async () => {
  const zsvc = require('../modules/mail/zoho/zohoService');
  const original = zsvc.readCall;
  zsvc.readCall = async () => ({ list_of_details: [{ contactemailaddress: 'Kim@Shop.com.au', contactfn: 'Kim', contactln: 'Lee', companyname: 'Shop', phone: '', mobile: '0400 111 222',
    city: 'Sydney', state: 'NSW', country: 'Australia', sentdate: '04 Nov 2026, 11:33 AM', numoftimeopened: '3',
    openreports: '{1=Nov 04, 2026 11:33 AM, 2=Nov 05, 2026 09:10 AM}' }] });
  try {
    const lead = await db().run("INSERT INTO leads (workspace_id, name, email, company_name, phone, status, created_at) VALUES (?, 'Kim Lee', 'kim@shop.com.au', 'Shop Pty Ltd', '0400 000 000', 'Contacted', UTC_TIMESTAMP())", [A.workspaceId]);
    const sent = await db().run("INSERT INTO mail_campaigns (workspace_id, name, status, zoho_campaign_key, created_at, updated_at) VALUES (?, 'Full', 'submitted', 'zk-2', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [A.workspaceId]);
    const r = await h.api('GET', `/api/v1/mail/campaigns/${sent.lastID}/recipients?activity=opened`, { token: A.token });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const [k] = r.data.recipients;
    assert.equal(k.name, 'Kim Lee');
    assert.equal(k.company, 'Shop Pty Ltd', 'the lead\'s business');
    assert.equal(k.phone, '0400 000 000');
    assert.equal(k.location, 'Sydney, NSW, Australia');
    assert.equal(k.sentAt, '04 Nov 2026, 11:33 AM');
    assert.equal(k.opens, 3);
    assert.equal(k.lastOpenedAt, 'Nov 05, 2026 09:10 AM');
    assert.equal(k.leadId, lead.lastID);
    assert.equal(k.leadStatus, 'Contacted');
  } finally { zsvc.readCall = original; }
});

test('without verified consent, opens and clicks stay off even when the workspace enabled them (delivery is still recorded)', async () => {
  const t1 = await tracking().begin(SM.workspaceId, { draftId: null, consentOk: false });
  const t2 = await tracking().begin(SM.workspaceId, { draftId: null, consentOk: true });
  const r1 = await db().get('SELECT track_opens, track_clicks, delivery_status FROM mail_message_tracking WHERE id = ?', [t1.id]);
  const r2 = await db().get('SELECT track_opens, track_clicks FROM mail_message_tracking WHERE id = ?', [t2.id]);
  assert.deepEqual([r1.track_opens, r1.track_clicks, r1.delivery_status], [0, 0, 'queued']);
  assert.deepEqual([r2.track_opens, r2.track_clicks], [1, 1]);
  assert.equal(await t1.instrumentSmtp('<a href="https://shop.example.io/a">x</a>'), '<a href="https://shop.example.io/a">x</a>');
});

// ------------------------------------------------------------------ review regressions (2026-10-28)

test('REVIEW: Zoho recipient lists parse the documented response shape (list_of_details[].contactemailaddress)', async () => {
  const zsvc = require('../modules/mail/zoho/zohoService');
  const original = zsvc.readCall;
  // Shape from zoho.com/campaigns/help/developers/campaign-recipient-data.html (JSON sample).
  zsvc.readCall = async () => ({ status: 'success', code: '0', requestdetails: { range: 20, fromindex: 1 },
    list_of_details: [{ contactemailaddress: 'john.doe@xyz.com', sent_time: '1375456161000', firstname: 'John', lastname: 'Doe', contactid: '303000014269257', phone: '123' }] });
  try {
    const c = await db().run("INSERT INTO mail_campaigns (workspace_id, name, status, zoho_campaign_key, created_at, updated_at) VALUES (?, 'Docs', 'submitted', 'zk-docs', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [A.workspaceId]);
    const r = await h.api('GET', `/api/v1/mail/campaigns/${c.lastID}/recipients?activity=sent`, { token: A.token });
    assert.deepEqual(r.data.recipients.map(x => [x.email, x.name, x.phone]), [['john.doe@xyz.com', 'John Doe', '123']]);
  } finally { zsvc.readCall = original; }
});

test('REVIEW: getcampaignrecipientsdata is sent as documented (POST, form body) and stays a read call', async () => {
  const zc = require('../modules/mail/zoho/zohoClient');
  const seen = [];
  const mock = h.mockFetch([{ match: u => u.startsWith('https://campaigns.zoho.com/api/v1.1/getcampaignrecipientsdata'),
    respond: (url, init) => { seen.push({ url, method: init.method, body: init.body, type: init.headers['Content-Type'] }); return h.json(200, { status: 'success', code: '0', list_of_details: [] }); } }]);
  try { await zc.call(zc.DATA_CENTERS.us, 'tok', 'getcampaignrecipientsdata', { campaignkey: 'k1', action: 'openedcontacts', fromindex: '1', range: '50' }); } finally { mock.restore(); }
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, 'https://campaigns.zoho.com/api/v1.1/getcampaignrecipientsdata');
  assert.equal(seen[0].type, 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(seen[0].body)), { resfmt: 'JSON', campaignkey: 'k1', action: 'openedcontacts', fromindex: '1', range: '50' });
  // A failed read is a plain error, never an "outcome unknown" write.
  const down = h.mockFetch([{ match: u => u.includes('getcampaignrecipientsdata'), respond: () => new Error('boom') }]);
  try { await assert.rejects(zc.call(zc.DATA_CENTERS.us, 'tok', 'getcampaignrecipientsdata', { campaignkey: 'k1', action: 'sentcontacts' }), e => e.code === 'ZOHO_UNREACHABLE' && !e.outcomeUnknown); } finally { down.restore(); }
});

test('REVIEW: recipient lookups are rate limited per workspace so Zoho\'s 500-per-5-minutes lock cannot be triggered from here', async () => {
  const zsvc = require('../modules/mail/zoho/zohoService');
  const original = zsvc.readCall;
  let calls = 0;
  zsvc.readCall = async () => { calls++; return { list_of_details: [] }; };
  const W = await h.createWorkspace({ name: 'Zoho limit' });
  try {
    const c = await db().run("INSERT INTO mail_campaigns (workspace_id, name, status, zoho_campaign_key, created_at, updated_at) VALUES (?, 'L', 'submitted', 'zk-l', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [W.workspaceId]);
    const statuses = [];
    for (let i = 0; i < 35; i++) statuses.push((await h.api('GET', `/api/v1/mail/campaigns/${c.lastID}/recipients?activity=opened`, { token: W.token })).status);
    assert.ok(statuses.includes(429), 'limited');
    assert.ok(calls <= 30, `Zoho called ${calls} times`);
  } finally { zsvc.readCall = original; }
});

test('REVIEW: Compose & Send refuses suppressed addresses (bounced, complaint, unsubscribed) before claiming or sending', async () => {
  const addr = `gone-${uid()}@acme.io`;
  await db().run("INSERT INTO email_suppressions (workspace_id, email, reason, source, created_at) VALUES (?, ?, 'bounced', 'zeptomail_webhook', UTC_TIMESTAMP())", [A.workspaceId, addr]);
  const calls = [];
  const mock = h.mockFetch([zeptoRoute(calls)]);
  let r;
  try { r = await sendDirect(A, { recipient_email: addr.toUpperCase() }); } finally { mock.restore(); }
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'RECIPIENT_SUPPRESSED');
  assert.equal(calls.length, 0, 'nothing sent');
  // Another workspace's suppression list does not apply.
  const calls2 = [];
  const mock2 = h.mockFetch([zeptoRoute(calls2)]);
  try { assert.equal((await sendDirect(B, { recipient_email: addr })).status, 200); } finally { mock2.restore(); }
});

test('REVIEW: a delay reason is not shown once the email is delivered', async () => {
  const s = await zeptoSent(A);
  const ep = await endpointOf(A);
  await postWebhook(ep, zeptoEvent('softbounce', s.requestId, [{ time: Date.now() - 5000, reason: 'Mailbox full' }]), KEY_A);
  await postWebhook(ep, zeptoEvent('delivered', s.requestId, [{ time: Date.now() }]), KEY_A);
  const v = (await h.api('GET', `/api/v1/mail/tracking/emails/${s.emailId}`, { token: A.token })).data.tracking;
  assert.equal(v.deliveryStatus, 'delivered');
  assert.equal(v.failure, null);
  assert.ok(v.events.some(e => e.type === 'soft_bounce' && /Mailbox full/.test(e.detail)), 'kept in history');
});

test('REVIEW: the SMTP pixel cannot record opens for ZeptoMail emails (their token is our client_reference at ZeptoMail)', async () => {
  const s = await zeptoSent(A);
  assert.equal(s.call.track_opens, true);
  await h.api('GET', `/api/v1/mail/t/o/${s.call.client_reference}.gif`);
  assert.equal((await trackingRow(s.emailId)).open_events, 0);
});

test('REVIEW: links carrying an email address in the query are not tracked (no extra copies of personal data)', () => {
  const { trackableUrl } = links();
  assert.equal(trackableUrl('https://shop.io/a?email=dana%40acme.io').ok, false);
  assert.equal(trackableUrl('https://shop.io/a?u=dana@acme.io').ok, false);
  assert.equal(trackableUrl('https://shop.io/a?utm_source=mail').ok, true);
});

test('REVIEW: click redirects and pixels keep working under load (rate limits only skip recording); the webhook is not behind the global per-IP limit', async () => {
  await h.api('PUT', '/api/v1/mail/tracking/settings', { token: SM.token, body: { trackOpens: true, trackClicks: true } });
  const calls = [];
  const m = smtpMock(calls);
  let r;
  try { r = await sendDirect(SM, { html_body: '<p><a href="https://shop.example.io/load">x</a></p>' }); } finally { m.restore(); }
  const click = calls[0].html.match(/\/api\/v1\/mail\/t\/c\/[a-f0-9]{32}/)[0];
  const pixel = calls[0].html.match(/\/api\/v1\/mail\/t\/o\/[a-f0-9]{32}\.gif/)[0];
  const codes = new Set();
  for (let i = 0; i < 320; i++) codes.add((await h.api('GET', i % 2 ? click : pixel)).status);
  assert.deepEqual([...codes].sort(), [200, 302], 'never 429 for a recipient');
  const ep = await endpointOf(A);
  const wh = new Set();
  for (let i = 0; i < 310; i++) wh.add((await h.api('POST', `/api/v1/mail/t/webhooks/zeptomail/${ep}`, { body: { x: i } })).status);
  assert.deepEqual([...wh], [401], 'rejected by signature, not by the global limiter');
});
