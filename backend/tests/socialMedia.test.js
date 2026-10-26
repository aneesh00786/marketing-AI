const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const fx = require('./mediaFixtures');

// Uploaded files go to a throwaway folder, never backend/storage.
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-social-media-test-'));
process.env.SOCIAL_MEDIA_STORAGE_DIR = STORAGE;

let W;
let other;
let approver;
let member;
let fb;
let ig;
let li;
let yt;

const LI_SCOPES = ['r_organization_social', 'w_organization_social', 'rw_organization_admin'];
const YT_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/youtube.force-ssl'];

test.before(async () => {
  await h.prepareDatabase();
  W = await h.createWorkspace({ name: 'Media Studio' });
  other = await h.createWorkspace({ name: 'Other Studio' });
  approver = await h.addMember(W.workspaceId, 'Approver');
  member = await h.addMember(W.workspaceId, 'Member');
  const stamp = Date.now();
  fb = await h.createAccount(W.workspaceId, { accountType: 'facebook_page', externalId: `mpage${stamp}` });
  ig = await h.createAccount(W.workspaceId, { accountType: 'instagram_business', externalId: `mig${stamp}` });
  li = await h.createAccount(W.workspaceId, { accountType: 'linkedin_organization', providerKey: 'linkedin', scopes: LI_SCOPES, externalId: `999${stamp}`, secret: { access_token: 'li-token-SECRET' } });
  yt = await h.createAccount(W.workspaceId, { accountType: 'youtube_channel', providerKey: 'youtube', scopes: YT_SCOPES, externalId: `UCyt${stamp}`, secret: { access_token: 'yt-token-SECRET', refresh_token: 'r' } });
});
test.after(async () => {
  await h.shutdown();
  fs.rmSync(STORAGE, { recursive: true, force: true });
});

const worker = () => require('../workers/socialWorker');
const { probeFile } = require('../lib/mediaProbe');

