const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// AI Campaigns analytics. Data is inserted with known counts so every number is checkable.
let A;
let B;
let C;
let seqX;
let seqY;
let social;

const db = () => h.db();
const overview = (ws, q = '') => h.api('GET', `/api/v1/campaign-analytics/overview${q}`, { token: ws.token });
const noAi = () => h.mockFetch([]); // any AI call would fail loudly ("Unmocked request")

async function sequenceWithResults(ws, name, { emailed, replied, bounced = 0, unsub = 0, failed = 0, leads = [] }) {
  const c = await db().run("INSERT INTO outreach_campaigns (workspace_id, name, status, created_at) VALUES (?, ?, 'running', UTC_TIMESTAMP())", [ws.workspaceId, name]);
  const step = await db().run("INSERT INTO outreach_steps (workspace_id, campaign_id, step_order, delay_days, subject, body_text) VALUES (?, ?, 1, 0, 'S', 'B')", [ws.workspaceId, c.lastID]);
  for (let i = 0; i < emailed; i++) {
    const status = i < replied ? 'replied' : i < replied + bounced ? 'bounced' : i < replied + bounced + unsub ? 'unsubscribed' : 'active';
    const r = await db().run(
      "INSERT INTO outreach_recipients (workspace_id, campaign_id, lead_id, email, name, status, next_step_order, first_sent_at, unsubscribe_token, created_at) VALUES (?, ?, ?, ?, 'R', ?, 2, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY), ?, UTC_TIMESTAMP())",
      [ws.workspaceId, c.lastID, leads[i] || null, `r${i}-${c.lastID}@co${i}.io`, status, require('crypto').randomBytes(20).toString('hex')]
    );
    await db().run("INSERT INTO outreach_sends (workspace_id, campaign_id, recipient_id, step_id, step_order, status, created_at, sent_at) VALUES (?, ?, ?, ?, 1, 'sent', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY))", [ws.workspaceId, c.lastID, r.lastID, step.lastID]);
  }
  for (let i = 0; i < failed; i++) {
    const r = await db().run("INSERT INTO outreach_recipients (workspace_id, campaign_id, email, status, unsubscribe_token) VALUES (?, ?, ?, 'failed', ?)", [ws.workspaceId, c.lastID, `f${i}-${c.lastID}@co.io`, require('crypto').randomBytes(20).toString('hex')]);
    await db().run("INSERT INTO outreach_sends (workspace_id, campaign_id, recipient_id, step_id, step_order, status, error, created_at) VALUES (?, ?, ?, ?, 1, 'failed', 'x', UTC_TIMESTAMP())", [ws.workspaceId, c.lastID, r.lastID, step.lastID]);
  }
  return c.lastID;
}

test.before(async () => {
  await h.prepareDatabase();
  A = await h.createWorkspace({ name: 'Analytics A' });
  B = await h.createWorkspace({ name: 'Analytics B' });
  C = await h.createWorkspace({ name: 'Analytics empty' });
  const l1 = (await db().run("INSERT INTO leads (workspace_id, name, email, status, created_at) VALUES (?, 'Won Via Email', 'won1@co.io', 'New', UTC_TIMESTAMP())", [A.workspaceId])).lastID;
  const l2 = (await db().run("INSERT INTO leads (workspace_id, name, email, status, created_at) VALUES (?, 'Won Alone', 'won2@co.io', 'New', UTC_TIMESTAMP())", [A.workspaceId])).lastID;
  seqX = await sequenceWithResults(A, 'Sequence X', { emailed: 40, replied: 4, bounced: 2, unsub: 1, failed: 2, leads: [l1] });
  seqY = await sequenceWithResults(A, 'Sequence Y', { emailed: 40, replied: 16 });
  // Conversions: l1 was emailed by X two days earlier; l2 had no email.
  const emit = require('../lib/automationEvents').emit;
  await emit(A.workspaceId, 'lead.status_changed', { subjectType: 'lead', subjectId: l1, payload: { from: 'New', to: 'Won' }, key: `t-won-${l1}` });
  await emit(A.workspaceId, 'lead.status_changed', { subjectType: 'lead', subjectId: l2, payload: { from: 'New', to: 'Won' }, key: `t-won-${l2}` });
  await db().run("UPDATE automation_events SET status = 'processed' WHERE workspace_id = ?", [A.workspaceId]);

  // Social: two published posts; only one has platform metrics; one demo snapshot.
  social = (await h.api('POST', '/api/v1/social/campaigns', { token: A.token, body: { name: 'Social S', platforms: ['linkedin'] } })).data.campaign.id;
  const acc = await h.createAccount(A.workspaceId, { accountType: 'linkedin_organization', providerKey: 'linkedin', scopes: [] });
  const post = async title => (await db().run("INSERT INTO content_items (workspace_id, campaign_id, content_type, title, caption_text, platform_key, social_account_id, status, published_at, external_post_id, version, created_at) VALUES (?, ?, 'post', ?, 'c', 'linkedin', ?, 'published', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY), ?, 1, UTC_TIMESTAMP())", [A.workspaceId, social, title, acc.id, `ext-${title}`])).lastID;
  const p1 = await post('P1');
  await post('P2');
  for (const [k, v, src] of [['impressions', 1000, 'linkedin_api'], ['likes', 30, 'linkedin_api'], ['comments', 10, 'linkedin_api']]) {
    await db().run("INSERT INTO social_metric_snapshots (workspace_id, social_account_id, content_item_id, external_object_id, object_type, metric_key, metric_value, availability, source, collected_at) VALUES (?, ?, ?, 'ext-P1', 'post', ?, ?, 'available', ?, UTC_TIMESTAMP())", [A.workspaceId, acc.id, p1, k, v, src]);
  }
  await db().run("INSERT INTO social_metric_snapshots (workspace_id, social_account_id, content_item_id, external_object_id, object_type, metric_key, metric_value, availability, source, collected_at) VALUES (?, ?, NULL, 'acct', 'account', 'followers', 5, 'available', 'demo_seed', UTC_TIMESTAMP())", [A.workspaceId, acc.id]);
});
test.after(() => h.shutdown());

