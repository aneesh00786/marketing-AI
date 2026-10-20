const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let A;
let B;
let prodA;
let prodA2;
let prodB;

async function product(ws, name, extra = {}) {
  const { run } = h.db();
  const r = await run(
    "INSERT INTO digital_products (workspace_id, name, url, tagline, description, features_json, target_audience, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'Active', UTC_TIMESTAMP())",
    [ws, name, extra.url || 'https://product.example.org', extra.tagline || null, extra.description || null, JSON.stringify(extra.features || []), extra.audience || null]
  );
  return r.lastID;
}

test.before(async () => {
  await h.prepareDatabase();
  A = await h.createWorkspace({ name: 'Leads A' });
  B = await h.createWorkspace({ name: 'Leads B' });
  prodA = await product(A.workspaceId, 'VanRoute Pro', { tagline: 'Route sales on mobile', features: ['Offline order booking', 'Live stock per van', 'Thermal receipt printing', 'Extra'] });
  prodA2 = await product(A.workspaceId, 'DeliverIt');
  prodB = await product(B.workspaceId, 'Other Tenant Product');
});
test.after(() => h.shutdown());

const create = (token, body) => h.api('POST', '/api/v1/leads', { token, body });

test('budget parsing handles commas, currency symbols, codes and suffixes', () => {
  const { parseBudget, scoreLead } = require('../modules/leads/leadService');
  assert.equal(parseBudget('$15,000'), 15000);
  assert.equal(parseBudget('AED 12,500.50'), 12500.5);
  assert.equal(parseBudget('₹ 2,00,000'), 200000);
  assert.equal(parseBudget('15k'), 15000);
  assert.equal(parseBudget('1.2M'), 1200000);
  assert.equal(parseBudget('€9,500'), 9500);
  assert.equal(parseBudget('15000'), 15000);
  assert.equal(parseBudget('not sure'), null);
  assert.equal(parseBudget(''), null);
  assert.equal(parseBudget(null), null);
  // The budget factor now applies to comma-formatted budgets too.
  const withComma = scoreLead({ estimated_budget: '$15,000' });
  const withoutComma = scoreLead({ estimated_budget: '15000' });
  assert.equal(withComma.score, withoutComma.score);
  assert.ok(withComma.factors.some(f => f.label.startsWith('Budget')));
  assert.ok(!scoreLead({ estimated_budget: '$500' }).factors.some(f => f.label.startsWith('Budget')));
});