/** Sends a file as the raw request body, like the app does. */
async function upload(token, buf, { filename = 'file.bin', query = '', type = 'application/octet-stream', pathName = '/api/v1/social/media/upload' } = {}) {
  const s = await h.startApp();
  const res = await globalThis.__realFetch(`http://127.0.0.1:${s.address().port}${pathName}?filename=${encodeURIComponent(filename)}${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
    body: buf
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data };
}

async function uploaded(buf, filename, token = W.token) {
  const r = await upload(token, buf, { filename });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.asset;
}

async function fetchPublic(previewPath, headers = {}) {
  const s = await h.startApp();
  return globalThis.__realFetch(`http://127.0.0.1:${s.address().port}${previewPath}`, { headers });
}

function tmpFile(buf) {
  const p = path.join(STORAGE, `probe-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(p, buf);
  return p;
}

async function approveAndPublishNow(contentId, token = W.token) {
  const a = await h.api('POST', `/api/v1/social/content/${contentId}/approve`, { token: approver.token, body: {} });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const j = await h.api('POST', `/api/v1/social/content/${contentId}/publish-now`, { token, body: {} });
  return j;
}

// ---------------------------------------------------------------- probing

test('media probe identifies images by content and reads their dimensions', async () => {
  assert.deepEqual(
    (({ kind, mime, width, height }) => ({ kind, mime, width, height }))(await probeFile(tmpFile(fx.jpeg(1080, 1350)))),
    { kind: 'image', mime: 'image/jpeg', width: 1080, height: 1350 }
  );
  const p = await probeFile(tmpFile(fx.png(1200, 627)));
  assert.equal(p.mime, 'image/png');
  assert.equal(p.width, 1200);
  const w = await probeFile(tmpFile(fx.webp(800, 600)));
  assert.deepEqual([w.mime, w.width, w.height], ['image/webp', 800, 600]);
  assert.equal((await probeFile(tmpFile(Buffer.from('<html><script>alert(1)</script></html>'.padEnd(64))))).ok, false);
  assert.match((await probeFile(tmpFile(Buffer.from('GIF89a'.padEnd(64, '\0'))))).reason, /GIF/);
});

test('media probe reads video duration, display size (with rotation), codecs and frame rate', async () => {
  const v = await probeFile(tmpFile(fx.mp4({ width: 1920, height: 1080, rotated: true, seconds: 12, fps: 30 })));
  assert.equal(v.kind, 'video');
  assert.equal(v.mime, 'video/mp4');
  assert.equal(v.width, 1080);
  assert.equal(v.height, 1920);
  assert.equal(v.durationSeconds, 12);
  assert.equal(v.videoCodec, 'h264');
  assert.equal(v.audioCodec, 'aac');
  assert.equal(v.frameRate, 30);
  const mov = await probeFile(tmpFile(fx.mp4({ brand: 'qt  ', codec: 'hvc1', audio: null })));
  assert.equal(mov.mime, 'video/quicktime');
  assert.equal(mov.videoCodec, 'hevc');
  assert.equal(mov.hasAudio, false);
  const noIndex = Buffer.concat([fx.mp4().subarray(0, 24), Buffer.alloc(64)]);
  assert.equal((await probeFile(tmpFile(noIndex))).ok, false);
});

// ---------------------------------------------------------------- upload security

test('uploads are verified by content, stored under opaque ids and served safely', async () => {
  const asset = await uploaded(fx.jpeg(1080, 1080), '../../etc/passwd.jpg');
  assert.equal(asset.assetType, 'image');
  assert.equal(asset.mimeType, 'image/jpeg');
  assert.equal(asset.width, 1080);
  assert.equal(asset.verified, true);
  assert.equal(asset.originalName, '....etcpasswd.jpg');
  assert.match(asset.previewPath, /^\/api\/v1\/social\/media-files\/[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(asset).includes(STORAGE), 'no server path is exposed');
  const files = fs.readdirSync(path.join(STORAGE, String(W.workspaceId)));
  assert.ok(files.every(f => /^[A-Za-z0-9_-]{43}$/.test(f)), 'stored names are opaque ids only');

  const res = await fetchPublic(asset.previewPath);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  const ranged = await fetchPublic(asset.previewPath, { Range: 'bytes=0-3' });
  assert.equal(ranged.status, 206);
  assert.equal(Buffer.from(await ranged.arrayBuffer()).length, 4);
  assert.equal((await fetchPublic(`/api/v1/social/media-files/${'A'.repeat(43)}`)).status, 404);

  // A script renamed to .jpg is refused, whatever its declared type.
  const spoof = await upload(W.token, Buffer.from('<svg onload=alert(1)>'.padEnd(80)), { filename: 'evil.jpg', type: 'image/jpeg' });
  assert.equal(spoof.status, 400);
  assert.equal(spoof.data.code, 'INVALID_MEDIA');
});

test('upload size limits are enforced while the file streams in', async () => {
  process.env.SOCIAL_MEDIA_MAX_IMAGE_MB = '1';
  try {
    const big = await upload(W.token, fx.jpeg(2000, 2000, { padBytes: 1.2 * 1024 * 1024 }), { filename: 'big.jpg' });
    assert.equal(big.status, 413);
    assert.equal(big.data.code, 'TOO_LARGE');
  } finally {
    delete process.env.SOCIAL_MEDIA_MAX_IMAGE_MB;
  }
  const left = fs.readdirSync(path.join(STORAGE, String(W.workspaceId))).filter(f => f.startsWith('.upload-'));
  assert.deepEqual(left, [], 'rejected uploads leave no temporary files');
});

test('media is isolated per workspace and uploads need the content.create permission', async () => {
  const asset = await uploaded(fx.png(600, 600), 'private.png');
  assert.equal((await h.api('GET', `/api/v1/social/media/${asset.id}`, { token: other.token })).status, 404);
  assert.ok(!(await h.api('GET', '/api/v1/social/media', { token: other.token })).data.items.some(a => a.id === asset.id));
  const attach = await h.api('POST', '/api/v1/social/content', { token: other.token, body: { platformKey: 'facebook', caption: 'x', mediaAssetIds: [asset.id] } });
  assert.equal(attach.status, 400);
  assert.equal((await h.api('DELETE', `/api/v1/social/media/${asset.id}`, { token: other.token })).status, 404);
  const denied = await upload(approver.token, fx.png(10, 10), { filename: 'a.png' });
  assert.equal(denied.status, 403);
});

// ---------------------------------------------------------------- platform validation

test('platform rules are reported per account before publishing, without altering content', async () => {
  const pngAsset = await uploaded(fx.png(1080, 1080), 'square.png');
  const wide = await uploaded(fx.jpeg(3000, 1000), 'wide.jpg');
  const r = await h.api('POST', '/api/v1/social/content/validate', {
    token: member.token,
    body: {
      base: { caption: 'Hello @friend #one', linkUrl: 'https://example.com', mediaAssetIds: [pngAsset.id] },
      targets: [{ accountId: ig.id }, { accountId: li.id }, { accountId: fb.id }, { accountId: ig.id, linkUrl: '', mediaAssetIds: [wide.id] }, { accountId: yt.id }, { platformKey: 'x', caption: 'y'.repeat(300), mediaAssetIds: [] }]
    }
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [igRes, liRes, fbRes, igWide, ytRes, xRes] = r.data.results;
  assert.ok(igRes.problems.some(p => /accepts JPEG/.test(p)), igRes.problems.join(' | '));
  assert.ok(igRes.problems.some(p => /does not support link/.test(p)));
  assert.ok(liRes.problems.some(p => /link preview/.test(p)));
  assert.ok(liRes.warnings.some(p => /@mentions/.test(p)));
  assert.ok(fbRes.problems.some(p => /link preview/.test(p)));
  assert.ok(igWide.problems.some(p => /aspect/.test(p)));
  assert.ok(ytRes.problems.some(p => /video/.test(p)) && ytRes.problems.some(p => /title/.test(p)));
  assert.ok(xRes.problems.some(p => /300 characters/.test(p)));
  // Instagram downloads uploaded files by URL: a non-public APP_BASE_URL blocks it.
  assert.ok(igWide.problems.some(p => /APP_BASE_URL/.test(p)));
});

test('video rules check duration, codec and frame rate per platform', async () => {
  const shortVid = await uploaded(fx.mp4({ seconds: 2, mdatBytes: 100 * 1024 }), 'short.mp4');
  const vp9 = await uploaded(fx.mp4({ codec: 'vp09', seconds: 20, fps: 15, mdatBytes: 100 * 1024 }), 'vp9.mp4');
  const r = await h.api('POST', '/api/v1/social/content/validate', {
    token: W.token,
    body: { base: { caption: 'Watch', title: 'Launch video' }, targets: [{ accountId: ig.id, mediaAssetIds: [shortVid.id] }, { accountId: ig.id, mediaAssetIds: [vp9.id] }, { accountId: li.id, mediaAssetIds: [shortVid.id] }, { accountId: yt.id, mediaAssetIds: [vp9.id] }] }
  });
  const [igShort, igVp9, liShort, ytOk] = r.data.results;
  assert.ok(igShort.problems.some(p => /at least 3s/.test(p)));
  assert.ok(igVp9.problems.some(p => /codec/.test(p)) && igVp9.problems.some(p => /fps/.test(p)));
  assert.ok(liShort.problems.some(p => /at least 3s/.test(p)));
  assert.deepEqual(ytOk.problems, []);
});

// ---------------------------------------------------------------- composer + publishing adapters

test('one composed post becomes one draft per account, each published and tracked independently', async () => {
  const img1 = await uploaded(fx.jpeg(1200, 1200), 'one.jpg');
  const img2 = await uploaded(fx.jpeg(1200, 1200), 'two.jpg');
  await h.api('PATCH', `/api/v1/social/media/${img1.id}`, { token: W.token, body: { altText: 'A red delivery van' } });
  const composed = await h.api('POST', '/api/v1/social/content/compose', {
    token: member.token,
    body: { base: { caption: 'Two photos', hashtags: '#fleet', mediaAssetIds: [img1.id, img2.id] }, targets: [{ accountId: fb.id }, { accountId: li.id, caption: 'Two photos, LinkedIn edition' }] }
  });
  assert.equal(composed.status, 200, JSON.stringify(composed.data));
  const [fbItem, liItem] = composed.data.items.map(i => i.content);
  assert.equal(fbItem.postGroupId, liItem.postGroupId);
  assert.equal(liItem.caption, 'Two photos, LinkedIn edition');
  assert.deepEqual(fbItem.mediaAssetIds, [img1.id, img2.id]);
  const detail = await h.api('GET', `/api/v1/social/content/${fbItem.id}`, { token: W.token });
  assert.equal(detail.data.siblings[0].id, liItem.id);

  // A Member may draft but not publish.
  assert.equal((await h.api('POST', `/api/v1/social/content/${fbItem.id}/publish-now`, { token: member.token, body: {} })).status, 403);
  assert.equal((await approveAndPublishNow(fbItem.id)).status, 202);
  assert.equal((await approveAndPublishNow(liItem.id)).status, 202);

  let photoCalls = 0;
  const mock = h.mockFetch([
    // Facebook: each photo uploaded unpublished, then one feed post that attaches them.
    { match: (u, i) => i.method === 'POST' && u.includes(`/${fb.externalId}/photos`), respond: (u, i) => { photoCalls++; assert.equal(i.body.get('published'), 'false'); assert.ok(i.body.get('source')); return h.json(200, { id: `photo${photoCalls}` }); } },
    { match: (u, i) => i.method === 'POST' && u.endsWith(`/${fb.externalId}/feed`), respond: (u, i) => { const b = new URLSearchParams(i.body); assert.equal(b.get('attached_media[1]'), JSON.stringify({ media_fbid: 'photo2' })); return h.json(200, { id: `${fb.externalId}_55` }); } },
    { match: u => u.includes('fields=permalink_url'), respond: () => h.json(200, { permalink_url: '/p/55' }) },
    // LinkedIn: Images API upload per image, then a multiImage post.
    { match: (u, i) => i.method === 'POST' && u.includes('/rest/images?action=initializeUpload'), respond: () => h.json(200, { value: { uploadUrl: `https://www.linkedin.com/dms-uploads/img${Math.random()}`, image: `urn:li:image:${Math.random().toString(16).slice(2)}` } }) },
    { match: (u, i) => i.method === 'PUT' && u.startsWith('https://www.linkedin.com/dms-uploads/'), respond: () => h.json(201, {}) },
    { match: (u, i) => (i.method || 'GET') === 'GET' && u.includes('/rest/images/'), respond: () => h.json(200, { status: 'AVAILABLE' }) },
    { match: (u, i) => i.method === 'POST' && u.endsWith('/rest/posts'), respond: (u, i) => { const b = JSON.parse(i.body); assert.equal(b.content.multiImage.images.length, 2); assert.equal(b.content.multiImage.images[0].altText, 'A red delivery van'); return h.json(201, {}, { 'x-restli-id': 'urn:li:share:77' }); } }
  ]);
  try {
    await worker().processPublishing();
  } finally { mock.restore(); }
  assert.equal(photoCalls, 2);
  const fbDone = (await h.api('GET', `/api/v1/social/content/${fbItem.id}`, { token: W.token })).data.content;
  const liDone = (await h.api('GET', `/api/v1/social/content/${liItem.id}`, { token: W.token })).data.content;
  assert.equal(fbDone.status, 'published');
  assert.equal(fbDone.externalUrl, 'https://www.facebook.com/p/55');
  assert.equal(liDone.status, 'published');
  assert.equal(liDone.externalPostId, 'urn:li:share:77');
});

