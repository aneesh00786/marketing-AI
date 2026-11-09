const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const fx = require('./mediaFixtures');

// AI Content Studio. Every provider is a local fake: text through the Groq mock, images and videos
// through setProviderForTests. No real AI request is made and no credits are spent.
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-studio-test-'));
process.env.SOCIAL_MEDIA_STORAGE_DIR = STORAGE;
process.env.STUDIO_INLINE = '0';
process.env.STUDIO_AI_RATE_PER_MIN = '1000';
const db = () => h.db();
const aiMedia = () => require('../lib/aiMedia');
const gen = () => require('../modules/social/studio/generationService');

let W; let other; let mock; let prompts;
// Every generation is for a campaign with a selected Digital Product: each test workspace has one,
// added to generation requests that do not name a campaign.
const GEN_PATHS = ['/ai/post', '/ai/poster', '/ai/carousel', '/ai/video'];
const sapi = (ws, method, p, body) => h.api(method, `/api/v1/social/studio${p}`, { token: ws.token,
  body: body && GEN_PATHS.includes(p) && !('campaignId' in body) && ws.campaignId ? { ...body, campaignId: ws.campaignId } : body });
async function productCampaign(ws) {
  const prod = await h.api('POST', '/api/v1/products', { token: ws.token, body: { name: 'Spring range', url: 'https://acme-co.io', description: 'Spring clothing for shops.', features: ['Light fabrics'] } });
  const camp = await h.api('POST', '/api/v1/social/campaigns', { token: ws.token, body: { name: 'Spring', productId: prod.data.productId, platforms: ['instagram', 'linkedin'] } });
  ws.productId = prod.data.productId;
  ws.campaignId = camp.data.campaign.id;
}
let n = 0;
const rk = () => `rk-${Date.now()}-${++n}`;

/** The fake text model: answers by what the prompt asks for, and keeps every prompt. */
function textModel(req) {
  const p = req.messages.map(m => m.content).join('\n');
  prompts.push(p);
  if (p.includes('"posts":[')) return JSON.stringify({ posts: [{ platform: 'instagram', title: 'Spring sale', caption: 'Fresh looks for spring.', description: 'Spring', hashtags: ['spring', 'sale'], call_to_action: 'Shop now', suggested_time: 'Tuesday 10:00', suggested_format: 'carousel' }, { platform: 'linkedin', title: 'Spring', caption: 'Our spring range is here.', hashtags: ['b2b'], call_to_action: 'Learn more', suggested_time: 'Wednesday 09:00', suggested_format: 'image' }] });
  if (p.includes('{"value"')) return JSON.stringify({ value: p.includes('hashtags') && p.includes('new hashtags') ? ['fresh', 'new'] : 'A brand new caption.' });
  if (p.includes('"items": [...]')) return JSON.stringify({ strategy: 'Build awareness, then convert.', items: [
    { day: 1, title: 'Announcement', format: 'poster', platform: 'instagram', caption: 'Black Friday is coming.', hashtags: ['blackfriday'], media_prompt: 'Bold poster', suggested_time: '10:00' },
    { day: 2, title: 'Benefits', format: 'carousel', platform: 'linkedin', caption: 'Three reasons to switch.', hashtags: [], media_prompt: 'Carousel of benefits', suggested_time: '09:30' },
    { day: 3, title: 'Promo video', format: 'reel', platform: 'instagram', caption: 'Watch this.', hashtags: [], media_prompt: 'Product reel', suggested_time: '18:00' },
    { day: 9, title: 'Out of range', format: 'post', platform: 'facebook', caption: 'x', hashtags: [], media_prompt: '', suggested_time: '10:00' }] });
  if (p.includes('"slides":[...]')) return JSON.stringify({ caption: 'Swipe to see how.', hashtags: ['howto'], slides: [{ title: 'Why it matters', body: 'One', image_prompt: 'Slide one' }, { title: 'Step one', body: 'Two', image_prompt: 'Slide two' }, { title: 'Get started', body: 'Three', image_prompt: 'Slide three' }] });
  return '{}';
}

