const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Business profile of the current workspace, and AI quota/metering for the calls that used to
// bypass it (inbox analysis, website extraction, inbox-sync analysis, assistant chat).
// AI providers are mocked; unmatched requests fail loudly.
const db = () => h.db();
let A;
let B;

test.before(async () => {
  await h.prepareDatabase();
  A = await h.createWorkspace({ name: 'Profile A' });
  B = await h.createWorkspace({ name: 'Profile B' });
});
test.after(() => h.shutdown());

const profileRows = wsId => db().all('SELECT * FROM business_profiles WHERE workspace_id = ?', [wsId]);
const usage = async (wsId, extra = '', params = []) => Number((await db().get(`SELECT COUNT(*) AS n FROM usage_ledger WHERE workspace_id = ? AND category = 'ai_text'${extra}`, [wsId, ...params])).n);
const aiOk = (calls, text = 'ok') => ({ match: u => u.startsWith('https://api.groq.com/'), respond: () => { calls.push(1); return h.json(200, { choices: [{ message: { content: text } }] }); } });
const aiDown = calls => ({ match: u => u.startsWith('https://api.groq.com/') || u.includes('localhost:11434'), respond: () => { calls.push(1); return h.json(500, {}); } });

// ------------------------------------------------------------------ business profile

test('profile: a workspace without one gets null; the first save creates it, later saves update the same row', async () => {
  const g = await h.api('GET', '/api/v1/business-profile', { token: A.token });
  assert.equal(g.status, 200);
  assert.equal(g.data.workspace.id, A.workspaceId);
  assert.equal(g.data.businessProfile, null);

  const noName = await h.api('PUT', '/api/v1/business-profile', { token: A.token, body: { industry: 'Retail' } });
  assert.equal(noName.status, 400, 'a new profile needs a business name');
  assert.equal((await profileRows(A.workspaceId)).length, 0);

  const created = await h.api('PUT', '/api/v1/business-profile', { token: A.token, body: { businessName: 'Alpha Co', industry: 'Retail', products: [{ name: 'X' }] } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.businessProfile.business_name, 'Alpha Co');
  assert.deepEqual(created.data.businessProfile.products, [{ name: 'X' }]);

  const updated = await h.api('PUT', '/api/business-profile', { token: A.token, body: { description: 'We sell things.' } });
  assert.equal(updated.status, 200);
  const rows = await profileRows(A.workspaceId);
  assert.equal(rows.length, 1, 'updated in place, not duplicated');
  assert.equal(rows[0].business_name, 'Alpha Co', 'fields not sent are kept');
  assert.equal(rows[0].description, 'We sell things.');

  const audits = await db().all("SELECT action FROM audit_logs WHERE workspace_id = ? AND action LIKE 'workspace.business_profile_%' ORDER BY id", [A.workspaceId]);
  assert.deepEqual(audits.map(a => a.action), ['workspace.business_profile_created', 'workspace.business_profile_updated']);
});

test('profile: two workspaces never read or write each other', async () => {
  await h.api('PUT', '/api/v1/business-profile', { token: B.token, body: { businessName: 'Bravo Ltd' } });
  const a = await h.api('GET', '/api/v1/business-profile', { token: A.token });
  const b = await h.api('GET', '/api/workspaces/current', { token: B.token });
  assert.equal(a.data.businessProfile.business_name, 'Alpha Co');
  assert.equal(b.data.businessProfile.business_name, 'Bravo Ltd');
  assert.equal(b.data.workspace.id, B.workspaceId);

  // A workspace id in the body is not accepted (the workspace comes from the session).
  const sneaky = await h.api('PUT', '/api/v1/business-profile', { token: A.token, body: { businessName: 'Hijack', workspaceId: B.workspaceId } });
  assert.equal(sneaky.status, 400);
  assert.equal((await profileRows(B.workspaceId))[0].business_name, 'Bravo Ltd');
  assert.equal((await profileRows(A.workspaceId))[0].business_name, 'Alpha Co');
});

test('profile: workspace 1 reads its own profile, not the first row of the table', async () => {
  const owner1 = await h.addMember(1, 'Workspace Owner');
  const r = await h.api('GET', '/api/v1/business-profile', { token: owner1.token });
  assert.equal(r.status, 200);
  assert.equal(r.data.workspace.id, 1);
  const own = await db().get('SELECT id FROM business_profiles WHERE workspace_id = 1 ORDER BY id DESC LIMIT 1');
  assert.equal(r.data.businessProfile ? r.data.businessProfile.id : null, own ? own.id : null);
});

test('profile: only Owners and Admins update; others are refused and nothing changes', async () => {
  for (const role of ['Marketing Manager', 'Approver', 'Member']) {
    const m = await h.addMember(A.workspaceId, role);
    const r = await h.api('PUT', '/api/v1/business-profile', { token: m.token, body: { businessName: `By ${role}` } });
    assert.equal(r.status, 403, role);
    assert.equal((await h.api('GET', '/api/v1/business-profile', { token: m.token })).status, 200, `${role} can read`);
  }
  const admin = await h.addMember(A.workspaceId, 'Workspace Admin');
  assert.equal((await h.api('PUT', '/api/v1/business-profile', { token: admin.token, body: { brandVoice: 'Warm' } })).status, 200);
  const row = (await profileRows(A.workspaceId))[0];
  assert.equal(row.business_name, 'Alpha Co');
  assert.equal(row.brand_voice, 'Warm');
  assert.equal((await h.api('PUT', '/api/v1/business-profile', { body: { businessName: 'Anon' } })).status, 401);
});

test('profile: concurrent first saves create exactly one profile', async () => {
  const C = await h.createWorkspace({ name: 'Profile race' });
  const results = await Promise.all([1, 2, 3].map(i => h.api('PUT', '/api/v1/business-profile', { token: C.token, body: { businessName: `Race ${i}` } })));
  assert.ok(results.every(r => r.status === 200), JSON.stringify(results.map(r => r.data)));
  assert.equal((await profileRows(C.workspaceId)).length, 1);
});

// ------------------------------------------------------------------ AI metering

test('metering: inbox analysis is recorded once, for the caller workspace, with the email as reference', async () => {
  const email = await db().run("INSERT INTO emails (workspace_id, sender, subject, body, status) VALUES (?, 'Kim', 'Pricing?', 'Please send pricing', 'Unread')", [A.workspaceId]);
  const [a0, b0] = [await usage(A.workspaceId), await usage(B.workspaceId)];
  const calls = [];
  const mock = h.mockFetch([aiOk(calls, JSON.stringify({ summary: 'Kim asks for pricing.', priority: 'Pricing', smart_replies: [] }))]);
  let r;
  try { r = await h.api('POST', `/api/v1/emails/${email.lastID}/ai-analyze`, { token: A.token }); } finally { mock.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(calls.length, 1);
  assert.equal(await usage(A.workspaceId), a0 + 1);
  assert.equal(await usage(B.workspaceId), b0, 'never attributed to another workspace');
  assert.equal(await usage(A.workspaceId, " AND reference_type = 'email' AND reference_id = ?", [email.lastID]), 1);

  // Another workspace cannot analyze (or be charged for) A's email.
  assert.equal((await h.api('POST', `/api/v1/emails/${email.lastID}/ai-analyze`, { token: B.token })).status, 404);
});

test('metering: a failed AI call records no usage and keeps the non-AI result', async () => {
  const email = await db().run("INSERT INTO emails (workspace_id, sender, subject, body, status) VALUES (?, 'Lee', 'Hello', 'Just saying hi', 'Unread')", [A.workspaceId]);
  const before = await usage(A.workspaceId);
  const calls = [];
  const mock = h.mockFetch([aiDown(calls)]);
  let r;
  try { r = await h.api('POST', `/api/v1/emails/${email.lastID}/ai-analyze`, { token: A.token }); } finally { mock.restore(); }
  assert.equal(r.status, 200);
  assert.ok(calls.length >= 1, 'the model was tried');
  assert.deepEqual(r.data.smartReplies, []);
  assert.equal(await usage(A.workspaceId), before);
});

test('metering: website extraction is metered to the caller workspace', async () => {
  const [a0, b0] = [await usage(A.workspaceId), await usage(B.workspaceId)];
  const ref0 = await usage(A.workspaceId, " AND reference_type = 'website_extraction'");
  const calls = [];
  const mock = h.mockFetch([aiOk(calls, JSON.stringify({ name: 'RouteKit', tagline: 'Routes', description: 'Plans routes.', features: ['Driver app'], target_audience: 'Fleets', pricing: [] }))]);
  let r;
  try { r = await h.api('POST', '/api/v1/products/extract-url', { token: A.token, body: { url: 'https://routekit.invalid/' } }); } finally { mock.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.product.name, 'RouteKit');
  assert.equal(await usage(A.workspaceId, " AND reference_type = 'website_extraction'"), ref0 + 1);
  assert.equal(await usage(A.workspaceId), a0 + 1);
  assert.equal(await usage(B.workspaceId), b0);
});

test('metering: assistant chat is metered to the signed-in workspace (not a hardcoded one)', async () => {
  const owner1 = await h.addMember(1, 'Workspace Owner');
  const before = await usage(1, " AND reference_type = 'assistant_chat'");
  const calls = [];
  const mock = h.mockFetch([aiOk(calls, 'Happy to help.')]);
  let r;
  try { r = await h.api('POST', '/api/v1/assistant/chat', { token: owner1.token, body: { message: 'Mark, summarise my week in one line' } }); } finally { mock.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await usage(1, " AND reference_type = 'assistant_chat'"), before + calls.length);
  assert.ok(calls.length >= 1);
});

test('quota: a workspace at its limit gets 429 with no AI call; other workspaces are unaffected', async () => {
  const saved = process.env.SOCIAL_AI_MONTHLY_REQUEST_LIMIT;
  const Q = await h.createWorkspace({ name: 'Quota full' });
  try {
    process.env.SOCIAL_AI_MONTHLY_REQUEST_LIMIT = '3';
    for (let i = 0; i < 3; i++) {
      await db().run("INSERT INTO usage_ledger (workspace_id, category, quantity, unit, created_at) VALUES (?, 'ai_text', 1, 'request', UTC_TIMESTAMP())", [Q.workspaceId]);
    }
    const email = await db().run("INSERT INTO emails (workspace_id, sender, subject, body, status) VALUES (?, 'Kim', 'Hi', 'Body', 'Unread')", [Q.workspaceId]);
    const calls = [];
    const mock = h.mockFetch([aiOk(calls, '{}')]);
    let analyze;
    let extract;
    let syncAnalysis;
    try {
      analyze = await h.api('POST', `/api/v1/emails/${email.lastID}/ai-analyze`, { token: Q.token });
      extract = await h.api('POST', '/api/v1/products/extract-url', { token: Q.token, body: { url: 'https://quota.invalid/' } });
      // Background inbox sync keeps working past the quota, without AI.
      syncAnalysis = await require('../services/aiEngine').analyzeEmail({ subject: 'Urgent help', body: 'asap', sender: 'Sam' }, null, { workspaceId: Q.workspaceId, fallbackOnQuota: true });
    } finally { mock.restore(); }
    assert.equal(analyze.status, 429);
    assert.equal(analyze.data.code, 'QUOTA_EXCEEDED');
    assert.equal(extract.status, 429);
    assert.equal(syncAnalysis.ai_priority, 'Urgent');
    assert.deepEqual(syncAnalysis.ai_replies, []);
    assert.equal(calls.length, 0, 'no AI call past the quota');
    assert.equal(await usage(Q.workspaceId), 3, 'nothing recorded past the quota');

    // A workspace under the limit still works.
    const okCalls = [];
    const ok = h.mockFetch([aiOk(okCalls, JSON.stringify({ summary: 's', priority: 'Normal', smart_replies: [] }))]);
    const bEmail = await db().run("INSERT INTO emails (workspace_id, sender, subject, body, status) VALUES (?, 'Ann', 'Hi', 'Body', 'Unread')", [B.workspaceId]);
    process.env.SOCIAL_AI_MONTHLY_REQUEST_LIMIT = String((await usage(B.workspaceId)) + 5);
    let r;
    try { r = await h.api('POST', `/api/v1/emails/${bEmail.lastID}/ai-analyze`, { token: B.token }); } finally { ok.restore(); }
    assert.equal(r.status, 200);
    assert.equal(okCalls.length, 1);
  } finally {
    process.env.SOCIAL_AI_MONTHLY_REQUEST_LIMIT = saved;
  }
});

test('metering: calls without a workspace are refused instead of running unmetered', async () => {
  const aiEngine = require('../services/aiEngine');
  await assert.rejects(aiEngine.analyzeEmail({ subject: 's', body: 'b', sender: 'x' }), /requires the workspace/);
  await assert.rejects(aiEngine.extractProductFromWebpage('https://x.invalid', 'text', 'Title', {}), /requires the workspace/);
});
