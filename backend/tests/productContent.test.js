const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Mail drafts are a legacy workspace-1 module, so workspace 1 is "A" here.
let A;
let B;
let twinA;
let twinB;
let thriveA;

// Unique per run: the test database keeps rows from earlier runs.
const TWIN = `Twin Product ${Date.now()}`;
const POST_JSON = '{"title":"t","caption_text":"Generated caption","hashtags":"#a","call_to_action":"Reply"}';

async function addProduct(token, body) {
  const r = await h.api('POST', '/api/v1/products', { token, body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.productId;
}

async function draftCount() {
  return Number((await h.db().get('SELECT COUNT(*) AS c FROM email_drafts')).c);
}

test.before(async () => {
  await h.prepareDatabase();
  A = await h.addMember(1, 'Workspace Owner');
  B = await h.createWorkspace({ name: 'Product Content B' });
  // A product whose name contains "ThriveWoo" must never be picked automatically.
  thriveA = await addProduct(A.token, { name: 'ThriveWoo Legacy', url: 'https://thrivewoo.com', tagline: 'Legacy tagline', features: ['Legacy feature'] });
  twinA = await addProduct(A.token, { name: TWIN, url: 'https://twin-a.example.org', tagline: 'Tagline of A', features: ['Feature only A has', '<b>Escaped</b>'] });
  twinB = await addProduct(B.token, { name: TWIN, url: 'https://twin-b.example.org', tagline: 'Tagline of B', features: ['Feature only B has'] });
});
test.after(() => h.shutdown());

test('mail draft with no product selected is generic and says so', async () => {
  const r = await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { recipientName: 'Dana', recipientEmail: 'dana@acme.io', goal: 'Ask for a short call about their process' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data.draft;
  assert.equal(d.product_id, null);
  assert.equal(d.product_name, null);
  assert.ok(r.data.missing_context.includes('product'));
  assert.match(r.data.message, /without product context/i);
  const all = `${d.subject}\n${d.body_html}\n${d.body_text}`;
  assert.doesNotMatch(all, /thrivewoo|wholesale|Twin Product|Legacy|Valued Partner|Executive Operations/i);
  assert.doesNotMatch(all, /https?:\/\//, 'no links without a product');
  assert.match(d.body_text, /Hi Dana,/);
  assert.match(d.body_text, /Ask for a short call about their process/);

  // No recipient name and no goal: neutral greeting and an explicit placeholder, nothing invented.
  const bare = await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: {} });
  assert.equal(bare.status, 200);
  assert.equal(bare.data.draft.recipient_name, '');
  assert.match(bare.data.draft.body_text, /Hi there,/);
  assert.match(bare.data.draft.body_text, /\[Add the purpose of this email\]/);
  assert.deepEqual(bare.data.missing_context.sort(), ['goal', 'product']);
});

test('malformed and unknown product ids are rejected before anything is saved', async () => {
  const before = await draftCount();
  for (const [productId, status] of [['abc', 400], [-1, 400], [1.5, 400], [999999999, 404]]) {
    const r = await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { productId, goal: 'x' } });
    assert.equal(r.status, status, `productId ${productId}`);
  }
  assert.equal(await draftCount(), before);
  const social = await h.api('POST', '/api/v1/marketing/generate-social-post', { token: A.token, body: { productId: 'abc', customTopic: 'x' } });
  assert.equal(social.status, 400);
});