/** A fake image provider: real PNG bytes, counted calls; fails while `failNext` is set. */
const imageCalls = [];
let failNext = 0;
const fakeImage = {
  key: 'fakeimg', kind: 'image', label: 'Fake Images', model: () => 'fake-1', configured: () => true,
  capabilities: { maxVariations: 4, aspects: ['1:1', '4:5', '9:16', '16:9'], referenceImages: false, textInImage: true },
  async generate({ prompt, variations }) {
    imageCalls.push(prompt);
    if (failNext > 0) { failNext--; throw aiMedia().providerError('Fake Images is busy.', { code: 'PROVIDER_RATE_LIMIT', status: 429, retryable: true }); }
    return { images: Array.from({ length: variations }, () => fx.png(1080, 1080)), model: 'fake-1', requestId: 'req-1' };
  }
};
const videoPolls = [];
const fakeVideo = {
  key: 'fakevid', kind: 'video', label: 'Fake Video', model: () => 'fv-1', configured: () => true,
  capabilities: { textToVideo: false, imageToVideo: true, durations: [5, 10], aspects: ['9:16', '16:9', '1:1'], audio: false },
  async start({ imageDataUri }) { assert.match(imageDataUri, /^data:image\/png;base64,/); return { jobId: 'job-123', model: 'fv-1' }; },
  async poll(jobId) { videoPolls.push(jobId); return videoPolls.length < 2 ? { status: 'processing', progress: 0.5 } : { status: 'completed', video: fx.mp4({ width: 720, height: 1280, seconds: 5 }) }; }
};

test.before(async () => {
  await h.prepareDatabase();
  W = await h.createWorkspace({ name: 'Studio' });
  other = await h.createWorkspace({ name: 'Other Studio' });
  await productCampaign(W);
  await productCampaign(other);
});
test.beforeEach(() => { prompts = []; mock = h.mockFetch([h.groqRoute(textModel)]); });
test.afterEach(() => { mock.restore(); aiMedia().setProviderForTests('image', null); aiMedia().setProviderForTests('video', null); delete process.env.SOCIAL_AI_MONTHLY_CREDIT_LIMIT; });
test.after(() => { fs.rmSync(STORAGE, { recursive: true, force: true }); return h.shutdown(); });

/** Runs the queued Studio jobs as the worker would (poll jobs included). */
async function runJobs(ws) {
  for (let i = 0; i < 10; i++) {
    const job = await db().get("SELECT * FROM background_jobs WHERE workspace_id = ? AND job_type = 'studio_generation' AND status = 'queued' ORDER BY id LIMIT 1", [ws.workspaceId]);
    if (!job) return;
    await db().run("UPDATE background_jobs SET status = 'running' WHERE id = ?", [job.id]);
    await gen().runJob(job);
    await db().run("UPDATE background_jobs SET status = 'succeeded' WHERE id = ?", [job.id]);
  }
}
const generation = async (ws, id) => (await sapi(ws, 'GET', `/generations/${id}`)).data.generation;

test('capabilities: nothing is offered without a provider key; keys are never returned', async () => {
  const r = await sapi(W, 'GET', '/capabilities');
  assert.equal(r.status, 200);
  assert.equal(r.data.capabilities.image.available, false);
  assert.match(r.data.capabilities.image.reason, /OPENAI_API_KEY or FAL_KEY/);
  assert.equal(r.data.capabilities.video.available, false);
  assert.equal(r.data.capabilities.videoEditing.available, false, 'no FFmpeg in tests');
  aiMedia().setProviderForTests('image', fakeImage);
  assert.equal((await sapi(W, 'GET', '/capabilities')).data.capabilities.image.provider, 'fakeimg');
  const poster = await sapi(other, 'POST', '/ai/poster', { requestKey: rk(), product: 'x' });
  assert.equal(poster.status, 202, 'available once a provider is configured');
  aiMedia().setProviderForTests('image', null);
  const none = await sapi(W, 'POST', '/ai/poster', { requestKey: rk(), product: 'x' });
  assert.deepEqual([none.status, none.data.code], [501, 'NOT_CONFIGURED']);
});