test('leads are isolated per workspace for list, read, update, delete, qualify and email', async () => {
  const aLead = (await create(A.token, { name: 'Alice A', email: 'alice@acme.io' })).data.lead;
  const bLead = (await create(B.token, { name: 'Bob B', email: 'bob@other.io' })).data.lead;
  const listA = await h.api('GET', '/api/v1/leads', { token: A.token });
  assert.equal(listA.status, 200);
  assert.ok(listA.data.leads.some(l => l.id === aLead.id));
  assert.ok(!listA.data.leads.some(l => l.id === bLead.id), 'workspace B lead never listed in A');
  for (const legacyPath of ['/api/leads', '/api/v1/crm/leads']) {
    const res = await h.api('GET', legacyPath, { token: A.token });
    assert.ok(!res.data.leads.some(l => l.id === bLead.id), `${legacyPath} is scoped too`);
  }
  for (const [method, path, body] of [
    ['GET', `/api/v1/leads/${bLead.id}`],
    ['PATCH', `/api/v1/leads/${bLead.id}`, { notes: 'hijack' }],
    ['DELETE', `/api/v1/leads/${bLead.id}`],
    ['POST', `/api/v1/leads/${bLead.id}/ai-qualify`, {}],
    ['POST', `/api/v1/leads/${bLead.id}/email-draft`, {}]
  ]) {
    const res = await h.api(method, path, { token: A.token, body });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  const { get } = h.db();
  const stillThere = await get('SELECT notes FROM leads WHERE id = ?', [bLead.id]);
  assert.ok(stillThere, 'B lead not deleted');
  assert.equal(stillThere.notes, null, 'B lead not modified');
  // A non-legacy workspace can use the Leads CRM (no longer workspace-1 only).
  assert.equal((await h.api('GET', '/api/v1/leads', { token: B.token })).status, 200);
});

test('qualify-all only touches the caller workspace', async () => {
  const { run, get } = h.db();
  const b = (await create(B.token, { name: 'Untouched B' })).data.lead;
  await run('UPDATE leads SET ai_score = 0, ai_category = ? WHERE id = ?', ['Cold', b.id]);
  const mock = h.mockFetch([{ match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) }]);
  try {
    const res = await h.api('POST', '/api/v1/leads/ai-qualify-all', { token: A.token, body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.data.aiAvailable, false);
  } finally { mock.restore(); }
  const row = await get('SELECT ai_score FROM leads WHERE id = ?', [b.id]);
  assert.equal(row.ai_score, 0, 'other workspace lead was not re-scored');
});

test('missing values stay empty, zero scores are preserved and notes are saved', async () => {
  const mock = h.mockFetch([{ match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(503, {}) }]);
  let res;
  try {
    res = await create(A.token, { name: 'Bare Lead', notes: 'Met at expo' });
  } finally { mock.restore(); }
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const l = res.data.lead;
  assert.equal(l.email, null);
  assert.equal(l.companyName, null);
  assert.equal(l.estimatedBudget, null, 'no invented $15,000');
  assert.equal(l.productId, null);
  assert.equal(l.productName, null, 'no default product assumed');
  assert.equal(l.notes, 'Met at expo');
  assert.equal(l.aiSuggestion, null);

  const patched = await h.api('PATCH', `/api/v1/leads/${l.id}`, { token: A.token, body: { notes: 'Called back, wants a demo' } });
  assert.equal(patched.data.lead.notes, 'Called back, wants a demo');

  const { run } = h.db();
  await run('UPDATE leads SET ai_score = 0 WHERE id = ?', [l.id]);
  const zero = await h.api('GET', `/api/v1/leads/${l.id}`, { token: A.token });
  assert.equal(zero.data.lead.score, 0, 'a real 0 is not turned into 50');
});

test('products: selection, validation, cross-workspace ids and filtering', async () => {
  const ok = await create(A.token, { name: 'With Product', productId: prodA });
  assert.equal(ok.data.lead.productId, prodA);
  assert.equal(ok.data.lead.productName, 'VanRoute Pro');

  const foreign = await create(A.token, { name: 'Foreign Product', productId: prodB });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.data.code, 'INVALID_PRODUCT');
  const bogus = await create(A.token, { name: 'Bogus Product', productId: 999999 });
  assert.equal(bogus.status, 400);

  const edit = await h.api('PATCH', `/api/v1/leads/${ok.data.lead.id}`, { token: A.token, body: { productId: prodB } });
  assert.equal(edit.status, 400, 'cannot re-link to another workspace product');
  const relink = await h.api('PATCH', `/api/v1/leads/${ok.data.lead.id}`, { token: A.token, body: { productId: prodA2 } });
  assert.equal(relink.data.lead.productName, 'DeliverIt');

  const products = await h.api('GET', '/api/v1/leads/products', { token: A.token });
  assert.deepEqual(products.data.products.map(p => p.name).sort(), ['DeliverIt', 'VanRoute Pro']);

  const filtered = await h.api('GET', `/api/v1/leads?productId=${prodA2}`, { token: A.token });
  assert.ok(filtered.data.leads.length >= 1 && filtered.data.leads.every(l => l.productId === prodA2));
  const none = await h.api('GET', '/api/v1/leads?productId=none', { token: A.token });
  assert.ok(none.data.leads.every(l => l.productId === null));
  const foreignFilter = await h.api('GET', `/api/v1/leads?productId=${prodB}`, { token: A.token });
  assert.equal(foreignFilter.status, 400);
});