test('identical product names across workspaces: only the caller workspace product is used', async () => {
  const before = await draftCount();
  const foreign = await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { productId: twinB, goal: 'Intro' } });
  assert.equal(foreign.status, 404);
  assert.ok(!JSON.stringify(foreign.data).includes('twin-b'));
  assert.equal(await draftCount(), before);

  const own = await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { productId: twinA, goal: 'Intro' } });
  assert.equal(own.status, 200);
  const all = own.data.draft.body_html + own.data.draft.body_text;
  assert.equal(own.data.draft.product_id, twinA);
  assert.match(all, /twin-a\.example\.org/);
  assert.doesNotMatch(all, /twin-b|Feature only B has|Tagline of B/);

  // Social posts: foreign id rejected without calling the AI; own id sends only A's details.
  let prompt = '';
  let calls = 0;
  const mock = h.mockFetch([h.groqRoute(b => { calls++; prompt = b.messages.map(m => m.content).join('\n'); return POST_JSON; })]);
  try {
    const bad = await h.api('POST', '/api/v1/marketing/generate-social-post', { token: A.token, body: { productId: twinB, platform: 'LinkedIn' } });
    assert.equal(bad.status, 404);
    assert.equal(calls, 0);
    const ok = await h.api('POST', '/api/v1/marketing/generate-social-post', { token: A.token, body: { productId: twinA, platform: 'LinkedIn' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.post.product_id, twinA);
  } finally { mock.restore(); }
  assert.match(prompt, /Tagline of A/);
  assert.doesNotMatch(prompt, /Tagline of B|Feature only B has|twin-b/);

  // Free-text product matching (Roger chat) stays in the workspace and needs an unambiguous name.
  const { findProductNamedIn } = require('../lib/productContext');
  assert.equal((await findProductNamedIn(1, `write a post about ${TWIN.toLowerCase()}`)).id, twinA);
  assert.equal((await findProductNamedIn(B.workspaceId, `write a post about ${TWIN}`)).id, twinB);
  assert.equal(await findProductNamedIn(1, 'write a post about our app'), null);
  const dup = await addProduct(A.token, { name: TWIN });
  assert.equal(await findProductNamedIn(1, `post about ${TWIN}`), null, 'duplicate names in one workspace are ambiguous');
  await h.api('DELETE', `/api/v1/products/${dup}`, { token: A.token });
});

test('selected product content uses only its stored details', async () => {
  const r = await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { productId: twinA, recipientName: 'Lee', recipientEmail: 'lee@acme.io', goal: 'Introduce the product' } });
  assert.equal(r.status, 200);
  const d = r.data.draft;
  assert.equal(d.product_name, TWIN);
  assert.deepEqual(r.data.missing_context, []);
  assert.equal(d.subject, `${TWIN}: Tagline of A`);
  assert.match(d.body_html, /href="https:\/\/twin-a\.example\.org"/);
  assert.match(d.body_html, /Feature only A has/);
  assert.match(d.body_html, /&lt;b&gt;Escaped&lt;\/b&gt;/, 'product text is HTML-escaped');
  assert.match(d.body_text, /Learn more: https:\/\/twin-a\.example\.org/);
  assert.doesNotMatch(d.body_html + d.body_text, /thrivewoo|Legacy feature|wholesale/i);

  // Selecting the "ThriveWoo" product explicitly is fine; it is just not a default.
  const tw = await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { productId: thriveA, goal: 'Intro' } });
  assert.equal(tw.data.draft.product_id, thriveA);
});

test('social post without a product is generic; without product or topic it is rejected', async () => {
  let prompt = '';
  const mock = h.mockFetch([h.groqRoute(b => { prompt = b.messages.map(m => m.content).join('\n'); return POST_JSON; })]);
  try {
    const none = await h.api('POST', '/api/v1/marketing/generate-social-post', { token: A.token, body: { platform: 'LinkedIn' } });
    assert.equal(none.status, 400);
    const generic = await h.api('POST', '/api/v1/marketing/generate-social-post', { token: A.token, body: { platform: 'LinkedIn', customTopic: 'Tips for planning a product launch', productKey: 'thrivewoo' } });
    assert.equal(generic.status, 200, JSON.stringify(generic.data));
    assert.equal(generic.data.post.product_id, null);
    assert.equal(generic.data.post.product_name, null);
    // The legacy template endpoint now goes through the same generator.
    const legacy = await h.api('POST', '/api/v1/marketing/generate-post', { token: A.token, body: { productKey: 'school_bus' } });
    assert.equal(legacy.status, 400);
  } finally { mock.restore(); }
  assert.match(prompt, /No product is selected/);
  assert.doesNotMatch(prompt, /thrivewoo|Twin Product|wholesale|Legacy tagline/i);
});

