const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { twoProportionTest } = require('../lib/abStats');

// A/B tests for email sequences and social variants. AI and mail are mocked; metric
// snapshots and replies are inserted directly, so every number below is a known count.
let A;
let B;
let prodA;
let emailId;
let testId;

const db = () => h.db();
const api = (ws, method, path, body) => h.api(method, `/api/v1/ab-tests${path}`, { token: ws.token, body });
const tick = (maxPerTick) => require('../modules/outreach/outreachSender').processOutreach('test-worker', { maxPerTick });
const aiDown = { match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) };
const groq = obj => h.groqRoute(() => JSON.stringify(obj));
const zepto = calls => ({ match: u => u.startsWith('https://api.zeptomail.com/'), respond: (url, init) => { const b = JSON.parse(init.body); calls.push({ to: b.to[0].email_address.address, subject: b.subject }); return h.json(200, { request_id: `r${calls.length}` }); } });

async function emailSequence(ws, { leads = 0, name = `Seq ${Date.now()}` } = {}) {
  const created = await h.api('POST', '/api/v1/outreach/campaigns', { token: ws.token, body: { name, productId: ws === A ? prodA : null, sendDays: [1, 2, 3, 4, 5, 6, 7], sendStartHour: 0, sendEndHour: 24, dailyLimit: 500 } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const c = created.data.campaign;
  await h.api('PUT', `/api/v1/outreach/campaigns/${c.id}/steps`, { token: ws.token, body: { steps: [
    { delayDays: 0, subject: 'Subject A', body: 'Hi {{first_name}},\n\nRouteKit plans delivery routes.' },
    { delayDays: 3, subject: 'Follow-up', body: 'Hi {{first_name}},\n\nChecking in.' }
  ] } });
  if (leads) {
    const ids = [];
    for (let i = 0; i < leads; i++) {
      const r = await db().run("INSERT INTO leads (workspace_id, name, email, status, created_at) VALUES (?, ?, ?, 'New', UTC_TIMESTAMP())", [ws.workspaceId, `Lead ${i}`, `lead${i}-${c.id}@fleet${i % 7}.io`]);
      ids.push(r.lastID);
    }
    const add = await h.api('POST', `/api/v1/outreach/campaigns/${c.id}/recipients`, { token: ws.token, body: { leadIds: ids } });
    assert.equal(add.data.added, leads, JSON.stringify(add.data.skipped));
  }
  return c.id;
}

test.before(async () => {
  await h.prepareDatabase();
  await db().run("UPDATE outreach_campaigns SET status = 'stopped' WHERE status = 'running'");
  A = await h.createWorkspace({ name: 'AB A' });
  B = await h.createWorkspace({ name: 'AB B' });
  assert.equal((await h.api('POST', '/api/v1/mail/config', { token: A.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: 'zepto-A', sender_email: 'hello@a-co.io' } })).status, 200);
  prodA = (await h.api('POST', '/api/v1/products', { token: A.token, body: { name: 'RouteKit', tagline: 'Plan delivery routes', features: ['Driver app'] } })).data.productId;
});
test.after(() => h.shutdown());

test('two-proportion test matches known values and refuses uncomputable cases', () => {
  const r = twoProportionTest(10, 100, 20, 100);
  assert.ok(Math.abs(r.z - 1.980) < 0.001);
  assert.ok(Math.abs(r.pValue - 0.0477) < 0.0005);
  assert.equal(twoProportionTest(0, 50, 0, 50).pValue, null, 'no events: no confidence');
  assert.equal(twoProportionTest(3, 0, 1, 10).pValue, null, 'no trials: no confidence');
});

test('email tests are defined on draft sequences with metric and sample fixed up front', async () => {
  emailId = await emailSequence(A, { leads: 80 });
  const other = await emailSequence(B);
  const base = { name: 'Subject test', emailCampaignId: emailId, stepOrder: 1, metric: 'reply_rate', minSamplePerVariant: 30, waitDays: 3 };
  assert.equal((await api(A, 'POST', '/email', { ...base, emailCampaignId: other })).status, 404, 'foreign sequence');
  assert.equal((await api(A, 'POST', '/email', { ...base, stepOrder: 4 })).status, 400, 'missing step');
  assert.equal((await api(A, 'POST', '/email', { ...base, minSamplePerVariant: 5 })).status, 400, 'tiny samples are rejected');
  assert.equal((await api(A, 'POST', '/email', { ...base, metric: 'open_rate' })).status, 400, 'opens are not tracked');
  const bad = await api(A, 'POST', '/email', { ...base, variant: { subject: 'Hi', body: 'Hello {{last_name}}' } });
  assert.equal(bad.status, 400, 'unknown placeholders');
  // The failed attempt above may have created the test before the variant was rejected; clean up for a fresh start.
  await db().run("UPDATE ab_tests SET status = 'cancelled' WHERE outreach_campaign_id = ?", [emailId]);
  const approver = await h.addMember(A.workspaceId, 'Approver');
  assert.equal((await api(approver, 'POST', '/email', base)).status, 403);

  const r = await api(A, 'POST', '/email', base);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  testId = r.data.test.id;
  assert.equal(r.data.test.status, 'draft');
  assert.equal(r.data.test.direction, 'higher');
  assert.equal((await api(A, 'POST', '/email', base)).status, 409, 'one test per sequence');

  const down = h.mockFetch([aiDown]);
  let g;
  try { g = await api(A, 'POST', `/${testId}/generate-variant`); } finally { down.restore(); }
  assert.equal(g.status, 503);
  assert.equal((await api(A, 'GET', `/${testId}`)).data.test.content.B, null, 'no canned variant');

  // Approving without variant B is blocked by the sequence readiness check.
  const blocked = await h.api('POST', `/api/v1/outreach/campaigns/${emailId}/approve`, { token: A.token, body: { confirm: true } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /no variant B/);

  const mock = h.mockFetch([groq({ subject: 'Subject B: plan routes in 50% less time', body: 'Hi {{first_name}},\n\nA different angle on RouteKit route planning.' })]);
  try { g = await api(A, 'POST', `/${testId}/generate-variant`); } finally { mock.restore(); }
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.deepEqual(g.data.test.content.B.needsVerification, ['50%'], 'invented claims in variant B are flagged');
  const flagged = await h.api('POST', `/api/v1/outreach/campaigns/${emailId}/approve`, { token: A.token, body: { confirm: true } });
  assert.equal(flagged.data.code, 'UNVERIFIED_CLAIMS', 'variant B claims gate the approval too');
  await api(A, 'PATCH', `/${testId}`, { variant: { subject: 'Subject B', body: 'Hi {{first_name}},\n\nA different angle on RouteKit route planning.' } });
});

test('approval locks the test and splits recipients evenly; each send records its variant', async () => {
  const ok = await h.api('POST', `/api/v1/outreach/campaigns/${emailId}/approve`, { token: A.token, body: { confirm: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const t = (await api(A, 'GET', `/${testId}`)).data.test;
  assert.equal(t.status, 'running');
  assert.ok(t.lockedAt);
  const split = await db().all('SELECT variant_label, COUNT(*) AS n FROM outreach_recipients WHERE campaign_id = ? GROUP BY variant_label', [emailId]);
  assert.deepEqual(Object.fromEntries(split.map(s => [s.variant_label, Number(s.n)])), { A: 40, B: 40 });
  assert.equal((await api(A, 'PATCH', `/${testId}`, { minSamplePerVariant: 30 })).status, 409, 'definition locked');

  const calls = [];
  const mock = h.mockFetch([zepto(calls)]);
  try { await tick(70); } finally { mock.restore(); }
  assert.equal(calls.length, 70);
  const sends = await db().all('SELECT s.variant_label, r.email, r.variant_label AS assigned FROM outreach_sends s JOIN outreach_recipients r ON r.id = s.recipient_id WHERE s.campaign_id = ?', [emailId]);
  assert.ok(sends.every(s => s.variant_label === s.assigned), 'each recipient got their assigned variant');
  const bySubject = Object.fromEntries(calls.map(c => [c.to, c.subject]));
  assert.ok(sends.every(s => bySubject[s.email] === (s.variant_label === 'B' ? 'Subject B' : 'Subject A')));
});

test('no winner without matured data and significance; the data-backed winner is applied to remaining sends', async () => {
  let t = (await api(A, 'GET', `/${testId}`)).data.test;
  assert.equal(t.result.decision.recommendation, 'insufficient_data', 'replies need 3 days to mature');
  assert.equal(t.result.variants.A.n, 0);
  const early = await api(A, 'POST', `/${testId}/conclude`, { decision: 'winner', winner: 'B', confirm: true });
  assert.equal(early.status, 409);
  assert.equal(early.data.code, 'INSUFFICIENT_EVIDENCE');

  // Mature the sends and record real outcomes: 1 reply for A, 15 for B.
  await db().run('UPDATE outreach_sends SET sent_at = DATE_SUB(sent_at, INTERVAL 4 DAY) WHERE campaign_id = ?', [emailId]);
  const sentA = await db().all("SELECT recipient_id FROM outreach_sends WHERE campaign_id = ? AND variant_label = 'A' ORDER BY id LIMIT 1", [emailId]);
  const sentB = await db().all("SELECT recipient_id FROM outreach_sends WHERE campaign_id = ? AND variant_label = 'B' ORDER BY id LIMIT 15", [emailId]);
  for (const r of [...sentA, ...sentB]) await db().run("UPDATE outreach_recipients SET status = 'replied', next_send_at = NULL WHERE id = ?", [r.recipient_id]);

  t = (await api(A, 'GET', `/${testId}`)).data.test;
  const { A: va, B: vb } = t.result.variants;
  assert.ok(va.n >= 30 && vb.n >= 30, `both variants matured: ${va.n}/${vb.n}`);
  assert.equal(va.events, 1);
  assert.equal(vb.events, 15);
  assert.equal(t.result.decision.recommendation, 'winner');
  assert.equal(t.result.decision.leader, 'B');
  const expected = twoProportionTest(1, va.n, 15, vb.n).pValue;
  assert.ok(Math.abs(t.result.decision.pValue - expected) < 1e-12, 'p-value is computed from the real counts');

  assert.equal((await api(A, 'POST', `/${testId}/conclude`, { decision: 'winner', winner: 'A', confirm: true })).data.code, 'WRONG_WINNER');
  assert.equal((await api(A, 'POST', `/${testId}/conclude`, { decision: 'winner', winner: 'B' })).status, 400, 'confirmation required');
  const member = await h.addMember(A.workspaceId, 'Member');
  assert.equal((await api(member, 'POST', `/${testId}/conclude`, { decision: 'winner', winner: 'B', confirm: true })).status, 403, 'needs mail.send');
  const done = await api(A, 'POST', `/${testId}/conclude`, { decision: 'winner', winner: 'B', confirm: true });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.test.winner, 'B');
  assert.ok(done.data.test.frozenResult.decision.pValue < 0.05, 'result snapshot kept for the record');

  // The 10 recipients not yet emailed now get the winning variant, whatever they were assigned.
  const calls = [];
  const mock = h.mockFetch([zepto(calls)]);
  try { await tick(50); } finally { mock.restore(); }
  const firstStep = calls.filter(c => c.subject !== 'Follow-up');
  assert.equal(firstStep.length, 10);
  assert.ok(firstStep.every(c => c.subject === 'Subject B'));
  await h.api('POST', `/api/v1/outreach/campaigns/${emailId}/stop`, { token: A.token });
});

test('social tests compare existing variant posts with real platform metrics only', async () => {
  const sc = (await h.api('POST', '/api/v1/social/campaigns', { token: A.token, body: { name: 'Social AB', productId: prodA, platforms: ['linkedin'] } })).data.campaign;
  const group = `c${sc.id}-s1`;
  const ins = label => db().run("INSERT INTO content_items (workspace_id, campaign_id, content_type, title, caption_text, platform, platform_key, status, version, variant_group, variant_label, created_at) VALUES (?, ?, 'post', ?, ?, 'LinkedIn', 'linkedin', 'approved', 1, ?, ?, UTC_TIMESTAMP())",
    [A.workspaceId, sc.id, `Post ${label}`, `Caption ${label}`, group, label]);
  const a = (await ins('A')).lastID;
  const b = (await ins('B')).lastID;
  const base = { name: 'Hook test', socialCampaignId: sc.id, variantGroup: group, metric: 'engagement_rate', minSamplePerVariant: 500 };
  assert.equal((await api(B, 'POST', '/social', base)).status, 404, 'foreign campaign');
  assert.equal((await api(A, 'POST', '/social', { ...base, variantGroup: 'nope' })).status, 400);
  const groups = (await api(A, 'GET', `/social-groups/${sc.id}`)).data.groups;
  assert.deepEqual(groups.map(g => g.variantGroup), [group]);

  const r = await api(A, 'POST', '/social', base);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sid = r.data.test.id;
  let t = (await api(A, 'GET', `/${sid}`)).data.test;
  assert.equal(t.result.decision.recommendation, 'insufficient_data');
  assert.ok(t.result.decision.reasons.some(x => /not published/.test(x)));

  // Publish both; demo snapshots must be ignored; real snapshots decide.
  const acc = await h.createAccount(A.workspaceId, { accountType: 'linkedin_org', providerKey: 'linkedin', scopes: [] });
  await db().run("UPDATE content_items SET status = 'published', published_at = UTC_TIMESTAMP(), social_account_id = ? WHERE id IN (?, ?)", [acc.id, a, b]);
  const snap = (cid, key, v, source = 'linkedin_api') => db().run(
    "INSERT INTO social_metric_snapshots (workspace_id, social_account_id, content_item_id, external_object_id, object_type, metric_key, metric_value, availability, source, collected_at) VALUES (?, ?, ?, ?, 'post', ?, ?, 'available', ?, UTC_TIMESTAMP())",
    [A.workspaceId, acc.id, cid, `ext-${cid}`, key, v, source]);
  await snap(a, 'impressions', 999999, 'demo_seed');
  await snap(a, 'likes', 999999, 'demo_seed');
  t = (await api(A, 'GET', `/${sid}`)).data.test;
  assert.equal(t.result.decision.recommendation, 'insufficient_data', 'demo numbers never count');
  await snap(a, 'impressions', 1000); await snap(a, 'likes', 20);
  await snap(b, 'impressions', 1000); await snap(b, 'likes', 45); await snap(b, 'comments', 15);
  t = (await api(A, 'GET', `/${sid}`)).data.test;
  assert.deepEqual([t.result.variants.A.n, t.result.variants.A.events, t.result.variants.B.n, t.result.variants.B.events], [1000, 20, 1000, 60]);
  assert.equal(t.result.decision.recommendation, 'winner');
  assert.equal(t.result.decision.leader, 'B');
  assert.equal((await api(A, 'POST', '/social', base)).status, 409, 'already published / test exists');

  const member = await h.addMember(A.workspaceId, 'Member');
  assert.equal((await api(member, 'POST', `/${sid}/conclude`, { decision: 'winner', winner: 'B', confirm: true })).status, 403, 'needs content.approve');
  const done = await api(A, 'POST', `/${sid}/conclude`, { decision: 'winner', winner: 'B', confirm: true });
  assert.equal(done.data.test.winner, 'B');
  assert.equal(Number((await db().get("SELECT COUNT(*) AS n FROM content_items WHERE campaign_id = ? AND status IN ('scheduled')", [sc.id])).n), 0, 'concluding publishes nothing');
});

test('a test with no significant difference can only end without a winner', async () => {
  const sc = (await h.api('POST', '/api/v1/social/campaigns', { token: A.token, body: { name: 'Even AB', productId: prodA, platforms: ['linkedin'] } })).data.campaign;
  const group = `c${sc.id}-s1`;
  const acc = await h.createAccount(A.workspaceId, { accountType: 'linkedin_org', providerKey: 'linkedin', scopes: [] });
  const ids = [];
  for (const label of ['A', 'B']) {
    ids.push((await db().run("INSERT INTO content_items (workspace_id, campaign_id, content_type, title, caption_text, platform_key, status, version, variant_group, variant_label, created_at) VALUES (?, ?, 'post', ?, 'c', 'linkedin', 'approved', 1, ?, ?, UTC_TIMESTAMP())", [A.workspaceId, sc.id, label, group, label])).lastID);
  }
  const sid = (await api(A, 'POST', '/social', { name: 'Even', socialCampaignId: sc.id, variantGroup: group, metric: 'click_rate', minSamplePerVariant: 500 })).data.test.id;
  await db().run("UPDATE content_items SET status = 'published', social_account_id = ? WHERE id IN (?, ?)", [acc.id, ...ids]);
  for (const [cid, clicks] of [[ids[0], 21], [ids[1], 24]]) {
    for (const [k, v] of [['impressions', 800], ['clicks', clicks]]) {
      await db().run("INSERT INTO social_metric_snapshots (workspace_id, social_account_id, content_item_id, external_object_id, object_type, metric_key, metric_value, availability, source, collected_at) VALUES (?, ?, ?, ?, 'post', ?, ?, 'available', 'linkedin_api', UTC_TIMESTAMP())", [A.workspaceId, acc.id, cid, `e${cid}`, k, v]);
    }
  }
  const t = (await api(A, 'GET', `/${sid}`)).data.test;
  assert.equal(t.result.decision.recommendation, 'no_difference');
  assert.equal(t.result.decision.observedLeader, 'B', 'B is ahead but not significantly');
  assert.equal((await api(A, 'POST', `/${sid}/conclude`, { decision: 'winner', winner: 'B', confirm: true })).data.code, 'INSUFFICIENT_EVIDENCE');
  const end = await api(A, 'POST', `/${sid}/conclude`, { decision: 'no_winner', confirm: true, note: 'No real difference' });
  assert.equal(end.status, 200);
  assert.equal(end.data.test.winner, null);
});

test('tests are private to their workspace and appear in the Command Center overview', async () => {
  for (const [m, p, b] of [['GET', `/${testId}`], ['PATCH', `/${testId}`, { name: 'x' }], ['POST', `/${testId}/conclude`, { decision: 'no_winner', confirm: true }], ['POST', `/${testId}/cancel`], ['POST', `/${testId}/generate-variant`]]) {
    assert.equal((await api(B, m, p, b)).status, 404, `${m} ${p}`);
  }
  assert.ok(!(await api(B, 'GET', '/')).data.tests.some(t => t.id === testId));
  assert.ok((await api(A, 'GET', `/?emailCampaignId=${emailId}`)).data.tests.some(t => t.id === testId));
  assert.equal((await h.api('GET', '/api/v1/ab-tests')).status, 401);

  const prog = (await h.api('POST', '/api/v1/command/programs', { token: A.token, body: { name: 'With test', channels: ['email'] } })).data.program;
  await db().run('UPDATE campaign_programs SET outreach_campaign_id = ? WHERE id = ?', [emailId, prog.id]);
  const ov = await h.api('GET', `/api/v1/command/programs/${prog.id}/overview`, { token: A.token });
  assert.ok(ov.data.abTests.some(t => t.id === testId && t.status === 'concluded'));
});
