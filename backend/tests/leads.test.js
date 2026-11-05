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

test('mail contact picker semantics: product filter combines with name/email/company search; unusable emails say why', async () => {
  const stamp = Date.now();
  const linked = await create(A.token, { name: `Picker Linked ${stamp}`, email: `linked.${stamp}@acme.io`, companyName: `PickCo ${stamp}`, productId: prodA });
  await create(A.token, { name: `Picker Other ${stamp}`, email: `other.${stamp}@acme.io`, companyName: `PickCo ${stamp}`, productId: prodA2 });
  const q = async (params) => (await h.api('GET', `/api/v1/leads?${new URLSearchParams(params)}`, { token: A.token })).data.leads.map(l => l.id);
  for (const term of [`Picker Linked ${stamp}`, `linked.${stamp}`, `PickCo ${stamp}`]) {
    const ids = await q({ productId: prodA, q: term });
    assert.deepEqual(ids, [linked.data.lead.id], `searching "${term}" within the product`);
  }
  assert.equal((await q({ q: `PickCo ${stamp}` })).length, 2, 'without a product, all matching contacts');
  assert.deepEqual(await q({ productId: prodA, q: `Picker Linked ${stamp}` }).then(ids => ids.length), 1);
  const bOnly = await h.api('GET', `/api/v1/leads?q=${encodeURIComponent(`PickCo ${stamp}`)}`, { token: B.token });
  assert.equal(bOnly.data.leads.length, 0, 'another workspace sees none of them');

  const placeholder = await create(A.token, { name: 'Demo Person', email: `demo.${stamp}@example.com` });
  assert.equal(placeholder.data.lead.hasValidEmail, false);
  assert.equal(placeholder.data.lead.emailIssue, 'placeholder');
  assert.equal((await create(A.token, { name: 'No Mail' })).data.lead.emailIssue, 'missing');
  assert.equal((await create(A.token, { name: 'Bad Mail', email: 'not an email' })).status, 400, 'Leads CRM refuses malformed emails on create');
  const legacy = await h.db().run("INSERT INTO leads (workspace_id, name, email, status, created_at) VALUES (?, 'Legacy Bad', 'not an email', 'New', UTC_TIMESTAMP())", [A.workspaceId]);
  const legacyLead = (await h.api('GET', `/api/v1/leads/${legacy.lastID}`, { token: A.token })).data.lead;
  assert.equal(legacyLead.emailIssue, 'invalid', 'older rows with malformed emails say why');
  assert.equal(linked.data.lead.emailIssue, null);
});

test('export: every lead matching the filters (not just one page), only this workspace, and audited', async () => {
  const ws = await h.createWorkspace({ name: 'Export' });
  const p = await product(ws.workspaceId, 'Exported Product');
  for (let i = 0; i < 55; i++) await create(ws.token, { name: `Export Lead ${i}`, email: `lead${i}@export.example.org`, phone: `+61 3 9000 ${String(1000 + i)}`, status: i % 2 ? 'New' : 'Contacted', productId: p });
  await create(B.token, { name: 'Other tenant lead' });

  const all = await h.api('GET', '/api/v1/leads/export', { token: ws.token });
  assert.equal(all.status, 200, JSON.stringify(all.data));
  assert.equal(all.data.leads.length, 55, 'more than one page of 50');
  assert.equal(all.data.truncated, false);
  assert.ok(all.data.leads.every(l => l.name.startsWith('Export Lead')), 'only this workspace');
  const first = all.data.leads.find(l => l.name === 'Export Lead 0');
  assert.deepEqual([first.email, first.phone, first.productName, first.status], ['lead0@export.example.org', '+61 3 9000 1000', 'Exported Product', 'Contacted']);

  const filtered = await h.api('GET', '/api/v1/leads/export?status=New&q=Lead%201', { token: ws.token });
  assert.ok(filtered.data.leads.length > 0);
  assert.ok(filtered.data.leads.every(l => l.status === 'New' && l.name.includes('Lead 1')));

  const logged = await h.db().get("SELECT metadata_json AS metadata FROM audit_logs WHERE workspace_id = ? AND action = 'leads.exported' ORDER BY id DESC LIMIT 1", [ws.workspaceId]);
  assert.ok(logged, 'the export is in the audit log');
  assert.match(String(logged.metadata), /"count":\d+/);

  const anon = await h.api('GET', '/api/v1/leads/export', {});
  assert.equal(anon.status, 401);
});

