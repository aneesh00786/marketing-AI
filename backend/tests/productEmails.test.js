const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Product -> Leads -> personalized emails -> preview -> send (queued, sent by the worker).
// Marketing goes only through an SMTP mailbox approved for marketing (workspace A); workspace B
// uses ZeptoMail (transactional only). SMTP is stubbed and ZeptoMail mocked; nothing is sent.
process.env.APP_BASE_URL = 'https://app.marketech.test'; // unsubscribe links need a public https base
const db = () => h.db();
const svc = () => require('../modules/mail/productEmails/service');
let A;
let B;
let product;
let productB;
const L = {};

const pe = (ws, method, p, body) => h.api(method, `/api/v1/mail/product-emails${p}`, { token: ws.token, body });
const uid = () => crypto.randomBytes(4).toString('hex');

/** consent: 'granted' (with evidence), 'legacy' (granted with a note only), 'unknown', 'withdrawn'. */
async function lead(ws, fields) {
  const consent = fields.consent || 'unknown';
  const r = await db().run(
    `INSERT INTO leads (workspace_id, name, email, company_name, status, marketing_consent, marketing_consent_source, marketing_consent_method, marketing_consent_evidence, marketing_consent_obtained_at, created_at)
     VALUES (?, ?, ?, ?, 'New', ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [ws.workspaceId, fields.name, fields.email ?? null, fields.company ?? null, consent === 'legacy' ? 'granted' : consent,
      consent === 'legacy' ? 'Met at a fair' : null,
      consent === 'granted' ? 'web_form' : null, consent === 'granted' ? `form-${uid()}` : null, consent === 'granted' ? '2026-09-01 00:00:00' : null]
  );
  return r.lastID;
}

const zepto = (calls, respond) => ({
  match: u => u.startsWith('https://api.zeptomail.com/'),
  respond: (u, init) => { const b = JSON.parse(init.body); calls.push(b); return respond ? respond(b) : h.json(200, { request_id: `r${calls.length}` }); }
});
const work = (opts) => svc().processBatches(`test-worker-${uid()}`, opts);

/**
 * Stubs SMTP. Records each message in the same shape as the ZeptoMail mock (to/htmlbody/textbody,
 * headers as mime_headers). respond(msg) may return h.json(5xx) (unknown outcome: connection
 * dropped during DATA), h.json(4xx) (clear rejection) or a promise (slow server).
 */
const nodemailer = require('nodemailer');
function smtpMock(calls, respond) {
  const original = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async m => {
      const rec = { to: [{ email_address: { address: m.to } }], htmlbody: m.html, textbody: m.text, mime_headers: m.headers };
      calls.push(rec);
      let out = respond ? respond(rec) : null;
      if (out && typeof out.then === 'function') out = await out;
      if (out && out.status >= 500) throw Object.assign(new Error('Connection closed during DATA'), { code: 'ETIMEDOUT', command: 'DATA' });
      if (out && out.status >= 400) throw Object.assign(new Error(`Recipient rejected (${out.status})`), { code: 'EENVELOPE', responseCode: 550 });
      return { messageId: `<m${calls.length}@acme-mail.io>`, response: '250 OK', accepted: [m.to] };
    }
  });
  return { restore: () => { nodemailer.createTransport = original; } };
}
const SMTP = { provider: 'custom_smtp', smtp_host: 'smtp.acme-mail.io', smtp_port: 587, smtp_user: 'news@acme-mail.io', smtp_pass: 'pw', sender_email: 'news@acme-mail.io', sender_name: 'Acme' };
const approveMarketing = ws => h.api('POST', '/api/v1/mail/marketing', { token: ws.token, body: { approved: true, confirm: true, note: 'Provider allows marketing (plan checked)' } });

/** Creates, approves and queues a batch for the given leads; returns the batch id. */
async function queued(ws, leadIds, extra = {}) {
  const c = await pe(ws, 'POST', '/batches', { productId: product, leadIds, goal: 'Intro to RouteKit', senderName: 'Jane', ...extra });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const ap = await pe(A, 'POST', `/batches/${c.data.batch.id}/approve`, {});
  assert.ok(ap.data.approved >= 1, JSON.stringify(ap.data));
  const q = await pe(A, 'POST', `/batches/${c.data.batch.id}/send`, { confirm: true });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  assert.equal(q.data.queued, true);
  return c.data.batch.id;
}
const drafts = id => db().all('SELECT id, recipient_email, status, batch_outcome, send_error, sent_at FROM email_drafts WHERE batch_id = ? ORDER BY id', [id]);
const batchRow = id => db().get('SELECT * FROM mail_draft_batches WHERE id = ?', [id]);

const savedPrivate = process.env.MAIL_ALLOW_PRIVATE_HOSTS;
test.before(async () => {
  await h.prepareDatabase();
  process.env.APP_BASE_URL = 'https://app.marketech.test';
  process.env.MAIL_ALLOW_PRIVATE_HOSTS = 'true'; // no DNS lookups of the stubbed SMTP host
  // Leftovers from earlier runs in the shared test database must not be processed here.
  await db().run("UPDATE mail_draft_batches SET status = 'paused' WHERE status IN ('queued', 'sending')");
  A = await h.createWorkspace({ name: 'Product mail A' });
  B = await h.createWorkspace({ name: 'Product mail B' });
  assert.equal((await h.api('POST', '/api/v1/mail/config', { token: A.token, body: SMTP })).status, 200);
  assert.equal((await approveMarketing(A)).status, 200);
  assert.equal((await h.api('POST', '/api/v1/mail/config', { token: B.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: `zepto-${B.workspaceId}`, sender_email: `news@ws${B.workspaceId}.io`, sender_name: 'B' } })).status, 200);
  product = (await h.api('POST', '/api/v1/products', { token: A.token, body: { name: 'RouteKit', tagline: 'Plan delivery routes', url: 'https://routekit.io', features: ['Driver app', 'Live tracking'] } })).data.productId;
  productB = (await h.api('POST', '/api/v1/products', { token: B.token, body: { name: 'Other', tagline: 'B only' } })).data.productId;
  L.dana = await lead(A, { name: 'Dana Smith', email: 'dana@fleetco.io', company: 'FleetCo', consent: 'granted' });
  L.lee = await lead(A, { name: 'Lee Wong', email: 'lee@shipit.io', consent: 'granted' });
  L.kim = await lead(A, { name: 'Kim Park', email: 'kim@cargo.io', company: 'Cargo & Co', consent: 'unknown' });
  L.sam = await lead(A, { name: 'Sam Ito', email: 'sam@cargo.io', consent: 'withdrawn' });
  L.legacy = await lead(A, { name: 'Leo Gacy', email: 'leo@oldnote.io', consent: 'legacy' });
  L.noemail = await lead(A, { name: 'Nia', consent: 'granted' });
  L.placeholder = await lead(A, { name: 'Pat', email: 'pat@example.com', consent: 'granted' });
  L.unsub = await lead(A, { name: 'Uma', email: 'uma@left.io', consent: 'granted' });
  L.bounced = await lead(A, { name: 'Bo', email: 'bo@gone.io', consent: 'granted' });
  L.dupe = await lead(A, { name: 'Dana Again', email: 'DANA@fleetco.io', consent: 'granted' });
  L.places = await lead(A, { name: 'Corner Shop', email: 'hello@cornershop.io', consent: 'unknown' });
  await db().run("INSERT INTO lead_place_refs (workspace_id, lead_id, place_id, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())", [A.workspaceId, L.places, `place-${uid()}`]);
  await db().run("INSERT INTO email_suppressions (workspace_id, email, reason, source, created_at) VALUES (?, 'uma@left.io', 'unsubscribed', 'test', UTC_TIMESTAMP()), (?, 'bo@gone.io', 'bounced', 'test', UTC_TIMESTAMP())", [A.workspaceId, A.workspaceId]);
  L.b = await lead(B, { name: 'B Lead', email: 'b@other.io', consent: 'granted' });
});
test.after(() => { process.env.MAIL_ALLOW_PRIVATE_HOSTS = savedPrivate; return h.shutdown(); });

// ------------------------------------------------------------------ recipients and consent

test('recipients: eligibility with reasons; note-only consent is not trusted; nothing pre-selected', async () => {
  const r = await pe(A, 'GET', `/recipients?productId=${product}&pageSize=100`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.product.name, 'RouteKit');
  const by = Object.fromEntries(r.data.leads.map(l => [l.id, l]));
  assert.ok(!r.data.leads.some(l => l.id === L.b), 'other workspace leads never listed');
  assert.equal(by[L.dana].eligible, true);
  assert.deepEqual(by[L.kim].reasons, ['Marketing consent not recorded']);
  assert.deepEqual(by[L.sam].reasons, ['Marketing consent withdrawn']);
  assert.deepEqual(by[L.legacy].reasons, ['Consent recorded without evidence; record how and when it was given']);
  assert.deepEqual(by[L.noemail].reasons, ['No email address']);
  assert.deepEqual(by[L.placeholder].reasons, ['Invalid or placeholder email address']);
  assert.deepEqual(by[L.unsub].reasons, ['Unsubscribed']);
  assert.deepEqual(by[L.bounced].reasons, ['Email bounced earlier']);
  assert.match(by[L.places].reasons[0], /AI Lead Discovery/);
  assert.equal(r.data.eligibleIds.length, 2);
  assert.ok(r.data.eligibleIds.includes(L.lee));
  assert.equal(r.data.eligibleIds.filter(x => x === L.dana || x === L.dupe).length, 1, 'one lead per email address');
  assert.equal((await pe(A, 'GET', `/recipients?productId=${productB}`)).status, 404, "another workspace's product");
  const approver = await h.addMember(A.workspaceId, 'Approver');
  assert.equal((await pe(approver, 'GET', '/recipients')).status, 403);
  // The legacy record itself is unchanged.
  assert.equal((await db().get('SELECT marketing_consent FROM leads WHERE id = ?', [L.legacy])).marketing_consent, 'granted');
});

test('consent: granting needs method, date, evidence and attestation; history and audit are kept', async () => {
  const kim2 = await lead(A, { name: 'Kim Two', email: `kim2-${uid()}@cargo.io` });
  const approver = await h.addMember(A.workspaceId, 'Approver');
  const good = { leadIds: [kim2], status: 'granted', method: 'web_form', obtainedAt: '2026-09-10', evidence: 'Form submission #8812', attest: true };
  assert.equal((await pe(approver, 'POST', '/consent', good)).status, 403);
  assert.equal((await pe(A, 'POST', '/consent', { leadIds: [kim2], status: 'granted', source: 'Web form' })).status, 400, 'a note alone does not grant consent');
  assert.equal((await pe(A, 'POST', '/consent', { ...good, attest: undefined })).status, 400, 'attestation required');
  assert.equal((await pe(A, 'POST', '/consent', { ...good, evidence: '' })).status, 400, 'evidence required');
  assert.equal((await pe(A, 'POST', '/consent', { ...good, method: 'guess' })).status, 400, 'known methods only');
  assert.equal((await pe(A, 'POST', '/consent', { ...good, obtainedAt: '2099-01-01' })).status, 400, 'not in the future');
  assert.equal((await pe(A, 'POST', '/consent', { ...good, leadIds: [L.b] })).status, 404, "another workspace's lead");
  const ok = await pe(A, 'POST', '/consent', good);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const row = await db().get('SELECT marketing_consent, marketing_consent_method, marketing_consent_evidence, marketing_consent_obtained_at, marketing_consent_by FROM leads WHERE id = ?', [kim2]);
  assert.equal(row.marketing_consent, 'granted');
  assert.equal(row.marketing_consent_method, 'web_form');
  assert.equal(row.marketing_consent_evidence, 'Form submission #8812');
  assert.equal(new Date(row.marketing_consent_obtained_at).toISOString().slice(0, 10), '2026-09-10');
  assert.equal(Number(row.marketing_consent_by), Number(A.userId));
  await pe(A, 'POST', '/consent', { leadIds: [kim2], status: 'withdrawn', note: 'Asked by phone' });
  const events = await db().all('SELECT status, method, evidence, actor_user_id FROM lead_consent_events WHERE lead_id = ? ORDER BY id', [kim2]);
  assert.deepEqual(events.map(e => e.status), ['granted', 'withdrawn']);
  assert.equal(events[0].evidence, 'Form submission #8812');
  assert.ok(await db().get("SELECT 1 AS x FROM audit_logs WHERE action = 'leads.consent_recorded' AND resource_id = ?", [String(kim2)]));
});

// ------------------------------------------------------------------ batches

test('batch: one personalized draft per eligible lead; exclusions explained', async () => {
  const r = await pe(A, 'POST', '/batches', { productId: product, leadIds: [L.dana, L.lee, L.sam, L.legacy, L.noemail, L.dupe], goal: 'Show {{company}} how route planning saves time', senderName: 'Jane <Ops>' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.drafts.length, 2);
  const reasons = Object.fromEntries(r.data.skipped.map(s => [s.leadId, s.reasons.join('; ')]));
  assert.match(reasons[L.sam], /withdrawn/);
  assert.match(reasons[L.legacy], /without evidence/);
  assert.match(reasons[L.dupe], /Same email address/);
  const dana = r.data.drafts.find(d => d.recipientEmail === 'dana@fleetco.io');
  assert.match(dana.bodyHtml, /Hi Dana,/);
  assert.match(dana.bodyHtml, /Show FleetCo how route planning/);
  assert.match(dana.bodyHtml, /Jane &lt;Ops&gt;/);
  assert.match(dana.bodyHtml, /https:\/\/app\.marketech\.test\/api\/v1\/mail\/unsubscribe\/[a-f0-9]{40}/);
  assert.deepEqual(r.data.drafts.find(d => d.recipientEmail === 'lee@shipit.io').placeholders, ['{{company}}']);
  assert.equal(r.data.marketingDelivery.allowed, true);
  assert.equal((await pe(B, 'GET', `/batches/${r.data.batch.id}`)).status, 404);
  assert.equal((await pe(B, 'POST', `/batches/${r.data.batch.id}/send`, { confirm: true })).status, 404);
});

test('sending is queued and done by the worker: separate emails, once each, with List-Unsubscribe headers', async () => {
  const x = await lead(A, { name: 'Xia Lim', email: `xia-${uid()}@acme.io`, company: 'Acme', consent: 'granted' });
  const y = await lead(A, { name: 'Yan Ho', email: `yan-${uid()}@acme.io`, company: 'Acme', consent: 'granted' });
  const member = await h.addMember(A.workspaceId, 'Member');
  const c = await pe(member, 'POST', '/batches', { productId: product, leadIds: [x, y], goal: 'Intro', senderName: 'Jane' });
  await pe(A, 'POST', `/batches/${c.data.batch.id}/approve`, {});
  assert.equal((await pe(member, 'POST', `/batches/${c.data.batch.id}/send`, { confirm: true })).status, 403);
  assert.equal((await pe(A, 'POST', `/batches/${c.data.batch.id}/send`, {})).data.code, 'CONFIRMATION_REQUIRED');
  const q = await pe(A, 'POST', `/batches/${c.data.batch.id}/send`, { confirm: true });
  assert.equal(q.data.batch.status, 'queued');
  assert.equal((await pe(A, 'POST', `/batches/${c.data.batch.id}/send`, { confirm: true })).data.code, 'BATCH_SENDING', 'queued once');

  const calls = [];
  const mock = smtpMock(calls);
  try { await work(); await work(); } finally { mock.restore(); }
  const mine = calls.filter(cl => /@acme\.io$/.test(cl.to[0].email_address.address));
  assert.equal(mine.length, 2, 'one separate email per recipient');
  assert.ok(mine.every(cl => cl.to.length === 1));
  const hdr = mine[0].mime_headers;
  assert.match(hdr['List-Unsubscribe'], /^<https:\/\/app\.marketech\.test\/api\/v1\/mail\/unsubscribe\/[a-f0-9]{40}>, <mailto:news@acme-mail\.io\?subject=unsubscribe>$/);
  assert.equal(hdr['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const ds = await drafts(c.data.batch.id);
  assert.ok(ds.every(d => d.status === 'Sent' && d.batch_outcome === 'sent' && d.sent_at));
  assert.equal((await batchRow(c.data.batch.id)).status, 'done');
  assert.equal((await pe(A, 'POST', `/batches/${c.data.batch.id}/send`, { confirm: true })).data.code, 'NOTHING_TO_SEND');
  assert.ok(await db().get("SELECT 1 AS x FROM audit_logs WHERE action = 'mail.batch_sent' AND resource_id = ?", [String(c.data.batch.id)]));
});

// ------------------------------------------------------------------ provider restrictions (Phase 8B)

test('ZeptoMail workspaces cannot send product emails: refused when queuing, batch kept as it was', async () => {
  const bl = await lead(B, { name: 'Bea', email: `bea-${uid()}@acme.io`, consent: 'granted' });
  const c = await pe(B, 'POST', '/batches', { productId: productB, leadIds: [bl], goal: 'Hi', senderName: 'B' });
  assert.equal(c.status, 200, 'preparing drafts is still possible');
  assert.equal(c.data.marketingDelivery.allowed, false);
  assert.equal(c.data.marketingDelivery.code, 'MARKETING_PROVIDER_BLOCKED');
  await pe(B, 'POST', `/batches/${c.data.batch.id}/approve`, {});
  const calls = [];
  const zm = smtpMock(calls);
  let q;
  try {
    q = await pe(B, 'POST', `/batches/${c.data.batch.id}/send`, { confirm: true });
    // Sending the batch draft on its own from Mail Drafts is refused as well.
    const d = (await db().get('SELECT id FROM email_drafts WHERE batch_id = ?', [c.data.batch.id])).id;
    const single = await h.api('POST', `/api/v1/drafts/${d}/send`, { token: B.token, body: { confirm: true } });
    assert.equal(single.data.code, 'MARKETING_PROVIDER_BLOCKED');
    await work();
  } finally { zm.restore(); }
  assert.equal(q.status, 409);
  assert.equal(q.data.code, 'MARKETING_PROVIDER_BLOCKED');
  assert.match(q.data.error, /ZeptoMail/);
  assert.equal(calls.length, 0, 'nothing reached ZeptoMail');
  const ds = await drafts(c.data.batch.id);
  assert.ok(ds.every(d => d.status === 'Approved' && d.batch_outcome === null), 'recipient state kept');
  assert.equal((await batchRow(c.data.batch.id)).status, 'approved');
});

test('SMTP needs explicit marketing approval by an Owner/Admin; changing the SMTP account clears it', async () => {
  const S = await h.createWorkspace({ name: 'Product mail approval' });
  await h.api('POST', '/api/v1/mail/config', { token: S.token, body: { ...SMTP, smtp_user: 'a@acme-mail.io', sender_email: 'a@acme-mail.io' } });
  const status = await h.api('GET', '/api/v1/mail/marketing', { token: S.token });
  assert.equal(status.data.marketing.code, 'MARKETING_NOT_APPROVED');
  const pS = (await h.api('POST', '/api/v1/products', { token: S.token, body: { name: 'Widget', tagline: 'W' } })).data.productId;
  const sl = await lead(S, { name: 'Sol', email: `sol-${uid()}@acme.io`, consent: 'granted' });
  const c = await pe(S, 'POST', '/batches', { productId: pS, leadIds: [sl], goal: 'Hi', senderName: 'S' });
  await pe(S, 'POST', `/batches/${c.data.batch.id}/approve`, {});
  assert.equal((await pe(S, 'POST', `/batches/${c.data.batch.id}/send`, { confirm: true })).data.code, 'MARKETING_NOT_APPROVED');

  const member = await h.addMember(S.workspaceId, 'Marketing Manager');
  assert.equal((await h.api('POST', '/api/v1/mail/marketing', { token: member.token, body: { approved: true, confirm: true } })).status, 403);
  assert.equal((await h.api('POST', '/api/v1/mail/marketing', { token: S.token, body: { approved: true } })).status, 400, 'confirmation required');
  const ok = await approveMarketing(S);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.marketing.allowed, true);
  assert.ok(await db().get("SELECT 1 AS x FROM audit_logs WHERE workspace_id = ? AND action = 'mail.marketing_approved'", [S.workspaceId]));
  // Approval belongs to that account: switching SMTP login (or to ZeptoMail) clears it.
  await h.api('POST', '/api/v1/mail/config', { token: S.token, body: { ...SMTP, smtp_user: 'b@acme-mail.io', sender_email: 'b@acme-mail.io' } });
  assert.equal((await h.api('GET', '/api/v1/mail/marketing', { token: S.token })).data.marketing.code, 'MARKETING_NOT_APPROVED');
  await h.api('POST', '/api/v1/mail/config', { token: S.token, body: { provider: 'zeptomail', smtp_pass: 'zt', sender_email: 'b@acme-mail.io' } });
  assert.equal((await approveMarketing(S)).data.code, 'MARKETING_PROVIDER_BLOCKED', 'ZeptoMail cannot be approved for marketing');
});

test('the worker re-checks delivery: a batch queued before the provider changed pauses, keeps its state and resumes once fixed', async () => {
  const W = await h.createWorkspace({ name: 'Product mail worker check' });
  await h.api('POST', '/api/v1/mail/config', { token: W.token, body: SMTP });
  await approveMarketing(W);
  const pW = (await h.api('POST', '/api/v1/products', { token: W.token, body: { name: 'Gadget', tagline: 'G' } })).data.productId;
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await lead(W, { name: `W${i}`, email: `w${i}-${uid()}@acme.io`, consent: 'granted' }));
  const c = await pe(W, 'POST', '/batches', { productId: pW, leadIds: ids, goal: 'Hi', senderName: 'W' });
  await pe(W, 'POST', `/batches/${c.data.batch.id}/approve`, {});
  assert.equal((await pe(W, 'POST', `/batches/${c.data.batch.id}/send`, { confirm: true })).data.batch.status, 'queued');
  // Someone switches the workspace to ZeptoMail before the worker runs.
  await h.api('POST', '/api/v1/mail/config', { token: W.token, body: { provider: 'zeptomail', smtp_pass: 'zt', sender_email: 'news@acme-mail.io' } });
  const sCalls = [];
  const zCalls = [];
  let sm = smtpMock(sCalls);
  let zm = h.mockFetch([zepto(zCalls)]);
  try { await work(); } finally { sm.restore(); zm.restore(); }
  assert.equal(sCalls.length + zCalls.length, 0, 'nothing sent through any provider');
  const paused = await batchRow(c.data.batch.id);
  assert.equal(paused.status, 'paused');
  assert.match(paused.last_error, /ZeptoMail/);
  assert.ok((await drafts(c.data.batch.id)).every(d => d.status === 'Approved' && d.batch_outcome === null), 'state kept');
  assert.equal((await pe(W, 'POST', `/batches/${c.data.batch.id}/send`, { confirm: true })).data.code, 'MARKETING_PROVIDER_BLOCKED', 'cannot resume while blocked');

  // Back to the approved SMTP mailbox: resuming sends each email exactly once.
  await h.api('POST', '/api/v1/mail/config', { token: W.token, body: SMTP });
  await approveMarketing(W);
  assert.equal((await pe(W, 'POST', `/batches/${c.data.batch.id}/send`, { confirm: true })).status, 200);
  sm = smtpMock(sCalls);
  zm = h.mockFetch([zepto(zCalls)]);
  try { await work(); await work(); } finally { sm.restore(); zm.restore(); }
  assert.equal(sCalls.length, 3);
  assert.equal(zCalls.length, 0);
  assert.equal(new Set(sCalls.map(x => x.to[0].email_address.address)).size, 3);
  assert.equal((await batchRow(c.data.batch.id)).status, 'done');
});

test('retrying failed emails is refused while marketing delivery is blocked, without changing their state', async () => {
  const R = await h.createWorkspace({ name: 'Product mail retry' });
  await h.api('POST', '/api/v1/mail/config', { token: R.token, body: SMTP });
  await approveMarketing(R);
  const pR = (await h.api('POST', '/api/v1/products', { token: R.token, body: { name: 'Thing', tagline: 'T' } })).data.productId;
  const l1 = await lead(R, { name: 'Fail', email: `fail-${uid()}@acme.io`, consent: 'granted' });
  const c = await pe(R, 'POST', '/batches', { productId: pR, leadIds: [l1], goal: 'Hi', senderName: 'R' });
  await pe(R, 'POST', `/batches/${c.data.batch.id}/approve`, {});
  await pe(R, 'POST', `/batches/${c.data.batch.id}/send`, { confirm: true });
  const calls = [];
  const sm = smtpMock(calls, () => h.json(422, {}));
  try { await work(); } finally { sm.restore(); }
  assert.equal((await drafts(c.data.batch.id))[0].batch_outcome, 'failed');
  await h.api('POST', '/api/v1/mail/marketing', { token: R.token, body: { approved: false, confirm: true } });
  const r = await pe(R, 'POST', `/batches/${c.data.batch.id}/retry-failed`, { confirm: true });
  assert.equal(r.data.code, 'MARKETING_NOT_APPROVED');
  assert.equal((await drafts(c.data.batch.id))[0].batch_outcome, 'failed', 'unchanged');
});

test('eligibility is rechecked before every email: withdrawn, unsubscribed or bounced recipients are skipped', async () => {
  const p = await lead(A, { name: 'Pia', email: `pia-${uid()}@acme.io`, consent: 'granted' });
  const q = await lead(A, { name: 'Quin', email: `quin-${uid()}@acme.io`, consent: 'granted' });
  const r = await lead(A, { name: 'Rae', email: `rae-${uid()}@acme.io`, consent: 'granted' });
  const s = await lead(A, { name: 'Sol', email: `sol-${uid()}@acme.io`, consent: 'granted' });
  const id = await queued(A, [p, q, r, s]);
  const emails = Object.fromEntries((await db().all(`SELECT id, email FROM leads WHERE id IN (?, ?, ?, ?)`, [p, q, r, s])).map(x => [x.id, x.email]));
  await pe(A, 'POST', '/consent', { leadIds: [q], status: 'withdrawn' });
  await db().run("INSERT INTO email_suppressions (workspace_id, email, reason, source, created_at) VALUES (?, ?, 'unsubscribed', 'test', UTC_TIMESTAMP()), (?, ?, 'bounced', 'test', UTC_TIMESTAMP())", [A.workspaceId, emails[r], A.workspaceId, emails[s]]);
  const calls = [];
  const mock = smtpMock(calls);
  try { await work(); } finally { mock.restore(); }
  assert.deepEqual(calls.map(cl => cl.to[0].email_address.address), [emails[p]]);
  const ds = Object.fromEntries((await drafts(id)).map(d => [d.recipient_email, d]));
  assert.equal(ds[emails[q]].batch_outcome, 'skipped');
  assert.match(ds[emails[q]].send_error, /withdrawn/);
  assert.match(ds[emails[r]].send_error, /Unsubscribed/);
  assert.match(ds[emails[s]].send_error, /bounced/);
  // Sending a skipped draft on its own is refused too.
  const qDraft = (await db().get('SELECT id FROM email_drafts WHERE batch_id = ? AND recipient_email = ?', [id, emails[q]])).id;
  assert.equal((await h.api('POST', `/api/v1/drafts/${qDraft}/send`, { token: A.token, body: { confirm: true } })).data.code, 'RECIPIENT_INELIGIBLE');
});

test('an interrupted batch resumes without resending sent or uncertain emails', async () => {
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await lead(A, { name: `Res ${i}`, email: `res${i}-${uid()}@acme.io`, consent: 'granted' }));
  const id = await queued(A, ids);
  const calls = [];
  let mock = smtpMock(calls);
  try { await work({ maxEmails: 1 }); } finally { mock.restore(); }
  assert.equal(calls.length, 1);
  assert.equal((await batchRow(id)).status, 'queued', 'more to send');
  // Simulate a worker that died while sending the second email.
  const second = (await drafts(id)).find(d => d.status === 'Approved');
  await db().run("UPDATE email_drafts SET status = 'Sending', updated_at = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE id = ?", [second.id]);
  await db().run("UPDATE mail_draft_batches SET status = 'sending', locked_by = 'dead-worker', locked_at = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE id = ?", [id]);
  const calls2 = [];
  mock = smtpMock(calls2);
  try { await work(); } finally { mock.restore(); }
  const ds = await drafts(id);
  const stuck = ds.find(d => d.id === second.id);
  assert.equal(stuck.status, 'Needs Review');
  assert.equal(stuck.batch_outcome, 'needs_review');
  assert.equal(calls2.length, 2, 'only the two never-attempted emails');
  assert.ok(!calls2.some(cl => cl.to[0].email_address.address === stuck.recipient_email), 'the uncertain one is not resent');
  assert.equal(new Set([...calls, ...calls2].map(cl => cl.to[0].email_address.address)).size, 3);
  assert.equal((await batchRow(id)).status, 'done');
});

test('concurrent workers send each email once; unknown outcomes stay in Needs Review; clear failures retry only on request', async () => {
  const a = await lead(A, { name: 'Ann', email: `ann-${uid()}@acme.io`, consent: 'granted' });
  const u = await lead(A, { name: 'Unk', email: `unk-${uid()}@acme.io`, consent: 'granted' });
  const f = await lead(A, { name: 'Fay', email: `fay-${uid()}@acme.io`, consent: 'granted' });
  const id = await queued(A, [a, u, f]);
  const calls = [];
  const mock = smtpMock(calls, b => {
    const to = b.to[0].email_address.address;
    if (to.startsWith('unk-')) return h.json(503, {});
    if (to.startsWith('fay-')) return h.json(422, { error: 'sender not verified' });
    return new Promise(r => setTimeout(() => r(h.json(200, { request_id: 'ok' })), 100));
  });
  try { await Promise.all([work(), work(), work()]); await work(); } finally { mock.restore(); }
  assert.equal(calls.filter(cl => cl.to[0].email_address.address.startsWith('ann-')).length, 1);
  assert.equal(calls.filter(cl => cl.to[0].email_address.address.startsWith('unk-')).length, 1);
  assert.equal(calls.filter(cl => cl.to[0].email_address.address.startsWith('fay-')).length, 1);
  const ds = Object.fromEntries((await drafts(id)).map(d => [d.recipient_email.split('-')[0], d]));
  assert.equal(ds.unk.status, 'Needs Review');
  assert.equal(ds.unk.batch_outcome, 'needs_review');
  assert.equal(ds.fay.batch_outcome, 'failed');
  assert.match(ds.fay.send_error, /422/);
  assert.equal((await batchRow(id)).status, 'done');

  // Retrying failed emails is explicit; the uncertain one is never included.
  const calls2 = [];
  const mock2 = smtpMock(calls2);
  try {
    const r = await pe(A, 'POST', `/batches/${id}/retry-failed`, { confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await work();
  } finally { mock2.restore(); }
  assert.deepEqual(calls2.map(cl => cl.to[0].email_address.address.split('-')[0]), ['fay']);
});

test('the batch pauses if the person who queued it lost access; nothing is sent', async () => {
  const sender = await h.addMember(A.workspaceId, 'Workspace Admin');
  const v = await lead(A, { name: 'Vic', email: `vic-${uid()}@acme.io`, consent: 'granted' });
  const c = await pe(A, 'POST', '/batches', { productId: product, leadIds: [v], goal: 'Hi', senderName: 'J' });
  await pe(A, 'POST', `/batches/${c.data.batch.id}/approve`, {});
  await pe(sender, 'POST', `/batches/${c.data.batch.id}/send`, { confirm: true });
  await db().run("UPDATE workspace_members SET status = 'Removed' WHERE workspace_id = ? AND user_id = ?", [A.workspaceId, sender.userId]);
  const calls = [];
  const mock = smtpMock(calls);
  try { await work(); } finally { mock.restore(); }
  assert.equal(calls.filter(cl => cl.to[0].email_address.address.startsWith('vic-')).length, 0);
  const b = await batchRow(c.data.batch.id);
  assert.equal(b.status, 'paused');
  assert.match(b.last_error, /no longer an active member/);
});

// ------------------------------------------------------------------ unsubscribes

test('one-click unsubscribe (RFC 8058): POST without login applies it, idempotently; GET only confirms', async () => {
  const o = await lead(A, { name: 'Ola', email: `ola-${uid()}@unsub.io`, consent: 'granted' });
  const c = await pe(A, 'POST', '/batches', { productId: product, leadIds: [o], goal: 'Hello', senderName: 'Jane' });
  const token = (await db().get('SELECT unsubscribe_token FROM email_drafts WHERE batch_id = ?', [c.data.batch.id])).unsubscribe_token;
  const view = await h.api('GET', `/api/v1/mail/unsubscribe/${token}`);
  assert.match(view.data, /Unsubscribe\?/);
  assert.equal((await db().get('SELECT marketing_consent FROM leads WHERE id = ?', [o])).marketing_consent, 'granted', 'GET changes nothing');
  const { port } = (await h.startApp()).address();
  const post = () => globalThis.__realFetch(`http://127.0.0.1:${port}/api/v1/mail/unsubscribe/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200, 'repeat is harmless');
  const email = (await db().get('SELECT email FROM leads WHERE id = ?', [o])).email;
  assert.ok(await db().get('SELECT 1 AS x FROM email_suppressions WHERE workspace_id = ? AND email = ?', [A.workspaceId, email]));
  assert.equal((await db().get('SELECT marketing_consent FROM leads WHERE id = ?', [o])).marketing_consent, 'withdrawn');
  const audits = await db().all("SELECT id FROM audit_logs WHERE action = 'mail.unsubscribed' AND resource_id = ?", [String(o)]);
  assert.equal(audits.length, 1, 'recorded once');
  assert.equal((await h.api('GET', `/api/v1/mail/unsubscribe/${'0'.repeat(40)}`)).status, 404);
});

