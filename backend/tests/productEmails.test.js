const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Product -> Leads -> personalized emails -> preview -> send. ZeptoMail is mocked; nothing is sent.
process.env.APP_BASE_URL = 'https://app.marketech.test'; // unsubscribe links need a public https base
const db = () => h.db();
let A;
let B;
let product;
let productB;
const L = {};

const pe = (ws, method, p, body) => h.api(method, `/api/v1/mail/product-emails${p}`, { token: ws.token, body });

async function lead(ws, fields) {
  const r = await db().run(
    "INSERT INTO leads (workspace_id, name, email, company_name, status, marketing_consent, product_interest, created_at) VALUES (?, ?, ?, ?, 'New', ?, ?, UTC_TIMESTAMP())",
    [ws.workspaceId, fields.name, fields.email ?? null, fields.company ?? null, fields.consent || 'unknown', fields.interest ?? null]
  );
  return r.lastID;
}

function zepto(calls, respond) {
  return { match: u => u.startsWith('https://api.zeptomail.com/'), respond: (u, init) => { calls.push(JSON.parse(init.body)); return respond ? respond(JSON.parse(init.body)) : h.json(200, { request_id: `r${calls.length}` }); } };
}

test.before(async () => {
  await h.prepareDatabase();
  process.env.APP_BASE_URL = 'https://app.marketech.test';
  A = await h.createWorkspace({ name: 'Product mail A' });
  B = await h.createWorkspace({ name: 'Product mail B' });
  for (const ws of [A, B]) {
    assert.equal((await h.api('POST', '/api/v1/mail/config', { token: ws.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: `zepto-${ws.workspaceId}`, sender_email: `news@ws${ws.workspaceId}.io`, sender_name: 'Acme' } })).status, 200);
  }
  product = (await h.api('POST', '/api/v1/products', { token: A.token, body: { name: 'RouteKit', tagline: 'Plan delivery routes', url: 'https://routekit.io', features: ['Driver app', 'Live tracking'] } })).data.productId;
  productB = (await h.api('POST', '/api/v1/products', { token: B.token, body: { name: 'Other', tagline: 'B only' } })).data.productId;
  L.dana = await lead(A, { name: 'Dana Smith', email: 'dana@fleetco.io', company: 'FleetCo', consent: 'granted' });
  L.lee = await lead(A, { name: 'Lee Wong', email: 'lee@shipit.io', company: null, consent: 'granted' });
  L.kim = await lead(A, { name: 'Kim Park', email: 'kim@cargo.io', company: 'Cargo & Co', consent: 'unknown' });
  L.sam = await lead(A, { name: 'Sam Ito', email: 'sam@cargo.io', consent: 'withdrawn' });
  L.noemail = await lead(A, { name: 'Nia', consent: 'granted' });
  L.placeholder = await lead(A, { name: 'Pat', email: 'pat@example.com', consent: 'granted' });
  L.unsub = await lead(A, { name: 'Uma', email: 'uma@left.io', consent: 'granted' });
  L.bounced = await lead(A, { name: 'Bo', email: 'bo@gone.io', consent: 'granted' });
  L.dupe = await lead(A, { name: 'Dana Again', email: 'DANA@fleetco.io', consent: 'granted' });
  L.places = await lead(A, { name: 'Corner Shop', email: 'hello@cornershop.io', consent: 'unknown' });
  await db().run("INSERT INTO lead_place_refs (workspace_id, lead_id, place_id, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP())", [A.workspaceId, L.places, `place-${Date.now()}`]);
  await db().run("INSERT INTO email_suppressions (workspace_id, email, reason, source, created_at) VALUES (?, 'uma@left.io', 'unsubscribed', 'test', UTC_TIMESTAMP()), (?, 'bo@gone.io', 'bounced', 'test', UTC_TIMESTAMP())", [A.workspaceId, A.workspaceId]);
  L.b = await lead(B, { name: 'B Lead', email: 'b@other.io', consent: 'granted' });
});
test.after(() => h.shutdown());

