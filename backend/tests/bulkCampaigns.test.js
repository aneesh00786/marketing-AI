const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const fx = require('./mediaFixtures');

// AI Campaign Strategy and Generate All Content. AI providers are local fakes; nothing is published.
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-bulk-'));
process.env.SOCIAL_MEDIA_STORAGE_DIR = STORAGE;
process.env.STUDIO_INLINE = '0';
process.env.STUDIO_AI_RATE_PER_MIN = '1000';
const db = () => h.db();
const aiMedia = () => require('../lib/aiMedia');
const gen = () => require('../modules/social/studio/generationService');
const bulk = () => require('../modules/social/studio/bulkService');

let W; let other; let mock; let prompts;
let n = 0;
const rk = () => `bk-${Date.now()}-${++n}`;
const api = (ws, method, p, body) => h.api(method, p, { token: ws.token, body });
const studio = (ws, method, p, body) => api(ws, method, `/api/v1/social/studio${p}`, body);

const IDEAS = [
  { day: 1, title: 'Introduce ShelfSync', idea: 'Meet ShelfSync.', objective: 'Awareness', format: 'poster', platforms: ['instagram', 'linkedin'], suggested_time: '18:00', image_prompt: 'A full store shelf', caption: 'Meet ShelfSync.', hashtags: ['retail'], cta: 'Learn more' },
  { day: 2, title: 'Three features', idea: 'Live counts, alerts, reorders.', format: 'carousel', platforms: ['linkedin'], suggested_time: '09:30', image_prompt: 'Feature slides' },
  { day: 3, title: 'Demo', idea: 'A product demo.', format: 'video', platforms: ['instagram'], suggested_time: '19:00', video_prompt: 'Phone scanning a shelf' },
  { day: 4, title: 'Why it matters', idea: 'Empty shelves cost sales.', format: 'post', platforms: ['instagram', 'linkedin'], suggested_time: '10:00' },
  { day: 5, title: 'Story', idea: 'Swipe up to see it.', format: 'story', platforms: ['instagram'], suggested_time: '20:00', image_prompt: 'Vertical teaser' }
];
function textModel(req) {
  const p = req.messages.map(m => m.content).join('\n');
  prompts.push(p);
  if (p.includes('"content_mix":{...}')) {
    return JSON.stringify({ overview: { theme: 'Never run out', objective: 'Launch', main_message: 'Real-time stock', target_audience: 'Store managers', unique_selling_points: ['Live counts'], approach: 'Problem, then demo' },
      content_mix: { posts: 1, posters: 1, videos: 1, reels: 0, carousels: 1, stories: 1 }, platform_strategy: { instagram: 'Visual', linkedin: 'Expert' },
      publishing: { frequency: 'Daily', best_times: 'Mornings', sequence: 'Intro, features, demo, why, story' }, messages: { headline: 'Never run out', supporting: ['Live counts'], promotional: [], ctas: ['Book a demo'], hashtags: ['retail'] },
      strategy: 'Launch week.', ideas: IDEAS });
  }
  if (p.includes('{"idea":{...}}')) return JSON.stringify({ idea: { day: 3, title: 'Customer story', idea: 'How a shop stopped running out.', format: 'post', platforms: ['linkedin'], suggested_time: '11:00', caption: 'A store manager\'s story.' } });
  if (p.includes('"slides":[...]')) return JSON.stringify({ caption: 'Swipe.', hashtags: ['retail'], slides: [{ title: 'Live counts' }, { title: 'Alerts' }, { title: 'Reorders' }] });
  if (p.includes('"posts":[')) return JSON.stringify({ posts: [{ platform: 'instagram', title: 'Why', caption: 'IG: empty shelves cost sales.', hashtags: ['shop'], call_to_action: 'See how' }, { platform: 'linkedin', title: 'Why', caption: 'LI: empty shelves cost sales.', hashtags: ['retail'], call_to_action: 'Book a demo' }] });
  return '{}';
}
const imageCalls = []; let failVideo = 0;
const fakeImage = { key: 'fakeimg', kind: 'image', label: 'Fake Images', model: () => 'fi-1', configured: () => true,
  capabilities: { maxVariations: 4, aspects: ['1:1', '4:5', '9:16', '16:9'], referenceImages: true },
  async generate({ prompt, variations, aspect }) { imageCalls.push({ prompt, aspect }); return { images: Array.from({ length: variations }, () => fx.png(1080, 1080)), model: 'fi-1' }; } };
