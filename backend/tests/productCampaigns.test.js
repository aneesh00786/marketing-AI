const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const fx = require('./mediaFixtures');

// Product-based social campaigns: product selection, campaign details, AI strategy, product-aware
// generation, review, analytics. All AI providers are local fakes; nothing is published.
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-product-campaigns-'));
process.env.SOCIAL_MEDIA_STORAGE_DIR = STORAGE;
process.env.STUDIO_INLINE = '0';
process.env.STUDIO_AI_RATE_PER_MIN = '1000';
const db = () => h.db();
const aiMedia = () => require('../lib/aiMedia');
const gen = () => require('../modules/social/studio/generationService');

let W; let other; let mock; let prompts;
let n = 0;
const rk = () => `pc-${Date.now()}-${++n}`;
const api = (ws, method, p, body) => h.api(method, p, { token: ws.token, body });
const studio = (ws, method, p, body) => api(ws, method, `/api/v1/social/studio${p}`, body);

function textModel(req) {
  const p = req.messages.map(m => m.content).join('\n');
  prompts.push(p);
  if (p.includes('"ideas":[...]')) {
    return JSON.stringify({
      strategy: 'Show how ShelfSync removes stock-outs, then convert with a demo.', theme: 'Never run out', main_message: 'Real-time stock across every shelf',
      audience_suggestions: ['Store managers'], content_themes: ['Problem', 'Solution'], recommended_formats: ['poster', 'carousel', 'video'], recommended_post_count: 4,
      poster_concepts: ['Empty shelf vs full shelf'], video_concepts: ['A day without stock-outs'], reel_concepts: [], carousel_concepts: ['3 features'],
      schedule: 'Mornings on LinkedIn, evenings on Instagram', hashtags: ['retail', 'inventory'], cta_suggestions: ['Book a demo'],
      ideas: [
        { day: 1, title: 'Introduce ShelfSync', idea: 'Meet ShelfSync: stock levels in real time.', format: 'poster', platform: 'instagram', suggested_time: '18:00', media_prompt: 'A bright store shelf' },
        { day: 2, title: 'Three features', idea: 'Live counts, alerts and reorder suggestions.', format: 'carousel', platform: 'linkedin', suggested_time: '09:30', media_prompt: 'Feature slides' },
        { day: 3, title: 'Special offer', idea: 'Get 50% off this week only!', format: 'post', platform: 'linkedin', suggested_time: '10:00', media_prompt: '' },
        { day: 9, title: 'Beyond the campaign', idea: 'x', format: 'post', platform: 'instagram', suggested_time: '10:00', media_prompt: '' },
        { day: 2, title: 'Wrong platform', idea: 'x', format: 'post', platform: 'youtube', suggested_time: '10:00', media_prompt: '' }
      ]
    });
  }
  if (p.includes('"slides":[...]')) return JSON.stringify({ caption: 'Swipe through the features.', hashtags: ['retail'], slides: [{ title: 'Live counts', body: 'a' }, { title: 'Alerts', body: 'b' }, { title: 'Reorders', body: 'c' }] });
  if (p.includes('"posts":[')) return JSON.stringify({ posts: [{ platform: 'linkedin', title: 'ShelfSync', caption: 'Real-time stock for $9.99 a month.', hashtags: ['retail'], call_to_action: 'Book a demo' }] });
  return '{}';
}

const imageCalls = [];
const fakeImage = {
  key: 'fakeimg', kind: 'image', label: 'Fake Images', model: () => 'fake-1', configured: () => true,
  capabilities: { maxVariations: 4, aspects: ['1:1', '4:5', '9:16', '16:9'], referenceImages: true, textInImage: true },
  async generate({ prompt, variations, references = [], aspect }) {
    imageCalls.push({ prompt, references: references.length, aspect });
    return { images: Array.from({ length: variations }, () => fx.png(1080, 1080)), model: 'fake-1', requestId: 'r' };
  }
};

test.before(async () => {
  await h.prepareDatabase();
  W = await h.createWorkspace({ name: 'Product Campaigns' });
  other = await h.createWorkspace({ name: 'Other Campaigns' });
});
test.beforeEach(() => { prompts = []; mock = h.mockFetch([h.groqRoute(textModel)]); aiMedia().setProviderForTests('image', fakeImage); });
test.afterEach(() => { mock.restore(); aiMedia().setProviderForTests('image', null); });
test.after(() => { fs.rmSync(STORAGE, { recursive: true, force: true }); return h.shutdown(); });