test('an empty workspace shows real zeros and explained gaps, never invented values', async () => {
  const r = await overview(C);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { email, social: s, crm } = r.data.channels;
  assert.deepEqual([email.emailsSent.status, email.emailsSent.value], ['available', 0], 'zero is a real zero');
  assert.equal(email.replyRate.status, 'unavailable');
  assert.equal(email.opens.status, 'unavailable');
  assert.deepEqual([s.postsPublished.value, s.impressions.status], [0, 'unavailable']);
  assert.match(s.impressions.reason, /No posts/);
  assert.equal(crm.leadsCreated.value, 0);
  assert.equal(r.data.attribution.revenue.status, 'unavailable');
  assert.equal(r.data.attribution.roi.status, 'unavailable');
  assert.ok(r.data.insights.some(i => i.id === 'reply_tracking_off'));
  const mock = noAi();
  let rec;
  try { rec = await h.api('POST', '/api/v1/campaign-analytics/recommendations', { token: C.token, body: {} }); } finally { mock.restore(); }
  assert.equal(rec.status, 200);
  assert.deepEqual(rec.data.recommendations, []);
  assert.match(rec.data.note, /nothing to base recommendations on/);
});

test('email metrics use real cohorts; replies are unavailable without mailbox sync', async () => {
  let r = (await overview(A)).data;
  const x = r.comparisons.email.find(c => c.id === seqX);
  assert.deepEqual([x.emailsSent.value, x.emailsFailed.value, x.recipientsEmailed.value], [40, 2, 40]);
  assert.equal(x.replies.status, 'unavailable');
  assert.match(x.replies.reason, /IMAP/);
  assert.equal(x.bounceRate.value, 2 / 40);
  assert.equal(x.unsubscribeRate.value, 1 / 40);
  assert.ok(r.insights.some(i => i.id === `failed_${seqX}`));
  assert.ok(!r.insights.some(i => i.id.startsWith('reply_compare')), 'no reply comparisons without reply tracking');
  assert.ok(!Array.isArray(r.trends.series.replies) && r.trends.series.replies.unavailable, 'reply trend unavailable, not zeros');

  await h.api('POST', '/api/v1/mail/config', { token: A.token, body: { provider: 'custom_smtp', imap_host: 'imap.example.org', imap_user: 'in@a-co.io', imap_pass: 'secret' } });
  await db().run('UPDATE mail_configurations SET last_synced_at = UTC_TIMESTAMP() WHERE workspace_id = ?', [A.workspaceId]);
  r = (await overview(A)).data;
  const x2 = r.comparisons.email.find(c => c.id === seqX);
  const y2 = r.comparisons.email.find(c => c.id === seqY);
  assert.deepEqual([x2.replies.value, x2.replyRate.value, y2.replyRate.value], [4, 0.1, 0.4]);
  assert.equal(r.channels.email.emailsSent.value, 80);
  const cmp = r.insights.find(i => i.id.startsWith('reply_compare'));
  assert.ok(cmp, 'significant difference is reported');
  assert.match(cmp.title, /"Sequence Y" gets significantly more replies than "Sequence X"/);
  assert.ok(cmp.evidence.some(e => e.metric === 'pValue' && e.value < 0.05));
  assert.equal(r.trends.series.emailsSent.reduce((a, b) => a + b, 0), 80);
});