test('rewrite never substitutes canned copy when the AI is unavailable', async () => {
  const d = (await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { productId: twinA, goal: 'Intro' } })).data.draft;
  const mock = h.mockFetch([{ match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) }]);
  let r;
  try {
    r = await h.api('POST', `/api/v1/drafts/${d.id}/rewrite`, { token: A.token, body: { instruction: 'Short' } });
  } finally { mock.restore(); }
  assert.equal(r.status, 503, JSON.stringify(r.data));
  const after = await h.db().get('SELECT subject, body_text FROM email_drafts WHERE id = ?', [d.id]);
  assert.equal(after.subject, d.subject);
  assert.equal(after.body_text, d.body_text);
});

test('a draft without a recipient address cannot be sent', async () => {
  const d = (await h.api('POST', '/api/v1/drafts/generate', { token: A.token, body: { goal: 'Intro' } })).data.draft;
  const r = await h.api('POST', `/api/v1/drafts/${d.id}/send`, { token: A.token });
  assert.equal(r.status, 400);
  assert.equal((await h.db().get('SELECT status FROM email_drafts WHERE id = ?', [d.id])).status, 'Draft');
});

test('Roger never sends email to a guessed address or with canned text', async () => {
  const { get } = h.db();
  const before = Number((await get('SELECT COUNT(*) AS c FROM emails')).c);
  let mailCalls = 0;
  const mock = h.mockFetch([
    { match: u => u.includes('zeptomail'), respond: () => { mailCalls++; return h.json(200, {}); } },
    { match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) }
  ]);
  try {
    for (const message of ['send email', `send email to Nobody Such Person ${Date.now()} saying hello`, 'send an email to sam@acme.io']) {
      const r = await h.api('POST', '/api/v1/assistant/chat', { token: A.token, body: { message } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.match(r.data.reply, /did not send anything/, message);
    }
  } finally { mock.restore(); }
  assert.equal(mailCalls, 0);
  assert.equal(Number((await get('SELECT COUNT(*) AS c FROM emails')).c), before);
});

test('Roger product details: a named product, never an arbitrary first one', async () => {
  const named = await h.api('POST', '/api/v1/assistant/chat', { token: A.token, body: { message: `show me the details of ${TWIN}` } });
  assert.match(named.data.reply, /Tagline of A/);
  assert.doesNotMatch(named.data.reply, /Tagline of B|FMCG/);
  const unnamed = await h.api('POST', '/api/v1/assistant/chat', { token: A.token, body: { message: 'show me my product details' } });
  assert.match(unnamed.data.reply, /Which one would you like/);
});

test('inbox analysis and website extraction invent nothing when the AI is unavailable', async () => {
  const aiEngine = require('../services/aiEngine');
  const mock = h.mockFetch([
    { match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) },
    { match: u => u.includes('localhost:11434'), respond: () => h.json(500, {}) }
  ]);
  let analysis;
  let extracted;
  try {
    analysis = await aiEngine.analyzeEmail({ subject: 'What does it cost?', body: 'Please send pricing', sender: 'Kim' });
    extracted = await aiEngine.extractProductFromWebpage('https://thrivewoo.com', 'Short page text', 'Page Title', { headings: ['Order tracking for teams'] });
  } finally { mock.restore(); }
  assert.equal(analysis.ai_priority, 'Pricing');
  assert.equal(analysis.ai_summary, 'Kim wrote about "What does it cost?".');
  assert.deepEqual(analysis.ai_replies, []);
  assert.equal(extracted.name, 'Page Title');
  assert.equal(extracted.tagline, null);
  assert.equal(extracted.description, null);
  assert.equal(extracted.target_audience, null);
  assert.deepEqual(extracted.features, ['Order tracking for teams']);
  assert.doesNotMatch(JSON.stringify(extracted), /FMCG|ThriveWoo -|Smart FMCG/);
});
