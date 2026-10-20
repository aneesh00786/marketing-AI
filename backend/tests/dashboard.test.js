const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let A;
let B;

async function publishedPost(ws, accountId, { daysAgo = 1, title = 'Post', campaignId = null, platform = 'facebook' } = {}) {
  const { run } = h.db();
  const ext = `dash-${Math.random().toString(36).slice(2)}`;
  const ins = await run(
    `INSERT INTO content_items (workspace_id, campaign_id, platform_key, platform, social_account_id, title, caption_text, status, external_post_id, published_at, version, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'x', 'published', ?, UTC_TIMESTAMP() - INTERVAL ? DAY, 1, 'manual', UTC_TIMESTAMP())`,
    [ws, campaignId, platform, platform, accountId, title, ext, daysAgo]
  );
  return { id: ins.lastID, ext };
}

async function metric(ws, accountId, post, key, value, availability = 'available', source = 'meta_api') {
  const { run } = h.db();
  await run(
    `INSERT INTO social_metric_snapshots (workspace_id, social_account_id, content_item_id, external_object_id, object_type, metric_key, metric_value, availability, period, source, collected_at)
     VALUES (?, ?, ?, ?, 'post', ?, ?, ?, 'lifetime', ?, UTC_TIMESTAMP())`,
    [ws, accountId, post.id, post.ext, key, value, availability, source]
  );
}

test.before(async () => {
  await h.prepareDatabase();
  A = await h.createWorkspace({ name: 'Dash A' });
  B = await h.createWorkspace({ name: 'Dash B' });
});
test.after(() => h.shutdown());

test('dashboard requires authentication and analytics permission', async () => {
  assert.equal((await h.api('GET', '/api/v1/social/dashboard')).status, 401);
  const bad = await h.api('GET', '/api/v1/social/dashboard?from=2026-10-10&to=2026-10-01', { token: A.token });
  assert.equal(bad.status, 400);
});