test('a failed photo upload before the visible post is retried, never treated as an unknown outcome', async () => {
  const img = await uploaded(fx.jpeg(800, 800), 'retry.jpg');
  const img2 = await uploaded(fx.jpeg(800, 800), 'retry2.jpg');
  const c = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'facebook', socialAccountId: fb.id, caption: 'retry', mediaAssetIds: [img.id, img2.id] } });
  const job = await approveAndPublishNow(c.data.content.id);
  const mock = h.mockFetch([{ match: (u, i) => i.method === 'POST' && u.includes('/photos'), respond: () => Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } }) }]);
  try { await worker().processPublishing(); } finally { mock.restore(); }
  const row = await h.db().get('SELECT status, last_error_code FROM publishing_jobs WHERE id = ?', [job.data.job.id]);
  assert.equal(row.status, 'queued', 'retry scheduled');
  assert.equal(row.last_error_code, 'NETWORK');
  await h.db().run("UPDATE publishing_jobs SET status = 'cancelled' WHERE id = ?", [job.data.job.id]);
});

test('YouTube uploads through a resumable session; a dropped upload is marked needs_review', async () => {
  const vid = await uploaded(fx.mp4({ seconds: 30, mdatBytes: 120 * 1024 }), 'launch.mp4');
  const c = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'youtube', socialAccountId: yt.id, title: 'Our launch', caption: 'Launch day', hashtags: '#launch', mediaAssetIds: [vid.id], platformOptions: { youtube: { privacyStatus: 'unlisted' } } } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const job = await approveAndPublishNow(c.data.content.id);
  assert.equal(job.status, 202, JSON.stringify(job.data));

  // The session start fails: nothing exists on the channel, so it is simply retried.
  let mock = h.mockFetch([{ match: u => u.includes('uploadType=resumable'), respond: () => Object.assign(new Error('reset'), { cause: { code: 'ECONNRESET' } }) }]);
  try { await worker().processPublishing(); } finally { mock.restore(); }
  assert.equal((await h.db().get('SELECT status FROM publishing_jobs WHERE id = ?', [job.data.job.id])).status, 'queued');

  // The byte upload drops after sending: the video may exist, so it needs review.
  await h.db().run('UPDATE publishing_jobs SET next_attempt_at = UTC_TIMESTAMP() WHERE id = ?', [job.data.job.id]);
  let meta;
  mock = h.mockFetch([
    { match: u => u.includes('uploadType=resumable'), respond: (u, i) => { meta = JSON.parse(i.body); return h.json(200, {}, { Location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc' }); } },
    { match: (u, i) => i.method === 'PUT' && u.includes('upload_id=abc'), respond: () => Object.assign(new Error('reset'), { cause: { code: 'ECONNRESET' } }) }
  ]);
  try { await worker().processPublishing(); } finally { mock.restore(); }
  assert.equal(meta.status.privacyStatus, 'unlisted');
  assert.equal(meta.snippet.title, 'Our launch');
  assert.deepEqual(meta.snippet.tags, ['launch']);
  const row = await h.db().get('SELECT status FROM publishing_jobs WHERE id = ?', [job.data.job.id]);
  assert.equal(row.status, 'needs_review');

  // After confirming on YouTube that nothing was posted, a retry uploads it.
  const retry = await h.api('POST', `/api/v1/social/queue/${job.data.job.id}/retry`, { token: W.token, body: { confirmNotPublished: true } });
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  mock = h.mockFetch([
    { match: u => u.includes('uploadType=resumable'), respond: () => h.json(200, {}, { Location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=def' }) },
    { match: (u, i) => i.method === 'PUT' && u.includes('upload_id=def'), respond: () => h.json(200, { id: 'vid123', status: { privacyStatus: 'unlisted', uploadStatus: 'processed' } }) }
  ]);
  try { await worker().processPublishing(); } finally { mock.restore(); }
  const done = (await h.api('GET', `/api/v1/social/content/${c.data.content.id}`, { token: W.token })).data.content;
  assert.equal(done.status, 'published');
  assert.equal(done.externalUrl, 'https://www.youtube.com/watch?v=vid123');
});

test('Instagram Reels and carousels use containers; only media_publish can have an unknown outcome', async () => {
  process.env.APP_BASE_URL = 'https://app.marketech.example';
  const meta = require('../modules/social/providers/meta');
  meta._pollDelayMs = 1;
  meta._videoPollDelayMs = 1;
  try {
    const reel = await uploaded(fx.mp4({ width: 1080, height: 1920, seconds: 20, mdatBytes: 50 * 1024 }), 'reel.mp4');
    const c = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'instagram', socialAccountId: ig.id, caption: 'Reel time', mediaAssetIds: [reel.id] } });
    const job = await approveAndPublishNow(c.data.content.id);
    assert.equal(job.status, 202, JSON.stringify(job.data));
    let containerBody;
    const mock = h.mockFetch([
      { match: (u, i) => i.method === 'POST' && u.endsWith(`/${ig.externalId}/media`), respond: (u, i) => { containerBody = new URLSearchParams(i.body); return h.json(200, { id: 'reel-c' }); } },
      { match: u => u.includes('/reel-c?') && u.includes('status_code'), respond: () => h.json(200, { status_code: 'FINISHED' }) },
      { match: (u, i) => i.method === 'POST' && u.endsWith('/media_publish'), respond: () => Object.assign(new Error('reset'), { cause: { code: 'ECONNRESET' } }) }
    ]);
    try { await worker().processPublishing(); } finally { mock.restore(); }
    assert.equal(containerBody.get('media_type'), 'REELS');
    assert.equal(containerBody.get('video_url'), `https://app.marketech.example/api/v1/social/media-files/${reel.previewPath.split('/').pop()}`);
    assert.equal((await h.db().get('SELECT status FROM publishing_jobs WHERE id = ?', [job.data.job.id])).status, 'needs_review');

    const a = await uploaded(fx.jpeg(1080, 1080), 'c1.jpg');
    const b = await uploaded(fx.jpeg(1080, 1350), 'c2.jpg');
    const carousel = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'instagram', socialAccountId: ig.id, caption: 'Swipe', mediaAssetIds: [a.id, b.id] } });
    await approveAndPublishNow(carousel.data.content.id);
    const created = [];
    const mock2 = h.mockFetch([
      { match: (u, i) => i.method === 'POST' && u.endsWith(`/${ig.externalId}/media`), respond: (u, i) => { const p = new URLSearchParams(i.body); created.push(p); return h.json(200, { id: `c${created.length}` }); } },
      { match: u => /\/c\d\?/.test(u) && u.includes('status_code'), respond: () => h.json(200, { status_code: 'FINISHED' }) },
      { match: (u, i) => i.method === 'POST' && u.endsWith('/media_publish'), respond: (u, i) => { assert.equal(new URLSearchParams(i.body).get('creation_id'), 'c3'); return h.json(200, { id: 'ig-car-1' }); } },
      { match: u => u.includes('/ig-car-1?'), respond: () => h.json(200, { permalink: 'https://instagram.com/p/car' }) }
    ]);
    try { await worker().processPublishing(); } finally { mock2.restore(); }
    assert.equal(created[0].get('is_carousel_item'), 'true');
    assert.equal(created[2].get('media_type'), 'CAROUSEL');
    assert.equal(created[2].get('children'), 'c1,c2');
    assert.equal((await h.api('GET', `/api/v1/social/content/${carousel.data.content.id}`, { token: W.token })).data.content.status, 'published');
  } finally {
    process.env.APP_BASE_URL = 'http://localhost:8000';
  }
});

