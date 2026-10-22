// Generous limits for this file; the budget tests set their own.
process.env.AI_ROUTE_RATE_MAX = '1000';
process.env.LEAD_DISCOVERY_DAILY_SEARCHES = '1000';
process.env.LEAD_DISCOVERY_DAILY_REQUESTS = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// AI Lead Discovery coverage: several distinct queries (AI categories, then states/cities seen in
// Google's results), pagination, de-duplication across queries, budgets and streaming progress.
// Google and AI are mocked; unmatched requests fail loudly.
let A;
let prodA;
const db = () => h.db();
const api = (who, method, path, body, headers) => h.api(method, `/api/v1/leads/discovery${path}`, { token: who.token, body, headers });

const REGIONS = { Kerala: 'KL', 'Tamil Nadu': 'TN', Karnataka: 'KA' };
function place(id, { region = 'Kerala', city = 'Kochi', status = 'OPERATIONAL' } = {}) {
  return {
    id: `ChIJcov${id}`.padEnd(20, 'x'),
    displayName: { text: `Biz ${id}` },
    formattedAddress: `${id} Road, ${city}, ${region}, India`,
    addressComponents: [
      { longText: city, types: ['locality'] },
      { longText: region, shortText: REGIONS[region] || region, types: ['administrative_area_level_1'] },
      { longText: 'India', shortText: 'IN', types: ['country'] }
    ],
    types: ['wholesaler'], businessStatus: status, internationalPhoneNumber: `+91 80 ${String(id).padStart(8, '0')}`
  };
}
const ids = (prefix, from, n, opts) => Array.from({ length: n }, (_, i) => place(`${prefix}${from + i}`, opts));

/** Google mock answering by query text and page token: book[textQuery] = [page1, page2, ...]. */
function google(book, calls) {
  return {
    match: u => u.startsWith('https://places.googleapis.com/v1/places:searchText'),
    respond: (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const pages = book[body.textQuery] || [];
      const idx = body.pageToken ? Number(body.pageToken.replace('page-', '')) : 0;
      const page = typeof pages === 'function' ? pages(idx) : pages[idx];
      if (page && (page.status || page instanceof Error)) return page;
      if (!page) return h.json(200, {});
      return h.json(200, { places: page, ...(pages[idx + 1] ? { nextPageToken: `page-${idx + 1}` } : {}) });
    }
  };
}
const aiCategories = names => h.groqRoute(() => JSON.stringify({ categories: names.map(n => ({ name: n, why: 'fits the description' })) }));

async function run(body, book, extraRoutes = [], headers) {
  const calls = [];
  const mock = h.mockFetch([google(book, calls), ...extraRoutes]);
  try {
    const r = await api(A, 'POST', '/search', body, headers);
    return { r, calls, queries: calls.map(c => c.textQuery) };
  } finally { mock.restore(); }
}
const uniq = () => Math.random().toString(36).slice(2, 7);

test.before(async () => {
  await h.prepareDatabase();
  process.env.GOOGLE_PLACES_API_KEY = 'test-places-key-coverage';
  A = await h.createWorkspace({ name: 'Coverage' });
  prodA = (await db().run("INSERT INTO digital_products (workspace_id, name, description, target_audience, status, created_at) VALUES (?, 'VanSales App', 'Order booking for van sales teams', 'Distributors with field sales reps', 'Active', UTC_TIMESTAMP())", [A.workspaceId])).lastID;
});
test.after(() => h.shutdown());

test('a broad business type is expanded into AI categories; invalid suggestions are dropped; the plan shows the budget', async () => {
  const ai = aiCategories(['Wholesale distributors', 'Industrial suppliers', 'shops in Mumbai', 'Packaging suppliers', 'wholesale distributors', '24x7 Stores', 'B2B businesses']);
  const mock = h.mockFetch([ai]);
  let plan;
  try { plan = await api(A, 'POST', '/plan', { businessType: 'B2B businesses', countryCode: 'IN', productId: prodA, expandCategories: true, maxResults: 300, maxRequests: 10 }); } finally { mock.restore(); }
  assert.equal(plan.status, 200, JSON.stringify(plan.data));
  const p = plan.data.plan;
  assert.deepEqual(p.categories, ['B2B businesses', 'Wholesale distributors', 'Industrial suppliers', 'Packaging suppliers'], 'user type first; locations, numbers and repeats removed');
  assert.deepEqual(p.firstQueries, ['B2B businesses in India', 'Wholesale distributors in India', 'Industrial suppliers in India', 'Packaging suppliers in India']);
  assert.equal(p.scope, 'country');
  assert.match(p.progressive, /states where Google's results are/);
  assert.equal(p.budget.allowedRequests, 10);
  assert.equal(p.budget.maxPlacesBeforeDuplicates, 200);
  assert.match(p.budget.shortfall, /target of 300 is more than 10 Google request\(s\) can return: at most 200 places/);
  assert.equal(p.budget.maxCostUsd, 0.35);

  const down = h.mockFetch([{ match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) }]);
  let noAi;
  try { noAi = await api(A, 'POST', '/plan', { businessType: 'B2B businesses', countryCode: 'IN', productId: prodA, expandCategories: true }); } finally { down.restore(); }
  assert.deepEqual(noAi.data.plan.categories, ['B2B businesses']);
  assert.match(noAi.data.plan.ai.reason, /only your business type is searched/);
});