test('unsubscribe replies: matched to the right recipient and workspace, idempotent, never affecting other leads', async () => {
  const email = `rep-${uid()}@acme.io`;
  const r1 = await lead(A, { name: 'Rep One', email, consent: 'granted' });
  const r2 = await lead(A, { name: 'Rep Same Address', email, consent: 'granted' }); // a different lead record
  const other = await lead(A, { name: 'Other', email: `oth-${uid()}@acme.io`, consent: 'granted' });
  const bLead = await lead(B, { name: 'In B', email, consent: 'granted' });
  const id = await queued(A, [r1, other]);
  const mock = smtpMock([]);
  try { await work(); } finally { mock.restore(); }
  const insertReply = (wsId, from, subject, body, when = 'UTC_TIMESTAMP() + INTERVAL 1 MINUTE') => db().run(
    `INSERT INTO emails (workspace_id, sender, sender_email, subject, body, status, smtp_status, received_at, is_read) VALUES (?, ?, ?, ?, ?, 'Unread', 'Received via IMAP', ${when}, 0)`,
    [wsId, from, from, subject, body]);
  await insertReply(A.workspaceId, email, 'Re: RouteKit', 'Thanks, sounds interesting');          // not an unsubscribe
  await insertReply(A.workspaceId, email, 'old', 'unsubscribe', 'UTC_TIMESTAMP() - INTERVAL 2 DAY'); // before the send: ignored
  await insertReply(B.workspaceId, email, 'unsubscribe', 'please unsubscribe');                    // other workspace
  assert.equal(await svc().detectUnsubscribeReplies({ workspaceId: A.workspaceId }), 0);
  assert.equal((await db().get('SELECT marketing_consent FROM leads WHERE id = ?', [r1])).marketing_consent, 'granted');

  await insertReply(A.workspaceId, email, 'Re: RouteKit', 'Please remove me from this list');
  assert.equal(await svc().detectUnsubscribeReplies({ workspaceId: A.workspaceId }), 1);
  assert.equal(await svc().detectUnsubscribeReplies({ workspaceId: A.workspaceId }), 0, 'duplicate processing changes nothing');
  assert.equal((await db().get('SELECT marketing_consent FROM leads WHERE id = ?', [r1])).marketing_consent, 'withdrawn');
  assert.ok(await db().get('SELECT 1 AS x FROM email_suppressions WHERE workspace_id = ? AND email = ?', [A.workspaceId, email]));
  assert.equal((await db().get('SELECT marketing_consent FROM leads WHERE id = ?', [r2])).marketing_consent, 'granted', 'other lead records are not changed');
  assert.equal((await db().get('SELECT marketing_consent FROM leads WHERE id = ?', [other])).marketing_consent, 'granted');
  assert.equal((await db().get('SELECT marketing_consent FROM leads WHERE id = ?', [bLead])).marketing_consent, 'granted', 'other workspace untouched');
  assert.equal(await db().get('SELECT 1 AS x FROM email_suppressions WHERE workspace_id = ? AND email = ?', [B.workspaceId, email]), null);
  // The same address in A is now suppressed, so the other lead record is ineligible too (by suppression, not consent).
  const rec = await pe(A, 'GET', `/recipients?q=${encodeURIComponent(email)}`);
  assert.ok(rec.data.leads.every(l => !l.eligible));
  const events = await db().all("SELECT status, actor_type, reference FROM lead_consent_events WHERE lead_id = ?", [r1]);
  assert.equal(events.length, 1);
  assert.equal(events[0].actor_type, 'recipient');
  assert.match(events[0].reference, /^email:\d+$/);
  assert.ok(id);
});

