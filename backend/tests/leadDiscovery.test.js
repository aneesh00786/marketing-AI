// Generous limits for this file; each limit has its own test below with a fresh workspace.
process.env.AI_ROUTE_RATE_MAX = '1000';
process.env.LEAD_DISCOVERY_DAILY_SEARCHES = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// AI Lead Discovery with Google Places API (New). Google and AI are mocked; unmatched requests
// fail loudly, so no real API credits are used.
const KEY = 'test-places-key-SECRET-123';
let A;
let B;
let prodA;
let prodB;
const db = () => h.db();
const api = (who, method, path, body) => h.api(method, `/api/v1/leads/discovery${path}`, { token: who.token, body });

function place(i, extra = {}) {
  return {
    id: `ChIJplace${String(i).padStart(4, '0')}abcdef`,
    displayName: { text: `Business ${i}`, languageCode: 'en' },
    formattedAddress: `${i} Market Road, Kochi, Kerala 682001, India`,
    addressComponents: [
      { longText: 'Kochi', shortText: 'Kochi', types: ['locality', 'political'] },
      { longText: 'Kerala', shortText: 'KL', types: ['administrative_area_level_1', 'political'] },
      { longText: '682001', shortText: '682001', types: ['postal_code'] },
      { longText: 'India', shortText: 'IN', types: ['country', 'political'] }
    ],
    types: ['wholesaler', 'point_of_interest', 'establishment'],
    primaryType: 'wholesaler',
    primaryTypeDisplayName: { text: 'Wholesaler', languageCode: 'en' },
    businessStatus: 'OPERATIONAL',
    googleMapsUri: `https://maps.google.com/?cid=${1000 + i}`,
    internationalPhoneNumber: `+91 484 ${String(2000000 + i)}`,
    websiteUri: `https://business${i}.in/`,
    ...extra
  };
}

/** Google route: `pages` is an array of { places, nextPageToken } or a function per call. */
function google(pages, calls = []) {
  return {
    match: u => u.startsWith('https://places.googleapis.com/'),
    respond: (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
      const page = typeof pages === 'function' ? pages(calls.length - 1, url, init) : pages[calls.length - 1];
      if (page instanceof Error || (page && page.status)) return page;
      return h.json(200, page || {});
    }
  };
}

async function searchWith(who, body, pages, extraRoutes = []) {
  const calls = [];
  const mock = h.mockFetch([google(pages, calls), ...extraRoutes]);
  try {
    const r = await api(who, 'POST', '/search', body);
    return { r, calls };
  } finally { mock.restore(); }
}

// Every search targets a product; AI fit is off unless a test turns it on.
const base = (extra = {}) => ({ businessType: `Wholesale distributors ${Math.random().toString(36).slice(2, 7)}`, countryCode: 'IN', productId: prodA, aiQualify: false, ...extra });
const productFor = async ws => (await db().run("INSERT INTO digital_products (workspace_id, name, status, created_at) VALUES (?, 'Route Planner', 'Active', UTC_TIMESTAMP())", [ws.workspaceId])).lastID;

test.before(async () => {
  await h.prepareDatabase();
  process.env.GOOGLE_PLACES_API_KEY = KEY;
  A = await h.createWorkspace({ name: 'Discovery A' });
  B = await h.createWorkspace({ name: 'Discovery B' });
  prodA = (await db().run("INSERT INTO digital_products (workspace_id, name, description, target_audience, features_json, status, created_at) VALUES (?, 'VanSales App', 'Mobile order booking for van sales teams', 'FMCG distributors with field sales reps', '[\"order booking\",\"route planning\"]', 'Active', UTC_TIMESTAMP())", [A.workspaceId])).lastID;
  prodB = (await db().run("INSERT INTO digital_products (workspace_id, name, status, created_at) VALUES (?, 'Other Product', 'Active', UTC_TIMESTAMP())", [B.workspaceId])).lastID;
});
test.after(() => h.shutdown());