test('multi-query search: every category runs, results are de-duplicated across queries, and identical queries never repeat', async () => {
  const t = `Traders ${uniq()}`;
  const book = {
    [`${t} in Kerala, India`]: [ids('a', 1, 20), ids('a', 21, 5)],
    [`Wholesale distributors in Kerala, India`]: [[...ids('a', 1, 10), ...ids('b', 1, 10)]],
    [`Packaging suppliers in Kerala, India`]: [ids('c', 1, 8)]
  };
  const { r, queries } = await run({ businessType: t, countryCode: 'IN', region: 'Kerala', productId: prodA, aiQualify: false, categories: [t, 'Wholesale distributors', 'wholesale distributors', 'Packaging suppliers'], maxResults: 300, maxRequests: 20 }, book);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(queries.slice(0, 4), [`${t} in Kerala, India`, `${t} in Kerala, India`, 'Wholesale distributors in Kerala, India', 'Packaging suppliers in Kerala, India'], 'page 2 of the first query, then one query per distinct category');
  const s = r.data.summary;
  assert.equal(s.found, 25 + 10 + 8, 'unique businesses across all queries');
  assert.equal(s.repeatsAcrossQueries, 10, 'the 10 repeats from the second category are counted, not added');
  assert.equal(s.raw, 25 + 20 + 8);
  assert.deepEqual(r.data.coverage.categories, [t, 'Wholesale distributors', 'Packaging suppliers']);
  assert.equal(r.data.coverage.categoriesFrom, 'you');
  // Region scope continues in the city seen in Google's results; each query text runs once.
  const texts = r.data.queries.map(q => q.query);
  assert.equal(new Set(texts).size, texts.length);
  assert.ok(texts.includes(`${t} in Kochi, Kerala, India`));
});

test('a query whose pages are mostly repeats stops paging; the search moves on to other queries', async () => {
  const t = `Repeaters ${uniq()}`;
  const book = {
    [`${t} in India`]: [ids('r', 1, 20)],
    [`Second kind in India`]: [[...ids('r', 1, 19), place('r100')], ids('r', 200, 20), ids('r', 300, 20)],
    [`Third kind in India`]: [ids('t', 1, 5)]
  };
  const { r, queries } = await run({ businessType: t, countryCode: 'IN', productId: prodA, aiQualify: false, categories: [t, 'Second kind', 'Third kind'], maxResults: 300, maxRequests: 20 }, book);
  const second = r.data.queries.find(q => q.query === 'Second kind in India');
  assert.equal(second.requests, 1, 'page 2 is not requested when page 1 was 95% repeats');
  assert.match(second.note, /mostly businesses already found/);
  assert.ok(queries.includes('Third kind in India'), 'the next query still runs');
  assert.equal(r.data.summary.found, 20 + 1 + 5);
});

test('budgets are enforced on the server and explained', async () => {
  const t = `Budget ${uniq()}`;
  const book = {
    [`${t} in India`]: [ids('x', 1, 20), ids('x', 21, 20), ids('x', 41, 20)],
    [`Other kind in India`]: [ids('y', 1, 20), ids('y', 21, 20)]
  };
  const { r, calls } = await run({ businessType: t, countryCode: 'IN', productId: prodA, aiQualify: false, categories: [t, 'Other kind'], maxResults: 100, maxRequests: 4 }, book);
  assert.equal(calls.length, 4, 'never more Google requests than the budget');
  assert.equal(r.data.summary.found, 80);
  assert.equal(r.data.coverage.stopReason, 'budget_exhausted');
  assert.match(r.data.coverage.explanation, /target of 100 is more than 4 Google request\(s\) can return: at most 80 places/);
  assert.match(r.data.coverage.explanation, /Found 80 unique business\(es\) of the 100 requested/);
  assert.equal(r.data.coverage.remainingRequests, 0);
  assert.equal(r.data.coverage.estimatedCostUsd, 0.14);
  const usage = await db().get("SELECT SUM(quantity) AS n FROM usage_ledger WHERE workspace_id = ? AND category = 'places_search' AND reference_type = 'lead_discovery'", [A.workspaceId]);
  assert.ok(Number(usage.n) >= 4, 'every Google request is metered');

  const target = await run({ businessType: `${t} B`, countryCode: 'IN', productId: prodA, aiQualify: false, categories: [`${t} B`], maxResults: 25, maxRequests: 10 }, { [`${t} B in India`]: [ids('z', 1, 20), ids('z', 21, 20), ids('z', 41, 20)] });
  assert.equal(target.calls.length, 2, 'stops once the target is reached');
  assert.equal(target.r.data.coverage.stopReason, 'reached_target');
  assert.equal(target.r.data.summary.found, 25);
});