test('address: saved on create, edit and import; the Leads search and export match it', async () => {
  const stamp = Date.now();
  const A = await h.createWorkspace({ name: `Address A ${stamp}` });
  const created = await h.api('POST', '/api/v1/leads', { token: A.token, body: { name: `Addr One ${stamp}`, address: ' 12 MG Road, Ernakulam, Kerala 682016 ' } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const one = created.data.lead;
  assert.equal(one.address, '12 MG Road, Ernakulam, Kerala 682016');
  const imp = await h.api('POST', '/api/v1/leads/import-bulk', { token: A.token, body: { leads: [{ name: `Addr Two ${stamp}`, address: 'Peenya Industrial Area, Bengaluru 560058' }] } });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  const search = async q => (await h.api('GET', `/api/v1/leads?q=${encodeURIComponent(q)}`, { token: A.token })).data.leads.map(l => l.name);
  assert.deepEqual(await search('Ernakulam'), [`Addr One ${stamp}`], 'a city in the address');
  assert.deepEqual(await search('560058'), [`Addr Two ${stamp}`], 'a postal code');
  const patched = await h.api('PATCH', `/api/v1/leads/${one.id}`, { token: A.token, body: { address: 'Kakkanad, Kochi' } });
  assert.equal(patched.data.lead.address, 'Kakkanad, Kochi');
  assert.deepEqual(await search('Ernakulam'), [], 'the old address no longer matches');
  const exp = await h.api('GET', `/api/v1/leads/export?q=Kakkanad`, { token: A.token });
  assert.deepEqual(exp.data.leads.map(l => l.address), ['Kakkanad, Kochi']);
  // The lead pickers (contact lists, campaigns, product emails) search the address too.
  const pick = await h.api('GET', '/api/v1/mail/campaigns/lead-options?q=560058', { token: A.token });
  assert.deepEqual(pick.data.leads.map(l => [l.name, l.address]), [[`Addr Two ${stamp}`, 'Peenya Industrial Area, Bengaluru 560058']]);
  const B = await h.createWorkspace({ name: `Address B ${stamp}` });
  assert.equal((await h.api('GET', `/api/v1/leads?q=Kakkanad`, { token: B.token })).data.leads.length, 0, 'another workspace sees none');
});

test('country: saved on create, edit and import; filters the Leads list, export and lead pickers; counts per country', async () => {
  const stamp = Date.now();
  const au = (await create(A.token, { name: `Country AU ${stamp}`, email: `au.${stamp}@acme.io`, country: ' Australia ' })).data.lead;
  assert.equal(au.country, 'Australia');
  const none = (await create(A.token, { name: `Country None ${stamp}`, email: `none.${stamp}@acme.io` })).data.lead;
  assert.equal(none.country, null);
  const imp = await h.api('POST', '/api/v1/leads/import-bulk', { token: A.token, body: { leads: [{ name: `Country IN ${stamp}`, email: `in.${stamp}@acme.io`, country: 'India' }] } });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  const inId = imp.data.leadIds ? imp.data.leadIds[0] : (await h.db().get('SELECT id FROM leads WHERE email = ?', [`in.${stamp}@acme.io`])).id;
  assert.equal((await h.api('PATCH', `/api/v1/leads/${none.id}`, { token: A.token, body: { country: 'India' } })).data.lead.country, 'India');
  await h.api('PATCH', `/api/v1/leads/${none.id}`, { token: A.token, body: { country: '' } });

  const list = async params => (await h.api('GET', `/api/v1/leads?${new URLSearchParams({ q: `${stamp}`, ...params })}`, { token: A.token })).data;
  assert.deepEqual((await list({ country: 'Australia' })).leads.map(l => l.id), [au.id]);
  assert.deepEqual((await list({ country: 'India' })).leads.map(l => l.id), [inId]);
  assert.deepEqual((await list({ country: 'none' })).leads.map(l => l.id), [none.id], 'leads without a country');
  const countries = (await list({})).countries;
  assert.ok(countries.find(c => c.country === 'Australia').count >= 1);
  assert.ok(countries.some(c => c.country === null), 'the "no country" group is counted too');
  const exp = await h.api('GET', `/api/v1/leads/export?q=${stamp}&country=India`, { token: A.token });
  assert.deepEqual(exp.data.leads.map(l => l.id), [inId]);
  const pick = await h.api('GET', `/api/v1/mail/campaigns/lead-options?q=${stamp}&country=Australia`, { token: A.token });
  assert.equal(pick.status, 200, JSON.stringify(pick.data));
  assert.deepEqual(pick.data.leads.map(l => [l.id, l.country]), [[au.id, 'Australia']]);
  assert.ok(pick.data.countries.some(c => c.country === 'India'));
  // Outreach (and Command Center) audience: the country filter, and each lead's country.
  const aud = await h.api('POST', '/api/v1/outreach/audience/preview', { token: A.token, body: { filter: { country: 'India' } } });
  assert.equal(aud.status, 200, JSON.stringify(aud.data));
  assert.ok(aud.data.audience.length >= 1 && aud.data.audience.every(x => x.country === 'India'));
  assert.ok(aud.data.audience.some(x => x.leadId === inId));
  const audNone = await h.api('POST', '/api/v1/outreach/audience/preview', { token: A.token, body: { filter: { country: 'none' } } });
  assert.ok(audNone.data.audience.some(x => x.leadId === none.id) && audNone.data.audience.every(x => !x.country));
  const other = await h.api('GET', `/api/v1/leads?country=Australia&q=${stamp}`, { token: B.token });
  assert.equal(other.data.leads.length, 0, 'another workspace sees none');
  assert.ok(!other.data.countries.some(c => c.country === 'India'), 'and not their countries');
});

test('consent on the Leads screen: works without Product Emails, needs evidence to grant, and is what campaigns use', async () => {
  const before = process.env.PRODUCT_EMAILS_ENABLED;
  delete process.env.PRODUCT_EMAILS_ENABLED;
  try {
    const stamp = Date.now();
    const ws = await h.createWorkspace({ name: `Consent leads ${stamp}` });
    const lead = (await create(ws.token, { name: `Consent ${stamp}`, email: `consent.${stamp}@acme.io` })).data.lead;
    assert.deepEqual([lead.marketingConsent, lead.marketingConsentProven], ['unknown', false]);
    const consent = body => h.api('POST', '/api/v1/leads/consent', { token: ws.token, body });
    // Granting without evidence (or without confirming it is held) is refused.
    assert.equal((await consent({ leadIds: [lead.id], status: 'granted', method: 'web_form', obtainedAt: '2026-10-01', evidence: 'x', attest: true })).status, 400);
    assert.equal((await consent({ leadIds: [lead.id], status: 'granted', method: 'web_form', obtainedAt: '2026-10-01', evidence: 'Form #4411' })).status, 400);
    const ok = await consent({ leadIds: [lead.id], status: 'granted', method: 'web_form', obtainedAt: '2026-10-01', evidence: 'Form #4411', attest: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const shown = (await h.api('GET', `/api/v1/leads?q=consent.${stamp}`, { token: ws.token })).data.leads[0];
    assert.deepEqual([shown.marketingConsent, shown.marketingConsentProven, shown.marketingConsentMethod], ['granted', true, 'web_form']);
    // A contact list with this person now counts them as reachable for Zoho campaigns.
    const list = await h.api('POST', '/api/v1/mail/campaigns/contact-lists', { token: ws.token, body: { name: `Consent list ${stamp}`, leadIds: [lead.id] } });
    assert.equal(list.status, 200, JSON.stringify(list.data));
    const lists = (await h.api('GET', '/api/v1/mail/campaigns/contact-lists', { token: ws.token })).data.lists;
    assert.deepEqual(lists.filter(l => l.name === `Consent list ${stamp}`).map(l => [l.reachable, l.noConsent]), [[1, 0]]);
    // Withdrawn: no longer reachable.
    assert.equal((await consent({ leadIds: [lead.id], status: 'withdrawn', note: 'Asked by phone' })).status, 200);
    const after = (await h.api('GET', '/api/v1/mail/campaigns/contact-lists', { token: ws.token })).data.lists.find(l => l.name === `Consent list ${stamp}`);
    assert.deepEqual([after.reachable, after.noConsent], [0, 1]);
    // Another workspace cannot record consent for this lead.
    const other = await h.createWorkspace({ name: `Consent other ${stamp}` });
    assert.equal((await h.api('POST', '/api/v1/leads/consent', { token: other.token, body: { leadIds: [lead.id], status: 'unknown' } })).status, 404);
  } finally {
    if (before === undefined) delete process.env.PRODUCT_EMAILS_ENABLED; else process.env.PRODUCT_EMAILS_ENABLED = before;
  }
});