test('recipients: workspace leads with eligibility and reasons; nothing selected; product details loaded', async () => {
  const r = await pe(A, 'GET', `/recipients?productId=${product}&pageSize=100`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.product.name, 'RouteKit');
  assert.deepEqual(r.data.product.features, ['Driver app', 'Live tracking']);
  const by = Object.fromEntries(r.data.leads.map(l => [l.id, l]));
  assert.ok(!r.data.leads.some(l => l.id === L.b), 'other workspace leads never listed');
  assert.equal(by[L.dana].eligible, true);
  assert.deepEqual(by[L.kim].reasons, ['Marketing consent not recorded']);
  assert.deepEqual(by[L.sam].reasons, ['Marketing consent withdrawn']);
  assert.deepEqual(by[L.noemail].reasons, ['No email address']);
  assert.deepEqual(by[L.placeholder].reasons, ['Invalid or placeholder email address']);
  assert.deepEqual(by[L.unsub].reasons, ['Unsubscribed']);
  assert.deepEqual(by[L.bounced].reasons, ['Email bounced earlier']);
  assert.match(by[L.places].reasons[0], /AI Lead Discovery/);
  // "Select all eligible": distinct addresses only (Dana's duplicate address is left out).
  assert.equal(r.data.eligibleIds.length, 2);
  assert.ok(r.data.eligibleIds.includes(L.lee));
  assert.equal(r.data.eligibleIds.filter(x => x === L.dana || x === L.dupe).length, 1, 'one lead per email address');
  assert.ok(!('selected' in by[L.dana]));

  const filtered = await pe(A, 'GET', '/recipients?q=cargo&eligibility=ineligible');
  assert.deepEqual(filtered.data.leads.map(l => l.id).sort(), [L.kim, L.sam].sort());
  assert.equal((await pe(A, 'GET', `/recipients?productId=${productB}`)).status, 404, "another workspace's product");
  const approver = await h.addMember(A.workspaceId, 'Approver');
  assert.equal((await pe(approver, 'GET', '/recipients')).status, 403, 'approvers do not compose');
});