test('the daily Google request budget caps a search and then refuses new ones', async () => {
  const ws = await h.createWorkspace({ name: 'Daily budget' });
  const prod = (await db().run("INSERT INTO digital_products (workspace_id, name, status, created_at) VALUES (?, 'P', 'Active', UTC_TIMESTAMP())", [ws.workspaceId])).lastID;
  process.env.LEAD_DISCOVERY_DAILY_REQUESTS = '3';
  try {
    const calls = [];
    const book = { 'Daily kind in India': [ids('d', 1, 20), ids('d', 21, 20), ids('d', 41, 20)], 'More kind in India': [ids('e', 1, 20)] };
    let mock = h.mockFetch([google(book, calls)]);
    let r;
    try { r = await api(ws, 'POST', '/search', { businessType: 'Daily kind', countryCode: 'IN', productId: prod, aiQualify: false, categories: ['Daily kind', 'More kind'], maxResults: 300, maxRequests: 10 }); } finally { mock.restore(); }
    assert.equal(r.status, 200);
    assert.equal(calls.length, 3);
    assert.equal(r.data.coverage.allowedRequests, 3);
    assert.equal(r.data.coverage.stopReason, 'daily_budget');
    mock = h.mockFetch([google(book, calls)]);
    try { r = await api(ws, 'POST', '/search', { businessType: 'Another kind', countryCode: 'IN', productId: prod }); } finally { mock.restore(); }
    assert.deepEqual([r.status, r.data.code], [429, 'DISCOVERY_DAILY_REQUESTS']);
    assert.equal(calls.length, 3, 'no request once the daily budget is used');
  } finally { process.env.LEAD_DISCOVERY_DAILY_REQUESTS = '100000'; }
});

test('country-wide coverage continues in the states found in Google\'s results; a city search stays in the city', async () => {
  const t = `Statewide ${uniq()}`;
  const book = {
    [`${t} in India`]: [[...ids('k', 1, 3), ...ids('tn', 1, 2, { region: 'Tamil Nadu', city: 'Chennai' }), place('ka1', { region: 'Karnataka', city: 'Bengaluru' })]],
    [`${t} in Kerala, India`]: [ids('k', 10, 4)],
    [`${t} in Tamil Nadu, India`]: [ids('tn', 10, 3, { region: 'Tamil Nadu', city: 'Chennai' })],
    [`${t} in Karnataka, India`]: [ids('ka', 10, 2, { region: 'Karnataka', city: 'Bengaluru' })]
  };
  const { r, queries } = await run({ businessType: t, countryCode: 'IN', productId: prodA, aiQualify: false, maxResults: 300, maxRequests: 10 }, book);
  assert.deepEqual(queries, [`${t} in India`, `${t} in Kerala, India`, `${t} in Tamil Nadu, India`, `${t} in Karnataka, India`], 'states ordered by how many results were there');
  assert.equal(r.data.summary.found, 6 + 4 + 3 + 2);
  assert.ok(r.data.queries.slice(1).every(q => q.tier === 'local'));

  const city = await run({ businessType: `${t} city`, countryCode: 'IN', region: 'Kerala', city: 'Kochi', productId: prodA, aiQualify: false, maxRequests: 10 }, { [`${t} city in Kochi, Kerala, India`]: [ids('c', 1, 3)] });
  assert.deepEqual(city.queries, [`${t} city in Kochi, Kerala, India`], 'no wider queries for a city search');
  assert.equal(city.r.data.run.scope, 'city');

  const region = await run({ businessType: `${t} r`, countryCode: 'IN', region: 'Kerala', productId: prodA, aiQualify: false, maxRequests: 10 },
    { [`${t} r in Kerala, India`]: [[...ids('rk', 1, 2, { city: 'Kochi' }), place('rk9', { city: 'Thrissur' }), place('rtn', { region: 'Tamil Nadu', city: 'Chennai' })]] });
  assert.deepEqual(region.queries.slice(1), [`${t} r in Kochi, Kerala, India`, `${t} r in Thrissur, Kerala, India`], 'only cities inside the chosen state');
});