const fakeVideo = { key: 'fakevid', kind: 'video', label: 'Fake Video', model: () => 'fv-1', configured: () => true,
  capabilities: { textToVideo: false, imageToVideo: true, durations: [5, 10], aspects: ['9:16', '16:9', '1:1'] },
  async start() { if (failVideo > 0) { failVideo--; throw aiMedia().providerError('Fake Video is down.', { code: 'PROVIDER_ERROR', retryable: true }); } return { jobId: 'v1', model: 'fv-1' }; },
  async poll() { return { status: 'completed', video: fx.mp4({ width: 720, height: 1280, seconds: 5 }) }; } };

test.before(async () => {
  await h.prepareDatabase();
  W = await h.createWorkspace({ name: 'Bulk' });
  other = await h.createWorkspace({ name: 'Other Bulk' });
});
test.beforeEach(() => { prompts = []; mock = h.mockFetch([h.groqRoute(textModel)]); aiMedia().setProviderForTests('image', fakeImage); aiMedia().setProviderForTests('video', fakeVideo); });
test.afterEach(() => { mock.restore(); aiMedia().setProviderForTests('image', null); aiMedia().setProviderForTests('video', null); delete process.env.SOCIAL_AI_MONTHLY_CREDIT_LIMIT; });
test.after(() => { fs.rmSync(STORAGE, { recursive: true, force: true }); return h.shutdown(); });

/** Runs queued Studio jobs (the bulk run, then the generations it started) as the worker would. */
async function runJobs(ws) {
  for (let i = 0; i < 30; i++) {
    const job = await db().get("SELECT * FROM background_jobs WHERE workspace_id = ? AND job_type IN ('studio_bulk', 'studio_generation') AND status = 'queued' ORDER BY id LIMIT 1", [ws.workspaceId]);
    if (!job) return;
    await db().run("UPDATE background_jobs SET status = 'running' WHERE id = ?", [job.id]);
    if (job.job_type === 'studio_bulk') await bulk().runJob(job); else await gen().runJob(job);
    await db().run("UPDATE background_jobs SET status = 'succeeded' WHERE id = ?", [job.id]);
  }
}
async function campaignFor(ws, name) {
  const prod = await api(ws, 'POST', '/api/v1/products', { name: 'ShelfSync', url: 'https://shelfsync.io', description: 'Tracks stock.', features: ['Live counts'] });
  const img = await require('../modules/social/mediaStore').storeBuffer(ws.ctx, fx.png(800, 800), { title: 'Photo', source: 'upload' });
  const c = await api(ws, 'POST', '/api/v1/social/campaigns', { name, productId: prod.data.productId, platforms: ['instagram', 'linkedin'], startDate: '2026-12-01', endDate: '2026-12-07', imageAssetIds: [img] });
  return c.data.campaign.id;
}
async function approvedCampaign(ws, name) {
  const id = await campaignFor(ws, name);
  assert.equal((await studio(ws, 'POST', `/campaigns/${id}/strategy`, { requestKey: rk() })).status, 200);
  assert.equal((await studio(ws, 'POST', `/campaigns/${id}/strategy/accept`, {})).status, 200);
  return id;
}

