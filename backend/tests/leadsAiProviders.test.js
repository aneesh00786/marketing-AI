process.env.AI_ROUTE_RATE_MAX = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Leads AI (follow-up advice, AI Lead Discovery) never calls Telnyx; other features still can.
// All providers are mocked; unmatched requests fail loudly.
let A;
let prodA;
const db = () => h.db();

function routes(calls, { groq = true } = {}) {
  const list = [{
    match: u => u.startsWith('https://api.telnyx.com/'),
    respond: () => { calls.telnyx++; return h.json(200, { choices: [{ message: { content: 'telnyx answer' } }] }); }
  }];
  if (groq) {
    list.push(h.groqRoute(req => {
      calls.groq++;
      const prompt = req.messages.map(m => m.content).join(' ');
      if (/KINDS OF BUSINESSES/.test(prompt)) return JSON.stringify({ categories: [{ name: 'Wholesale distributors', why: 'resellers' }] });
      if (/Assess how well each business/.test(prompt)) return JSON.stringify({ results: [] });
      return 'Call them this week to qualify their need.';
    }));
  } else {
    list.push({ match: u => u.startsWith('https://api.groq.com/'), respond: () => { calls.groq++; return h.json(500, {}); } });
  }
  list.push({ match: u => u.startsWith('https://places.googleapis.com/'), respond: () => h.json(200, { places: [{ id: 'ChIJproviderTest01', displayName: { text: 'Biz' }, businessStatus: 'OPERATIONAL' }] }) });
  return list;
}

test.before(async () => {
  await h.prepareDatabase();
  process.env.TELNYX_API_KEY = 'KEY01_test_telnyx_key';
  process.env.GOOGLE_PLACES_API_KEY = 'test-places-key';
  A = await h.createWorkspace({ name: 'Leads AI providers' });
  prodA = (await db().run("INSERT INTO digital_products (workspace_id, name, status, created_at) VALUES (?, 'VanSales App', 'Active', UTC_TIMESTAMP())", [A.workspaceId])).lastID;
});
test.after(() => { process.env.TELNYX_API_KEY = ''; return h.shutdown(); });

test('lead follow-up advice and AI Lead Discovery never call Telnyx', async () => {
  const calls = { telnyx: 0, groq: 0 };
  const mock = h.mockFetch(routes(calls));
  try {
    const lead = (await h.api('POST', '/api/v1/leads', { token: A.token, body: { name: 'Lead One', productId: prodA } })).data.lead;
    const advice = await h.api('POST', `/api/v1/leads/${lead.id}/ai-qualify`, { token: A.token });
    assert.equal(advice.status, 200, JSON.stringify(advice.data));
    assert.equal(advice.data.ai.available, true);
    assert.equal(advice.data.lead.aiSuggestion, 'Call them this week to qualify their need.');

    const plan = await h.api('POST', '/api/v1/leads/discovery/plan', { token: A.token, body: { businessType: 'B2B businesses', countryCode: 'IN', productId: prodA, expandCategories: true } });
    assert.deepEqual(plan.data.plan.categories, ['B2B businesses', 'Wholesale distributors']);

    const search = await h.api('POST', '/api/v1/leads/discovery/search', { token: A.token, body: { businessType: 'Retailers', countryCode: 'IN', productId: prodA, scope: 'country', maxRequests: 1 } });
    assert.equal(search.status, 200, JSON.stringify(search.data));
    assert.equal(search.data.ai.available, true, 'product fit ran on another provider');
  } finally { mock.restore(); }
  assert.equal(calls.telnyx, 0, 'Telnyx is never called by Leads');
  assert.ok(calls.groq >= 3);
  const providers = await db().all("SELECT DISTINCT provider_key FROM usage_ledger WHERE workspace_id = ? AND category = 'ai_text'", [A.workspaceId]);
  assert.ok(providers.length && providers.every(p => !/telnyx/i.test(p.provider_key)));
});

test('without another provider, Leads AI is reported unavailable instead of falling back to Telnyx', async () => {
  const calls = { telnyx: 0, groq: 0 };
  const mock = h.mockFetch(routes(calls, { groq: false }));
  try {
    const lead = (await h.api('POST', '/api/v1/leads', { token: A.token, body: { name: 'Lead Two' } })).data.lead;
    const advice = await h.api('POST', `/api/v1/leads/${lead.id}/ai-qualify`, { token: A.token });
    assert.equal(advice.data.ai.available, false);
    const plan = await h.api('POST', '/api/v1/leads/discovery/plan', { token: A.token, body: { businessType: 'B2B businesses', countryCode: 'IN', productId: prodA, expandCategories: true } });
    assert.match(plan.data.plan.ai.reason, /only your business type is searched/);
  } finally { mock.restore(); }
  assert.equal(calls.telnyx, 0);

  const { generateText } = require('../lib/aiStructured');
  const m2 = h.mockFetch(routes(calls, { groq: false }));
  try {
    await assert.rejects(generateText({ workspaceId: A.workspaceId, prompt: 'x', system: 'y', excludeProviders: ['telnyx'] }), /Telnyx is not used for this feature/);
  } finally { m2.restore(); }
});

test('features outside Leads still use Telnyx', async () => {
  const calls = { telnyx: 0, groq: 0 };
  const mock = h.mockFetch(routes(calls));
  let res;
  try { res = await require('../services/aiEngine').generateAiResponse('Hello there', 'Be brief.', A.workspaceId, { maxTokens: 20 }); } finally { mock.restore(); }
  assert.equal(calls.telnyx, 1);
  assert.match(res.provider, /Telnyx/);
});