// ---------------------------------------------------------------- approvals and media changes

test('changing a file used by an approved post re-opens its approval; files in use cannot be deleted', async () => {
  const img = await uploaded(fx.jpeg(900, 900), 'approved.jpg');
  const c = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'linkedin', socialAccountId: li.id, caption: 'Approved', mediaAssetIds: [img.id] } });
  await h.api('POST', `/api/v1/social/content/${c.data.content.id}/approve`, { token: approver.token, body: {} });
  const del = await h.api('DELETE', `/api/v1/social/media/${img.id}`, { token: W.token });
  assert.equal(del.status, 409);
  assert.equal(del.data.code, 'MEDIA_IN_USE');

  const alt = await h.api('PATCH', `/api/v1/social/media/${img.id}`, { token: W.token, body: { altText: 'New description' } });
  assert.deepEqual(alt.data.approvalsReopened, [c.data.content.id]);
  let post = (await h.api('GET', `/api/v1/social/content/${c.data.content.id}`, { token: W.token })).data.content;
  assert.equal(post.status, 'draft');
  assert.equal(post.version, 2);

  await h.api('POST', `/api/v1/social/content/${c.data.content.id}/approve`, { token: approver.token, body: {} });
  const rep = await upload(W.token, fx.jpeg(1000, 1000), { filename: 'new.jpg', pathName: `/api/v1/social/media/${img.id}/replace` });
  assert.equal(rep.status, 200, JSON.stringify(rep.data));
  post = (await h.api('GET', `/api/v1/social/content/${c.data.content.id}`, { token: W.token })).data.content;
  assert.deepEqual(post.mediaAssetIds, [rep.data.asset.id]);
  assert.equal(post.status, 'draft');
  assert.equal(rep.data.asset.altText, 'New description');
  const wrongKind = await upload(W.token, fx.mp4(), { filename: 'v.mp4', pathName: `/api/v1/social/media/${rep.data.asset.id}/replace` });
  assert.equal(wrongKind.status, 400);

  // The old file is now unused: it can be deleted and is no longer served.
  const oldPath = (await h.api('GET', `/api/v1/social/media/${img.id}`, { token: W.token })).data.asset.previewPath;
  assert.equal((await h.api('DELETE', `/api/v1/social/media/${img.id}`, { token: W.token })).status, 200);
  assert.equal((await fetchPublic(oldPath)).status, 404);
  const unused = await h.api('GET', '/api/v1/social/media?unused=1', { token: W.token });
  assert.ok(!unused.data.items.some(i => i.id === img.id));
});

