const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Email outreach campaigns. AI and ZeptoMail are mocked; unmatched requests fail loudly,
// so no real email can be sent. The sender is driven directly (one tick per call).
let A;
let B;
let C;
let prodA;
let leads = {};

const sender = () => require('../modules/outreach/outreachSender');
const db = () => h.db();
const tick = (opts = {}) => sender().processOutreach('test-worker', { now: new Date(), ...opts });

const zepto = (calls, respond) => ({
  match: u => u.startsWith('https://api.zeptomail.com/'),
  respond: (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ auth: init.headers.Authorization, to: body.to[0].email_address.address, subject: body.subject, html: body.htmlbody });
    return respond ? respond(body) : h.json(200, { request_id: `req-${calls.length}` });
  }
});
const groq = content => h.groqRoute(() => (typeof content === 'string' ? content : JSON.stringify(content)));
const aiDown = { match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) };

async function api(ws, method, path, body) {
  return h.api(method, `/api/v1/outreach${path}`, { token: ws.token, body });
}

async function addLead(ws, body) {
  const mock = h.mockFetch([aiDown]);
  try {
    const r = await h.api('POST', '/api/v1/leads', { token: ws.token, body });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.lead.id;
  } finally { mock.restore(); }
}

const SEQ = { steps: [
  { delay_days: 0, subject: 'Routes for {{company}}', body: 'Hi {{first_name}},\n\nRouteKit plans delivery routes. Worth a short call?' },
  { delay_days: 3, subject: 'Following up', body: 'Hi {{first_name}},\n\nJust checking whether route planning is on your list this quarter.' }
] };