test('import matches products by name or id within the workspace and flags the rest', async () => {
  const rows = [
    { name: 'Imp ByName', email: 'byname@acme.io', product: 'vanroute pro', budget: '$12,000' },
    { name: 'Imp ById', email: 'byid@acme.io', productId: String(prodA2) },
    { name: 'Imp Foreign', productId: String(prodB) },
    { name: 'Imp Unknown', product: 'Made Up Product' },
    { name: 'Imp NoProduct', company: 'Acme' },
    { email: 'noname@acme.io' },
    { name: 'Imp Dup', email: 'byname@acme.io' }
  ].map(r => ({ ...r, estimatedBudget: r.budget, companyName: r.company }));
  const res = await h.api('POST', '/api/v1/leads/import-bulk', { token: A.token, body: { leads: rows } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.imported, 5);
  assert.equal(res.data.skipped.length, 1);
  assert.equal(res.data.duplicates.length, 1);
  assert.equal(res.data.flagged.length, 2);

  const { all } = h.db();
  const imported = await all(`SELECT name, workspace_id, product_id, product_review_note, estimated_budget FROM leads WHERE id IN (${res.data.leadIds.join(',')})`);
  const byName = Object.fromEntries(imported.map(r => [r.name, r]));
  assert.ok(imported.every(r => r.workspace_id === A.workspaceId), 'imported into the caller workspace');
  assert.equal(byName['Imp ByName'].product_id, prodA);
  assert.equal(byName['Imp ById'].product_id, prodA2);
  assert.equal(byName['Imp Foreign'].product_id, null, 'foreign product id is never linked');
  assert.match(byName['Imp Foreign'].product_review_note, /does not exist in this workspace/);
  assert.equal(byName['Imp Unknown'].product_id, null);
  assert.match(byName['Imp Unknown'].product_review_note, /not found/);
  assert.equal(byName['Imp NoProduct'].product_id, null);
  assert.equal(byName['Imp NoProduct'].product_review_note, null);
  assert.equal(byName['Imp NoProduct'].estimated_budget, null, 'no invented budget');
  assert.equal(byName['Imp ByName'].estimated_budget, '$12,000');
});

test('AI advice: real model output only, product facts in the prompt, honest failure', async () => {
  const withProduct = (await create(A.token, { name: 'Prompt Check', email: 'p@acme.io', productId: prodA })).data.lead;
  let prompt = '';
  const ok = h.mockFetch([h.groqRoute(b => { prompt = b.messages.map(m => m.content).join('\n'); return 'Offer a route pilot for two vans.'; })]);
  try {
    const res = await h.api('POST', `/api/v1/leads/${withProduct.id}/ai-qualify`, { token: A.token, body: {} });
    assert.equal(res.data.ai.available, true);
    assert.equal(res.data.lead.aiSuggestion, 'Offer a route pilot for two vans.');
  } finally { ok.restore(); }
  assert.match(prompt, /VanRoute Pro/);
  assert.match(prompt, /Offline order booking/);
  assert.doesNotMatch(prompt, /ThriveWoo/);

  const noProduct = (await create(A.token, { name: 'No Product Prompt' })).data.lead;
  let prompt2 = '';
  const ok2 = h.mockFetch([h.groqRoute(b => { prompt2 = b.messages.map(m => m.content).join('\n'); return 'Ask what problem they need solved.'; })]);
  try { await h.api('POST', `/api/v1/leads/${noProduct.id}/ai-qualify`, { token: A.token, body: {} }); } finally { ok2.restore(); }
  assert.match(prompt2, /No product is selected/);
  assert.doesNotMatch(prompt2, /VanRoute|ThriveWoo/);

  // Provider failure: no canned text is stored; earlier genuine advice is kept.
  const down = h.mockFetch([{ match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) }]);
  let failed;
  try { failed = await h.api('POST', `/api/v1/leads/${withProduct.id}/ai-qualify`, { token: A.token, body: {} }); } finally { down.restore(); }
  assert.equal(failed.data.ai.available, false);
  assert.match(failed.data.message, /AI unavailable/);
  assert.equal(failed.data.lead.aiStatus, 'unavailable');
  assert.equal(failed.data.lead.aiSuggestion, 'Offer a route pilot for two vans.');

  const fresh = (await create(A.token, { name: 'Never Advised' })).data.lead;
  const down2 = h.mockFetch([{ match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) }]);
  try { await h.api('POST', `/api/v1/leads/${fresh.id}/ai-qualify`, { token: A.token, body: {} }); } finally { down2.restore(); }
  const { get } = h.db();
  const row = await get('SELECT ai_suggestion, ai_status FROM leads WHERE id = ?', [fresh.id]);
  assert.equal(row.ai_suggestion, null, 'nothing canned saved as AI output');
  assert.equal(row.ai_status, 'unavailable');
});