test('recipients always come from each lead record: several leads get their own name and email; browser values are ignored', async () => {
  const l1 = await lead(A, { name: 'Mia Rossi', email: `mia-${uid()}@acme.io`, company: 'Acme', consent: 'granted' });
  const l2 = await lead(A, { name: 'Noah Kim', email: `noah-${uid()}@beta.io`, company: 'Beta', consent: 'granted' });
  const rows = Object.fromEntries((await db().all('SELECT id, name, email FROM leads WHERE id IN (?, ?)', [l1, l2])).map(r => [r.id, r]));
  // Recipient details or a workspace id sent by the browser are rejected outright.
  for (const extra of [{ recipientEmail: 'attacker@evil.io' }, { recipients: [{ email: 'x@evil.io' }] }, { workspaceId: B.workspaceId }]) {
    assert.equal((await pe(A, 'POST', '/batches', { productId: product, leadIds: [l1], goal: 'Hi', senderName: 'J', ...extra })).status, 400, JSON.stringify(extra));
  }
  const c = await pe(A, 'POST', '/batches', { productId: product, leadIds: [l1, l2], goal: 'Hi {{first_name}}', senderName: 'J' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const byLead = Object.fromEntries(c.data.drafts.map(d => [d.leadId, d]));
  for (const id of [l1, l2]) {
    assert.equal(byLead[id].recipientEmail, rows[id].email);
    assert.equal(byLead[id].recipientName, rows[id].name);
  }
  assert.match(byLead[l1].bodyHtml, /Hi Mia/);
  assert.match(byLead[l2].bodyHtml, /Hi Noah/);
  // The recipient of a product email cannot be changed afterwards (only placeholders/content).
  const d1 = byLead[l1].id;
  const edit = await h.api('PATCH', `/api/v1/drafts/${d1}`, { token: A.token, body: { recipient_email: 'other@acme.io' } });
  assert.equal(edit.status, 409);
  assert.equal(edit.data.code, 'RECIPIENT_FROM_LEAD');
  assert.equal((await h.api('PATCH', `/api/v1/drafts/${d1}`, { token: A.token, body: { recipient_name: 'Someone' } })).data.code, 'RECIPIENT_FROM_LEAD');
  assert.equal((await db().get('SELECT recipient_email FROM email_drafts WHERE id = ?', [d1])).recipient_email, rows[l1].email);
});

test('Mail Drafts generator: choosing a lead fills the recipient from the lead (workspace-checked); leads without email are refused', async () => {
  const l = await lead(A, { name: 'Ola Berg', email: `ola-${uid()}@acme.io`, consent: 'unknown' });
  const noMail = await lead(A, { name: 'No Mail' });
  const badMail = await lead(A, { name: 'Bad Mail', email: 'someone@example.com' });
  const email = (await db().get('SELECT email FROM leads WHERE id = ?', [l])).email;
  const g = await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { leadId: l, productId: product, recipientEmail: 'typed@other.io', recipientName: 'Typed Name', goal: 'Intro' } });
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.equal(g.data.draft.recipient_email, email, 'browser-typed recipient ignored');
  assert.equal(g.data.draft.recipient_name, 'Ola Berg');
  assert.equal(Number(g.data.draft.lead_id), l);
  assert.equal((await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { leadId: noMail } })).data.code, 'LEAD_NO_EMAIL');
  assert.equal((await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { leadId: badMail } })).data.code, 'LEAD_NO_EMAIL');
  assert.equal((await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { leadId: L.b } })).status, 404, "another workspace's lead");
  assert.equal((await h.api('POST', '/api/v1/drafts/generate', { token: B.token, body: { leadId: l } })).status, 404);
});