test("an approval lapses when the approver loses permission, at scheduling and in the worker", async () => {
  const lapsing = await h.addMember(W.workspaceId, 'Approver');
  const c = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'facebook', socialAccountId: fb.id, caption: 'Approver leaves' } });
  await h.api('POST', `/api/v1/social/content/${c.data.content.id}/approve`, { token: lapsing.token, body: {} });
  const job = await h.api('POST', `/api/v1/social/content/${c.data.content.id}/publish-now`, { token: W.token, body: {} });
  assert.equal(job.status, 202);
  await h.db().run("UPDATE workspace_members SET role = 'Member' WHERE workspace_id = ? AND user_id = ?", [W.workspaceId, lapsing.userId]);
  const mock = h.mockFetch([]);
  try { await worker().processPublishing(); } finally { mock.restore(); }
  assert.equal(mock.calls.length, 0, 'nothing is sent');
  const row = await h.db().get('SELECT status, last_error_code FROM publishing_jobs WHERE id = ?', [job.data.job.id]);
  assert.equal(row.status, 'failed');
  assert.equal(row.last_error_code, 'APPROVAL_REQUIRED');
  const again = await h.api('POST', `/api/v1/social/content/${c.data.content.id}/publish-now`, { token: W.token, body: {} });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /can no longer approve/);
});