test('consent: recorded only by lead managers, with how it was obtained; audited', async () => {
  const approver = await h.addMember(A.workspaceId, 'Approver');
  assert.equal((await pe(approver, 'POST', '/consent', { leadIds: [L.kim], status: 'granted', source: 'Web form' })).status, 403);
  assert.equal((await pe(A, 'POST', '/consent', { leadIds: [L.kim], status: 'granted' })).status, 400, 'source required');
  assert.equal((await pe(A, 'POST', '/consent', { leadIds: [L.b], status: 'granted', source: 'x form' })).status, 404, "another workspace's lead");
  const ok = await pe(A, 'POST', '/consent', { leadIds: [L.kim], status: 'granted', source: 'Trade show sign-up sheet, 2026-09-10' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const row = await db().get('SELECT marketing_consent, marketing_consent_source, marketing_consent_by FROM leads WHERE id = ?', [L.kim]);
  assert.equal(row.marketing_consent, 'granted');
  assert.match(row.marketing_consent_source, /Trade show/);
  assert.equal(Number(row.marketing_consent_by), Number(A.userId));
  assert.ok(await db().get("SELECT 1 AS x FROM audit_logs WHERE action = 'leads.consent_recorded' AND resource_id = ?", [String(L.kim)]));
  const leadView = await h.api('GET', `/api/v1/leads/${L.kim}`, { token: A.token });
  assert.equal(leadView.data.lead.marketingConsent, 'granted');
});

test('batch: one personalized draft per eligible lead; ineligible and duplicate addresses excluded with reasons', async () => {
  const r = await pe(A, 'POST', '/batches', {
    productId: product,
    leadIds: [L.dana, L.lee, L.sam, L.noemail, L.dupe],
    goal: 'Show {{company}} how route planning saves time',
    senderName: 'Jane <Ops>'
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.drafts.length, 2);
  const reasons = Object.fromEntries(r.data.skipped.map(s => [s.leadId, s.reasons.join('; ')]));
  assert.match(reasons[L.sam], /withdrawn/);
  assert.match(reasons[L.noemail], /No email/);
  assert.match(reasons[L.dupe], /Same email address/);

  const dana = r.data.drafts.find(d => d.recipientEmail === 'dana@fleetco.io');
  assert.match(dana.bodyHtml, /Hi Dana,/);
  assert.match(dana.bodyHtml, /Show FleetCo how route planning/);
  assert.match(dana.bodyHtml, /RouteKit/);
  assert.match(dana.bodyHtml, /Driver app/);
  assert.match(dana.bodyHtml, /Jane &lt;Ops&gt;/, 'sender name escaped, replaces [Your name]');
  assert.match(dana.bodyHtml, /https:\/\/app\.marketech\.test\/api\/v1\/mail\/unsubscribe\/[a-f0-9]{40}/);
  assert.match(dana.subject, /for FleetCo/);
  assert.deepEqual(dana.placeholders, []);
  // Lee has no company: the {{company}} token stays visible as a placeholder to fill.
  const lee = r.data.drafts.find(d => d.recipientEmail === 'lee@shipit.io');
  assert.deepEqual(lee.placeholders, ['{{company}}']);
  const rows = await db().all('SELECT lead_id, batch_id, status FROM email_drafts WHERE batch_id = ?', [r.data.batch.id]);
  assert.ok(rows.every(x => x.status === 'Draft'));

  const none = await pe(A, 'POST', '/batches', { productId: product, leadIds: [L.sam, L.places], goal: 'x', senderName: 'J' });
  assert.equal(none.data.code, 'NO_ELIGIBLE_RECIPIENTS');
  assert.equal((await pe(A, 'POST', '/batches', { productId: product, leadIds: [L.b], goal: 'x', senderName: 'J' })).status, 404, "another workspace's lead");
  assert.equal((await pe(B, 'GET', `/batches/${r.data.batch.id}`)).status, 404);
});

test('batch from a template: tokens filled per lead and escaped', async () => {
  const tpl = await h.api('POST', '/api/v1/mail/templates', { token: A.token, body: { name: 'Promo', html: '<table><tr><td>Hello {{first_name}} at {{company}}, meet {{product_name}}.</td></tr></table>' } });
  await pe(A, 'POST', '/consent', { leadIds: [L.kim], status: 'granted', source: 'Web form' });
  const r = await pe(A, 'POST', '/batches', { productId: product, leadIds: [L.kim], templateId: tpl.data.template.id, subject: '{{product_name}} for {{company}}', senderName: 'Jane' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data.drafts[0];
  assert.match(d.bodyHtml, /Hello Kim at Cargo &amp; Co, meet RouteKit\./);
  assert.equal(d.subject, 'RouteKit for Cargo & Co');
  assert.match((await h.api('GET', `/api/v1/mail/templates/${tpl.data.template.id}`, { token: A.token })).data.template.html, /\{\{first_name\}\}/, 'template unchanged');
});

test('approve and send: separate emails, each once; unsubscribed-after-approval skipped; repeat sends nothing', async () => {
  const member = await h.addMember(A.workspaceId, 'Member');
  const created = await pe(member, 'POST', '/batches', { productId: product, leadIds: [L.dana, L.lee, L.kim], goal: 'Intro to RouteKit', senderName: 'Jane' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const id = created.data.batch.id;
  assert.equal((await pe(member, 'POST', `/batches/${id}/approve`, {})).status, 403, 'members do not approve');
  const ap = await pe(A, 'POST', `/batches/${id}/approve`, {});
  assert.equal(ap.data.approved, 3);

  // Kim withdraws between approval and sending.
  await pe(A, 'POST', '/consent', { leadIds: [L.kim], status: 'withdrawn' });
  assert.equal((await pe(member, 'POST', `/batches/${id}/send`, { confirm: true })).status, 403, 'members do not send');
  assert.equal((await pe(A, 'POST', `/batches/${id}/send`, {})).data.code, 'CONFIRMATION_REQUIRED');

  const calls = [];
  const mock = h.mockFetch([zepto(calls)]);
  let res;
  let again;
  try {
    res = await pe(A, 'POST', `/batches/${id}/send`, { confirm: true });
    again = await pe(A, 'POST', `/batches/${id}/send`, { confirm: true });
  } finally { mock.restore(); }
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.summary, { sent: 2, skipped: 1 });
  assert.match(res.data.results.find(x => x.email === 'kim@cargo.io').reason, /withdrawn/);
  assert.equal(calls.length, 2, 'one separate email per recipient');
  assert.deepEqual(calls.map(c => c.to[0].email_address.address).sort(), ['dana@fleetco.io', 'lee@shipit.io']);
  assert.ok(calls.every(c => c.to.length === 1), 'never several recipients in one message');
  assert.match(calls.find(c => c.to[0].email_address.address === 'dana@fleetco.io').htmlbody, /Hi Dana,/);
  assert.match(calls[0].textbody, /reply "unsubscribe"/);
  assert.equal(again.data.summary.sent || 0, 0, 'a repeated send sends nothing again');
  const statuses = await db().all('SELECT recipient_email, status FROM email_drafts WHERE batch_id = ? ORDER BY id', [id]);
  assert.deepEqual(statuses.map(s => s.status), ['Sent', 'Sent', 'Approved']);
  assert.equal((await db().get('SELECT status FROM mail_draft_batches WHERE id = ?', [id])).status, 'partial');
  assert.ok(await db().get("SELECT 1 AS x FROM audit_logs WHERE action = 'mail.batch_sent' AND resource_id = ?", [String(id)]));

  // Sending Kim's draft on its own is refused too.
  const kimDraft = (await db().get("SELECT id FROM email_drafts WHERE batch_id = ? AND recipient_email = 'kim@cargo.io'", [id])).id;
  assert.equal((await h.api('POST', `/api/v1/drafts/${kimDraft}/send`, { token: A.token, body: { confirm: true } })).data.code, 'RECIPIENT_INELIGIBLE');
});

test('concurrent batch sends run once; unknown outcomes are held for review, not retried', async () => {
  await pe(A, 'POST', '/consent', { leadIds: [L.kim], status: 'granted', source: 'Web form' });
  const c = await pe(A, 'POST', '/batches', { productId: product, leadIds: [L.dana, L.kim], goal: 'Follow-up', senderName: 'Jane' });
  const id = c.data.batch.id;
  await pe(A, 'POST', `/batches/${id}/approve`, {});
  const calls = [];
  const mock = h.mockFetch([zepto(calls, body => (body.to[0].email_address.address === 'kim@cargo.io'
    ? h.json(503, {})
    : new Promise(r => setTimeout(() => r(h.json(200, { request_id: 'slow' })), 120))))]);
  let results;
  try {
    results = await Promise.all([1, 2, 3].map(() => pe(A, 'POST', `/batches/${id}/send`, { confirm: true })));
  } finally { mock.restore(); }
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.ok(results.filter(r => r.status !== 200).every(r => r.data.code === 'BATCH_SENDING'));
  assert.equal(calls.length, 2);
  const ok = results.find(r => r.status === 200).data;
  assert.equal(ok.results.find(x => x.email === 'kim@cargo.io').outcome, 'needs_review');
  const kim = await db().get("SELECT status FROM email_drafts WHERE batch_id = ? AND recipient_email = 'kim@cargo.io'", [id]);
  assert.equal(kim.status, 'Needs Review');
  const calls2 = [];
  const mock2 = h.mockFetch([zepto(calls2)]);
  try { await pe(A, 'POST', `/batches/${id}/send`, { confirm: true }); } finally { mock2.restore(); }
  assert.equal(calls2.length, 0, 'nothing resent automatically');
});

test('unsubscribe link: GET confirms only; POST suppresses the address and withdraws consent', async () => {
  const lid = await lead(A, { name: 'Ola', email: 'ola@unsub.io', consent: 'granted' });
  const c = await pe(A, 'POST', '/batches', { productId: product, leadIds: [lid], goal: 'Hello', senderName: 'Jane' });
  const token = (await db().get('SELECT unsubscribe_token FROM email_drafts WHERE batch_id = ?', [c.data.batch.id])).unsubscribe_token;
  const view = await h.api('GET', `/api/v1/mail/unsubscribe/${token}`);
  assert.equal(view.status, 200);
  assert.match(view.data, /Unsubscribe\?/);
  assert.equal((await db().get('SELECT marketing_consent FROM leads WHERE id = ?', [lid])).marketing_consent, 'granted', 'GET changes nothing');
  const done = await h.api('POST', `/api/v1/mail/unsubscribe/${token}`);
  assert.equal(done.status, 200);
  assert.ok(await db().get("SELECT 1 AS x FROM email_suppressions WHERE workspace_id = ? AND email = 'ola@unsub.io'", [A.workspaceId]));
  assert.equal((await db().get('SELECT marketing_consent FROM leads WHERE id = ?', [lid])).marketing_consent, 'withdrawn');
  assert.equal((await h.api('GET', `/api/v1/mail/unsubscribe/${'0'.repeat(40)}`)).status, 404);
});

test('existing workflows unchanged: manual single drafts and direct sends still work for any valid address', async () => {
  const g = await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { recipientEmail: 'manual@person.io', recipientName: 'Manual', goal: 'Hi' } });
  assert.equal(g.status, 200);
  assert.equal(g.data.draft.batch_id, null);
  const calls = [];
  const mock = h.mockFetch([zepto(calls)]);
  let r;
  try {
    r = await h.api('POST', '/api/v1/emails/send', { token: A.token, headers: { 'Idempotency-Key': `manual-${Date.now()}-abcdefgh` }, body: { recipient_email: 'manual@person.io', subject: 'Hi', body: 'Hello', confirm: true } });
  } finally { mock.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(calls.length, 1);
});