test('an empty workspace shows unavailable metrics, not zeros', async () => {
  const res = await h.api('GET', '/api/v1/social/dashboard?range=30', { token: B.token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const d = res.data.dashboard;
  assert.equal(d.kpis.publishedPosts.value, 0);
  assert.equal(d.kpis.reach.value, null);
  assert.equal(d.kpis.clicks.value, null);
  assert.equal(d.kpis.engagementRate.value, null);
  assert.equal(d.kpis.leads.value, 0, 'lead counts are real counts, so zero is genuine');
  assert.ok(d.series.every(p => p.reach === null && p.posts === 0), 'days without posts are gaps');
  assert.equal(d.dataQuality.containsDemoData, false);
  assert.ok(d.insights.some(i => i.title === 'Connect a social account'));
});

test('KPIs, series and platforms come only from the authenticated workspace', async () => {
  const acctA = await h.createAccount(A.workspaceId, { accountType: 'facebook_page' });
  const igA = await h.createAccount(A.workspaceId, { accountType: 'instagram_business' });
  const acctB = await h.createAccount(B.workspaceId, { accountType: 'facebook_page' });
  const { run } = h.db();
  const camp = await run("INSERT INTO campaigns (workspace_id, name, status, source, platforms_json, created_at) VALUES (?, 'Dash campaign', 'Active', 'social_hub', '[\"facebook\"]', UTC_TIMESTAMP())", [A.workspaceId]);

  const p1 = await publishedPost(A.workspaceId, acctA.id, { daysAgo: 2, title: 'FB winner', campaignId: camp.lastID });
  await metric(A.workspaceId, acctA.id, p1, 'reach', 1000);
  await metric(A.workspaceId, acctA.id, p1, 'likes', 40);
  await metric(A.workspaceId, acctA.id, p1, 'comments', 10);
  await metric(A.workspaceId, acctA.id, p1, 'shares', 0);
  await metric(A.workspaceId, acctA.id, p1, 'clicks', 25);
  await metric(A.workspaceId, acctA.id, p1, 'impressions', null, 'unavailable');
  const p2 = await publishedPost(A.workspaceId, igA.id, { daysAgo: 3, title: 'IG post', platform: 'instagram' });
  await metric(A.workspaceId, igA.id, p2, 'reach', 500);
  await metric(A.workspaceId, igA.id, p2, 'likes', 5);

  // Workspace B data that must never leak into A.
  const pb = await publishedPost(B.workspaceId, acctB.id, { daysAgo: 1, title: 'Other tenant' });
  await metric(B.workspaceId, acctB.id, pb, 'reach', 999999);
  await run("INSERT INTO leads (workspace_id, name, status, created_at) VALUES (?, 'B lead', 'New', UTC_TIMESTAMP())", [B.workspaceId]);
  await run("INSERT INTO leads (workspace_id, name, product_interest, status, created_at) VALUES (?, 'A lead', 'Social (meta)', 'New', UTC_TIMESTAMP() - INTERVAL 1 DAY)", [A.workspaceId]);

  const res = await h.api('GET', '/api/v1/social/dashboard?range=30', { token: A.token });
  const d = res.data.dashboard;
  assert.equal(d.kpis.publishedPosts.value, 2);
  assert.equal(d.kpis.reach.value, 1500);
  assert.equal(d.kpis.impressions.value, null, 'impressions were unavailable for every post');
  assert.equal(d.kpis.clicks.value, 25);
  assert.deepEqual(d.kpis.clicks.coverage, { available: 1, total: 2 });
  assert.equal(d.kpis.engagementRate.value, Number(((55 / 1500) * 100).toFixed(2)));
  assert.equal(d.kpis.leads.value, 1);
  assert.equal(d.kpis.leads.fromSocial, 1);
  assert.equal(d.kpis.totalCampaigns.value, 1);
  assert.equal(d.kpis.activeCampaigns.value, 1);
  assert.ok(!JSON.stringify(d).includes('999999'), 'no other-tenant metrics');
  assert.ok(!JSON.stringify(d).includes('Other tenant'));

  const fb = d.platforms.find(p => p.key === 'facebook');
  const li = d.platforms.find(p => p.key === 'linkedin');
  assert.equal(fb.connected, true);
  assert.equal(fb.engagements, 50);
  assert.equal(li.connected, false);
  assert.equal(li.reach, null);
  assert.equal(d.series.filter(p => p.posts > 0).length, 2);
  const row = d.campaigns.find(c => c.name === 'Dash campaign');
  assert.equal(row.metrics.reach, 1000);
  assert.equal(row.metrics.engagements, 50);
  assert.ok(d.insights.some(i => i.title.includes('has the highest engagement per post')));
  assert.equal(d.kpis.reach.change, null, 'no previous-period data, so no comparison');
});

test('comparison appears only with previous-period data, and demo data is labelled', async () => {
  const acct = await h.createAccount(A.workspaceId, { accountType: 'facebook_page' });
  const old = await publishedPost(A.workspaceId, acct.id, { daysAgo: 10, title: 'Older' });
  await metric(A.workspaceId, acct.id, old, 'reach', 500);
  const res = await h.api('GET', `/api/v1/social/dashboard?from=${new Date(Date.now() - 7 * 86400000).toISOString()}`, { token: A.token });
  const d = res.data.dashboard;
  assert.ok(d.kpis.reach.change, 'previous 7 days contain a post with reach');
  assert.equal(d.kpis.reach.change.delta, d.kpis.reach.value - 500);

  const demo = await publishedPost(A.workspaceId, acct.id, { daysAgo: 1, title: 'Seeded' });
  await metric(A.workspaceId, acct.id, demo, 'reach', 10, 'available', 'demo_seed');
  const flagged = (await h.api('GET', '/api/v1/social/dashboard?range=7', { token: A.token })).data.dashboard;
  assert.equal(flagged.dataQuality.containsDemoData, true);
  assert.deepEqual(flagged.dataQuality.demoSources, ['demo_seed']);
});

test('analytics permission is enforced server-side', async () => {
  // A member whose role grants no capabilities must be refused.
  const m = await h.addMember(A.workspaceId, 'Guest');
  const res = await h.api('GET', '/api/v1/social/dashboard?range=30', { token: m.token });
  assert.equal(res.status, 403);
  assert.equal(res.data.code, 'FORBIDDEN');
  const viewer = await h.addMember(A.workspaceId, 'Member');
  assert.equal((await h.api('GET', '/api/v1/social/dashboard?range=30', { token: viewer.token })).status, 200);
});

test('date filters: presets, custom range, and invalid input', async () => {
  for (const r of ['7', '30', '90']) {
    const res = await h.api('GET', `/api/v1/social/dashboard?range=${r}`, { token: A.token });
    assert.equal(res.status, 200, `range ${r}`);
    const span = (new Date(res.data.dashboard.range.to) - new Date(res.data.dashboard.range.from)) / 86400000;
    assert.ok(Math.abs(span - Number(r)) < 0.01, `range ${r} spans ${span} days`);
    const prevSpan = (new Date(res.data.dashboard.range.previousTo) - new Date(res.data.dashboard.range.previousFrom)) / 86400000;
    assert.ok(Math.abs(prevSpan - Number(r)) < 0.01, 'previous period has the same length');
  }
  const from = new Date(Date.now() - 14 * 86400000).toISOString();
  const to = new Date().toISOString();
  const custom = await h.api('GET', `/api/v1/social/dashboard?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { token: A.token });
  assert.equal(custom.status, 200);
  assert.equal(custom.data.dashboard.range.from, from);
  for (const bad of ['from=not-a-date', 'from=2026-10-10&to=2026-10-01', 'range=800', `from=2024-01-01&to=2026-01-01`]) {
    const res = await h.api('GET', `/api/v1/social/dashboard?${bad}`, { token: A.token });
    assert.equal(res.status, 400, bad);
    assert.ok(res.data.error, 'clear error message');
  }
});

test('dashboard responses never contain credentials', async () => {
  const res = await h.api('GET', '/api/v1/social/dashboard?range=90', { token: A.token });
  const text = JSON.stringify(res.data);
  assert.ok(!/page-token-SECRET|user-token-SECRET|secret_ciphertext|access_token|enc:v1:/.test(text));
});

test('demo accounts never reach real providers', async () => {
  const D = await h.createWorkspace({ name: 'Demo guard' });
  const acct = await h.createAccount(D.workspaceId, { accountType: 'facebook_page', externalId: `demo_fb_${D.workspaceId}` });
  const c = await h.api('POST', '/api/v1/social/content', { token: D.token, body: { platformKey: 'facebook', socialAccountId: acct.id, caption: 'demo' } });
  await h.api('POST', `/api/v1/social/content/${c.data.content.id}/approve`, { token: D.token, body: {} });
  const mock = h.mockFetch([]);
  try {
    const pub = await h.api('POST', `/api/v1/social/content/${c.data.content.id}/publish-now`, { token: D.token, body: {} });
    assert.equal(pub.status, 409);
    assert.equal(pub.data.code, 'DEMO_ACCOUNT');
    const health = await h.api('POST', `/api/v1/social/accounts/${acct.id}/check`, { token: D.token });
    assert.equal(health.data.ok, true);
    const job = { workspace_id: D.workspaceId, payload_json: JSON.stringify({ accountId: acct.id }) };
    assert.deepEqual(await require('../modules/social/analyticsService').syncAccountAnalytics(job), { skipped: 'demo account' });
    assert.deepEqual(await require('../modules/social/inboxService').syncAccountInbox(job), { skipped: 'demo account' });
    assert.equal(mock.calls.length, 0, 'no provider request was made');
  } finally { mock.restore(); }
  const { get } = h.db();
  assert.equal((await get('SELECT status FROM social_accounts WHERE id = ?', [acct.id])).status, 'connected');
});