test('validation: business type and country are required; limits are enforced', async () => {
  const cases = [
    [{ countryCode: 'IN', productId: prodA }, /businessType/],
    [{ businessType: 'Distributors', productId: prodA }, /countryCode/],
    [{ businessType: 'Distributors', countryCode: 'IN' }, /Choose the product these leads are for/],
    [{ businessType: 'Distributors', countryCode: 'IN', productId: '' }, /Choose the product these leads are for/],
    [{ businessType: 'D', countryCode: 'IN', productId: prodA }, /business type/i],
    [{ businessType: 'Distributors', countryCode: 'XX', productId: prodA }, /valid country/],
    [{ businessType: 'Distributors', countryCode: 'DD', productId: prodA }, /valid country/],
    [{ businessType: 'Distributors', countryCode: 'IN', productId: prodA, maxResults: 301 }, /at most 300 unique results/],
    [{ businessType: 'Distributors', countryCode: 'IN', productId: prodA, maxRequests: 21 }, /at most 20 Google requests/],
    [{ businessType: 'Distributors', countryCode: 'IN', productId: prodA, scope: 'city' }, /Enter the city/],
    [{ businessType: 'Distributors', countryCode: 'IN', productId: prodA, scope: 'region' }, /Enter the state or region/],
    [{ businessType: 'Distributors', countryCode: 'IN', productId: prodA, categories: ['shops in Delhi', '123'] }, /Each category must name a kind of business/],
    [{ businessType: 'Distributors', countryCode: 'IN', productId: prodA, workspaceId: 999 }, /Unrecognized key/]
  ];
  const mock = h.mockFetch([]);
  try {
    for (const [body, msg] of cases) {
      const r = await api(A, 'POST', '/search', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.data.error, msg);
    }
  } finally { mock.restore(); }
  assert.equal(mock.calls.length, 0, 'nothing reaches Google for an invalid request');
});

test('search query is built only from the user\'s inputs', () => {
  const { buildTextQuery } = require('../modules/leadDiscovery/googlePlacesProvider');
  assert.equal(buildTextQuery({ businessType: 'IT service companies', countryCode: 'IN', region: 'Kerala' }), 'IT service companies in Kerala, India');
  assert.equal(buildTextQuery({ businessType: 'Wholesale distributors', keywords: 'FMCG', city: 'Kochi', region: 'Kerala', countryCode: 'in' }), 'Wholesale distributors (FMCG) in Kochi, Kerala, India');
  assert.equal(buildTextQuery({ businessType: 'Bakeries', countryCode: 'AE' }), 'Bakeries in United Arab Emirates');
});