let cid;
test('strategy: structured (overview, content mix, platforms, publishing, messages) and a plan with multi-platform items; one item regenerated; reorder and edit; approval makes one post per platform', async () => {
  cid = await campaignFor(W, 'Launch');
  const r = await studio(W, 'POST', `/campaigns/${cid}/strategy`, { requestKey: rk() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = r.data.strategy;
  assert.deepEqual([s.overview.unique_selling_points, s.content_mix.posters, s.publishing.frequency, s.messages.headline], [['Live counts'], 1, 'Daily', 'Never run out']);
  assert.deepEqual(s.ideas[0].platforms, ['instagram', 'linkedin']);
  assert.equal(s.ideas[0].media_format, 'Image 1:1 or 4:5', 'media format filled in');
  assert.ok(prompts.some(p => p.includes('1 image(s) that posters and videos can show')), 'the product images are part of the analysis');
  // Regenerate only day 3.
  const day3 = s.ideas.find(i => i.day === 3).id;
  const re = await studio(W, 'POST', `/campaigns/${cid}/strategy/items/${day3}/regenerate`, { requestKey: rk() });
  assert.equal(re.status, 200, JSON.stringify(re.data));
  const ideas = re.data.strategy.ideas;
  assert.equal(ideas.find(i => i.id === day3).title, 'Customer story');
  assert.equal(ideas.filter(i => i.id !== day3).map(i => i.title).join(), s.ideas.filter(i => i.id !== day3).map(i => i.title).join(), 'the others unchanged');
  // Put the video back, reorder, change a type and platforms.
  const edited = [ideas[1], ideas[0], { ...IDEAS[2], id: day3 }, ideas[3], { ...ideas[4], format: 'poster', platforms: ['instagram', 'linkedin'] }];
  const put = await studio(W, 'PUT', `/campaigns/${cid}/strategy`, { ideas: edited });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.strategy.ideas[0].title, 'Three features', 'reordered');
  assert.equal((await studio(W, 'PUT', `/campaigns/${cid}/strategy`, { ideas: [{ ...edited[0], platforms: ['youtube'] }] })).status, 400);
  // Approve: 5 items on 1-2 platforms -> 8 posts, grouped per item; no media yet.
  const acc = await studio(W, 'POST', `/campaigns/${cid}/strategy/accept`, {});
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  const posts = await db().all('SELECT format, platform_key, post_group_id, hashtags, call_to_action FROM content_items WHERE campaign_id = ? ORDER BY id', [cid]);
  assert.equal(posts.length, 8);
  assert.equal(new Set(posts.map(p => p.post_group_id)).size, 5);
  assert.equal((await db().get("SELECT COUNT(*) AS n FROM social_content_generations WHERE campaign_id = ? AND kind IN ('image', 'video', 'carousel')", [cid])).n, 0, 'no paid media before Generate All');
});

test('Generate All Content: estimate by type against the balance; confirmation; one run only; every item generated once; posts written per platform; media shared across an item\'s platforms', async () => {
  const est = await studio(W, 'GET', `/campaigns/${cid}/bulk/estimate`);
  assert.equal(est.status, 200, JSON.stringify(est.data));
  const e = est.data.estimate;
  assert.equal(e.totalItems, 5, 'one unit per planned item, not per platform');
  assert.deepEqual(e.byType.map(t => [t.type, t.count]).sort(), [['carousel', 1], ['post', 1], ['poster', 2], ['video', 1]]);
  assert.equal(e.credits, 5 + 5 + 26 + 50 + 1, 'poster 5 + poster 5 + carousel 1 + 5 slides x 5 + video 5 s x 10 (product image as start frame) + post 1');
  assert.ok(e.balance.available > 0);
  assert.equal(e.costUsd, null, 'no invented prices');
  const noConfirm = await studio(W, 'POST', `/campaigns/${cid}/bulk`, {});
  assert.deepEqual([noConfirm.status, noConfirm.data.code], [409, 'CONFIRMATION_REQUIRED']);
  const s1 = await studio(W, 'POST', `/campaigns/${cid}/bulk`, { confirm: true });
  assert.equal(s1.status, 202, JSON.stringify(s1.data));
  const s2 = await studio(W, 'POST', `/campaigns/${cid}/bulk`, { confirm: true });
  assert.deepEqual([s2.data.batchKey, s2.data.alreadyRunning], [s1.data.batchKey, true], 'a second click returns the same run');
  await runJobs(W);
  const st = (await studio(W, 'GET', `/campaigns/${cid}/bulk`)).data;
  assert.deepEqual(st.counts, { total: 5, completed: 5, processing: 0, queued: 0, failed: 0, canceled: 0 }, JSON.stringify(st.items));
  assert.equal(st.run.active, false);
  const gens = await db().all('SELECT kind, product_id, campaign_id FROM social_content_generations WHERE batch_key = ?', [s1.data.batchKey]);
  assert.equal(gens.length, 5, 'each item once');
  assert.ok(gens.every(g => g.campaign_id === cid && g.product_id));
  const posts = await db().all('SELECT id, format, platform_key, media_asset_ids_json, caption_text, post_group_id, status FROM content_items WHERE campaign_id = ? ORDER BY id', [cid]);
  const posterPair = posts.filter(p => p.format === 'poster' && p.post_group_id === posts.find(x => x.format === 'poster' && x.platform_key === 'instagram').post_group_id);
  assert.equal(posterPair.length, 2);
  assert.deepEqual(JSON.parse(posterPair[0].media_asset_ids_json), JSON.parse(posterPair[1].media_asset_ids_json), 'one design shared by both platforms');
  const textPosts = posts.filter(p => p.format === 'post');
  assert.deepEqual(textPosts.map(p => p.caption_text.slice(0, 3)).sort(), ['IG:', 'LI:'], 'a post written for each platform');
  assert.ok(posts.every(p => p.status === 'draft'), 'nothing approved, scheduled or published');
  assert.equal((await db().get('SELECT COUNT(*) AS n FROM publishing_jobs WHERE workspace_id = ?', [W.workspaceId])).n, 0);
  // Starting again: nothing left to generate.
  assert.equal((await studio(W, 'POST', `/campaigns/${cid}/bulk`, { confirm: true })).data.code, 'NOTHING_TO_GENERATE');
  // Another workspace cannot see or start it.
  assert.equal((await studio(other, 'GET', `/campaigns/${cid}/bulk`)).status, 404);
  assert.equal((await studio(other, 'POST', `/campaigns/${cid}/bulk`, { confirm: true })).status, 404);
});

test('credits: an estimate over the available balance is refused; running work reserves credits; failures are not charged and a retried item is charged once; canceled items are never charged', async () => {
  const id = await approvedCampaign(W, 'Credits');
  process.env.SOCIAL_AI_MONTHLY_CREDIT_LIMIT = '20';
  const low = await studio(W, 'POST', `/campaigns/${id}/bulk`, { confirm: true });
  assert.deepEqual([low.status, low.data.code], [402, 'CREDIT_LIMIT']);
  delete process.env.SOCIAL_AI_MONTHLY_CREDIT_LIMIT;
  failVideo = 1;
  const s = await studio(W, 'POST', `/campaigns/${id}/bulk`, { confirm: true });
  assert.equal(s.status, 202);
  // Reservation: before the jobs run, queued work holds credits.
  const before = await gen().creditBalance(W.workspaceId);
  await runJobs(W);
  let st = (await studio(W, 'GET', `/campaigns/${id}/bulk`)).data;
  const video = st.items.find(i => i.format === 'video');
  assert.equal(video.status, 'failed');
  assert.match(video.error, /down/);
  assert.equal(video.credits, null, 'failed: not charged');
  const r = await studio(W, 'POST', `/campaigns/${id}/bulk/items/${video.itemId}/retry`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await runJobs(W);
  st = (await studio(W, 'GET', `/campaigns/${id}/bulk`)).data;
  assert.equal(st.items.find(i => i.format === 'video').status, 'completed');
  assert.equal(st.items.find(i => i.format === 'video').credits, 50, 'charged once');
  assert.ok(before.reserved >= 0);
  // Cancel: a run whose queued generations are canceled before they start.
  const id2 = await approvedCampaign(W, 'Cancel me');
  await studio(W, 'POST', `/campaigns/${id2}/bulk`, { confirm: true });
  const job = await db().get("SELECT * FROM background_jobs WHERE workspace_id = ? AND job_type = 'studio_bulk' AND status = 'queued' ORDER BY id DESC LIMIT 1", [W.workspaceId]);
  await db().run("UPDATE background_jobs SET status = 'running' WHERE id = ?", [job.id]);
  await bulk().runJob(job);   // the run starts the image/video jobs (queued)
  await db().run("UPDATE background_jobs SET status = 'succeeded' WHERE id = ?", [job.id]);
  const reserved = await gen().creditBalance(W.workspaceId);
  assert.ok(reserved.reserved > 0, 'queued work reserves credits');
  const c = await studio(W, 'POST', `/campaigns/${id2}/bulk/cancel`, {});
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.ok(c.data.counts.canceled >= 3);
  await runJobs(W);
  const charged = await db().get("SELECT COUNT(*) AS n FROM social_content_generations WHERE campaign_id = ? AND status = 'canceled' AND credits IS NOT NULL", [id2]);
  assert.equal(charged.n, 0, 'canceled: never charged');
  assert.equal((await gen().creditBalance(W.workspaceId)).reserved, 0, 'reservations released');
});

test('regenerating one item keeps the previous version; the history lists versions with provider, model, prompt, cost and files', async () => {
  const poster = (await db().get("SELECT id FROM content_items WHERE campaign_id = ? AND format = 'poster' ORDER BY id LIMIT 1", [cid])).id;
  const before = JSON.parse((await db().get('SELECT media_asset_ids_json FROM content_items WHERE id = ?', [poster])).media_asset_ids_json);
  const r = await studio(W, 'POST', '/ai/poster', { requestKey: rk(), campaignId: cid, contentItemId: poster, variations: 1, prompt: 'A brighter version' });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  await runJobs(W);
  const after = JSON.parse((await db().get('SELECT media_asset_ids_json FROM content_items WHERE id = ?', [poster])).media_asset_ids_json);
  assert.notDeepEqual(after, before);
  assert.equal((await db().get('SELECT status FROM assets WHERE id = ?', [before[0]])).status, 'ready', 'the previous design is kept');
  const hist = (await studio(W, 'GET', `/content/${poster}/generations`)).data.history;
  assert.ok(hist.length >= 2);
  const last = hist[hist.length - 1];
  assert.deepEqual([last.version, last.provider, last.model, last.status], [hist.length, 'fakeimg', 'fi-1', 'completed']);
  assert.match(last.prompt, /A brighter version/);
  assert.equal(last.credits, 5);
  assert.ok(last.assets[0].url);
  assert.equal((await studio(other, 'GET', `/content/${poster}/generations`)).status, 404);
  // Analytics: planned items, failed and the comparison by content type.
  const a = (await studio(W, 'GET', `/campaigns/${cid}/analytics`)).data.analytics;
  assert.equal(a.funnel.planned, 5);
  assert.ok(a.funnel.generatedWithMedia >= 7);
  assert.ok('byFormat' in a.metrics);
});

test('strategy from a small model: loose values are tidied, an unusable item is dropped, and an off-format reply is retried with the reason', async () => {
  const cid = await campaignFor(W, 'Loose model');
  let calls = 0;
  mock.restore();
  mock = h.mockFetch([h.groqRoute(req => {
    const p = req.messages.map(m => m.content).join('\n');
    calls++;
    if (calls === 1) return JSON.stringify({ overview: 'not an object', ideas: [{ nothing: true }] });
    assert.match(p, /previous answer was rejected/);
    assert.match(p, /ideas/);
    return JSON.stringify({
      strategy: { summary: 'Wrapped in a strategy object.', overview: { theme: 'Never run out', unique_selling_points: 'Live counts, Alerts' }, content_mix: { posters: '2' },
        platform_strategy: { Instagram: 'Visual' }, messages: { hashtags: '#retail #stock' },
        ideas: [
          { day: '1', title: 'Intro', format: 'Image Post', platforms: 'Instagram, LinkedIn', suggested_time: '6:30 PM', hashtags: '#retail, #launch', call_to_action: 'Learn more' },
          { day: 2, description: 'A quick demo', type: 'Reels', platform: 'IG', time: '9 am' },
          { day: 3, format: 'hologram' }
        ] }
    });
  })]);
  const r = await studio(W, 'POST', `/campaigns/${cid}/strategy`, { requestKey: rk() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(calls, 2);
  const s = r.data.strategy;
  assert.equal(s.overview.theme, 'Never run out');
  assert.deepEqual(s.overview.unique_selling_points, ['Live counts', 'Alerts']);
  assert.deepEqual(s.messages.hashtags, ['retail', 'stock']);
  assert.equal(s.ideas.length, 2, 'the unusable item is dropped');
  assert.deepEqual(s.ideas.map(i => [i.day, i.format, i.platforms.join('+'), i.suggested_time]), [[1, 'poster', 'instagram+linkedin', '18:30'], [2, 'reel', 'instagram', '09:00']]);
  assert.deepEqual(s.ideas[0].hashtags, ['retail', 'launch']);
  assert.equal(s.ideas[0].cta, 'Learn more');
  assert.equal(s.ideas[1].title, 'A quick demo');
});
