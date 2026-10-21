// Must be set before the app loads: a small per-route AI limit so the rate-limit test is quick.
process.env.AI_ROUTE_RATE_MAX = '5';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFile } = require('child_process');
const h = require('./helpers');

// Regression tests for the AI Campaigns audit findings. Email, IMAP, AI and Meta are mocked
// (unmatched requests fail loudly); the inbox sync is stubbed so no IMAP connection is opened.
const emailService = require('../services/emailService');
emailService.syncIncomingEmails = async () => ({ success: true });

let A; // mail configured, reply tracking on
const db = () => h.db();
const tick = () => require('../modules/outreach/outreachSender').processOutreach('audit-worker', { now: new Date(), maxPerTick: 200 });
const aiDown = { match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) };
const groq = content => h.groqRoute(() => JSON.stringify(content));
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const zepto = (calls, respond) => ({
  match: u => u.startsWith('https://api.zeptomail.com/'),
  respond: (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.to[0].email_address.address);
    return respond ? respond(body) : h.json(200, { request_id: `req-${calls.length}` });
  }
});

async function workspaceWithMail(name) {
  const ws = await h.createWorkspace({ name });
  const r = await h.api('POST', '/api/v1/mail/config', { token: ws.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: `zepto-${ws.workspaceId}`, sender_email: `hello@ws${ws.workspaceId}.io`, imap_host: 'imap.mailhost.io', imap_user: `in@ws${ws.workspaceId}.io`, imap_pass: 'x' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await db().run('UPDATE mail_configurations SET last_synced_at = UTC_TIMESTAMP() WHERE workspace_id = ?', [ws.workspaceId]);
  return ws;
}

async function lead(ws, name, email, status) {
  const mock = h.mockFetch([aiDown]);
  try {
    const r = await h.api('POST', '/api/v1/leads', { token: ws.token, body: { name, email, ...(status ? { status } : {}) } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.lead.id;
  } finally { mock.restore(); }
}

async function sequence(ws, leadIds, steps = [{ delayDays: 0, subject: 'Only email', body: 'Hi {{first_name}}' }]) {
  const c = (await h.api('POST', '/api/v1/outreach/campaigns', { token: ws.token, body: { name: `Seq ${Date.now()}`, sendDays: [1, 2, 3, 4, 5, 6, 7], sendStartHour: 0, sendEndHour: 24, dailyLimit: 500 } })).data.campaign;
  await h.api('PUT', `/api/v1/outreach/campaigns/${c.id}/steps`, { token: ws.token, body: { steps } });
  assert.equal((await h.api('POST', `/api/v1/outreach/campaigns/${c.id}/recipients`, { token: ws.token, body: { leadIds } })).status, 200);
  const ok = await h.api('POST', `/api/v1/outreach/campaigns/${c.id}/approve`, { token: ws.token, body: { confirm: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  return c.id;
}

async function sendTick(respond) {
  const calls = [];
  const mock = h.mockFetch([zepto(calls, respond)]);
  try { await tick(); } finally { mock.restore(); }
  return calls;
}

const inbound = (ws, from, subject, body, receivedSql = 'DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 SECOND)') => db().run(
  `INSERT INTO emails (workspace_id, sender, sender_email, recipient_email, recipient_name, subject, body, status, smtp_status, received_at)
   VALUES (?, 'Lead', ?, 'hello@ws.io', 'Us', ?, ?, 'Unread', 'Received via IMAP', ${receivedSql})`, [ws.workspaceId, from, subject, body]);
const events = async (ws, type, leadId) => Number((await db().get('SELECT COUNT(*) AS n FROM automation_events WHERE workspace_id = ? AND event_type = ? AND subject_id = ?', [ws.workspaceId, type, leadId])).n);
const recipient = id => db().get('SELECT * FROM outreach_recipients WHERE campaign_id = ?', [id]);
const overview = ws => h.api('GET', '/api/v1/campaign-analytics/overview', { token: ws.token });

test.before(async () => {
  await h.prepareDatabase();
  await db().run("UPDATE outreach_campaigns SET status = 'stopped' WHERE status = 'running'");
  A = await workspaceWithMail('Audit A');
});
test.after(() => h.shutdown());

// ---------------------------------------------------------------- E1 + E2: reply detection
test('a reply between steps is recorded on the next tick, once, without waiting for the next email', async () => {
  const l = await lead(A, 'Mid Replier', 'mid@fleet.io');
  const id = await sequence(A, [l], [{ delayDays: 0, subject: 'One', body: 'Hi' }, { delayDays: 5, subject: 'Two', body: 'Hi again' }]);
  assert.deepEqual(await sendTick(), ['mid@fleet.io']);
  await inbound(A, 'mid@fleet.io', 'Re: One', 'Interested, call me');
  assert.deepEqual(await sendTick(), [], 'nothing is sent');
  const r = await recipient(id);
  assert.equal(r.status, 'replied');
  assert.equal(r.next_send_at, null, 'email 2 is cancelled');
  assert.equal(await events(A, 'email.replied', l), 1);
  // Repeated polling records nothing new.
  await sendTick();
  await sendTick();
  assert.equal(await events(A, 'email.replied', l), 1, 'one event per reply');
  assert.equal((await recipient(id)).status, 'replied');
});

test('a reply to the final email is detected and counted in analytics', async () => {
  const l = await lead(A, 'Last Replier', 'last@fleet.io');
  const id = await sequence(A, [l]);
  await sendTick();
  assert.equal((await recipient(id)).status, 'completed');
  assert.equal((await db().get('SELECT status FROM outreach_campaigns WHERE id = ?', [id])).status, 'completed');
  await inbound(A, 'last@fleet.io', 'Re: Only email', 'Yes please');
  await sendTick();
  assert.equal((await recipient(id)).status, 'replied');
  assert.equal(await events(A, 'email.replied', l), 1);
  const row = (await overview(A)).data.comparisons.email.find(c => c.id === id);
  assert.equal(row.replies.value, 1);
  assert.equal(row.replies.status, 'available');
});

test('an "unsubscribe" reply to the final email unsubscribes and suppresses the address', async () => {
  const l = await lead(A, 'Late Unsub', 'lateunsub@fleet.io');
  const id = await sequence(A, [l]);
  await sendTick();
  await inbound(A, 'lateunsub@fleet.io', 'Re: Only email', 'Please unsubscribe me');
  await sendTick();
  assert.equal((await recipient(id)).status, 'unsubscribed');
  assert.ok(await db().get("SELECT 1 FROM email_suppressions WHERE workspace_id = ? AND email = 'lateunsub@fleet.io' AND reason = 'unsubscribed'", [A.workspaceId]));
  assert.equal(await events(A, 'email.unsubscribed', l), 1);
});

test('replies after the monitoring window are not attributed to a completed sequence', async () => {
  const { REPLY_MONITOR_DAYS } = require('../modules/outreach/outreachSender');
  const l = await lead(A, 'Old Contact', 'old@fleet.io');
  const id = await sequence(A, [l]);
  await sendTick();
  const ago = REPLY_MONITOR_DAYS + 6;
  await db().run(`UPDATE outreach_recipients SET first_sent_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${ago} DAY), last_sent_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${ago} DAY) WHERE campaign_id = ?`, [id]);
  await inbound(A, 'old@fleet.io', 'Hello again', 'New enquiry');
  await sendTick();
  assert.equal((await recipient(id)).status, 'completed');
  assert.equal(await events(A, 'email.replied', l), 0);
});

// ---------------------------------------------------------------- E3: bounces vs failed sends
test('bounces are not reported as failed sends; transport failures are', async () => {
  const ws = await workspaceWithMail('Bounces');
  const bounced = await lead(ws, 'Bad Address', 'nobody@fleet.io');
  const outage = await lead(ws, 'Good Address', 'someone@fleet.io');
  const respond = b => (b.to[0].email_address.address === 'nobody@fleet.io'
    ? h.json(400, { error: { message: '550 5.1.1 mailbox unavailable' } })
    : h.json(500, { error: 'temporary outage' }));
  const onlyBounce = await sequence(ws, [bounced]);
  await sendTick(respond);
  let ov = (await overview(ws)).data;
  assert.ok(!ov.insights.find(i => i.id === `failed_${onlyBounce}`), 'a bounce alone never suggests checking Mail Settings');
  assert.equal(ov.comparisons.email.find(c => c.id === onlyBounce).emailsFailed.value, 0);

  await db().run('DELETE FROM email_suppressions WHERE workspace_id = ?', [ws.workspaceId]);
  const mixed = await sequence(ws, [bounced, outage]);
  await sendTick(respond);
  ov = (await overview(ws)).data;
  const failed = ov.insights.find(i => i.id === `failed_${mixed}`);
  assert.ok(failed, 'a transport failure is reported');
  assert.equal(failed.evidence[0].value, 1, 'only the transport failure counts');
  assert.match(failed.detail, /other than a bounced address/);
  const row = ov.comparisons.email.find(c => c.id === mixed);
  assert.equal(row.emailsFailed.value, 1);
  assert.equal(row.bounceRate.numerator, 1);
});

// ---------------------------------------------------------------- T1: atomic A/B test creation
test('an invalid variant leaves no test or variant behind; a valid one saves both', async () => {
  const c = (await h.api('POST', '/api/v1/outreach/campaigns', { token: A.token, body: { name: 'AB atomic' } })).data.campaign;
  await h.api('PUT', `/api/v1/outreach/campaigns/${c.id}/steps`, { token: A.token, body: { steps: [{ delayDays: 0, subject: 'S', body: 'B' }] } });
  const count = async () => [
    Number((await db().get('SELECT COUNT(*) AS n FROM ab_tests WHERE outreach_campaign_id = ?', [c.id])).n),
    Number((await db().get('SELECT COUNT(*) AS n FROM outreach_step_variants WHERE campaign_id = ?', [c.id])).n)
  ];
  const bad = await h.api('POST', '/api/v1/ab-tests/email', { token: A.token, body: { name: 'T', emailCampaignId: c.id, stepOrder: 1, metric: 'reply_rate', variant: { subject: 'x', body: 'Hi {{last_name}}' } } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await count(), [0, 0]);
  const ok = await h.api('POST', '/api/v1/ab-tests/email', { token: A.token, body: { name: 'T', emailCampaignId: c.id, stepOrder: 1, metric: 'reply_rate', variant: { subject: 'S2', body: 'Hi {{first_name}}' } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(await count(), [1, 1]);
});

// ---------------------------------------------------------------- Unsubscribe safety
test('unsubscribe: GET previews only; POST unsubscribes once; invalid tokens are rejected', async () => {
  const l = await lead(A, 'Unsub Link', 'unsublink@fleet.io');
  const id = await sequence(A, [l], [{ delayDays: 0, subject: 'One', body: 'Hi' }, { delayDays: 5, subject: 'Two', body: 'Hi' }]);
  await sendTick();
  const { unsubscribe_token: tok } = await recipient(id);
  const url = `/api/v1/outreach/unsubscribe/${tok}`;

  const preview = await h.api('GET', url);
  assert.equal(preview.status, 200);
  assert.match(preview.data, /<form method="post"/);
  assert.equal((await recipient(id)).status, 'active', 'a link scanner opening the URL changes nothing');
  assert.equal(await events(A, 'email.unsubscribed', l), 0);

  const first = await h.api('POST', url);
  assert.equal(first.status, 200);
  assert.match(first.data, /You are unsubscribed/);
  assert.equal((await recipient(id)).status, 'unsubscribed');
  const again = await h.api('POST', url);
  assert.equal(again.status, 200, 'repeating the confirmation is harmless');
  assert.equal(await events(A, 'email.unsubscribed', l), 1);
  assert.equal(Number((await db().get("SELECT COUNT(*) AS n FROM email_suppressions WHERE workspace_id = ? AND email = 'unsublink@fleet.io'", [A.workspaceId])).n), 1);
  assert.match((await h.api('GET', url)).data, /You are unsubscribed/);

  // Malformed tokens never reach the public route (401); well-formed unknown ones are 404.
  for (const [m, t, status] of [['GET', 'not-a-token', 401], ['POST', 'not-a-token', 401], ['GET', 'f'.repeat(40), 404], ['POST', 'f'.repeat(40), 404]]) {
    assert.equal((await h.api(m, `/api/v1/outreach/unsubscribe/${t}`)).status, status, `${m} ${t}`);
  }
});

// ---------------------------------------------------------------- A1: demo metrics are never live
async function programWithPost(ws, source) {
  const p = (await h.api('POST', '/api/v1/command/programs', { token: ws.token, body: { name: 'Launch', channels: ['linkedin'] } })).data.program;
  const sc = (await h.api('POST', '/api/v1/social/campaigns', { token: ws.token, body: { name: 'Posts', platforms: ['linkedin'] } })).data.campaign.id;
  await db().run('UPDATE campaign_programs SET social_campaign_id = ?, brief_json = ? WHERE id = ?', [sc, JSON.stringify({ kpis: [{ metric: 'engagements', name: 'Engagements', target: null }, { metric: 'impressions', name: 'Impressions', target: null }] }), p.id]);
  const acc = await h.createAccount(ws.workspaceId, { accountType: 'linkedin_organization', providerKey: 'linkedin', scopes: [] });
  const ext = `post-${source}-${ws.workspaceId}`;
  const post = (await db().run("INSERT INTO content_items (workspace_id, campaign_id, content_type, title, caption_text, platform_key, social_account_id, status, published_at, external_post_id, version, created_at) VALUES (?, ?, 'post', 'P', 'c', 'linkedin', ?, 'published', UTC_TIMESTAMP(), ?, 1, UTC_TIMESTAMP())", [ws.workspaceId, sc, acc.id, ext])).lastID;
  for (const [k, v] of [['impressions', 9000], ['likes', 700]]) {
    await db().run("INSERT INTO social_metric_snapshots (workspace_id, social_account_id, content_item_id, external_object_id, object_type, metric_key, metric_value, availability, source, collected_at) VALUES (?, ?, ?, ?, 'post', ?, ?, 'available', ?, UTC_TIMESTAMP())", [ws.workspaceId, acc.id, post, ext, k, v, source]);
  }
  await new Promise(r => setTimeout(r, 1100));
  return p.id;
}

test('Command Center and Analytics never present demo-seeded social metrics as live results', async () => {
  const demo = await h.createWorkspace({ name: 'Seeded metrics' });
  const live = await h.createWorkspace({ name: 'Live metrics' });
  const dp = await programWithPost(demo, 'demo_seed');
  const lp = await programWithPost(live, 'linkedin_api');

  const d = (await h.api('GET', `/api/v1/command/programs/${dp}/overview`, { token: demo.token })).data;
  const dk = Object.fromEntries(d.kpis.map(k => [k.metric, k]));
  assert.equal(dk.engagements.actual, null, 'not an actual result');
  assert.equal(dk.impressions.actual, null);
  assert.deepEqual([dk.engagements.nonLive.value, dk.impressions.nonLive.value], [700, 9000]);
  assert.match(dk.engagements.nonLive.note, /Not live platform data/);
  assert.equal(d.metrics.engagements, null);

  const l = (await h.api('GET', `/api/v1/command/programs/${lp}/overview`, { token: live.token })).data;
  const lk = Object.fromEntries(l.kpis.map(k => [k.metric, k]));
  assert.deepEqual([lk.engagements.actual, lk.impressions.actual], [700, 9000]);
  assert.equal(lk.engagements.nonLive, undefined);

  const da = (await overview(demo)).data.channels.social;
  assert.equal(da.impressions.status, 'non_live');
  assert.equal(da.engagements.status, 'non_live');
  assert.equal(da.engagementRate.status, 'non_live');
  const la = (await overview(live)).data.channels.social;
  assert.equal(la.impressions.status, 'available');
  assert.equal(la.engagements.status, 'available');
});

// ---------------------------------------------------------------- A2 + A3: conversions
test('each lead converts once: created as Won, status flips, duplicate events and several sequences', async () => {
  const ws = await workspaceWithMail('Conversions');
  const conv = async () => (await overview(ws)).data;
  assert.equal((await conv()).channels.crm.conversions.status, 'unavailable', 'no history yet');

  await lead(ws, 'Born Won', 'bornwon@fleet.io', 'Won');
  assert.equal((await conv()).channels.crm.conversions.value, 1, 'a lead created as Won is a conversion');

  const flip = await lead(ws, 'Flip Flop', 'flip@fleet.io');
  for (const s of ['Won', 'Contacted', 'Won']) assert.equal((await h.api('PATCH', `/api/v1/leads/${flip}`, { token: ws.token, body: { status: s } })).status, 200);
  await db().run("INSERT INTO automation_events (workspace_id, event_type, subject_type, subject_id, payload_json, idempotency_key, created_at) VALUES (?, 'lead.status_changed', 'lead', ?, ?, ?, UTC_TIMESTAMP())",
    [ws.workspaceId, flip, JSON.stringify({ from: 'New', to: 'Won' }), `dup-${flip}`]);
  assert.equal((await conv()).channels.crm.conversions.value, 2, 'Won -> Contacted -> Won and a duplicate event count once');

  const multi = await lead(ws, 'Two Sequences', 'multi@fleet.io');
  const s1 = await sequence(ws, [multi]);
  await sendTick();
  await db().run('UPDATE outreach_sends SET sent_at = DATE_SUB(sent_at, INTERVAL 2 DAY) WHERE campaign_id = ?', [s1]);
  const s2 = await sequence(ws, [multi]);
  await sendTick();
  assert.equal((await h.api('PATCH', `/api/v1/leads/${multi}`, { token: ws.token, body: { status: 'Won' } })).status, 200);
  const ov = await conv();
  assert.equal(ov.channels.crm.conversions.value, 3);
  assert.equal(ov.attribution.email[s2]?.value, 1, 'credited to the last sequence that emailed the lead');
  assert.equal(ov.attribution.email[s1], undefined, 'and not also to the earlier one');
  assert.equal(ov.attribution.unattributed.value, 2);
});

// ---------------------------------------------------------------- A4: evidence-based recommendations
test('recommendation figures must come from the cited evidence (formatting variations allowed)', () => {
  const { unsupportedClaim } = require('../modules/campaignAnalytics/campaignAnalyticsService');
  const cited = { 'email.replyRate': { value: 0.1181, numerator: 15, denominator: 127, status: 'available' }, 'email_campaign:7': { name: 'Q4 Van Sales Push', emailsSent: { value: 1250 } } };
  const check = action => unsupportedClaim({ title: 'Next step', action }, cited);
  assert.equal(check('Reply rate is 11.8% (15 of 127 replied); reuse that opener.'), null);
  assert.equal(check('About 12% replied.'), null, 'rounded percentage');
  assert.equal(check('Sequence 7 sent 1,250 emails.'), null, 'thousands separator; id from the evidence key');
  assert.equal(check('Q4 Van Sales Push had a 0.118 reply ratio.'), null);
  assert.match(check('Reply rate is 35%.'), /35%/);
  assert.match(check('Spend $12,000 next month.'), /12,000/);
  assert.match(check('This will increase replies.'), /promises an outcome/);
  assert.match(check('Expect to double conversions.'), /promises an outcome/);
});

test('recommendations with invented figures or no evidence are dropped; none left gives a clear fallback', async () => {
  const ws = await h.createWorkspace({ name: 'Recs' });
  await lead(ws, 'Some Lead', 'some@fleet.io');
  const call = async recs => {
    const mock = h.mockFetch([groq({ recommendations: recs })]);
    try { return await h.api('POST', '/api/v1/campaign-analytics/recommendations', { token: ws.token, body: {} }); } finally { mock.restore(); }
  };
  const mixed = await call([
    { title: 'Follow up new leads', action: 'Add the new lead to an email sequence.', evidence: ['crm.leadsCreated'] },
    { title: 'Scale up', action: 'This will lift replies by 35% and add $12,000 revenue.', evidence: ['crm.leadsCreated'] },
    { title: 'Benchmarks', action: 'Industry reply rate is 8%.', evidence: ['crm.leadsCreated'] },
    { title: 'Nothing cited', action: 'Post more often.', evidence: ['made.up'] }
  ]);
  assert.equal(mixed.status, 200, JSON.stringify(mixed.data));
  assert.deepEqual(mixed.data.recommendations.map(r => r.title), ['Follow up new leads']);
  assert.equal(mixed.data.dropped, 3);
  assert.equal(mixed.data.status, undefined);

  const none = await call([{ title: 'Grow', action: 'Expect 3x more leads.', evidence: ['crm.leadsCreated'] }]);
  assert.equal(none.status, 200);
  assert.deepEqual(none.data.recommendations, []);
  assert.equal(none.data.status, 'rejected');
  assert.match(none.data.note, /not backed by your data/);
});

// ---------------------------------------------------------------- AI rate limiting
test('AI endpoints are rate limited per workspace member, with a clear 429', async () => {
  const ws = await h.createWorkspace({ name: 'Rate' });
  for (let i = 0; i < 5; i++) assert.equal((await h.api('POST', '/api/v1/campaign-analytics/recommendations', { token: ws.token, body: {} })).status, 200);
  const limited = await h.api('POST', '/api/v1/campaign-analytics/recommendations', { token: ws.token, body: {} });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.code, 'RATE_LIMITED');
  assert.match(limited.data.error, /Too many AI requests/);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const colleague = await h.addMember(ws.workspaceId, 'Workspace Owner');
  assert.equal((await h.api('POST', '/api/v1/campaign-analytics/recommendations', { token: colleague.token, body: {} })).status, 200, 'counted per member');
  const otherRoute = await h.api('POST', '/api/v1/command/programs/999999/brief', { token: ws.token });
  assert.equal(otherRoute.status, 404, 'each route has its own limit');
});

// ---------------------------------------------------------------- Budget & ROI
async function budgetFor(ws, { amount = 1000, start = day(-5), end = day(25) } = {}) {
  const p = (await h.api('POST', '/api/v1/command/programs', { token: ws.token, body: { name: `Budget ${Date.now()}`, channels: ['email'] } })).data.program;
  const r = await h.api('POST', '/api/v1/budgets', { token: ws.token, body: { programId: p.id, amount, currency: 'USD', periodStart: start, periodEnd: end } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { programId: p.id, id: r.data.budget.id };
}
const spend = (ws, id, amount, date = day(0)) => h.api('POST', `/api/v1/budgets/${id}/spend`, { token: ws.token, body: { date, amount, currency: 'USD', description: 'Invoice', evidenceRef: 'INV-1' } });
const revenue = (ws, id, amount) => h.api('POST', `/api/v1/budgets/${id}/revenue`, { token: ws.token, body: { date: day(0), amount, currency: 'USD', description: 'Deal won' } });
const summary = async (ws, id) => (await h.api('GET', `/api/v1/budgets/${id}`, { token: ws.token })).data.budget.summary;

test('budget currency cannot change once spend or revenue exists', async () => {
  const withSpend = await budgetFor(A);
  await spend(A, withSpend.id, 100);
  const a = await h.api('PATCH', `/api/v1/budgets/${withSpend.id}`, { token: A.token, body: { currency: 'EUR' } });
  assert.deepEqual([a.status, a.data.code], [409, 'HAS_SPEND']);

  const withRevenue = await budgetFor(A);
  await revenue(A, withRevenue.id, 500);
  const b = await h.api('PATCH', `/api/v1/budgets/${withRevenue.id}`, { token: A.token, body: { currency: 'EUR' } });
  assert.deepEqual([b.status, b.data.code], [409, 'HAS_REVENUE']);
  assert.match(b.data.error, /spend or revenue/);

  const empty = await budgetFor(A);
  assert.equal((await h.api('PATCH', `/api/v1/budgets/${empty.id}`, { token: A.token, body: { currency: 'EUR' } })).status, 200);
});

test('a campaign with a budget cannot be deleted; its financial history is kept', async () => {
  const b = await budgetFor(A);
  await spend(A, b.id, 250);
  await revenue(A, b.id, 400);
  const del = await h.api('DELETE', `/api/v1/command/programs/${b.programId}`, { token: A.token });
  assert.deepEqual([del.status, del.data.code], [409, 'HAS_BUDGET']);
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM budget_spend_entries WHERE budget_id = ?', [b.id])).n), 1);
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM budget_revenue_entries WHERE budget_id = ?', [b.id])).n), 1);
  // The database refuses too (migration 011: ON DELETE RESTRICT).
  await assert.rejects(db().run('DELETE FROM campaign_programs WHERE id = ?', [b.programId]), /foreign key/i);

  const plain = (await h.api('POST', '/api/v1/command/programs', { token: A.token, body: { name: 'No money', channels: ['email'] } })).data.program;
  assert.equal((await h.api('DELETE', `/api/v1/command/programs/${plain.id}`, { token: A.token })).status, 200);
});

test('linked email sequences cannot be deleted and links cannot point at missing records', async () => {
  const p = (await h.api('POST', '/api/v1/command/programs', { token: A.token, body: { name: 'Linked', channels: ['email'] } })).data.program;
  const seq = (await h.api('POST', '/api/v1/outreach/campaigns', { token: A.token, body: { name: 'Linked seq' } })).data.campaign;
  await db().run('UPDATE campaign_programs SET outreach_campaign_id = ? WHERE id = ?', [seq.id, p.id]);
  const del = await h.api('DELETE', `/api/v1/outreach/campaigns/${seq.id}`, { token: A.token });
  assert.deepEqual([del.status, del.data.code], [409, 'LINKED_TO_CAMPAIGN']);
  await assert.rejects(db().run('UPDATE campaign_programs SET outreach_campaign_id = 99999999 WHERE id = ?', [p.id]), /foreign key/i);
  await assert.rejects(db().run('UPDATE campaign_programs SET social_campaign_id = 99999999 WHERE id = ?', [p.id]), /foreign key/i);
});

test('only spend inside the budget period counts; the rest is reported separately', async () => {
  const b = await budgetFor(A);
  await spend(A, b.id, 600, day(-40));
  await spend(A, b.id, 100);
  await revenue(A, b.id, 300);
  const s = await summary(A, b.id);
  assert.equal(s.actualSpend.value, 100);
  assert.deepEqual([s.actualSpend.outOfPeriod.value, s.actualSpend.outOfPeriod.entries], [600, 1]);
  assert.equal(s.percentUsed.value, 0.1);
  assert.equal(s.remaining.value, 900);
  assert.equal(s.roi.value, 2, '(300 - 100) / 100');
  assert.notEqual(s.pacing.status, 'no_data');

  const onlyOld = await budgetFor(A);
  await spend(A, onlyOld.id, 50, day(-30));
  const o = await summary(A, onlyOld.id);
  assert.equal(o.actualSpend.status, 'none_recorded');
  assert.equal(o.pacing.status, 'no_data');
  assert.match(o.pacing.reason, /inside the budget period/);
});

test('zero budget: spend is over budget without a percentage; no spend is explicit', async () => {
  const b = await budgetFor(A, { amount: 0 });
  let s = await summary(A, b.id);
  assert.deepEqual([s.pacing.status, s.percentUsed.value, s.percentUsed.status, s.remaining.value], ['no_data', null, 'none_recorded', 0]);
  assert.match(s.percentUsed.reason, /budget is 0/);

  await spend(A, b.id, 50);
  s = await summary(A, b.id);
  assert.equal(s.pacing.status, 'over');
  assert.equal(s.percentUsed.status, 'over_budget');
  assert.equal(s.percentUsed.value, null, 'no division by zero');
  assert.equal(s.remaining.value, -50);
  const alerts = (await h.api('GET', `/api/v1/budgets/${b.id}`, { token: A.token })).data.budget.alerts;
  assert.ok(alerts.find(a => a.key === 'threshold_100' && a.severity === 'critical'));
});

test('Meta spend sync rejects missing or different currencies; matching currency imports', async () => {
  const b = await budgetFor(A);
  const acc = await h.createAccount(A.workspaceId, { scopes: ['ads_read'], secret: { access_token: 'p', user_access_token: 'u', meta_user_id: 'm' } });
  const src = (await h.api('POST', `/api/v1/budgets/${b.id}/sources`, { token: A.token, body: { provider: 'meta_ads', socialAccountId: acc.id, adAccountId: '987654321' } })).data.budget.summary.sources[0];
  const sync = async currency => {
    const mock = h.mockFetch([{ match: u => u.startsWith('https://graph.facebook.com/'), respond: () => h.json(200, { data: [{ date_start: day(0), spend: '77.00', ...(currency ? { account_currency: currency } : {}) }] }) }]);
    try { return await h.api('POST', `/api/v1/budgets/${b.id}/sources/${src.id}/sync`, { token: A.token }); } finally { mock.restore(); }
  };
  const entries = async () => Number((await db().get('SELECT COUNT(*) AS n FROM budget_spend_entries WHERE budget_id = ?', [b.id])).n);

  const missing = await sync(null);
  assert.deepEqual([missing.status, missing.data.code], [409, 'CURRENCY_UNKNOWN']);
  assert.equal(await entries(), 0, 'nothing imported');
  assert.ok(await db().get("SELECT 1 FROM audit_logs WHERE workspace_id = ? AND action = 'budget.spend_sync_rejected' AND resource_id = ?", [A.workspaceId, String(b.id)]));
  assert.match((await db().get('SELECT last_error FROM budget_spend_sources WHERE id = ?', [src.id])).last_error, /did not report the ad account currency/);

  const other = await sync('EUR');
  assert.deepEqual([other.status, other.data.code], [409, 'CURRENCY_MISMATCH']);
  assert.equal(await entries(), 0);

  const ok = await sync('USD');
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(await entries(), 1);
  assert.equal((await summary(A, b.id)).actualSpend.value, 77);
});

// ---------------------------------------------------------------- D1 + D2: demo lifecycle
const BACKEND = path.resolve(__dirname, '..');
const script = (name, args = []) => new Promise(resolve => {
  execFile('node', [path.join(BACKEND, 'scripts', name), ...args], { cwd: BACKEND, env: process.env }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: `${stdout}\n${stderr}` }));
});

test('demo seed: rows are marked internally, the mailbox is not live, removal is complete and safe', { timeout: 120000 }, async () => {
  const otherBefore = await db().get("SELECT COUNT(*) AS leads, (SELECT COUNT(*) FROM emails WHERE workspace_id <> COALESCE((SELECT id FROM workspaces WHERE slug = 'tradesage-demo-workspace'), -1)) AS emails FROM leads WHERE workspace_id <> COALESCE((SELECT id FROM workspaces WHERE slug = 'tradesage-demo-workspace'), -1)");
  let r = await script('seedDemoWorkspace.js', ['--reset']);
  assert.equal(r.code, 0, r.out);
  const W = (await db().get("SELECT id FROM workspaces WHERE slug = 'tradesage-demo-workspace'")).id;
  if (!(await db().get('SELECT id FROM digital_products WHERE workspace_id = ?', [W]))) {
    await db().run("INSERT INTO digital_products (workspace_id, name, status, created_at) VALUES (?, 'Route Planner', 'Active', UTC_TIMESTAMP())", [W]);
  }
  r = await script('seedDemoCampaigns.js');
  assert.equal(r.code, 0, r.out);
  const marked = Object.fromEntries((await db().all('SELECT seeded_by, COUNT(*) AS n FROM demo_seed_records WHERE workspace_id = ? GROUP BY seeded_by', [W])).map(x => [x.seeded_by, Number(x.n)]));
  assert.ok(marked.seedDemoWorkspace > 0 && marked.seedDemoCampaigns > 0, JSON.stringify(marked));
  const { isSeededRecord } = require('../lib/demoSeed');
  const seq = await db().get('SELECT id FROM outreach_campaigns WHERE workspace_id = ? LIMIT 1', [W]);
  assert.equal(await isSeededRecord('outreach_campaigns', seq.id), true);

  const mail = await db().get('SELECT last_synced_at FROM mail_configurations WHERE workspace_id = ?', [W]);
  assert.equal(mail.last_synced_at, null, 'the demo inbox is never marked as synced');
  const { capabilitiesForRole } = require('../lib/permissions');
  const ctx = { auth: { workspaceId: W, userId: null, capabilities: capabilitiesForRole('Workspace Owner') } };
  const ov = await require('../modules/campaignAnalytics/campaignAnalyticsService').overview(ctx, {});
  assert.equal(ov.dataQuality.replyTracking.live, false);
  assert.equal(ov.channels.email.replyRate.status, 'non_live');
  const commandService = require('../modules/command/commandService');
  const built = (await commandService.listPrograms(ctx)).find(p => p.status === 'built');
  const cc = await commandService.overview(ctx, built.id);
  assert.equal(cc.metrics.reply_rate, null, 'Command Center does not show demo replies as an actual result');
  assert.equal(typeof cc.nonLiveMetrics.reply_rate, 'number');

  // A second campaign seed refreshes instead of duplicating.
  const before = Number((await db().get('SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ?', [W])).n);
  assert.equal((await script('seedDemoCampaigns.js')).code, 0);
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ?', [W])).n), before);

  // Records people create while using the demo workspace.
  const user = await db().get('SELECT user_id FROM workspace_members WHERE workspace_id = ?', [W]);
  await db().run("INSERT INTO email_drafts (workspace_id, recipient_name, recipient_email, subject) VALUES (?, 'X', 'x@example.com', 'Draft')", [W]);
  await db().run("INSERT INTO emails (workspace_id, sender, sender_email, recipient_email, recipient_name, subject, body, status) VALUES (?, 'a', 'a@example.com', 'b@example.com', 'b', 's', 'b', 'Sent')", [W]);
  const conv = await db().run("INSERT INTO conversations (workspace_id, user_id, title) VALUES (?, ?, 'Chat')", [W, user.user_id]);
  await db().run("INSERT INTO conversation_messages (workspace_id, conversation_id, role, content_text) VALUES (?, ?, 'user', 'hi')", [W, conv.lastID]);
  const task = await db().run("INSERT INTO tasks (workspace_id, title) VALUES (?, 'Task')", [W]);
  await db().run("INSERT INTO task_steps (task_id, step_index, title) VALUES (?, 0, 'Step')", [task.lastID]);

  // Possible real provider resources block removal; nothing is deleted.
  await db().run("INSERT INTO phone_numbers (workspace_id, phone_number) VALUES (?, '+15550100')", [W]);
  r = await script('seedDemoWorkspace.js', ['--remove']);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /phone_numbers \(1\).*real provider or billing resources.*Nothing was deleted/s);
  assert.ok(await db().get('SELECT id FROM workspaces WHERE id = ?', [W]));
  assert.ok(await db().get('SELECT id FROM email_drafts WHERE workspace_id = ?', [W]));
  await db().run('DELETE FROM phone_numbers WHERE workspace_id = ?', [W]);

  r = await script('seedDemoWorkspace.js', ['--remove']);
  assert.equal(r.code, 0, r.out);
  const owned = (await db().all("SELECT TABLE_NAME AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'workspace_id'")).map(x => x.t);
  const left = [];
  for (const t of owned) {
    const n = Number((await db().get(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE workspace_id = ?`, [W])).n);
    if (n) left.push(`${t}:${n}`);
  }
  assert.deepEqual(left, [], 'no workspace-owned rows left');
  assert.equal(await db().get('SELECT id FROM task_steps WHERE task_id = ?', [task.lastID]), null);
  assert.equal(await db().get("SELECT id FROM users WHERE email = 'demo@tradesage.ai'"), null);
  assert.equal(Number((await db().get("SELECT COUNT(*) AS n FROM demo_seed_records WHERE (table_name = 'workspaces' AND record_id = ?) OR workspace_id = ?", [W, W])).n), 0);
  const otherAfter = await db().get('SELECT COUNT(*) AS leads, (SELECT COUNT(*) FROM emails WHERE workspace_id <> ?) AS emails FROM leads WHERE workspace_id <> ?', [W, W]);
  assert.deepEqual([Number(otherAfter.leads), Number(otherAfter.emails)], [Number(otherBefore.leads), Number(otherBefore.emails)], 'other workspaces unchanged');
});