test('results are parsed and mapped; missing fields stay unavailable; the key stays on the server', async () => {
  const noContact = place(2, { internationalPhoneNumber: undefined, nationalPhoneNumber: undefined, websiteUri: undefined, addressComponents: undefined, primaryTypeDisplayName: undefined });
  const closed = place(3, { businessStatus: 'CLOSED_PERMANENTLY' });
  const { r, calls } = await searchWith(A, base({ region: 'Kerala', maxResults: 10 }), [{ places: [place(1), noContact, closed, { displayName: { text: 'no id' } }] }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [p1, p2, p3] = r.data.results;
  assert.deepEqual(
    { name: p1.name, category: p1.category, city: p1.city, region: p1.region, postalCode: p1.postalCode, country: p1.country, phone: p1.phone, website: p1.website, maps: p1.googleMapsUri },
    { name: 'Business 1', category: 'Wholesaler', city: 'Kochi', region: 'Kerala', postalCode: '682001', country: 'India', phone: '+91 484 2000001', website: 'https://business1.in/', maps: 'https://maps.google.com/?cid=1001' }
  );
  assert.deepEqual([p2.phone, p2.website, p2.city, p2.category], [null, null, null, 'wholesaler'], 'unavailable values are null, never invented');
  assert.equal(p2.missingContact, true);
  assert.equal(p2.eligible, true);
  assert.deepEqual([p3.eligible, p3.ineligibleReason], [false, 'permanently_closed']);
  assert.equal(r.data.results.length, 3, 'a place without an id is dropped');
  // Region scope: after the first query, the city seen in Google's results (Kochi) is searched too.
  assert.deepEqual(r.data.summary, { found: 3, raw: 3, repeatsAcrossQueries: 0, duplicates: 0, possibleDuplicates: 0, eligible: 2, missingContact: 1, closed: 1, requests: 2, queries: 2, requested: 10 });
  assert.deepEqual(r.data.queries.map(q => q.query), [r.data.run.textQuery, r.data.run.textQuery.replace(' in Kerala, India', ' in Kochi, Kerala, India')]);
  assert.equal(r.data.attribution, 'Google Maps');
  assert.match(r.data.notice, /Each Google query returns at most 60 places/);

  const call = calls[0];
  assert.equal(call.url, 'https://places.googleapis.com/v1/places:searchText');
  assert.equal(call.headers['X-Goog-Api-Key'], KEY);
  assert.ok(!call.url.includes(KEY), 'key never in a URL');
  assert.match(call.headers['X-Goog-FieldMask'], /places\.websiteUri/);
  assert.deepEqual(call.body, { textQuery: r.data.run.textQuery, pageSize: 20, regionCode: 'in', languageCode: 'en' });
  assert.ok(!JSON.stringify(r.data).includes(KEY), 'key never in a response');

  // Without contact details the cheaper field mask is used.
  const lean = await searchWith(A, base({ includeContacts: false }), [{ places: [place(9)] }]);
  assert.doesNotMatch(lean.calls[0].headers['X-Goog-FieldMask'], /websiteUri|PhoneNumber/);

  // Nothing Google returned is stored: only place ids and our own flags.
  const stored = JSON.stringify(await db().all('SELECT * FROM lead_discovery_runs r JOIN lead_discovery_places p ON p.run_id = r.id WHERE r.id = ?', [r.data.run.id]));
  for (const v of ['Business 1', 'Market Road', '2000001', 'business1.in', 'cid=1001']) assert.ok(!stored.includes(v), `${v} must not be stored`);
  assert.ok(stored.includes(p1.placeId));
});

test('pagination follows page tokens and stops at the requested maximum', async () => {
  const pages = [0, 1, 2].map(n => ({ places: Array.from({ length: 20 }, (_, i) => place(100 + n * 20 + i)), nextPageToken: n < 2 ? `token-${n + 1}` : undefined }));
  const small = await searchWith(A, base({ maxResults: 25 }), pages);
  assert.equal(small.r.status, 200);
  assert.equal(small.r.data.results.length, 25);
  assert.equal(small.calls.length, 2, 'stops once enough results arrive');
  assert.equal(small.calls[1].body.pageToken, 'token-1');
  assert.equal(small.calls[1].body.pageSize, 20, 'every page repeats the same parameters');

  const full = await searchWith(A, base({ maxResults: 60 }), pages);
  assert.equal(full.r.data.results.length, 60);
  assert.equal(full.calls.length, 3);

  const few = await searchWith(A, base({ maxResults: 60 }), [{ places: [place(400), place(401)] }]);
  assert.equal(few.r.data.results.length, 2);
  assert.equal(few.r.data.coverage.stopReason, 'no_more_queries');
  assert.match(few.r.data.coverage.explanation, /Found 2 unique business\(es\) of the 60 requested/);
});

test('quota errors, timeouts, malformed responses and partial results are reported honestly', async () => {
  const quota = await searchWith(A, base(), [h.json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } })]);
  assert.deepEqual([quota.r.status, quota.r.data.code], [429, 'PLACES_QUOTA']);
  assert.match(quota.r.data.error, /quota or rate limit/);
  const failed = await db().get("SELECT status, error_code FROM lead_discovery_runs WHERE workspace_id = ? ORDER BY id DESC LIMIT 1", [A.workspaceId]);
  assert.deepEqual(failed, { status: 'failed', error_code: 'QUOTA_EXCEEDED' });

  const denied = await searchWith(A, base(), [h.json(403, { error: { status: 'PERMISSION_DENIED', message: 'Places API (New) has not been used in project 123 before or it is disabled.' } })]);
  assert.deepEqual([denied.r.status, denied.r.data.code], [502, 'PLACES_PERMISSION_DENIED']);
  assert.match(denied.r.data.error, /not been used in project/);

  const partial = await searchWith(A, base({ maxResults: 40 }), [{ places: Array.from({ length: 20 }, (_, i) => place(500 + i)), nextPageToken: 't2' }, h.json(429, { error: { status: 'RESOURCE_EXHAUSTED' } })]);
  assert.equal(partial.r.status, 200);
  assert.equal(partial.r.data.run.status, 'partial');
  assert.equal(partial.r.data.results.length, 20);
  assert.match(partial.r.data.partial.message, /quota or rate limit was reached/);
  assert.equal(partial.r.data.coverage.stopReason, 'quota');

  const malformed = await searchWith(A, base(), [{ status: 200, text: '<html>not json</html>' }]);
  assert.deepEqual([malformed.r.status, malformed.r.data.code], [502, 'PLACES_PROVIDER_ERROR']);
  const wrongShape = await searchWith(A, base(), [{ places: 'nope' }]);
  assert.deepEqual([wrongShape.r.status, wrongShape.r.data.code], [502, 'PLACES_PROVIDER_ERROR']);

  process.env.PLACES_TIMEOUT_MS = '150';
  try {
    const calls = [];
    const mock = h.mockFetch([{ match: u => u.startsWith('https://places.googleapis.com/'), respond: (url, init) => { calls.push(url); return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))); } }]);
    let r;
    try { r = await api(A, 'POST', '/search', base()); } finally { mock.restore(); }
    assert.deepEqual([r.status, r.data.code], [504, 'PLACES_TIMEOUT']);
  } finally { delete process.env.PLACES_TIMEOUT_MS; }
});

