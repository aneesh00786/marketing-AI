const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const fx = require('./mediaFixtures');

// Production-readiness regressions: missing media, long uploads vs stale-lock recovery,
// platform processing states and quota handling. All provider calls are mocked.
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-social-ready-test-'));
process.env.SOCIAL_MEDIA_STORAGE_DIR = STORAGE;

let W;
let approver;
let fb;
let ig;
let li;
let yt;

test.before(async () => {
  await h.prepareDatabase();
  W = await h.createWorkspace({ name: 'Readiness' });
  approver = await h.addMember(W.workspaceId, 'Approver');
  const s = Date.now();
  fb = await h.createAccount(W.workspaceId, { accountType: 'facebook_page', externalId: `rpage${s}` });
  ig = await h.createAccount(W.workspaceId, { accountType: 'instagram_business', externalId: `rig${s}` });
  li = await h.createAccount(W.workspaceId, { accountType: 'linkedin_organization', providerKey: 'linkedin', scopes: ['r_organization_social', 'w_organization_social', 'rw_organization_admin'], externalId: `77${s}`, secret: { access_token: 'li-SECRET' } });
  yt = await h.createAccount(W.workspaceId, { accountType: 'youtube_channel', providerKey: 'youtube', scopes: ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/youtube.force-ssl'], externalId: `UCr${s}`, secret: { access_token: 'yt-SECRET', refresh_token: 'r' } });
  const meta = require('../modules/social/providers/meta');
  meta._pollDelayMs = 1;
  meta._videoPollDelayMs = 1;
  meta._videoStatusPolls = 2;
  require('../modules/social/providers/linkedin')._videoPollDelayMs = 1;
  require('../modules/social/providers/linkedin')._imagePollDelayMs = 1;
});
test.after(async () => {
  await h.shutdown();
  fs.rmSync(STORAGE, { recursive: true, force: true });
});

const publishing = () => require('../modules/social/publishingService');
const worker = () => require('../workers/socialWorker');

async function upload(buf, filename) {
  const s = await h.startApp();
  const res = await globalThis.__realFetch(`http://127.0.0.1:${s.address().port}/api/v1/social/media/upload?filename=${filename}`, { method: 'POST', headers: { Authorization: `Bearer ${W.token}`, 'Content-Type': 'application/octet-stream' }, body: buf });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  return data.asset;
}

async function queued(body) {
  const c = await h.api('POST', '/api/v1/social/content', { token: W.token, body });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  await h.api('POST', `/api/v1/social/content/${c.data.content.id}/approve`, { token: approver.token, body: {} });
  const j = await h.api('POST', `/api/v1/social/content/${c.data.content.id}/publish-now`, { token: W.token, body: {} });
  assert.equal(j.status, 202, JSON.stringify(j.data));
  return { contentId: c.data.content.id, jobId: j.data.job.id };
}

const job = id => h.db().get('SELECT * FROM publishing_jobs WHERE id = ?', [id]);
const content = id => h.db().get('SELECT * FROM content_items WHERE id = ?', [id]);

test('a media file missing from storage blocks publishing before any provider call, without exposing server paths', async () => {
  const img = await upload(fx.jpeg(900, 900), 'gone.jpg');
  const q = await queued({ platformKey: 'linkedin', socialAccountId: li.id, caption: 'Missing file', mediaAssetIds: [img.id] });
  const row = await h.db().get('SELECT public_id FROM assets WHERE id = ?', [img.id]);
  fs.unlinkSync(path.join(STORAGE, String(W.workspaceId), row.public_id));
  const mock = h.mockFetch([]);
  try { await worker().processPublishing(); } finally { mock.restore(); }
  assert.equal(mock.calls.length, 0, 'nothing was sent to LinkedIn');
  const j = await job(q.jobId);
  assert.equal(j.status, 'failed');
  assert.equal(j.last_error_code, 'MEDIA_MISSING');
  assert.ok(!j.last_error.includes(STORAGE), 'no server path in the error');
  assert.ok(!(await content(q.contentId)).last_error.includes(STORAGE));
});

test('an Instagram image container that is still processing is never published early', async () => {
  process.env.APP_BASE_URL = 'https://app.example.test';
  try {
    const img = await upload(fx.jpeg(1080, 1080), 'slow.jpg');
    const q = await queued({ platformKey: 'instagram', socialAccountId: ig.id, caption: 'Slow', mediaAssetIds: [img.id] });
    const mock = h.mockFetch([
      { match: (u, i) => i.method === 'POST' && u.endsWith(`/${ig.externalId}/media`), respond: () => h.json(200, { id: 'slowc' }) },
      { match: u => u.includes('/slowc?'), respond: () => h.json(200, { status_code: 'IN_PROGRESS' }) }
    ]);
    try { await worker().processPublishing(); } finally { mock.restore(); }
    assert.ok(!mock.calls.some(c => c.url.includes('media_publish')), 'media_publish was not called');
    const j = await job(q.jobId);
    assert.equal(j.status, 'queued', 'retried later; nothing was published');
    await h.db().run("UPDATE publishing_jobs SET status = 'cancelled' WHERE id = ?", [q.jobId]);
  } finally {
    process.env.APP_BASE_URL = 'http://localhost:8000';
  }
});

test('a long upload keeps its lock alive, so another worker does not mark it needs_review mid-upload', async () => {
  const vid = await upload(fx.mp4({ seconds: 20, mdatBytes: 100 * 1024 }), 'long.mp4');
  const q = await queued({ platformKey: 'youtube', socialAccountId: yt.id, title: 'Long upload', caption: 'x', mediaAssetIds: [vid.id] });
  const svc = publishing();
  svc._heartbeatMs = 10;
  let recovered = null;
  const mock = h.mockFetch([
    { match: u => u.includes('uploadType=resumable'), respond: () => h.json(200, {}, { Location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=long' }) },
    {
      match: (u, i) => i.method === 'PUT' && u.includes('upload_id=long'),
      respond: async () => {
        // Simulate an upload that has been running for a long time, then a second worker's recovery pass.
        await h.db().run('UPDATE publishing_jobs SET locked_at = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE id = ?', [q.jobId]);
        await new Promise(r => setTimeout(r, 60));
        await svc.recoverStaleJobs();
        recovered = (await job(q.jobId)).status;
        return h.json(200, { id: 'longvid', status: { uploadStatus: 'processed', privacyStatus: 'public' } });
      }
    }
  ]);
  try { await worker().processPublishing(); } finally { mock.restore(); svc._heartbeatMs = 60000; }
  assert.equal(recovered, 'running', 'the live job was not taken over');
  assert.equal((await job(q.jobId)).status, 'succeeded');
});

test('Facebook video: an accepted upload is "processing" until Facebook reports it ready', async () => {
  const vid = await upload(fx.mp4({ seconds: 15, mdatBytes: 100 * 1024 }), 'fbv.mp4');
  const q = await queued({ platformKey: 'facebook', socialAccountId: fb.id, caption: 'FB video', title: 'T', mediaAssetIds: [vid.id] });
  let state = 'processing';
  const routes = [
    { match: (u, i) => i.method === 'POST' && u.includes('graph-video.facebook.com') && u.endsWith('/videos'), respond: () => h.json(200, { id: 'fbv9' }) },
    { match: u => u.includes('/fbv9?') && u.includes('fields=status'), respond: () => h.json(200, { status: { video_status: state } }) },
    { match: u => u.includes('/fbv9?') && u.includes('permalink_url'), respond: () => h.json(200, { permalink_url: '/watch/?v=fbv9' }) }
  ];
  let mock = h.mockFetch(routes);
  try { await worker().processPublishing(); } finally { mock.restore(); }
  let j = await job(q.jobId);
  assert.equal(j.status, 'processing');
  assert.equal(j.external_post_id, 'fbv9', 'the upload id is kept so it is never uploaded twice');
  assert.equal((await content(q.contentId)).status, 'publishing', 'not reported as published yet');
  // A repeat publish request is refused while processing.
  const again = await h.api('POST', `/api/v1/social/content/${q.contentId}/publish-now`, { token: W.token, body: {} });
  assert.equal(again.status, 409);

  state = 'ready';
  await h.db().run('UPDATE publishing_jobs SET next_attempt_at = UTC_TIMESTAMP() WHERE id = ?', [q.jobId]);
  mock = h.mockFetch(routes);
  try { await worker().processProcessing(); } finally { mock.restore(); }
  j = await job(q.jobId);
  assert.equal(j.status, 'succeeded');
  const c = await content(q.contentId);
  assert.equal(c.status, 'published');
  assert.equal(c.external_url, 'https://www.facebook.com/watch/?v=fbv9');
});

test('a video whose processing fails is reported failed and can be retried as a fresh upload', async () => {
  const vid = await upload(fx.mp4({ seconds: 15, mdatBytes: 100 * 1024 }), 'ytfail.mp4');
  const q = await queued({ platformKey: 'youtube', socialAccountId: yt.id, title: 'Will fail', caption: 'x', mediaAssetIds: [vid.id] });
  let mock = h.mockFetch([
    { match: u => u.includes('uploadType=resumable'), respond: () => h.json(200, {}, { Location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=f' }) },
    { match: (u, i) => i.method === 'PUT', respond: () => h.json(200, { id: 'ytf1', status: { uploadStatus: 'uploaded', privacyStatus: 'private' } }) }
  ]);
  try { await worker().processPublishing(); } finally { mock.restore(); }
  let j = await job(q.jobId);
  assert.equal(j.status, 'processing');
  assert.match(JSON.parse(j.provider_response_json).note, /private/, 'a privacy change by YouTube is reported');

  await h.db().run('UPDATE publishing_jobs SET next_attempt_at = UTC_TIMESTAMP() WHERE id = ?', [q.jobId]);
  mock = h.mockFetch([{ match: u => u.includes('/youtube/v3/videos?part=status') && u.includes('ytf1'), respond: () => h.json(200, { items: [{ id: 'ytf1', status: { uploadStatus: 'rejected', rejectionReason: 'duplicate', privacyStatus: 'private' } }] }) }]);
  try { await worker().processProcessing(); } finally { mock.restore(); }
  j = await job(q.jobId);
  assert.equal(j.status, 'failed');
  assert.equal(j.last_error_code, 'PROCESSING_FAILED');
  assert.match(j.last_error, /duplicate/);
  assert.equal(j.external_post_id, null, 'a retry uploads again instead of being marked published');
  assert.equal((await content(q.contentId)).status, 'failed');
});

test('a video still processing after the deadline is handed to a person (needs_review), not retried', async () => {
  const vid = await upload(fx.mp4({ seconds: 15, mdatBytes: 100 * 1024 }), 'ytslow.mp4');
  const q = await queued({ platformKey: 'youtube', socialAccountId: yt.id, title: 'Slow', caption: 'x', mediaAssetIds: [vid.id] });
  let mock = h.mockFetch([
    { match: u => u.includes('uploadType=resumable'), respond: () => h.json(200, {}, { Location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=s' }) },
    { match: (u, i) => i.method === 'PUT', respond: () => h.json(200, { id: 'yts1', status: { uploadStatus: 'uploaded', privacyStatus: 'public' } }) }
  ]);
  try { await worker().processPublishing(); } finally { mock.restore(); }
  const j0 = await job(q.jobId);
  const resp = JSON.parse(j0.provider_response_json);
  resp.processingStartedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  await h.db().run('UPDATE publishing_jobs SET provider_response_json = ?, next_attempt_at = UTC_TIMESTAMP() WHERE id = ?', [JSON.stringify(resp), q.jobId]);
  mock = h.mockFetch([{ match: u => u.includes('part=status'), respond: () => h.json(200, { items: [{ id: 'yts1', status: { uploadStatus: 'uploaded' } }] }) }]);
  try { await worker().processProcessing(); } finally { mock.restore(); }
  const j = await job(q.jobId);
  assert.equal(j.status, 'needs_review');
  assert.equal(j.external_post_id, 'yts1');
});

test('LinkedIn waits for uploaded images to become AVAILABLE before creating the post', async () => {
  const img = await upload(fx.jpeg(800, 800), 'li.jpg');
  const q = await queued({ platformKey: 'linkedin', socialAccountId: li.id, caption: 'Img', mediaAssetIds: [img.id] });
  const order = [];
  let polls = 0;
  const mock = h.mockFetch([
    { match: (u, i) => i.method === 'POST' && u.includes('/rest/images?action=initializeUpload'), respond: () => h.json(200, { value: { uploadUrl: 'https://www.linkedin.com/dms-uploads/i1', image: 'urn:li:image:I1' } }) },
    { match: (u, i) => i.method === 'PUT', respond: () => { order.push('put'); return h.json(201, {}); } },
    { match: (u, i) => (i.method || 'GET') === 'GET' && u.includes('/rest/images/'), respond: () => { order.push('poll'); return h.json(200, { status: ++polls < 2 ? 'PROCESSING' : 'AVAILABLE' }); } },
    { match: (u, i) => i.method === 'POST' && u.endsWith('/rest/posts'), respond: () => { order.push('post'); return h.json(201, {}, { 'x-restli-id': 'urn:li:share:I' }); } }
  ]);
  try { await worker().processPublishing(); } finally { mock.restore(); }
  assert.deepEqual(order, ['put', 'poll', 'poll', 'post']);
  assert.equal((await job(q.jobId)).status, 'succeeded');
});

test('YouTube quota exhaustion waits until the daily reset and says so; nothing was uploaded', async () => {
  const vid = await upload(fx.mp4({ seconds: 15, mdatBytes: 100 * 1024 }), 'quota.mp4');
  const q = await queued({ platformKey: 'youtube', socialAccountId: yt.id, title: 'Quota', caption: 'x', mediaAssetIds: [vid.id] });
  const mock = h.mockFetch([{ match: u => u.includes('uploadType=resumable'), respond: () => h.json(403, { error: { message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] } }) }]);
  try { await worker().processPublishing(); } finally { mock.restore(); }
  const j = await h.db().get('SELECT status, last_error_code, last_error, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), next_attempt_at) AS wait FROM publishing_jobs WHERE id = ?', [q.jobId]);
  assert.equal(j.status, 'queued');
  assert.equal(j.last_error_code, 'RATE_LIMITED');
  assert.match(j.last_error, /quota/i);
  assert.match(j.last_error, /Pacific/);
  assert.ok(j.wait > 0 && j.wait <= 24 * 3600 + 120, `waits until the reset (${j.wait}s)`);
  await h.db().run("UPDATE publishing_jobs SET status = 'cancelled' WHERE id = ?", [q.jobId]);
});

test('stale running jobs become needs_review once and completed jobs are never reset', async () => {
  const { run } = h.db();
  const q = await queued({ platformKey: 'facebook', socialAccountId: fb.id, caption: 'stale' });
  await run("UPDATE publishing_jobs SET status = 'running', locked_by = 'dead', locked_at = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE id = ?", [q.jobId]);
  const done = await queued({ platformKey: 'facebook', socialAccountId: fb.id, caption: 'done' });
  await run("UPDATE publishing_jobs SET status = 'succeeded', external_post_id = 'x1', locked_at = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE id = ?", [done.jobId]);
  await publishing().recoverStaleJobs();
  await publishing().recoverStaleJobs();
  assert.equal((await job(q.jobId)).status, 'needs_review');
  assert.equal((await job(done.jobId)).status, 'succeeded');
  const mock = h.mockFetch([]);
  try { await worker().processPublishing(); } finally { mock.restore(); }
  assert.equal(mock.calls.length, 0, 'needs_review is never retried automatically');
});

test('a relative storage setting resolves to the same folder for the API and the worker', () => {
  const mediaStore = require('../modules/social/mediaStore');
  const saved = process.env.SOCIAL_MEDIA_STORAGE_DIR;
  const cwd = process.cwd();
  try {
    process.env.SOCIAL_MEDIA_STORAGE_DIR = 'storage/social-media';
    const fromBackend = mediaStore.storageRoot();
    process.chdir(os.tmpdir());
    assert.equal(mediaStore.storageRoot(), fromBackend);
    assert.equal(fromBackend, path.resolve(__dirname, '..', 'storage/social-media'));
  } finally {
    process.chdir(cwd);
    process.env.SOCIAL_MEDIA_STORAGE_DIR = saved;
  }
});

test('a processing check never turns a disconnected account into "expired"', async () => {
  const acct = await h.createAccount(W.workspaceId, { accountType: 'youtube_channel', providerKey: 'youtube', scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'], externalId: `UCd${Date.now()}`, secret: { access_token: 'x' } });
  const c = await h.db().run("INSERT INTO content_items (workspace_id, content_type, caption_text, platform, platform_key, social_account_id, status, version, created_at) VALUES (?, 'post', 'x', 'youtube', 'youtube', ?, 'publishing', 1, UTC_TIMESTAMP())", [W.workspaceId, acct.id]);
  const j = await h.db().run("INSERT INTO publishing_jobs (workspace_id, content_item_id, social_account_id, content_version, idempotency_key, status, scheduled_for, next_attempt_at, external_post_id, provider_response_json, created_at) VALUES (?, ?, ?, 1, ?, 'processing', UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'ytd1', ?, UTC_TIMESTAMP())",
    [W.workspaceId, c.lastID, acct.id, `t${Date.now()}`, JSON.stringify({ processingStartedAt: new Date().toISOString() })]);
  await h.db().run("UPDATE social_accounts SET status = 'disconnected', credential_id = NULL WHERE id = ?", [acct.id]);
  const mock = h.mockFetch([]);
  try { await worker().processProcessing(); } finally { mock.restore(); }
  assert.equal((await h.db().get('SELECT status FROM social_accounts WHERE id = ?', [acct.id])).status, 'disconnected');
  assert.equal((await job(j.lastID)).status, 'processing', 'kept for a later check or the deadline');
});

test('an overdue job already queued for a demo account is refused by the worker without any network call', async () => {
  const demo = await h.createAccount(W.workspaceId, { accountType: 'facebook_page', externalId: `demo_page_${Date.now()}` });
  const c = await h.db().run("INSERT INTO content_items (workspace_id, content_type, caption_text, platform, platform_key, social_account_id, status, version, created_at) VALUES (?, 'post', 'demo', 'facebook', 'facebook', ?, 'scheduled', 1, UTC_TIMESTAMP())", [W.workspaceId, demo.id]);
  await h.db().run("INSERT INTO approval_requests (workspace_id, resource_type, resource_id, resource_version, status, decided_by, decided_at, created_at) VALUES (?, 'content', ?, 1, 'approved', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())", [W.workspaceId, c.lastID, approver.userId]);
  const j = await h.db().run("INSERT INTO publishing_jobs (workspace_id, content_item_id, social_account_id, content_version, idempotency_key, status, scheduled_for, next_attempt_at, requested_by, created_at) VALUES (?, ?, ?, 1, ?, 'queued', UTC_TIMESTAMP() - INTERVAL 4 DAY, UTC_TIMESTAMP() - INTERVAL 4 DAY, ?, UTC_TIMESTAMP())",
    [W.workspaceId, c.lastID, demo.id, `demo-${Date.now()}`, W.userId]);
  const mock = h.mockFetch([]);
  try { await worker().processPublishing(); } finally { mock.restore(); }
  assert.equal(mock.calls.length, 0, 'nothing sent to any platform');
  const row = await job(j.lastID);
  assert.equal(row.status, 'failed');
  assert.equal(row.last_error_code, 'DEMO_ACCOUNT');
});