test('a failed query does not lose results: others continue and the search is reported as partial', async () => {
  const t = `Flaky ${uniq()}`;
  const book = {
    [`${t} in India`]: [ids('f', 1, 6)],
    [`Slow kind in India`]: [h.json(500, { error: { status: 'INTERNAL' } })],
    [`Good kind in India`]: [ids('g', 1, 4)]
  };
  const { r } = await run({ businessType: t, countryCode: 'IN', productId: prodA, aiQualify: false, categories: [t, 'Slow kind', 'Good kind'], scope: 'country', maxRequests: 3 }, book);
  assert.equal(r.status, 200);
  assert.equal(r.data.summary.found, 10);
  assert.equal(r.data.run.status, 'partial');
  assert.match(r.data.partial.message, /1 of 3 queries failed/);
  assert.equal(r.data.queries.find(q => q.query === 'Slow kind in India').status, 'error');

  const quota = await run({ businessType: `${t} Q`, countryCode: 'IN', productId: prodA, aiQualify: false, categories: [`${t} Q`, 'Quota kind', 'Never run'], maxRequests: 10 },
    { [`${t} Q in India`]: [ids('q', 1, 5)], 'Quota kind in India': [h.json(429, { error: { status: 'RESOURCE_EXHAUSTED' } })], 'Never run in India': [ids('n', 1, 5)] });
  assert.equal(quota.r.data.summary.found, 5, 'results before the quota error are kept');
  assert.ok(!quota.queries.includes('Never run in India'), 'no further requests after a quota error');
  assert.equal(quota.r.data.coverage.stopReason, 'quota');
});

test('streaming search sends progress then the result; validation errors return before streaming', async () => {
  const t = `Stream ${uniq()}`;
  const calls = [];
  const mock = h.mockFetch([google({ [`${t} in India`]: [ids('s', 1, 20), ids('s', 21, 3)], [`Next kind in India`]: [ids('sn', 1, 2)] }, calls)]);
  let r;
  let bad;
  try {
    r = await api(A, 'POST', '/search', { businessType: t, countryCode: 'IN', productId: prodA, aiQualify: false, categories: [t, 'Next kind'], scope: 'country', maxRequests: 3 }, { Accept: 'application/x-ndjson' });
    bad = await api(A, 'POST', '/search', { businessType: t, countryCode: 'IN' }, { Accept: 'application/x-ndjson' });
  } finally { mock.restore(); }
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/x-ndjson/);
  const lines = String(r.data).trim().split('\n').map(l => JSON.parse(l));
  const progress = lines.filter(l => l.type === 'progress');
  assert.ok(progress.length >= 3);
  assert.ok(progress.some(p => p.current === `${t} in India` && p.maxRequests === 3));
  const result = lines.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.summary.found, 25);
  assert.ok(!JSON.stringify(lines).includes('test-places-key-coverage'), 'the key is never streamed');
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'VALIDATION_ERROR');
});

test('imports work for more than one page of results and stay linked to the product', async () => {
  const t = `Bulk ${uniq()}`;
  const { r } = await run({ businessType: t, countryCode: 'IN', productId: prodA, aiQualify: false, categories: [t, 'Second bulk'], maxResults: 120, maxRequests: 6 },
    { [`${t} in India`]: [ids('m', 1, 20), ids('m', 21, 20), ids('m', 41, 20)], 'Second bulk in India': [ids('m', 61, 20), ids('m', 81, 20)] });
  assert.equal(r.data.summary.found, 100);
  const imp = await api(A, 'POST', `/runs/${r.data.run.id}/import`, { placeIds: r.data.results.map(x => x.placeId) });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  assert.equal(imp.data.created.length, 100);
  const linked = await db().get('SELECT COUNT(*) AS n FROM leads l JOIN lead_place_refs r ON r.lead_id = l.id WHERE r.run_id = ? AND l.product_id = ?', [r.data.run.id, prodA]);
  assert.equal(Number(linked.n), 100);
  // Nothing Google returned was stored with the run.
  const stored = JSON.stringify(await db().get('SELECT * FROM lead_discovery_runs WHERE id = ?', [r.data.run.id]));
  assert.ok(!/Biz m|Road, Kochi|\+91 80/.test(stored));
});