test('missing API key: clear 503 and nothing sent to Google', async () => {
  delete process.env.GOOGLE_PLACES_API_KEY;
  try {
    const cfg = await api(A, 'GET', '/config');
    assert.equal(cfg.data.config.configured, false);
    const { r, calls } = await searchWith(A, base(), [{ places: [place(1)] }]);
    assert.deepEqual([r.status, r.data.code], [503, 'PLACES_NOT_CONFIGURED']);
    assert.equal(calls.length, 0);
  } finally { process.env.GOOGLE_PLACES_API_KEY = KEY; }
  const cfg = await api(A, 'GET', '/config');
  assert.equal(cfg.data.config.configured, true);
  assert.equal(cfg.data.config.maxResults, 300);
  assert.equal(cfg.data.config.maxRequests, 20);
  assert.equal(cfg.data.config.resultsPerRequest, 20);
  assert.ok(!JSON.stringify(cfg.data).includes(KEY));
});

test('duplicates: place id, phone and website domain are reliable; a name-only match is only a warning', async () => {
  const ws = await h.createWorkspace({ name: 'Dedup' });
  const wsProduct = await productFor(ws);
  await db().run("INSERT INTO leads (workspace_id, name, phone, email, company_name, status, created_at) VALUES (?, 'Ravi', '0484-2000701', NULL, NULL, 'New', UTC_TIMESTAMP())", [ws.workspaceId]);
  await db().run("INSERT INTO leads (workspace_id, name, email, company_name, status, created_at) VALUES (?, 'Asha', 'asha@business702.in', NULL, 'New', UTC_TIMESTAMP())", [ws.workspaceId]);
  await db().run("INSERT INTO leads (workspace_id, name, email, company_name, status, created_at) VALUES (?, 'Joe', 'joe@gmail.com', 'Business 703 Pvt Ltd', 'New', UTC_TIMESTAMP())", [ws.workspaceId]);
  const { r } = await searchWith(ws, base({ productId: wsProduct }), [{ places: [place(701), place(702), place(703, { websiteUri: 'https://gmail.com/' }), place(704)] }]);
  const by = Object.fromEntries(r.data.results.map(x => [x.name, x]));
  assert.equal(by['Business 701'].duplicate.reason, 'phone');
  assert.equal(by['Business 702'].duplicate.reason, 'website_domain');
  assert.equal(by['Business 703'].duplicate, null, 'a free-mail domain is not evidence of the same business');
  assert.equal(by['Business 703'].possibleDuplicate.reason, 'name');
  assert.equal(by['Business 703'].eligible, true, 'similar names alone never block import');
  assert.equal(by['Business 704'].duplicate, null);
  assert.deepEqual([r.data.summary.duplicates, r.data.summary.possibleDuplicates, r.data.summary.eligible], [2, 1, 2]);

  const imp = await api(ws, 'POST', `/runs/${r.data.run.id}/import`, { placeIds: r.data.results.map(x => x.placeId) });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  assert.equal(imp.data.created.length, 2);
  assert.equal(imp.data.duplicates.length, 2);
  const again = await searchWith(ws, base({ productId: wsProduct }), [{ places: [place(704)] }]);
  assert.equal(again.r.data.results[0].duplicate.reason, 'place_id', 'an imported place is recognised on later searches');
});