test('brand kit: saved per workspace, applied to AI prompts; another workspace\'s images or kits are refused', async () => {
  const kit = await sapi(W, 'POST', '/brand-kits', { name: 'Main', companyName: 'ThriveWoo', primaryColor: '#1E40AF', secondaryColor: '#F59E0B', tone: 'Confident and friendly', guidelines: 'Never use slang.' });
  assert.equal(kit.status, 200, JSON.stringify(kit.data));
  assert.equal(kit.data.brandKit.isDefault, true, 'the first kit is the default');
  assert.equal((await sapi(W, 'POST', '/brand-kits', { name: 'Main' })).status, 409);
  assert.equal((await sapi(W, 'POST', '/brand-kits', { name: 'Bad', primaryColor: 'blue' })).status, 400);
  const otherImg = await db().run("INSERT INTO assets (workspace_id, asset_type, source, public_id, storage_key, mime_type, status, created_at) VALUES (?, 'image', 'upload', ?, ?, 'image/png', 'ready', UTC_TIMESTAMP())", [other.workspaceId, `p${Date.now()}`, `s${Date.now()}`]);
  assert.equal((await sapi(W, 'PUT', `/brand-kits/${kit.data.brandKit.id}`, { logoAssetId: otherImg.lastID })).status, 400, 'logo from another workspace');
  assert.equal((await sapi(other, 'GET', '/brand-kits')).data.brandKits.length, 0);
  assert.equal((await sapi(other, 'PUT', `/brand-kits/${kit.data.brandKit.id}`, { name: 'Stolen' })).status, 404);
  // The default kit reaches the text model as data.
  await sapi(W, 'POST', '/ai/post', { requestKey: rk(), platforms: ['instagram'], product: 'Spring range' });
  assert.ok(prompts.some(p => p.includes('ThriveWoo') && p.includes('#1E40AF') && p.includes('Never use slang.')));
});