/** Creates an approved, always-open campaign for the given leads (AI mocked). */
async function runningCampaign(ws, leadIds, extra = {}) {
  await db().run('DELETE FROM email_suppressions WHERE workspace_id = ?', [ws.workspaceId]);
  const c = (await api(ws, 'POST', '/campaigns', { name: `C ${Date.now()}`, productId: prodA, sendDays: [1, 2, 3, 4, 5, 6, 7], sendStartHour: 0, sendEndHour: 24, ...extra })).data.campaign;
  const mock = h.mockFetch([groq(SEQ)]);
  try { assert.equal((await api(ws, 'POST', `/campaigns/${c.id}/generate`, { steps: 2 })).status, 200); } finally { mock.restore(); }
  assert.equal((await api(ws, 'POST', `/campaigns/${c.id}/recipients`, { leadIds })).status, 200);
  const ok = await api(ws, 'POST', `/campaigns/${c.id}/approve`, { confirm: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  return c.id;
}

const recipients = async id => (await db().all('SELECT * FROM outreach_recipients WHERE campaign_id = ? ORDER BY id', [id]));
const sends = async id => (await db().all('SELECT * FROM outreach_sends WHERE campaign_id = ? ORDER BY id', [id]));

test.before(async () => {
  await h.prepareDatabase();
  // Earlier runs may have left campaigns running in the shared test database.
  await db().run("UPDATE outreach_campaigns SET status = 'stopped' WHERE status = 'running'");
  A = await h.createWorkspace({ name: 'Outreach A' });
  B = await h.createWorkspace({ name: 'Outreach B' });
  C = await h.createWorkspace({ name: 'Outreach C (no mail)' });
  for (const [ws, token, sender] of [[A, 'zepto-A', 'hello@a-co.io'], [C, null, null]]) {
    if (!token) continue;
    const r = await h.api('POST', '/api/v1/mail/config', { token: ws.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: token, sender_email: sender, sender_name: 'A Co' } });
    assert.equal(r.status, 200);
  }
  prodA = (await h.api('POST', '/api/v1/products', { token: A.token, body: { name: 'RouteKit', tagline: 'Plan delivery routes', features: ['Driver app'] } })).data.productId;
  leads.dana = await addLead(A, { name: 'Dana Smith', email: 'dana@fleetco.io', companyName: 'FleetCo', status: 'Contacted' });
  leads.lee = await addLead(A, { name: 'Lee Wong', email: 'lee@fleetco.io' });
  leads.kim = await addLead(A, { name: 'Kim Park', email: 'kim@shipit.io' });
  leads.sam = await addLead(A, { name: 'Sam Ito', email: 'sam@cargo.io' });
  leads.placeholder = await addLead(A, { name: 'Pat', email: 'pat@example.com' });
  leads.none = await addLead(A, { name: 'Nia' });
  leads.b = await addLead(B, { name: 'B Lead', email: 'b@other.io' });
});
test.after(() => h.shutdown());

test('AI writes the sequence from verified facts; AI failure leaves no canned emails', async () => {
  const c = (await api(A, 'POST', '/campaigns', { name: 'Gen test', productId: prodA, goal: 'Book intro calls' })).data.campaign;
  assert.equal(c.status, 'draft');
  const down = h.mockFetch([aiDown]);
  let r;
  try { r = await api(A, 'POST', `/campaigns/${c.id}/generate`, { steps: 3 }); } finally { down.restore(); }
  assert.equal(r.status, 503);
  assert.equal((await api(A, 'GET', `/campaigns/${c.id}`)).data.campaign.steps.length, 0, 'no fallback copy');

  let prompt = '';
  const mock = h.mockFetch([h.groqRoute(b => { prompt = b.messages.map(m => m.content).join('\n'); return JSON.stringify({ steps: [
    { delay_days: 0, subject: 'Save 40% on planning', body: 'Hi {{first_name}},\n\nStart a 14-day free trial of RouteKit.' },
    { delay_days: 0, subject: 'Quick follow-up', body: 'Hi {{first_name}},\n\nRouteKit includes a driver app.' }
  ] }); })]);
  try { r = await api(A, 'POST', `/campaigns/${c.id}/generate`, { steps: 2 }); } finally { mock.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(prompt, /Plan delivery routes/);
  assert.match(prompt, /Book intro calls/);
  const [s1, s2] = r.data.campaign.steps;
  assert.deepEqual(s1.needsVerification.sort(), ['14-day free trial', '40%'].sort());
  assert.deepEqual(s2.needsVerification, []);
  assert.equal(s2.delayDays, 1, 'follow-ups are at least a day apart');

  const bad = await api(A, 'PUT', `/campaigns/${c.id}/steps`, { steps: [{ delayDays: 0, subject: 'Hi', body: 'Hello {{last_name}}' }] });
  assert.equal(bad.status, 400, 'unknown placeholders are rejected');
});

test('audience: only valid, owned, unsuppressed leads are added', async () => {
  const c = (await api(A, 'POST', '/campaigns', { name: 'Audience test' })).data.campaign;
  const preview = await api(A, 'POST', '/audience/preview', { filter: { statuses: ['Contacted'] } });
  assert.equal(preview.status, 200);
  assert.ok(preview.data.audience.every(a => a.status === 'Contacted'));
  assert.equal((await api(A, 'POST', `/campaigns/${c.id}/recipients`, { leadIds: [leads.dana, leads.b] })).status, 404, 'foreign lead');
  await db().run("INSERT IGNORE INTO email_suppressions (workspace_id, email, reason, source) VALUES (?, 'sam@cargo.io', 'unsubscribed', 'test')", [A.workspaceId]);
  const r = await api(A, 'POST', `/campaigns/${c.id}/recipients`, { leadIds: [leads.dana, leads.placeholder, leads.none, leads.sam] });
  assert.equal(r.data.added, 1);
  assert.deepEqual(r.data.skipped.map(s => s.reason).sort(), ['invalid or placeholder email address', 'no email address', 'unsubscribed or bounced earlier'].sort());
  const again = await api(A, 'POST', `/campaigns/${c.id}/recipients`, { leadIds: [leads.dana] });
  assert.equal(again.data.added, 0);
  await db().run("DELETE FROM email_suppressions WHERE workspace_id = ? AND email = 'sam@cargo.io'", [A.workspaceId]);
});

test('approval needs confirmation, a configured mailbox, filled placeholders and verified claims', async () => {
  const c = (await api(A, 'POST', '/campaigns', { name: 'Approve test', productId: prodA })).data.campaign;
  await api(A, 'PUT', `/campaigns/${c.id}/steps`, { steps: [{ delayDays: 0, subject: 'Hello', body: 'Hi {{first_name}}, we helped [customer example] cut costs by 30%.' }] });
  await api(A, 'POST', `/campaigns/${c.id}/recipients`, { leadIds: [leads.kim] });
  assert.equal((await api(A, 'POST', `/campaigns/${c.id}/approve`, {})).status, 400, 'confirm required');
  const ph = await api(A, 'POST', `/campaigns/${c.id}/approve`, { confirm: true });
  assert.equal(ph.status, 409);
  assert.equal(ph.data.code, 'NOT_READY');
  await api(A, 'PUT', `/campaigns/${c.id}/steps`, { steps: [{ delayDays: 0, subject: 'Hello', body: 'Hi {{first_name}}, we cut costs by 30%.' }] });
  const flags = await api(A, 'POST', `/campaigns/${c.id}/approve`, { confirm: true });
  assert.equal(flags.status, 409);
  assert.equal(flags.data.code, 'UNVERIFIED_CLAIMS');
  const ok = await api(A, 'POST', `/campaigns/${c.id}/approve`, { confirm: true, acknowledgeFlags: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.campaign.status, 'running');
  await api(A, 'POST', `/campaigns/${c.id}/stop`);

  // A workspace without mail settings cannot start sending.
  const lc = await addLead(C, { name: 'C Lead', email: 'c@lead.io' });
  const cc = (await api(C, 'POST', '/campaigns', { name: 'No mail' })).data.campaign;
  await api(C, 'PUT', `/campaigns/${cc.id}/steps`, { steps: [{ delayDays: 0, subject: 'Hi', body: 'Hi {{first_name}}' }] });
  await api(C, 'POST', `/campaigns/${cc.id}/recipients`, { leadIds: [lc] });
  const nm = await api(C, 'POST', `/campaigns/${cc.id}/approve`, { confirm: true });
  assert.equal(nm.status, 409);
  assert.match(nm.data.error, /Mail is not configured/);

  const approver = await h.addMember(A.workspaceId, 'Member');
  assert.equal((await api(approver, 'POST', `/campaigns/${c.id}/approve`, { confirm: true })).status, 403, 'members cannot start sending');
});

test('the sender sends each step once, in order, from the caller mailbox', async () => {
  const id = await runningCampaign(A, [leads.dana, leads.lee]);
  const calls = [];
  const mock = h.mockFetch([zepto(calls)]);
  try {
    await tick();
    await tick(); // nothing new: next steps are 3 days away
  } finally { mock.restore(); }
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.auth === 'zepto-A'));
  const dana = calls.find(c => c.to === 'dana@fleetco.io');
  assert.equal(dana.subject, 'Routes for FleetCo');
  assert.match(dana.html, /Hi Dana,/);
  assert.match(dana.html, /reply "unsubscribe"/);
  const rs = await recipients(id);
  assert.ok(rs.every(r => r.status === 'active' && r.next_step_order === 2));
  assert.ok(rs.every(r => new Date(r.next_send_at).getTime() > Date.now() + 2.9 * 86400000));
  const sent = await sends(id);
  assert.ok(sent.every(s => s.status === 'sent' && s.email_id));
  const rec = await db().get("SELECT status, sender_email FROM emails WHERE id = ?", [sent[0].email_id]);
  assert.equal(rec.status, 'Sent');

  // Step 2 becomes due: sent once, then the sequence completes.
  await db().run('UPDATE outreach_recipients SET next_send_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE campaign_id = ?', [id]);
  const calls2 = [];
  const mock2 = h.mockFetch([zepto(calls2)]);
  try { await tick(); await tick(); } finally { mock2.restore(); }
  assert.equal(calls2.length, 2);
  assert.ok(calls2.every(c => c.subject === 'Following up'));
  assert.ok((await recipients(id)).every(r => r.status === 'completed'));
  assert.equal((await db().get('SELECT status FROM outreach_campaigns WHERE id = ?', [id])).status, 'completed');
  assert.equal((await sends(id)).length, 4, 'exactly one send per recipient per step');
});

test('replies, unsubscribe replies and unsubscribe links stop the sequence', async () => {
  const id = await runningCampaign(A, [leads.dana, leads.lee, leads.kim]);
  const calls = [];
  let mock = h.mockFetch([zepto(calls)]);
  try { await tick(); } finally { mock.restore(); }
  assert.equal(calls.length, 3);
  const [rDana, rLee, rKim] = await recipients(id);
  await db().run('UPDATE outreach_recipients SET next_send_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE), first_sent_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR) WHERE campaign_id = ?', [id]);
  const inbound = "INSERT INTO emails (workspace_id, sender, sender_email, recipient_email, recipient_name, subject, body, status, smtp_status, received_at) VALUES (?, 'x', ?, 'hello@a-co.io', 'A', ?, ?, 'Unread', 'Received via IMAP', UTC_TIMESTAMP())";
  await db().run(inbound, [A.workspaceId, 'dana@fleetco.io', 'Re: Routes', 'Sounds good, call me Tuesday']);
  await db().run(inbound, [A.workspaceId, 'lee@fleetco.io', 'Re: Routes', 'Please unsubscribe me']);
  const link = await h.api('GET', `/api/v1/outreach/unsubscribe/${rKim.unsubscribe_token}`);
  assert.equal(link.status, 200);
  assert.equal((await h.api('GET', '/api/v1/outreach/unsubscribe/' + 'f'.repeat(40))).status, 404);

  const calls2 = [];
  mock = h.mockFetch([zepto(calls2)]);
  try { await tick(); } finally { mock.restore(); }
  assert.equal(calls2.length, 0, 'no follow-up to anyone who replied or unsubscribed');
  const after = Object.fromEntries((await recipients(id)).map(r => [r.email, r.status]));
  assert.deepEqual(after, { 'dana@fleetco.io': 'replied', 'lee@fleetco.io': 'unsubscribed', 'kim@shipit.io': 'unsubscribed' });
  const sup = await db().all('SELECT email FROM email_suppressions WHERE workspace_id = ? ORDER BY email', [A.workspaceId]);
  assert.deepEqual(sup.map(s => s.email).filter(e => ['lee@fleetco.io', 'kim@shipit.io'].includes(e)).sort(), ['kim@shipit.io', 'lee@fleetco.io']);
  await db().run("DELETE FROM email_suppressions WHERE workspace_id = ?", [A.workspaceId]);
  void rDana; void rLee;
});

test('bounces suppress the address; other failures wait for a confirmed retry', async () => {
  const id = await runningCampaign(A, [leads.dana, leads.lee]);
  const calls = [];
  let mock = h.mockFetch([zepto(calls, body => body.to[0].email_address.address === 'dana@fleetco.io'
    ? h.json(400, { error: { message: '550 5.1.1 mailbox unavailable' } })
    : h.json(500, { error: 'temporary outage' }))]);
  try { await tick(); await tick(); } finally { mock.restore(); }
  assert.equal(calls.length, 2, 'failed sends are not retried automatically');
  const st = Object.fromEntries((await recipients(id)).map(r => [r.email, r.status]));
  assert.deepEqual(st, { 'dana@fleetco.io': 'bounced', 'lee@fleetco.io': 'failed' });
  assert.ok(await db().get("SELECT 1 FROM email_suppressions WHERE workspace_id = ? AND email = 'dana@fleetco.io' AND reason = 'bounced'", [A.workspaceId]));
  assert.equal((await sends(id)).filter(s => s.status === 'sent').length, 0, 'nothing counted as sent');

  const lee = (await recipients(id)).find(r => r.email === 'lee@fleetco.io');
  assert.equal((await api(A, 'POST', `/campaigns/${id}/recipients/${lee.id}/retry`, {})).status, 400, 'retry needs confirmation');
  assert.equal((await api(A, 'POST', `/campaigns/${id}/recipients/${lee.id}/retry`, { confirm: true })).status, 200);
  const calls2 = [];
  mock = h.mockFetch([zepto(calls2)]);
  try { await tick(); } finally { mock.restore(); }
  assert.equal(calls2.length, 1);
  assert.equal((await sends(id)).filter(s => s.status === 'sent').length, 1);
  await db().run("DELETE FROM email_suppressions WHERE workspace_id = ?", [A.workspaceId]);
  await api(A, 'POST', `/campaigns/${id}/stop`);
});

test('sending respects the window, the daily limit, pause and stop', async () => {
  // Outside the window: nothing is sent.
  const today = [7, 1, 2, 3, 4, 5, 6][new Date().getUTCDay()];
  const closed = await runningCampaign(A, [leads.dana], { sendDays: [1, 2, 3, 4, 5, 6, 7].filter(d => d !== today), timezone: 'UTC' });
  const limited = await runningCampaign(A, [leads.lee, leads.kim, leads.sam], { dailyLimit: 1 });
  const calls = [];
  const mock = h.mockFetch([zepto(calls)]);
  try { await tick(); await tick(); } finally { mock.restore(); }
  assert.equal(calls.filter(c => c.to === 'dana@fleetco.io').length, 0, 'closed sending day');
  assert.equal((await sends(limited)).length, 1, 'daily limit of 1');

  assert.equal((await api(A, 'POST', `/campaigns/${limited}/pause`)).status, 200);
  await db().run('UPDATE outreach_sends SET created_at = DATE_SUB(created_at, INTERVAL 2 DAY) WHERE campaign_id = ?', [limited]);
  const calls2 = [];
  const mock2 = h.mockFetch([zepto(calls2)]);
  try { await tick(); } finally { mock2.restore(); }
  assert.equal(calls2.length, 0, 'paused campaigns do not send');
  assert.equal((await api(A, 'POST', `/campaigns/${limited}/stop`)).status, 200);
  assert.ok((await recipients(limited)).every(r => ['stopped', 'active', 'completed'].includes(r.status) && r.status !== 'active'));
  await api(A, 'POST', `/campaigns/${closed}/stop`);
});

test('a send interrupted by a crash is flagged for review, never resent', async () => {
  const id = await runningCampaign(A, [leads.sam]);
  const [r] = await recipients(id);
  const step = await db().get('SELECT id FROM outreach_steps WHERE campaign_id = ? AND step_order = 1', [id]);
  await db().run("INSERT INTO outreach_sends (workspace_id, campaign_id, recipient_id, step_id, step_order, status, created_at) VALUES (?, ?, ?, ?, 1, 'sending', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR))", [A.workspaceId, id, r.id, step.id]);
  const calls = [];
  const mock = h.mockFetch([zepto(calls)]);
  try { await tick(); await tick(); } finally { mock.restore(); }
  assert.equal(calls.length, 0);
  assert.equal((await recipients(id))[0].status, 'needs_review');
  assert.equal((await sends(id))[0].status, 'needs_review');
  await api(A, 'POST', `/campaigns/${id}/stop`);
});

test('campaigns are private to their workspace', async () => {
  const c = (await api(A, 'POST', '/campaigns', { name: 'Private' })).data.campaign;
  for (const [m, p, b] of [['GET', `/campaigns/${c.id}`], ['PATCH', `/campaigns/${c.id}`, { name: 'x' }], ['POST', `/campaigns/${c.id}/approve`, { confirm: true }],
    ['POST', `/campaigns/${c.id}/stop`], ['GET', `/campaigns/${c.id}/recipients`], ['DELETE', `/campaigns/${c.id}`]]) {
    assert.equal((await api(B, m, p, b)).status, 404, `${m} ${p}`);
  }
  assert.ok(!(await api(B, 'GET', '/campaigns')).data.campaigns.some(x => x.id === c.id));
  assert.equal((await api(A, 'POST', '/campaigns', { name: 'Bad product', productId: 999999999 })).status, 404);
  assert.equal((await h.api('GET', '/api/v1/outreach/campaigns')).status, 401);
});