test('import: product link, no Google content stored, safe re-import and per-record outcomes', async () => {
  const { r } = await searchWith(A, base({ productId: prodA, aiQualify: false, city: 'Kochi', region: 'Kerala' }), [{ places: [place(801), place(802), place(803, { businessStatus: 'CLOSED_PERMANENTLY' })] }]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.run.productName, 'VanSales App');
  const [a, b, c] = r.data.results.map(x => x.placeId);
  const imp = await api(A, 'POST', `/runs/${r.data.run.id}/import`, { placeIds: [a, b, c, 'ChIJnotInThisRun12345'] });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  assert.deepEqual([imp.data.created.length, imp.data.skipped.length, imp.data.failed.length, imp.data.duplicates.length], [2, 1, 1, 0]);
  assert.match(imp.data.skipped[0].reason, /permanently closed/);
  assert.match(imp.data.failed[0].reason, /Not part of this search/);

  const leads = await db().all('SELECT l.*, r.place_id FROM leads l JOIN lead_place_refs r ON r.lead_id = l.id WHERE l.workspace_id = ? AND r.run_id = ? ORDER BY l.id', [A.workspaceId, r.data.run.id]);
  assert.equal(leads.length, 2);
  for (const l of leads) {
    assert.equal(l.product_id, prodA, 'linked to the selected product');
    assert.equal(l.product_interest, 'VanSales App');
    assert.equal(l.status, 'Imported');
    assert.deepEqual([l.email, l.phone, l.company_name], [null, null, null]);
    assert.match(l.name, /^Prospect \d+: Wholesale distributors .* \(Kochi, Kerala, India\)$/);
    const row = JSON.stringify(l);
    for (const v of ['Business 80', 'Market Road', '+91 484', 'business80', 'maps.google.com']) assert.ok(!row.includes(v), `${v} must not be stored`);
  }
  const again = await api(A, 'POST', `/runs/${r.data.run.id}/import`, { placeIds: [a] });
  assert.deepEqual([again.data.created.length, again.data.duplicates.length], [0, 1]);
  assert.match(again.data.duplicates[0].reason, /Already imported/);

  // Imported leads appear in the existing Leads CRM, flagged as Google Places leads.
  const list = await h.api('GET', '/api/v1/leads?limit=200', { token: A.token });
  const flagged = list.data.leads.filter(l => l.googlePlace).map(l => l.id);
  assert.ok(leads.every(l => flagged.includes(l.id)));
});

test('product-aware AI fit is evidence-based, shown for review only, and optional', async () => {
  const ai = h.groqRoute(req => {
    const ids = [...JSON.stringify(req).matchAll(/ChIJplace\d{4}abcdef/g)].map(m => m[0]);
    return JSON.stringify({ results: [
      { placeId: ids[0], score: 45, confidence: 'low', evidence: 'Category is Wholesaler; no other facts about their sales team.', inference: true },
      { placeId: 'ChIJunknownPlace999', score: 99, confidence: 'high', evidence: 'invented', inference: false }
    ] });
  });
  const { r } = await searchWith(A, base({ aiQualify: true }), [{ places: [place(901), place(902)] }], [ai]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.ai, { available: true, assessed: 1, limited: null });
  assert.deepEqual(r.data.results[0].fit, { score: 45, confidence: 'low', evidence: 'Category is Wholesaler; no other facts about their sales team.', inference: true });
  assert.equal(r.data.results[1].fit, null, 'no assessment is invented for a business the AI did not cover');
  const stored = await db().get('SELECT COUNT(*) AS n FROM lead_discovery_places WHERE run_id = ?', [r.data.run.id]);
  assert.equal(Number(stored.n), 2);

  const down = await searchWith(A, base({ aiQualify: true }), [{ places: [place(903)] }], [{ match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) }]);
  assert.equal(down.r.status, 200);
  assert.equal(down.r.data.ai.available, false);
  assert.equal(down.r.data.results.length, 1, 'discovery still works without AI');

  const aiOff = await searchWith(A, base(), [{ places: [place(904)] }]);
  assert.equal(aiOff.r.data.ai, null, 'AI fit is optional');
  assert.equal(aiOff.r.data.run.productId, prodA);
});