test('AI post: platform-specific fields; the same request key never runs twice; a field is regenerated on its own', async () => {
  const key = rk();
  const r = await sapi(W, 'POST', '/ai/post', { requestKey: key, platforms: ['instagram', 'linkedin'], product: 'Spring range', objective: 'Sales' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const g = r.data.generation;
  assert.equal(g.status, 'completed');
  assert.deepEqual(g.output.posts.map(p => [p.platform, p.call_to_action, p.suggested_time]), [['instagram', 'Shop now', 'Tuesday 10:00'], ['linkedin', 'Learn more', 'Wednesday 09:00']]);
  assert.equal(g.credits, 1);
  const calls = prompts.length;
  const again = await sapi(W, 'POST', '/ai/post', { requestKey: key, platforms: ['instagram'], product: 'Other' });
  assert.equal(again.data.generation.id, g.id, 'same generation');
  assert.equal(prompts.length, calls, 'no second model call, no second charge');
  const f = await sapi(W, 'POST', '/ai/post-field', { requestKey: rk(), field: 'caption', post: g.output.posts[0] });
  assert.equal(f.data.generation.output.value, 'A brand new caption.');
  assert.equal((await sapi(W, 'POST', '/ai/post', { platforms: ['instagram'] })).status, 400, 'request key required');
});

test('poster: variations saved to the library as AI-generated; charged once on completion; nothing published', async () => {
  aiMedia().setProviderForTests('image', fakeImage);
  imageCalls.length = 0;
  const key = rk();
  const r = await sapi(W, 'POST', '/ai/poster', { requestKey: key, product: 'Spring range', message: 'SPRING SALE 20% OFF', purpose: 'offer', style: 'bold', variations: 2, aspect: '1:1' });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(r.data.generation.status, 'queued');
  assert.equal((await sapi(W, 'POST', '/ai/poster', { requestKey: key, variations: 2 })).data.generation.id, r.data.generation.id);
  await runJobs(W);
  const g = await generation(W, r.data.generation.id);
  assert.equal(g.status, 'completed');
  assert.equal(g.assets.length, 2);
  assert.ok(g.assets.every(a => a.url && a.type === 'image'));
  assert.equal(imageCalls.length, 1, 'one provider call');
  assert.match(imageCalls[0], /"SPRING SALE 20% OFF"/);
  assert.match(imageCalls[0], /ThriveWoo/, 'brand kit applied');
  assert.equal(g.credits, 10, '2 images x 5 credits');
  const assets = await db().all('SELECT source, generation_id FROM assets WHERE workspace_id = ? AND generation_id = ?', [W.workspaceId, g.id]);
  assert.deepEqual(assets.map(a => a.source), ['ai', 'ai']);
  assert.equal((await db().get("SELECT COUNT(*) AS n FROM publishing_jobs WHERE workspace_id = ?", [W.workspaceId])).n, 0);
  assert.equal((await sapi(other, 'GET', `/generations/${g.id}`)).status, 404, 'another workspace cannot see it');
  assert.equal((await sapi(W, 'POST', '/ai/poster', { requestKey: rk(), variations: 2, aspect: '3:4' })).status, 400, 'capability check');
});

test('failures are not charged; a retry continues the same generation and charges once; limits and confirmations', async () => {
  aiMedia().setProviderForTests('image', fakeImage);
  failNext = 1;
  const r = await sapi(W, 'POST', '/ai/poster', { requestKey: rk(), product: 'Retry me', variations: 1 });
  await runJobs(W);
  let g = await generation(W, r.data.generation.id);
  assert.deepEqual([g.status, g.credits, g.errorCode], ['failed', null, 'PROVIDER_RATE_LIMIT']);
  assert.match(g.error, /busy/);
  const retry = await sapi(W, 'POST', `/generations/${g.id}/retry`, {});
  assert.equal(retry.status, 202);
  await runJobs(W);
  g = await generation(W, g.id);
  assert.deepEqual([g.status, g.credits, g.attempts], ['completed', 5, 1]);
  assert.equal((await sapi(W, 'POST', `/generations/${g.id}/retry`, {})).status, 409, 'done: no second charge');
  // Monthly credit limit.
  process.env.SOCIAL_AI_MONTHLY_CREDIT_LIMIT = '1';
  const limited = await sapi(W, 'POST', '/ai/poster', { requestKey: rk(), variations: 1 });
  assert.deepEqual([limited.status, limited.data.code], [402, 'CREDIT_LIMIT']);
  delete process.env.SOCIAL_AI_MONTHLY_CREDIT_LIMIT;
  // Expensive: needs confirmation, with the estimate.
  aiMedia().setProviderForTests('video', fakeVideo);
  const v = await sapi(W, 'POST', '/ai/video', { requestKey: rk(), title: 'Promo', prompt: 'A product promo', durationSeconds: 5, aspect: '9:16' });
  assert.deepEqual([v.status, v.data.code], [409, 'CONFIRMATION_REQUIRED']);
  assert.equal(v.data.details.estimate.credits, 55, '5 s x 10 + a start frame 5');
  const est = await sapi(W, 'POST', '/estimate', { kind: 'video', input: { durationSeconds: 10, imageAssetId: 1 } });
  assert.equal(est.data.estimate.credits, 100);
  assert.equal(est.data.estimate.costUsd, null, 'no invented prices');
});

test('video: asynchronous job (start frame, provider job, polling) saved as a library video; editing needs FFmpeg', async () => {
  aiMedia().setProviderForTests('image', fakeImage);
  aiMedia().setProviderForTests('video', fakeVideo);
  videoPolls.length = 0;
  const r = await sapi(W, 'POST', '/ai/video', { requestKey: rk(), title: 'Spring reel', prompt: 'Models walking in spring clothes', durationSeconds: 5, aspect: '9:16', confirm: true });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  await runJobs(W);
  const g = await generation(W, r.data.generation.id);
  assert.equal(g.status, 'completed', JSON.stringify(g));
  assert.deepEqual(videoPolls, ['job-123', 'job-123'], 'polled until done');
  const video = await db().get('SELECT asset_type, source, duration_seconds FROM assets WHERE id = ?', [g.output.videoAssetId]);
  assert.deepEqual([video.asset_type, video.source], ['video', 'ai']);
  assert.ok(g.output.startImageAssetId, 'a start frame was generated for the image-to-video provider');
  assert.equal(g.credits, 55);
  assert.equal((await sapi(W, 'POST', '/ai/video', { requestKey: rk(), title: 'x', prompt: 'xyz', durationSeconds: 7, confirm: true })).status, 400, 'unsupported duration');
  const subs = await sapi(W, 'POST', '/ai/video', { requestKey: rk(), title: 'x', prompt: 'xyz', durationSeconds: 5, subtitles: true, confirm: true });
  assert.deepEqual([subs.status, subs.data.code], [501, 'CAPABILITY']);
  const trim = await sapi(W, 'POST', '/ai/video-edit', { requestKey: rk(), assetId: g.output.videoAssetId, start: 1, end: 3 });
  assert.equal(trim.status, 501);
  assert.match(trim.data.error, /FFmpeg/);
});

test('carousel: slide-by-slide copy saved as a draft carousel; slide images generated with one style', async () => {
  aiMedia().setProviderForTests('image', fakeImage);
  imageCalls.length = 0;
  const r = await sapi(W, 'POST', '/ai/carousel', { requestKey: rk(), topic: 'How to set up your store', kind: 'steps', slideCount: 3, withImages: true, style: 'minimal' });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  await runJobs(W);
  const g = await generation(W, r.data.generation.id);
  assert.equal(g.status, 'completed');
  const item = await db().get('SELECT status, format, carousel_json, media_asset_ids_json FROM content_items WHERE id = ?', [g.output.contentItemId]);
  assert.deepEqual([item.status, item.format], ['draft', 'carousel']);
  const slides = JSON.parse(item.carousel_json);
  assert.deepEqual(slides.map(s => s.title), ['Why it matters', 'Step one', 'Get started']);
  assert.ok(slides.every(s => s.assetId));
  assert.equal(JSON.parse(item.media_asset_ids_json).length, 3);
  assert.equal(imageCalls.length, 3);
  assert.ok(imageCalls.every(p => /identical minimal design/.test(p)), 'one consistent style');
  assert.equal(g.credits, 16, 'copy 1 + 3 images x 5');
  // Slides are edited and reordered like any content (versioned).
  const edit = await h.api('PATCH', `/api/v1/social/content/${g.output.contentItemId}`, { token: W.token, body: { slides: [slides[1], slides[0], slides[2]] } });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.equal(edit.data.content.slides[0].title, 'Step one');
});

test('image editor: an edited image is a new asset linked to the original, which is kept; another workspace\'s image is refused', async () => {
  aiMedia().setProviderForTests('image', fakeImage);
  const r = await sapi(W, 'POST', '/ai/poster', { requestKey: rk(), variations: 1 });
  await runJobs(W);
  const original = (await generation(W, r.data.generation.id)).assets[0].id;
  const up = await h.api('POST', `/api/v1/social/studio/media/${original}/edited?title=Edited`, { token: W.token, rawBody: fx.png(1080, 1350), headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const edited = await db().get('SELECT source, parent_asset_id FROM assets WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [W.workspaceId]);
  assert.deepEqual([edited.source, edited.parent_asset_id], ['edited', original]);
  assert.equal((await db().get('SELECT status FROM assets WHERE id = ?', [original])).status, 'ready', 'the original stays');
  const stolen = await h.api('POST', `/api/v1/social/studio/media/${original}/edited`, { token: other.token, rawBody: fx.png(10, 10), headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(stolen.status, 404);
});

test('usage: this month\'s credits by kind and provider; only completed generations count; per workspace', async () => {
  const u = (await sapi(W, 'GET', '/usage')).data.usage;
  assert.ok(u.creditsUsed > 0);
  assert.ok(u.byKind.some(k => k.kind === 'image' && k.provider === 'fakeimg'));
  assert.ok(u.failedThisMonth >= 0);
  assert.equal(u.creditLimit, 2000);
  const o = (await sapi(other, 'GET', '/usage')).data.usage;
  assert.ok(o.recent.every(r => r.kind), 'own generations only');
  assert.ok(!o.recent.some(r => (u.recent.map(x => x.id)).includes(r.id)));
});

// ------------------------------------------------------------------ video editing with FFmpeg (real, when installed)

const { spawnSync } = require('child_process');
const HAS_FFMPEG = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version']).status === 0;
function ffmpegMake(args, file) {
  const out = path.join(STORAGE, file);
  const r = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, out]);
  assert.equal(r.status, 0, String(r.stderr));
  return fs.readFileSync(out);
}

test('music: MP3 only through the Studio; never attached to posts; kept out of the image/video library list', async () => {
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0, 0, 0, 0]), Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(400)]);
  const up = await h.api('POST', '/api/v1/social/studio/music?filename=Theme.mp3', { token: W.token, rawBody: mp3, headers: { 'content-type': 'audio/mpeg' } });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.asset.assetType, 'audio');
  const normal = await h.api('POST', '/api/v1/social/media/upload?filename=x.mp3', { token: W.token, rawBody: mp3, headers: { 'content-type': 'audio/mpeg' } });
  assert.equal(normal.status, 400, 'the media library upload stays images and videos only');
  const png = await h.api('POST', '/api/v1/social/studio/music', { token: W.token, rawBody: fx.png(10, 10), headers: { 'content-type': 'image/png' } });
  assert.equal(png.status, 400);
  const lib = await h.api('GET', '/api/v1/social/media', { token: W.token });
  assert.ok(!lib.data.items.some(i => i.assetType === 'audio'));
  assert.equal((await h.api('GET', '/api/v1/social/media?type=audio', { token: W.token })).data.items.length, 1);
  const post = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'instagram', caption: 'x', mediaAssetIds: [up.data.asset.id] } });
  assert.equal(post.status, 400);
  assert.match(post.data.error, /background music/);
});