async function runJobs(ws) {
  for (let i = 0; i < 10; i++) {
    const job = await db().get("SELECT * FROM background_jobs WHERE workspace_id = ? AND job_type = 'studio_generation' AND status = 'queued' ORDER BY id LIMIT 1", [ws.workspaceId]);
    if (!job) return;
    await db().run("UPDATE background_jobs SET status = 'running' WHERE id = ?", [job.id]);
    await gen().runJob(job);
    await db().run("UPDATE background_jobs SET status = 'succeeded' WHERE id = ?", [job.id]);
  }
}
const image = async ws => require('../modules/social/mediaStore').storeBuffer(ws.ctx, fx.png(800, 800), { title: 'Product photo', source: 'upload' });

let productId; let productImage; let campaignId;

test('products: the existing Digital Products, searchable and filterable by category for the campaign picker; another workspace sees none', async () => {
  productImage = await image(W);
  const foreign = await image(other);
  const bad = await api(W, 'POST', '/api/v1/products', { name: 'X', url: 'https://x.io', imageAssetIds: [foreign] });
  assert.equal(bad.status, 400, 'another workspace\'s image');
  const r = await api(W, 'POST', '/api/v1/products', { name: 'ShelfSync', url: 'https://shelfsync.io', tagline: 'Real-time shelf stock', description: 'Tracks stock on every shelf.',
    features: ['Live stock counts', 'Low-stock alerts', 'Reorder suggestions'], category: 'Retail software' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  productId = r.data.productId;
  await api(W, 'POST', '/api/v1/products', { name: 'CafeBook', url: 'https://cafebook.io', category: 'Hospitality' });
  const list = (await api(W, 'GET', '/api/v1/products?search=shelf')).data.products;
  assert.deepEqual(list.map(p => p.name), ['ShelfSync']);
  assert.equal(list[0].category, 'Retail software');
  assert.deepEqual((await api(W, 'GET', '/api/v1/products?category=Hospitality')).data.products.map(p => p.name), ['CafeBook']);
  assert.deepEqual((await api(W, 'GET', '/api/v1/products/categories')).data.categories, ['Hospitality', 'Retail software']);
  assert.equal((await api(other, 'GET', '/api/v1/products')).data.products.length, 0);
  assert.equal((await api(other, 'GET', `/api/v1/products/${productId}`)).status, 404);
});

test('campaign details: saved as a draft with the product; another workspace\'s product is refused; the wizard step is kept', async () => {
  const theirs = await api(other, 'POST', '/api/v1/products', { name: 'Theirs', url: 'https://t.io' });
  const refused = await api(W, 'POST', '/api/v1/social/campaigns', { name: 'X', productId: theirs.data.productId, platforms: ['instagram'] });
  assert.equal(refused.status, 400);
  const c = await api(W, 'POST', '/api/v1/social/campaigns', { name: 'ShelfSync launch', productId, objective: 'Product Launch', targetAudience: 'Store managers', description: 'Launch week',
    keyMessage: 'Never run out', startDate: '2026-12-01', endDate: '2026-12-03', platforms: ['instagram', 'linkedin'], language: 'en', tone: 'Professional', callToAction: 'Book a demo',
    landingUrl: 'https://shelfsync.io', wizardStep: 'details', imageAssetIds: [productImage] });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  campaignId = c.data.campaign.id;
  assert.deepEqual([c.data.campaign.status, c.data.campaign.description, c.data.campaign.wizardStep, c.data.campaign.imageAssetIds], ['Draft', 'Launch week', 'details', [productImage]],
    'the product images are chosen for the campaign');
  const foreignImg = await image(other);
  assert.equal((await api(W, 'PATCH', `/api/v1/social/campaigns/${c.data.campaign.id}`, { imageAssetIds: [foreignImg] })).status, 400, 'another workspace\'s image is refused');
  assert.equal((await api(other, 'GET', `/api/v1/social/campaigns/${campaignId}`)).status, 404);
});

test('AI strategy: from the product\'s facts; ideas within the campaign\'s days and platforms; unsupported claims flagged; edit, add, remove; accept creates drafts once', async () => {
  const r = await studio(W, 'POST', `/campaigns/${campaignId}/strategy`, { requestKey: rk() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = r.data.strategy;
  assert.ok(prompts.some(p => p.includes('ShelfSync') && p.includes('Low-stock alerts') && p.includes('Do not invent features')), 'grounded in the product');
  assert.deepEqual(s.ideas.map(i => [i.day, i.platforms[0]]), [[1, 'instagram'], [2, 'linkedin'], [3, 'linkedin']], 'day 9 and youtube dropped');
  assert.ok(s.unverifiedClaims.includes('50%'), 'a discount not in the facts is flagged');
  assert.ok(s.missingInformation.some(m => /Pricing/.test(m)), 'missing pricing is reported');
  assert.equal(s.status, 'draft');
  assert.equal((await db().get('SELECT product_id FROM social_content_generations WHERE id = ?', [r.data.generation.id])).product_id, productId);
  assert.equal((await db().get('SELECT COUNT(*) AS n FROM content_items WHERE campaign_id = ?', [campaignId])).n, 0, 'no posts and no media before acceptance');
  // Edit: remove the offer idea, add one, change a title.
  const ideas = s.ideas.filter(i => i.format !== 'post').map(i => (i.day === 1 ? { ...i, title: 'Meet ShelfSync' } : i));
  ideas.push({ day: 3, title: 'Demo video', idea: 'A short product demo.', format: 'video', platform: 'instagram', suggested_time: '19:00', media_prompt: 'Phone scanning a shelf' });
  const ed = await studio(W, 'PUT', `/campaigns/${campaignId}/strategy`, { ideas, theme: 'Full shelves' });
  assert.equal(ed.status, 200, JSON.stringify(ed.data));
  assert.equal(ed.data.strategy.ideas.length, 3);
  assert.equal((await studio(W, 'PUT', `/campaigns/${campaignId}/strategy`, { ideas: [{ ...ideas[0], platform: 'youtube' }] })).status, 400, 'only the campaign\'s platforms');
  assert.equal((await studio(other, 'PUT', `/campaigns/${campaignId}/strategy`, { ideas })).status, 404);
  const acc = await studio(W, 'POST', `/campaigns/${campaignId}/strategy/accept`, {});
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  const again = await studio(W, 'POST', `/campaigns/${campaignId}/strategy/accept`, {});
  assert.equal(again.data.alreadyAccepted, true);
  const posts = await db().all('SELECT status, format, plan_day, product_id, title, suggested_publish_at, source FROM content_items WHERE campaign_id = ? ORDER BY plan_day, id', [campaignId]);
  assert.deepEqual(posts.map(p => [p.plan_day, p.format, p.status, p.product_id]), [[1, 'poster', 'draft', productId], [2, 'carousel', 'draft', productId], [3, 'video', 'draft', productId]], 'once, linked to the product');
  assert.equal(posts[0].title, 'Meet ShelfSync');
  assert.ok(posts.every(p => p.suggested_publish_at && p.source === 'ai_strategy'));
  assert.equal((await studio(W, 'POST', `/campaigns/${campaignId}/strategy`, { requestKey: rk() })).status, 409, 'an accepted strategy is not replaced');
  assert.equal((await db().get('SELECT COUNT(*) AS n FROM publishing_jobs WHERE workspace_id = ?', [W.workspaceId])).n, 0, 'nothing scheduled or published');
});

test('content generation uses the product: product images as references, product in the prompt, linked to the planned post and product', async () => {
  const poster = (await db().get("SELECT id FROM content_items WHERE campaign_id = ? AND format = 'poster'", [campaignId])).id;
  imageCalls.length = 0;
  const r = await studio(W, 'POST', '/ai/poster', { requestKey: rk(), campaignId, contentItemId: poster, purpose: 'product_ad', variations: 2 });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  await runJobs(W);
  assert.equal(imageCalls.length, 1);
  assert.equal(imageCalls[0].references, 1, 'the product photo is the reference');
  assert.match(imageCalls[0].prompt, /ShelfSync/);
  assert.match(imageCalls[0].prompt, /do not invent features or prices/);
  const g = await db().get('SELECT product_id, campaign_id, status FROM social_content_generations WHERE id = ?', [r.data.generation.id]);
  assert.deepEqual([g.status, g.product_id, g.campaign_id], ['completed', productId, campaignId]);
  const item = await db().get('SELECT media_asset_ids_json, version FROM content_items WHERE id = ?', [poster]);
  assert.equal(JSON.parse(item.media_asset_ids_json).length, 1, 'the first design is attached as a new version');
  // Stories are vertical.
  imageCalls.length = 0;
  await studio(W, 'POST', '/ai/poster', { requestKey: rk(), campaignId, purpose: 'story', aspect: '1:1', variations: 1 });
  await runJobs(W);
  assert.equal(imageCalls[0].aspect, '9:16');
  // A carousel for the planned carousel post updates that post (no extra post).
  const car = (await db().get("SELECT id FROM content_items WHERE campaign_id = ? AND format = 'carousel'", [campaignId])).id;
  const before = (await db().get('SELECT COUNT(*) AS n FROM content_items WHERE campaign_id = ?', [campaignId])).n;
  const c = await studio(W, 'POST', '/ai/carousel', { requestKey: rk(), campaignId, contentItemId: car, topic: 'ShelfSync features', slideCount: 3 });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal((await db().get('SELECT COUNT(*) AS n FROM content_items WHERE campaign_id = ?', [campaignId])).n, before);
  assert.equal(JSON.parse((await db().get('SELECT carousel_json FROM content_items WHERE id = ?', [car])).carousel_json).length, 3);
  // Posts: a price the product does not have is flagged.
  const p = await studio(W, 'POST', '/ai/post', { requestKey: rk(), campaignId, platforms: ['linkedin'] });
  assert.ok(p.data.generation.output.unverifiedClaims.includes('$9.99'));
  // Another workspace cannot generate for this campaign.
  assert.ok([400, 404].includes((await studio(other, 'POST', '/ai/poster', { requestKey: rk(), campaignId, variations: 1 })).status), 'refused');
});

test('AI background replacement: a new edited copy linked to the original, which is kept', async () => {
  imageCalls.length = 0;
  const r = await studio(W, 'POST', '/ai/background', { requestKey: rk(), assetId: productImage, background: 'a clean white studio' });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  await runJobs(W);
  const g = await db().get('SELECT status, output_json FROM social_content_generations WHERE id = ?', [r.data.generation.id]);
  assert.equal(g.status, 'completed');
  const out = JSON.parse(g.output_json).assets[0].id;
  const a = await db().get('SELECT source, parent_asset_id FROM assets WHERE id = ?', [out]);
  assert.deepEqual([a.source, a.parent_asset_id], ['edited', productImage]);
  assert.equal(imageCalls[0].references, 1);
  assert.match(imageCalls[0].prompt, /Replace only the background with: a clean white studio/);
  assert.equal((await db().get('SELECT status FROM assets WHERE id = ?', [productImage])).status, 'ready');
  assert.equal((await studio(other, 'POST', '/ai/background', { requestKey: rk(), assetId: productImage, background: 'x y z' })).status, 400);
});

test('review overview and analytics: posts with previews and generation status, real metrics only, no leads; per workspace', async () => {
  const o = await studio(W, 'GET', `/campaigns/${campaignId}/overview`);
  assert.equal(o.status, 200, JSON.stringify(o.data));
  assert.equal(o.data.product.name, 'ShelfSync');
  assert.equal(o.data.product.images.length, 1);
  assert.equal(o.data.strategy.status, 'accepted');
  const poster = o.data.items.find(i => i.format === 'poster');
  assert.equal(poster.media[0].type, 'image');
  assert.equal(poster.generation.status, 'completed');
  assert.equal(o.data.counts.draft, 3);
  assert.equal((await studio(other, 'GET', `/campaigns/${campaignId}/overview`)).status, 404);
  const a = await studio(W, 'GET', `/campaigns/${campaignId}/analytics`);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.deepEqual([a.data.analytics.funnel.generated, a.data.analytics.funnel.published], [3, 0]);
  assert.ok(a.data.analytics.ai.credits > 0);
  assert.equal(a.data.analytics.metrics.publishedCount, 0);
  assert.ok(!('leads' in a.data.analytics), 'no leads for social campaigns');
  assert.equal((await studio(other, 'GET', `/campaigns/${campaignId}/analytics`)).status, 404);
  // Approval is still required before scheduling (existing publishing rules).
  const sched = await api(W, 'POST', `/api/v1/social/content/${poster.id}/schedule`, { localDateTime: '2026-12-01T10:00' });
  assert.notEqual(sched.status, 200);
});