test('a product is required: no search without one, and leads are only imported for that product', async () => {
  const { r, calls } = await searchWith(A, base({ productId: undefined }), [{ places: [place(1)] }]);
  assert.deepEqual([r.status, r.data.code], [400, 'VALIDATION_ERROR']);
  assert.match(r.data.error, /Choose the product these leads are for/);
  assert.equal(calls.length, 0, 'nothing is sent to Google without a product');

  const temp = (await db().run("INSERT INTO digital_products (workspace_id, name, status, created_at) VALUES (?, 'Short-lived Product', 'Active', UTC_TIMESTAMP())", [A.workspaceId])).lastID;
  const found = await searchWith(A, base({ productId: temp }), [{ places: [place(905), place(906)] }]);
  assert.equal(found.r.data.run.productName, 'Short-lived Product');
  const ok = await api(A, 'POST', `/runs/${found.r.data.run.id}/import`, { placeIds: [found.r.data.results[0].placeId] });
  assert.equal((await db().get('SELECT product_id FROM leads WHERE id = ?', [ok.data.created[0].leadId])).product_id, temp);

  // The product is deleted between search and import: nothing is imported without it.
  await db().run('DELETE FROM leads WHERE workspace_id = ? AND product_id = ?', [A.workspaceId, temp]);
  await db().run('DELETE FROM digital_products WHERE id = ?', [temp]);
  const refused = await api(A, 'POST', `/runs/${found.r.data.run.id}/import`, { placeIds: [found.r.data.results[1].placeId] });
  assert.deepEqual([refused.status, refused.data.code], [409, 'PRODUCT_REMOVED']);
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM lead_place_refs WHERE run_id = ? AND place_id = ?', [found.r.data.run.id, found.r.data.results[1].placeId])).n), 0);
});

test('workspace isolation and permissions', async () => {
  const foreignProduct = await searchWith(A, base({ productId: prodB }), [{ places: [place(1)] }]);
  assert.deepEqual([foreignProduct.r.status, foreignProduct.r.data.code], [400, 'INVALID_PRODUCT']);
  assert.equal(foreignProduct.calls.length, 0);

  const { r } = await searchWith(A, base(), [{ places: [place(950)] }]);
  const foreignImport = await api(B, 'POST', `/runs/${r.data.run.id}/import`, { placeIds: [r.data.results[0].placeId] });
  assert.equal(foreignImport.status, 404);
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ?', [B.workspaceId])).n), 0);

  const imp = await api(A, 'POST', `/runs/${r.data.run.id}/import`, { placeIds: [r.data.results[0].placeId] });
  const leadId = imp.data.created[0].leadId;
  const foreignDetails = await api(B, 'GET', `/leads/${leadId}/place`);
  assert.equal(foreignDetails.status, 404);

  assert.equal((await h.api('POST', '/api/v1/leads/discovery/search', { body: base() })).status, 401);
  const approver = await h.addMember(A.workspaceId, 'Approver');
  assert.equal((await api(approver, 'POST', '/search', base())).status, 403, 'searching costs money: leads.manage');
  assert.equal((await api(approver, 'POST', `/runs/${r.data.run.id}/import`, { placeIds: [r.data.results[0].placeId] })).status, 403);
});

test('live details for an imported lead are fetched from Google and not stored', async () => {
  const { r } = await searchWith(A, base(), [{ places: [place(960)] }]);
  const imp = await api(A, 'POST', `/runs/${r.data.run.id}/import`, { placeIds: [r.data.results[0].placeId] });
  const leadId = imp.data.created[0].leadId;
  const calls = [];
  const mock = h.mockFetch([google(() => place(960), calls)]);
  let d;
  try { d = await api(A, 'GET', `/leads/${leadId}/place`); } finally { mock.restore(); }
  assert.equal(d.status, 200, JSON.stringify(d.data));
  assert.equal(d.data.place.name, 'Business 960');
  assert.equal(d.data.stored, false);
  assert.equal(d.data.attribution, 'Google Maps');
  assert.equal(calls[0].url, `https://places.googleapis.com/v1/places/${r.data.results[0].placeId}`);
  assert.equal(calls[0].headers['X-Goog-Api-Key'], KEY);
  assert.ok(!JSON.stringify(d.data).includes(KEY));
  const lead = await db().get('SELECT name, phone, company_name, notes FROM leads WHERE id = ?', [leadId]);
  assert.ok(!JSON.stringify(lead).includes('Business 960'));

  const manual = (await h.api('POST', '/api/v1/leads', { token: A.token, body: { name: 'Walk-in' } })).data.lead;
  assert.equal((await api(A, 'GET', `/leads/${manual.id}/place`)).status, 404);
});