test('video editing (real FFmpeg): trim, replaced scene, intro and outro cards, subtitles and music in one new asset; the original is kept', { skip: !HAS_FFMPEG && 'FFmpeg is not installed' }, async () => {
  process.env.FFMPEG_TEST_AVAILABLE = '1';
  try {
    const media = require('../modules/social/mediaStore');
    const ctx = W.ctx;
    const main = await media.storeBuffer(ctx, ffmpegMake(['-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], 'm.mp4'), { title: 'Main', source: 'upload' });
    const clip = await media.storeBuffer(ctx, ffmpegMake(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an'], 'c.mp4'), { title: 'Clip', source: 'upload' });
    const card = await media.storeBuffer(ctx, ffmpegMake(['-f', 'lavfi', '-i', 'color=c=blue:size=1080x1080', '-frames:v', '1'], 'card.png'), { title: 'Card', source: 'upload' });
    const mp3 = ffmpegMake(['-f', 'lavfi', '-i', 'sine=frequency=220', '-t', '3'], 'music.mp3');
    const music = (await h.api('POST', '/api/v1/social/studio/music?filename=bg.mp3', { token: W.token, rawBody: mp3, headers: { 'content-type': 'audio/mpeg' } })).data.asset.id;
    const r = await sapi(W, 'POST', '/ai/video-edit', { requestKey: rk(), assetId: main, start: 0.5, end: 5.5, replace: { start: 1, end: 2.5, assetId: clip },
      introAssetId: card, introSeconds: 1.5, outroAssetId: card, outroSeconds: 1, musicAssetId: music, musicVolume: 0.4,
      subtitles: [{ start: 0, end: 2, text: 'Hello' }, { start: 2, end: 4, text: "It's here: now" }] });
    assert.equal(r.status, 202, JSON.stringify(r.data));
    await runJobs(W);
    const g = await generation(W, r.data.generation.id);
    assert.equal(g.status, 'completed', g.error);
    const out = await db().get('SELECT asset_type, source, parent_asset_id, duration_seconds, width, height, audio_codec FROM assets WHERE id = ?', [g.assets[0].id]);
    assert.deepEqual([out.asset_type, out.source, out.parent_asset_id, Number(out.duration_seconds), out.width, out.height, out.audio_codec], ['video', 'edited', main, 7.5, 720, 1280, 'aac'],
      '1.5 s intro + 5 s trimmed video + 1 s outro, at the main video\'s size, with sound');
    assert.match(g.output.srt, /00:00:01,500 --> 00:00:03,500\nHello/, 'subtitles shifted by the intro');
    assert.ok(['burned', 'track'].includes(g.output.subtitlesMode));
    assert.equal((await db().get('SELECT status FROM assets WHERE id = ?', [main])).status, 'ready');
    // Another workspace's file can never be used in an edit.
    const foreign = await sapi(other, 'POST', '/ai/video-edit', { requestKey: rk(), assetId: main, end: 2 });
    assert.equal(foreign.status, 400);
    assert.equal((await sapi(W, 'POST', '/ai/video-edit', { requestKey: rk(), assetId: main })).status, 400, 'at least one change');
  } finally { delete process.env.FFMPEG_TEST_AVAILABLE; }
});

test('no free-text product: content needs a campaign with a selected product; another workspace\'s campaign is refused; generations record the product', async () => {
  const bare = await h.api('POST', '/api/v1/social/studio/ai/post', { token: W.token, body: { requestKey: rk(), platforms: ['instagram'], product: 'Typed product' } });
  assert.deepEqual([bare.status, bare.data.code], [400, 'CAMPAIGN_REQUIRED']);
  const noProduct = await h.api('POST', '/api/v1/social/campaigns', { token: W.token, body: { name: 'No product', platforms: ['instagram'] } });
  const np = await sapi(W, 'POST', '/ai/post', { requestKey: rk(), platforms: ['instagram'], campaignId: noProduct.data.campaign.id });
  assert.deepEqual([np.status, np.data.code], [400, 'PRODUCT_REQUIRED']);
  const foreign = await sapi(W, 'POST', '/ai/post', { requestKey: rk(), platforms: ['instagram'], campaignId: other.campaignId });
  assert.equal(foreign.status, 404);
  prompts.length = 0;
  const ok = await sapi(W, 'POST', '/ai/post', { requestKey: rk(), platforms: ['instagram'], product: 'Typed product' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(prompts.some(pr => pr.includes('Spring range') && pr.includes('Light fabrics')), 'the product\'s database record is the context');
  assert.ok(!prompts.some(pr => pr.includes('Typed product')), 'a typed product is ignored');
  assert.equal((await db().get('SELECT product_id FROM social_content_generations WHERE id = ?', [ok.data.generation.id])).product_id, W.productId);
});

test('changing a campaign\'s product: confirmation once it has content; a draft strategy is cleared; locked once posts are scheduled or published', async () => {
  const p2 = await h.api('POST', '/api/v1/products', { token: W.token, body: { name: 'Autumn range', url: 'https://acme-co.io/autumn' } });
  const camp = (await h.api('POST', '/api/v1/social/campaigns', { token: W.token, body: { name: 'Switch', productId: W.productId, platforms: ['instagram'] } })).data.campaign;
  const patch = body => h.api('PATCH', `/api/v1/social/campaigns/${camp.id}`, { token: W.token, body });
  assert.equal((await patch({ productId: p2.data.productId })).status, 200, 'nothing made yet: no confirmation needed');
  await db().run("UPDATE campaigns SET strategy_json = ? WHERE id = ?", [JSON.stringify({ status: 'draft', ideas: [] }), camp.id]);
  const ask = await patch({ productId: W.productId });
  assert.deepEqual([ask.status, ask.data.code], [409, 'CONFIRM_PRODUCT_CHANGE']);
  const yes = await patch({ productId: W.productId, confirmProductChange: true });
  assert.equal(yes.status, 200);
  assert.equal(yes.data.campaign.strategy, null, 'the draft strategy for the old product is cleared');
  await h.api('POST', '/api/v1/social/content', { token: W.token, body: { campaignId: camp.id, platformKey: 'instagram', caption: 'x' } });
  await db().run("UPDATE content_items SET status = 'scheduled' WHERE campaign_id = ?", [camp.id]);
  const locked = await patch({ productId: p2.data.productId, confirmProductChange: true });
  assert.deepEqual([locked.status, locked.data.code], [409, 'PRODUCT_LOCKED']);
  const theirs = await h.api('POST', '/api/v1/products', { token: other.token, body: { name: 'Theirs', url: 'https://t.io' } });
  assert.equal((await patch({ productId: theirs.data.productId, confirmProductChange: true })).status, 400, 'another workspace\'s product');
});