// ---------------------------------------------------------------- scheduling, calendar, templates

test('rescheduling moves the one job instead of creating a duplicate; calendar shows review state', async () => {
  const c = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'facebook', socialAccountId: fb.id, caption: 'Reschedule me' } });
  await h.api('POST', `/api/v1/social/content/${c.data.content.id}/approve`, { token: approver.token, body: {} });
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const s1 = await h.api('POST', `/api/v1/social/content/${c.data.content.id}/schedule`, { token: W.token, body: { localDateTime: `${day(5)}T10:00`, timezone: 'Europe/London' } });
  const s2 = await h.api('POST', `/api/v1/social/content/${c.data.content.id}/schedule`, { token: W.token, body: { localDateTime: `${day(6)}T11:30`, timezone: 'Europe/London' } });
  assert.equal(s1.data.job.id, s2.data.job.id);
  const jobs = await h.db().all("SELECT id FROM publishing_jobs WHERE content_item_id = ? AND status = 'queued'", [c.data.content.id]);
  assert.equal(jobs.length, 1);
  await h.db().run("UPDATE publishing_jobs SET status = 'needs_review' WHERE id = ?", [s2.data.job.id]);
  const cal = await h.api('GET', `/api/v1/social/calendar?from=${day(0)}T00:00:00Z&to=${day(10)}T00:00:00Z`, { token: W.token });
  const item = cal.data.items.find(i => i.id === c.data.content.id);
  assert.equal(item.needsReview, true);
  await h.db().run("UPDATE publishing_jobs SET status = 'cancelled' WHERE id = ?", [s2.data.job.id]);
});

test('saved post templates are workspace-scoped', async () => {
  const t = await h.api('POST', '/api/v1/social/templates', { token: member.token, body: { name: 'Weekly tip', caption: 'Tip of the week:', hashtags: 'tips weekly' } });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  assert.deepEqual(t.data.template.hashtags, ['#tips', '#weekly']);
  assert.ok(!(await h.api('GET', '/api/v1/social/templates', { token: other.token })).data.templates.some(x => x.id === t.data.template.id));
  assert.equal((await h.api('PATCH', `/api/v1/social/templates/${t.data.template.id}`, { token: other.token, body: { name: 'stolen' } })).status, 404);
  assert.equal((await h.api('DELETE', `/api/v1/social/templates/${t.data.template.id}`, { token: approver.token })).status, 403);
  assert.equal((await h.api('DELETE', `/api/v1/social/templates/${t.data.template.id}`, { token: member.token })).status, 200);
});