test('cost controls: repeated identical searches and the daily limit are refused', async () => {
  const ws = await h.createWorkspace({ name: 'Limits' });
  const wsProduct = await productFor(ws);
  const body = base({ productId: wsProduct });
  const first = await searchWith(ws, body, [{ places: [place(970)] }]);
  assert.equal(first.r.status, 200);
  const repeat = await searchWith(ws, body, [{ places: [place(970)] }]);
  assert.deepEqual([repeat.r.status, repeat.r.data.code], [409, 'DUPLICATE_SEARCH']);
  assert.equal(repeat.calls.length, 0, 'no second charge');

  process.env.LEAD_DISCOVERY_DAILY_SEARCHES = '2';
  try {
    assert.equal((await searchWith(ws, base({ productId: wsProduct }), [{ places: [] }])).r.status, 200);
    const over = await searchWith(ws, base({ productId: wsProduct }), [{ places: [] }]);
    assert.deepEqual([over.r.status, over.r.data.code], [429, 'DISCOVERY_DAILY_LIMIT']);
    assert.equal(over.calls.length, 0);
  } finally { process.env.LEAD_DISCOVERY_DAILY_SEARCHES = '1000'; }
  const usage = await db().get("SELECT COUNT(*) AS n FROM usage_ledger WHERE workspace_id = ? AND category = 'places_search'", [ws.workspaceId]);
  assert.equal(Number(usage.n), 2, 'each Google request page is metered');
});

test('existing manual lead creation, editing, CSV import and listing still work', async () => {
  const mock = h.mockFetch([{ match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) }]);
  try {
    const created = await h.api('POST', '/api/v1/leads', { token: B.token, body: { name: 'Manual Lead', email: 'manual@corp.io', phone: '+1 555 0100', productId: prodB } });
    assert.equal(created.status, 200);
    assert.equal(created.data.lead.googlePlace, false);
    assert.equal(created.data.lead.productId, prodB);
    const edited = await h.api('PATCH', `/api/v1/leads/${created.data.lead.id}`, { token: B.token, body: { status: 'Contacted' } });
    assert.equal(edited.data.lead.status, 'Contacted');
    const csv = await h.api('POST', '/api/v1/leads/import-bulk', { token: B.token, body: { leads: [{ name: 'Row One', email: 'row1@corp.io' }, { name: 'Dup', email: 'manual@corp.io' }] } });
    assert.deepEqual([csv.data.imported, csv.data.duplicates.length], [1, 1]);
    const list = await h.api('GET', '/api/v1/leads', { token: B.token });
    assert.equal(list.data.total, 2);
    assert.ok(list.data.leads.every(l => l.googlePlace === false));
  } finally { mock.restore(); }
});

test('the Leads CRM and AI Lead Discovery tables list separate leads that together make up the whole list', async () => {
  const { r } = await searchWith(A, base(), [{ places: [place(990), place(991)] }]);
  await api(A, 'POST', `/runs/${r.data.run.id}/import`, { placeIds: r.data.results.map(x => x.placeId) });
  const list = async q => (await h.api('GET', `/api/v1/leads?limit=200${q}`, { token: A.token })).data;
  const [all, crm, discovered] = [await list(''), await list('&source=crm'), await list('&source=discovery')];
  assert.ok(discovered.total >= 2);
  assert.ok(discovered.leads.every(l => l.googlePlace), 'discovery table: only Google Places leads');
  assert.ok(crm.leads.every(l => !l.googlePlace), 'CRM table: no Google Places leads');
  assert.equal(crm.total + discovered.total, all.total);
  // Other workspaces see none of them.
  assert.equal((await h.api('GET', '/api/v1/leads?source=discovery', { token: B.token })).data.total, 0);
});
