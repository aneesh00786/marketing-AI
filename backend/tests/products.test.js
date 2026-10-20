const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let A;
let B;
let prodB;

test.before(async () => {
  await h.prepareDatabase();
  A = await h.createWorkspace({ name: 'Products A' });
  B = await h.createWorkspace({ name: 'Products B' });
  const r = await h.api('POST', '/api/v1/products', { token: B.token, body: { name: 'B Secret Product', url: 'https://b.example.org', tagline: 'Only for B', features: ['B feature'] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  prodB = r.data.productId;
});
test.after(() => h.shutdown());

test('create stores the product in the caller workspace, ignoring any workspace in the body', async () => {
  const r = await h.api('POST', '/api/v1/products', { token: A.token, body: { name: 'A Product', url: 'https://a.example.org', workspace_id: B.workspaceId, features: ['Fast'] } });
  assert.equal(r.status, 200);
  const { get } = h.db();
  const row = await get('SELECT workspace_id FROM digital_products WHERE id = ?', [r.data.productId]);
  assert.equal(row.workspace_id, A.workspaceId);
});

test('list and view never expose another workspace product', async () => {
  for (const path of ['/api/v1/products', '/api/products']) {
    const list = await h.api('GET', path, { token: A.token });
    assert.equal(list.status, 200, path);
    assert.ok(!list.data.products.some(p => p.id === prodB || p.name === 'B Secret Product'), `${path} leaks B products`);
    assert.ok(list.data.products.every(p => p.workspace_id === A.workspaceId));
  }
  const view = await h.api('GET', `/api/v1/products/${prodB}`, { token: A.token });
  assert.equal(view.status, 404);
  const own = await h.api('GET', `/api/v1/products/${prodB}`, { token: B.token });
  assert.equal(own.status, 200);
  assert.deepEqual(own.data.product.features, ['B feature']);
});

test('edit and delete require ownership', async () => {
  const edit = await h.api('PATCH', `/api/v1/products/${prodB}`, { token: A.token, body: { name: 'Hijacked' } });
  assert.equal(edit.status, 404);
  const del = await h.api('DELETE', `/api/v1/products/${prodB}`, { token: A.token });
  assert.equal(del.status, 404);
  const legacyDel = await h.api('DELETE', `/api/products/${prodB}`, { token: A.token });
  assert.equal(legacyDel.status, 404);
  const { get } = h.db();
  const row = await get('SELECT name FROM digital_products WHERE id = ?', [prodB]);
  assert.equal(row.name, 'B Secret Product', 'B product untouched');

  const ownEdit = await h.api('PATCH', `/api/v1/products/${prodB}`, { token: B.token, body: { tagline: 'Updated by owner', features: ['x'.repeat(900)] } });
  assert.equal(ownEdit.status, 200);
  assert.equal(ownEdit.data.product.tagline, 'Updated by owner');
  assert.equal(ownEdit.data.product.features[0].length, 500, 'over-long values are trimmed, not rejected');
});

test('permissions and validation', async () => {
  const member = await h.addMember(A.workspaceId, 'Member');
  assert.equal((await h.api('GET', '/api/v1/products', { token: member.token })).status, 200);
  assert.equal((await h.api('POST', '/api/v1/products', { token: member.token, body: { name: 'Nope' } })).status, 403);
  assert.equal((await h.api('POST', '/api/v1/products', { token: A.token, body: { name: '  ' } })).status, 400);
  assert.equal((await h.api('GET', '/api/v1/products')).status, 401);
  assert.equal((await h.api('GET', '/api/v1/products/abc', { token: A.token })).status, 400);
  // Website extraction moved with the module and keeps its SSRF guard (and now works outside workspace 1).
  const ssrf = await h.api('POST', '/api/v1/products/extract-url', { token: A.token, body: { url: 'http://169.254.169.254/latest' } });
  assert.equal(ssrf.status, 400);
});

test('deleting a product reports linked leads, which then show "Product removed"', async () => {
  const p = (await h.api('POST', '/api/v1/products', { token: A.token, body: { name: 'To Delete' } })).data.productId;
  const mock = h.mockFetch([{ match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) }]);
  let lead;
  try {
    lead = (await h.api('POST', '/api/v1/leads', { token: A.token, body: { name: 'Linked Lead', productId: p } })).data.lead;
  } finally { mock.restore(); }
  const del = await h.api('DELETE', `/api/v1/products/${p}`, { token: A.token });
  assert.equal(del.status, 200);
  assert.equal(del.data.linkedLeads, 1);
  const after = await h.api('GET', `/api/v1/leads/${lead.id}`, { token: A.token });
  assert.equal(after.data.lead.productMissing, true);
  assert.equal(after.data.lead.productName, null);
});

test('consumers never use another workspace product: campaigns, leads, drafts, social posts', async () => {
  // Campaign generation input
  const camp = await h.api('POST', '/api/v1/social/campaigns', { token: A.token, body: { name: 'X', productId: prodB, platforms: ['facebook'] } });
  assert.equal(camp.status, 400);
  // Leads
  const lead = await h.api('POST', '/api/v1/leads', { token: A.token, body: { name: 'X', productId: prodB } });
  assert.equal(lead.status, 400);

  // Mail draft generation (legacy workspace-1 module): a foreign product id is rejected, nothing is saved.
  const W1 = await h.addMember(1, 'Workspace Owner');
  const { get } = h.db();
  const before = await get('SELECT COUNT(*) AS c FROM email_drafts');
  const draft = await h.api('POST', '/api/v1/drafts/generate', { token: W1.token, body: { productId: prodB, recipientName: 'Test', recipientEmail: 't@acme.io', goal: 'Intro' } });
  assert.equal(draft.status, 404, JSON.stringify(draft.data));
  assert.ok(!JSON.stringify(draft.data).includes('B Secret Product'));
  assert.equal((await get('SELECT COUNT(*) AS c FROM email_drafts')).c, before.c);

  // Social post generator, service level: a foreign product id is rejected before the AI is called.
  let called = false;
  const mock = h.mockFetch([h.groqRoute(() => { called = true; return '{"title":"t","caption_text":"c","hashtags":"#a","call_to_action":"go"}'; })]);
  try {
    await assert.rejects(require('../services/marketingService').generateAiSocialPost(A.workspaceId, { productId: prodB, platform: 'LinkedIn' }), e => e.status === 404);
  } finally { mock.restore(); }
  assert.equal(called, false);
});