// ---------------------------------------------------------------- analytics

test('analytics keep unavailable metrics distinct from zero, average watch time and export honestly', async () => {
  const { run } = h.db();
  const mk = async (ext, platform) => {
    const ins = await run(
      "INSERT INTO content_items (workspace_id, content_type, title, caption_text, platform, platform_key, social_account_id, status, version, external_post_id, published_at, created_at) VALUES (?, 'post', ?, '', ?, ?, ?, 'published', 1, ?, UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP())",
      [W.workspaceId, `=HYPERLINK("x") ${ext}`, platform, platform, platform === 'youtube' ? yt.id : ig.id, ext]
    );
    return ins.lastID;
  };
  const igPost = await mk(`igm${Date.now()}`, 'instagram');
  const ytPost = await mk(`ytm${Date.now()}`, 'youtube');
  const analytics = require('../modules/social/analyticsService');
  const igAcct = await h.db().get('SELECT * FROM social_accounts WHERE id = ?', [ig.id]);
  const ytAcct = await h.db().get('SELECT * FROM social_accounts WHERE id = ?', [yt.id]);
  const igExt = (await h.db().get('SELECT external_post_id FROM content_items WHERE id = ?', [igPost])).external_post_id;
  const ytExt = (await h.db().get('SELECT external_post_id FROM content_items WHERE id = ?', [ytPost])).external_post_id;
  await analytics.insertSnapshots(igAcct, 'post', igExt, igPost, [
    { metric_key: 'likes', value: 0, availability: 'available' },
    { metric_key: 'shares', value: null, availability: 'unavailable', reason: 'Not returned' },
    { metric_key: 'avg_watch_time', value: 10, availability: 'available' }
  ], 'meta_api');
  await analytics.insertSnapshots(ytAcct, 'post', ytExt, ytPost, [
    { metric_key: 'likes', value: 4, availability: 'available' },
    { metric_key: 'avg_watch_time', value: 20, availability: 'available' }
  ], 'youtube_api');

  const s = await h.api('GET', '/api/v1/social/analytics/summary', { token: W.token });
  const igRow = s.data.analytics.posts.find(p => p.contentId === igPost);
  assert.equal(igRow.metrics.likes.value, 0, 'a reported zero stays zero');
  assert.equal(igRow.metrics.shares.value, null);
  assert.equal(igRow.metrics.shares.availability, 'unavailable');
  assert.equal(s.data.analytics.totals.avg_watch_time.value, 15, 'watch time is averaged, not summed');
  assert.ok(s.data.analytics.trend.length >= 1);

  const csv = await h.api('GET', '/api/v1/social/analytics/export', { token: W.token });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const line = csv.data.split('\r\n').find(l => l.includes(igExt) || l.includes('HYPERLINK') && l.includes('instagram'));
  assert.ok(line.includes(`"'=HYPERLINK(""x"") ${igExt}"`), 'formula-like cells are neutralised');
  assert.match(line, /shares \(unavailable\)/);
  assert.equal((await h.api('GET', '/api/v1/social/analytics/export', { token: other.token })).data.includes(igExt), false);
});

// ---------------------------------------------------------------- AI assist