test('transactional email unchanged: manual drafts and direct sends still go through ZeptoMail', async () => {
  const g = await h.api('POST', '/api/v1/drafts/generate', { token: B.token, body: { recipientEmail: 'manual@person.io', recipientName: 'Manual', goal: 'Hi' } });
  assert.equal(g.status, 200);
  assert.equal(g.data.draft.batch_id, null);
  const calls = [];
  const mock = h.mockFetch([zepto(calls)]);
  let r;
  try {
    r = await h.api('POST', '/api/v1/emails/send', { token: B.token, headers: { 'Idempotency-Key': `manual-${uid()}-abcdefgh` }, body: { recipient_email: 'manual@person.io', subject: 'Hi', body: 'Hello', confirm: true } });
  } finally { mock.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(calls.length, 1, 'sent through ZeptoMail');
  assert.equal(calls[0].mime_headers, undefined, 'no marketing headers on one-off emails');
  // A regular (non-batch) draft is transactional too: approved and sent through ZeptoMail.
  const fill = Object.fromEntries((g.data.draft.placeholders || []).map(x => [x, 'Jane']));
  await h.api('PATCH', `/api/v1/drafts/${g.data.draft.id}`, { token: B.token, body: { replacements: fill } });
  assert.equal((await h.api('PUT', `/api/v1/drafts/${g.data.draft.id}/approve`, { token: B.token })).status, 200);
  const calls2 = [];
  const mock2 = h.mockFetch([zepto(calls2)]);
  let sent;
  try { sent = await h.api('POST', `/api/v1/drafts/${g.data.draft.id}/send`, { token: B.token, body: { confirm: true } }); } finally { mock2.restore(); }
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(calls2.length, 1);
});