test('social metrics are marked partial when only some posts report them; demo sources are flagged', async () => {
  const r = (await overview(A)).data;
  const s = r.comparisons.social.find(c => c.id === social);
  assert.equal(s.postsPublished.value, 2);
  assert.deepEqual([s.impressions.status, s.impressions.value], ['partial', 1000]);
  assert.match(s.impressions.basis, /1 of 2/);
  assert.deepEqual([s.engagements.status, s.engagements.value], ['partial', 40]);
  assert.equal(s.engagementRate.value, 40 / 1000);
  assert.equal(s.clicks.status, 'unavailable', 'not reported is not zero');
  assert.deepEqual(r.dataQuality.demoSources, ['demo_seed']);
  assert.ok(r.insights.some(i => i.id === 'demo_data'));
});

test('attribution is a labelled last-touch estimate; social, revenue and ROI stay unavailable', async () => {
  const r = (await overview(A)).data;
  assert.equal(r.channels.crm.conversions.value, 2);
  assert.deepEqual(r.attribution.email[seqX], { value: 1, status: 'estimate', method: r.attribution.method });
  assert.equal(r.attribution.unattributed.value, 1);
  assert.match(r.attribution.method, /association, not proof/);
  assert.equal(r.attribution.social.status, 'unavailable');
  assert.equal(r.comparisons.email.find(c => c.id === seqY).attributedConversions.value, 0);
  const q = (await overview(A, '?conversionStatus=Qualified')).data;
  assert.equal(q.channels.crm.conversions.value, 0);
  assert.equal((await overview(A, '?conversionStatus=Bogus')).status, 400);
  assert.equal((await overview(A, '?from=2026-01-10&to=2026-01-01')).status, 400);
});

test('AI recommendations must cite real evidence; AI failure is reported', async () => {
  const down = h.mockFetch([{ match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) }]);
  let r;
  try { r = await h.api('POST', '/api/v1/campaign-analytics/recommendations', { token: A.token, body: {} }); } finally { down.restore(); }
  assert.equal(r.status, 503);
  assert.equal(r.data.code, 'AI_UNAVAILABLE');

  let prompt = '';
  const mock = h.mockFetch([h.groqRoute(b => {
    prompt = b.messages.map(m => m.content).join('\n');
    return JSON.stringify({ recommendations: [
      { title: 'Reuse Y messaging', action: 'Apply Sequence Y angle to X.', evidence: [`email_campaign:${seqY}`, 'insight:made_up'], confidence: 'medium' },
      { title: 'Industry benchmark', action: 'Aim for 25% reply rate like peers.', evidence: ['benchmark:industry'] }
    ] });
  })]);
  try { r = await h.api('POST', '/api/v1/campaign-analytics/recommendations', { token: A.token, body: {} }); } finally { mock.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.recommendations.length, 1, 'recommendations without real evidence are dropped');
  assert.equal(r.data.dropped, 1);
  assert.deepEqual(r.data.recommendations[0].evidence, [`email_campaign:${seqY}`]);
  assert.ok(r.data.recommendations[0].evidenceDetail[`email_campaign:${seqY}`].replyRate.value === 0.4);
  assert.match(prompt, /unavailable" are unknown, not zero/);
  assert.match(prompt, /Never invent numbers, revenue, ROI/);
});

test('analytics are private to the workspace', async () => {
  const r = (await overview(B)).data;
  assert.equal(r.channels.email.emailsSent.value, 0);
  assert.ok(!r.comparisons.email.some(c => [seqX, seqY].includes(c.id)));
  assert.ok(!r.comparisons.social.some(c => c.id === social));
  assert.equal(r.channels.crm.conversions.status, 'unavailable', "A's status history is not B's");
  const member = await h.addMember(A.workspaceId, 'Member');
  assert.equal((await overview(member)).status, 200);
  assert.equal((await h.api('GET', '/api/v1/campaign-analytics/overview')).status, 401);
});