test('email drafts need a valid address and use the lead product only', async () => {
  const noEmail = (await create(A.token, { name: 'No Email' })).data.lead;
  const r1 = await h.api('POST', `/api/v1/leads/${noEmail.id}/email-draft`, { token: A.token, body: {} });
  assert.equal(r1.status, 400);
  assert.equal(r1.data.code, 'NO_VALID_EMAIL');
  const placeholder = (await create(A.token, { name: 'Placeholder', email: 'lead@example.com' })).data.lead;
  assert.equal((await h.api('POST', `/api/v1/leads/${placeholder.id}/email-draft`, { token: A.token, body: {} })).status, 400);

  const withProduct = (await create(A.token, { name: 'Dana Smith', email: 'dana@fleetco.io', companyName: 'FleetCo', productId: prodA })).data.lead;
  const d = (await h.api('POST', `/api/v1/leads/${withProduct.id}/email-draft`, { token: A.token, body: {} })).data.draft;
  assert.equal(d.to, 'dana@fleetco.io');
  assert.match(d.subject, /VanRoute Pro/);
  assert.match(d.body, /Hi Dana/);
  assert.match(d.body, /Offline order booking/);
  assert.match(d.body, /Route sales on mobile/);
  assert.doesNotMatch(d.body + d.html, /ThriveWoo|WooCommerce|\$/);
  assert.ok(!d.body.includes('Extra'), 'at most three features');

  const generic = (await create(A.token, { name: 'Gen Eric', email: 'gen@co.io' })).data.lead;
  const g = (await h.api('POST', `/api/v1/leads/${generic.id}/email-draft`, { token: A.token, body: {} })).data.draft;
  assert.equal(g.productName, null);
  assert.doesNotMatch(g.subject + g.body, /VanRoute|DeliverIt|ThriveWoo/);
});

test('validation and permissions', async () => {
  assert.equal((await create(A.token, { name: '' })).status, 400);
  assert.equal((await create(A.token, { name: 'Bad Email', email: 'not-an-email' })).status, 400);
  assert.equal((await create(A.token, { name: 'Bad Status', status: 'Whatever' })).status, 400);
  const approver = await h.addMember(A.workspaceId, 'Approver');
  assert.equal((await h.api('GET', '/api/v1/leads', { token: approver.token })).status, 200);
  assert.equal((await create(approver.token, { name: 'Nope' })).status, 403, 'approvers can view but not edit');
  assert.equal((await h.api('GET', '/api/v1/leads')).status, 401);
});

test('voice tool track_lead uses the same validated, workspace-scoped logic', async () => {
  process.env.TOOL_WEBHOOK_SECRET = 'tool-secret-for-leads';
  const mock = h.mockFetch([{ match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) }]);
  let res;
  try {
    res = await h.api('POST', '/api/tools/track_lead', { headers: { 'X-Tool-Secret': 'tool-secret-for-leads' }, body: { name: 'Voice Caller', interest: 'Something unlisted' } });
  } finally { mock.restore(); }
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const { get } = h.db();
  const row = await get('SELECT workspace_id, product_id, product_review_note, estimated_budget FROM leads WHERE id = ?', [res.data.lead_id]);
  assert.equal(row.workspace_id, 1);
  assert.equal(row.product_id, null);
  assert.match(row.product_review_note, /not linked to a product/);
  assert.equal(row.estimated_budget, null);
});