test('AI assist returns suggestions only, is metered, and flags claims not in the facts', async () => {
  const before = Number((await h.db().get("SELECT COUNT(*) AS c FROM usage_ledger WHERE workspace_id = ? AND category = 'ai_text'", [W.workspaceId])).c);
  const posts = Number((await h.db().get('SELECT COUNT(*) AS c FROM content_items WHERE workspace_id = ?', [W.workspaceId])).c);
  const mock = h.mockFetch([h.groqRoute(JSON.stringify({ variants: [{ platform: 'x', caption: 'Save 50% today! ' + 'x'.repeat(300), hashtags: ['deal'], call_to_action: 'Buy now' }], assumptions: [], missing_information: ['pricing'] }))]);
  let r;
  try {
    r = await h.api('POST', '/api/v1/social/ai/assist', { token: member.token, body: { mode: 'caption', platforms: ['x'], instruction: 'Announce the launch' } });
  } finally { mock.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const v = r.data.suggestions[0];
  assert.equal(v.overLimit, true, 'over-limit text is flagged, not truncated');
  assert.ok(v.caption.length > 280);
  assert.deepEqual(v.unverified, ['50%']);
  assert.deepEqual(v.hashtags, ['#deal']);
  const after = Number((await h.db().get("SELECT COUNT(*) AS c FROM usage_ledger WHERE workspace_id = ? AND category = 'ai_text'", [W.workspaceId])).c);
  assert.equal(after, before + 1);
  assert.equal(Number((await h.db().get('SELECT COUNT(*) AS c FROM content_items WHERE workspace_id = ?', [W.workspaceId])).c), posts, 'nothing is saved');
  const foreign = await h.api('POST', '/api/v1/social/ai/assist', { token: other.token, body: { mode: 'alt_text', assetId: v ? (await h.db().get("SELECT id FROM assets WHERE workspace_id = ? AND asset_type = 'image' AND status = 'ready' LIMIT 1", [W.workspaceId])).id : 0 } });
  assert.equal(foreign.status, 404);
});

test('LinkedIn video uploads in parts and finalizes with ETags; Facebook video uploads the file', async () => {
  const vid = await uploaded(fx.mp4({ seconds: 15, mdatBytes: 100 * 1024 }), 'promo.mp4');
  const liPost = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'linkedin', socialAccountId: li.id, title: 'Promo', caption: 'New promo video', mediaAssetIds: [vid.id] } });
  const fbPost = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'facebook', socialAccountId: fb.id, title: 'Promo', caption: 'Watch our promo', mediaAssetIds: [vid.id] } });
  assert.equal((await approveAndPublishNow(liPost.data.content.id)).status, 202);
  assert.equal((await approveAndPublishNow(fbPost.data.content.id)).status, 202);
  const linkedin = require('../modules/social/providers/linkedin');
  linkedin._videoPollDelayMs = 1;
  const size = (await h.db().get('SELECT size_bytes FROM assets WHERE id = ?', [vid.id])).size_bytes;
  const half = Math.floor(Number(size) / 2);
  const parts = [];
  let finalize;
  let polls = 0;
  let fbForm;
  const mock = h.mockFetch([
    { match: (u, i) => i.method === 'POST' && u.includes('/rest/videos?action=initializeUpload'), respond: (u, i) => { assert.equal(JSON.parse(i.body).initializeUploadRequest.fileSizeBytes, Number(size)); return h.json(200, { value: { video: 'urn:li:video:V1', uploadToken: 'tok', uploadInstructions: [{ uploadUrl: 'https://www.linkedin.com/dms-uploads/p1', firstByte: 0, lastByte: half - 1 }, { uploadUrl: 'https://www.linkedin.com/dms-uploads/p2', firstByte: half, lastByte: Number(size) - 1 }] } }); } },
    { match: (u, i) => i.method === 'PUT' && u.startsWith('https://www.linkedin.com/dms-uploads/'), respond: (u, i) => { parts.push(i.body.size); return h.json(200, {}, { ETag: `etag-${parts.length}` }); } },
    { match: (u, i) => i.method === 'POST' && u.includes('action=finalizeUpload'), respond: (u, i) => { finalize = JSON.parse(i.body); return h.json(200, {}); } },
    { match: (u, i) => (i.method || 'GET') === 'GET' && u.includes('/rest/videos/'), respond: () => h.json(200, { status: ++polls < 2 ? 'PROCESSING' : 'AVAILABLE' }) },
    { match: (u, i) => i.method === 'POST' && u.endsWith('/rest/posts'), respond: (u, i) => { assert.equal(JSON.parse(i.body).content.media.id, 'urn:li:video:V1'); return h.json(201, {}, { 'x-restli-id': 'urn:li:share:V' }); } },
    { match: (u, i) => i.method === 'POST' && u.startsWith('https://graph-video.facebook.com/') && u.endsWith(`/${fb.externalId}/videos`), respond: (u, i) => { fbForm = i.body; return h.json(200, { id: 'fbvid1' }); } },
    { match: u => u.includes('/fbvid1?') && u.includes('fields=status'), respond: () => h.json(200, { status: { video_status: 'ready' } }) },
    { match: u => u.includes('/fbvid1?') && u.includes('permalink_url'), respond: () => h.json(200, { permalink_url: '/watch/?v=fbvid1' }) }
  ]);
  try { await worker().processPublishing(); } finally { mock.restore(); }
  assert.deepEqual(parts, [half, Number(size) - half], 'each part carries exactly its byte range');
  assert.deepEqual(finalize.finalizeUploadRequest.uploadedPartIds, ['etag-1', 'etag-2']);
  assert.equal(fbForm.get('description'), 'Watch our promo');
  assert.equal(fbForm.get('title'), 'Promo');
  assert.equal(fbForm.get('source').size, Number(size));
  assert.equal((await h.api('GET', `/api/v1/social/content/${liPost.data.content.id}`, { token: W.token })).data.content.status, 'published');
  const fbDone = (await h.api('GET', `/api/v1/social/content/${fbPost.data.content.id}`, { token: W.token })).data.content;
  assert.equal(fbDone.status, 'published');
  assert.equal(fbDone.externalUrl, 'https://www.facebook.com/watch/?v=fbvid1');
});
