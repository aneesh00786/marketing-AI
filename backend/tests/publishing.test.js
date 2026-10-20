const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let W;
let fb;
let ig;

test.before(async () => {
  await h.prepareDatabase();
  process.env.META_APP_ID = 'app-id';
  process.env.META_APP_SECRET = 'app-secret';
  W = await h.createWorkspace({ name: 'Publisher' });
  fb = await h.createAccount(W.workspaceId, { accountType: 'facebook_page', externalId: `page${Date.now()}` });
  ig = await h.createAccount(W.workspaceId, { accountType: 'instagram_business', externalId: `ig${Date.now()}` });
});
test.after(() => h.shutdown());

const publishing = () => require('../modules/social/publishingService');
const worker = () => require('../workers/socialWorker');

async function newApprovedPost(extra = {}) {
  const c = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'facebook', socialAccountId: fb.id, caption: 'Hello from TradeSage', hashtags: ['#launch'], ...extra } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const a = await h.api('POST', `/api/v1/social/content/${c.data.content.id}/approve`, { token: W.token, body: {} });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  return a.data.content;
}

async function runWorkerOnce() {
  return worker().processPublishing();
}

// A local date ~30 days ahead; Asia/Kolkata has no DST so UTC is always 05:30 earlier.
const FUTURE_DAY = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const FUTURE_LOCAL = `${FUTURE_DAY}T09:00`;
const FUTURE_UTC = `${FUTURE_DAY}T03:30:00.000Z`;

const feedRoute = (respond) => ({ match: (u, init) => init.method === 'POST' && /\/page\d+\/feed$/.test(new URL(u).pathname), respond });
const permalinkRoute = { match: (u, init) => (init.method || 'GET') === 'GET' && u.includes('fields=permalink_url'), respond: () => h.json(200, { permalink_url: 'https://facebook.com/p/1' }) };

test('scheduling requires approval of the current version', async () => {
  const c = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'facebook', socialAccountId: fb.id, caption: 'Needs approval' } });
  const res = await h.api('POST', `/api/v1/social/content/${c.data.content.id}/publish-now`, { token: W.token, body: {} });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /Approve/);

  // Submit + approve, then edit: approval is invalidated and the item returns to draft.
  await h.api('POST', `/api/v1/social/content/${c.data.content.id}/submit`, { token: W.token, body: {} });
  await h.api('POST', `/api/v1/social/content/${c.data.content.id}/approve`, { token: W.token, body: {} });
  const sched = await h.api('POST', `/api/v1/social/content/${c.data.content.id}/schedule`, { token: W.token, body: { localDateTime: FUTURE_LOCAL, timezone: 'Asia/Kolkata' } });
  assert.equal(sched.status, 200, JSON.stringify(sched.data));
  const edited = await h.api('PATCH', `/api/v1/social/content/${c.data.content.id}`, { token: W.token, body: { caption: 'Changed after approval' } });
  assert.equal(edited.data.content.status, 'draft');
  assert.equal(edited.data.content.version, 2);
  const detail = await h.api('GET', `/api/v1/social/content/${c.data.content.id}`, { token: W.token });
  assert.equal(detail.data.publishingJobs[0].status, 'cancelled');
  assert.ok(detail.data.versions.length >= 2);
});

test('schedules store UTC and preserve the intended time zone', async () => {
  const post = await newApprovedPost();
  const res = await h.api('POST', `/api/v1/social/content/${post.id}/schedule`, { token: W.token, body: { localDateTime: FUTURE_LOCAL, timezone: 'Asia/Kolkata' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(new Date(res.data.job.scheduledFor).toISOString(), FUTURE_UTC);
  assert.equal(res.data.job.scheduleTimezone, 'Asia/Kolkata');
  const past = await h.api('POST', `/api/v1/social/content/${post.id}/schedule`, { token: W.token, body: { localDateTime: '2020-01-01T09:00', timezone: 'UTC' } });
  assert.equal(past.status, 400);
  // Not due yet: the worker must not publish it.
  const mock = h.mockFetch([]);
  try {
    await runWorkerOnce();
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }
  await h.api('POST', `/api/v1/social/content/${post.id}/unschedule`, { token: W.token });
});

test('content is marked published only after the provider confirms, and is never posted twice', async () => {
  const post = await newApprovedPost();
  const job = await h.api('POST', `/api/v1/social/content/${post.id}/publish-now`, { token: W.token, body: {} });
  assert.equal(job.status, 202, JSON.stringify(job.data));

  // Before the worker runs, nothing is published.
  let detail = await h.api('GET', `/api/v1/social/content/${post.id}`, { token: W.token });
  assert.equal(detail.data.content.status, 'scheduled');

  const mock = h.mockFetch([feedRoute(() => h.json(200, { id: `${fb.externalId}_777` })), permalinkRoute]);
  try {
    await runWorkerOnce();
    await runWorkerOnce(); // a second pass must not re-post
    assert.equal(mock.calls.filter(c => c.method === 'POST').length, 1);
    const body = new URLSearchParams(mock.calls.find(c => c.method === 'POST').body);
    assert.equal(body.get('message'), 'Hello from TradeSage\n\n#launch');
  } finally { mock.restore(); }

  detail = await h.api('GET', `/api/v1/social/content/${post.id}`, { token: W.token });
  assert.equal(detail.data.content.status, 'published');
  assert.equal(detail.data.content.externalPostId, `${fb.externalId}_777`);
  assert.equal(detail.data.content.externalUrl, 'https://facebook.com/p/1');
  assert.equal(detail.data.publishingJobs[0].status, 'succeeded');

  const again = await h.api('POST', `/api/v1/social/content/${post.id}/publish-now`, { token: W.token, body: {} });
  assert.equal(again.status, 409);
});

test('an unknown outcome (network drop after sending) is never auto-retried', async () => {
  const post = await newApprovedPost({ caption: 'Unknown outcome post' });
  const job = await h.api('POST', `/api/v1/social/content/${post.id}/publish-now`, { token: W.token, body: {} });
  const mock = h.mockFetch([feedRoute(() => Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } }))]);
  try {
    await runWorkerOnce();
    await runWorkerOnce();
    assert.equal(mock.calls.length, 1);
  } finally { mock.restore(); }
  const queue = await h.api('GET', '/api/v1/social/queue?status=needs_review', { token: W.token });
  const j = queue.data.jobs.find(x => x.id === job.data.job.id);
  assert.equal(j.status, 'needs_review');
  const detail = await h.api('GET', `/api/v1/social/content/${post.id}`, { token: W.token });
  assert.equal(detail.data.content.status, 'failed');

  const noConfirm = await h.api('POST', `/api/v1/social/queue/${j.id}/retry`, { token: W.token, body: {} });
  assert.equal(noConfirm.status, 409);
  assert.equal(noConfirm.data.code, 'CONFIRMATION_REQUIRED');
  const confirmed = await h.api('POST', `/api/v1/social/queue/${j.id}/retry`, { token: W.token, body: { confirmNotPublished: true } });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.job.status, 'queued');
  await h.api('POST', `/api/v1/social/queue/${j.id}/cancel`, { token: W.token });
});

test('retryable provider errors are retried with backoff; rate limits honour Retry-After', async () => {
  const post = await newApprovedPost({ caption: 'Retry me' });
  const job = await h.api('POST', `/api/v1/social/content/${post.id}/publish-now`, { token: W.token, body: {} });
  const mock = h.mockFetch([feedRoute(() => h.json(429, { error: { code: 4, message: 'Application request limit reached' } }, { 'Retry-After': '120' }))]);
  try {
    await runWorkerOnce();
  } finally { mock.restore(); }
  const { get, run } = h.db();
  const row = await get('SELECT status, attempt_count, last_error_code, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), next_attempt_at) AS wait FROM publishing_jobs WHERE id = ?', [job.data.job.id]);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempt_count, 1);
  assert.equal(row.last_error_code, 'RATE_LIMITED');
  assert.ok(row.wait >= 100 && row.wait <= 125, `wait was ${row.wait}`);

  // Make it due again and succeed.
  await run('UPDATE publishing_jobs SET next_attempt_at = UTC_TIMESTAMP() WHERE id = ?', [job.data.job.id]);
  const ok = h.mockFetch([feedRoute(() => h.json(200, { id: `${fb.externalId}_888` })), permalinkRoute]);
  try { await runWorkerOnce(); } finally { ok.restore(); }
  const done = await get('SELECT status, attempt_count FROM publishing_jobs WHERE id = ?', [job.data.job.id]);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.attempt_count, 2);
  const attempts = await h.db().all('SELECT outcome FROM publishing_attempts WHERE publishing_job_id = ? ORDER BY attempt_number', [job.data.job.id]);
  assert.deepEqual(attempts.map(a => a.outcome), ['retry', 'succeeded']);
});

test('an expired token fails the job and flags the account for reconnection', async () => {
  const acct = await h.createAccount(W.workspaceId, { accountType: 'facebook_page', externalId: `page${Date.now()}9` });
  const c = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'facebook', socialAccountId: acct.id, caption: 'Token test' } });
  await h.api('POST', `/api/v1/social/content/${c.data.content.id}/approve`, { token: W.token, body: {} });
  await h.api('POST', `/api/v1/social/content/${c.data.content.id}/publish-now`, { token: W.token, body: {} });
  const mock = h.mockFetch([feedRoute(() => h.json(400, { error: { code: 190, message: 'Error validating access token' } }))]);
  try { await runWorkerOnce(); } finally { mock.restore(); }
  const detail = await h.api('GET', `/api/v1/social/content/${c.data.content.id}`, { token: W.token });
  assert.equal(detail.data.content.status, 'failed');
  assert.equal(detail.data.publishingJobs[0].last_error_code, 'AUTH_EXPIRED');
  const accounts = await h.api('GET', '/api/v1/social/accounts', { token: W.token });
  assert.equal(accounts.data.accounts.find(a => a.id === acct.id).status, 'expired');
  // Publishing to an expired account is refused up front.
  const retry = await h.api('POST', `/api/v1/social/queue/${detail.data.publishingJobs[0].id}/retry`, { token: W.token, body: {} });
  assert.equal(retry.status, 409);
});

test('Instagram requires an image and publishes through the media container flow', async () => {
  const c = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'instagram', socialAccountId: ig.id, caption: 'IG post' } });
  await h.api('POST', `/api/v1/social/content/${c.data.content.id}/approve`, { token: W.token, body: {} });
  const noImage = await h.api('POST', `/api/v1/social/content/${c.data.content.id}/publish-now`, { token: W.token, body: {} });
  assert.equal(noImage.status, 409);
  assert.equal(noImage.data.code, 'CAPABILITY_UNAVAILABLE');

  const { run } = h.db();
  const asset = await run("INSERT INTO assets (workspace_id, asset_type, source, public_url, mime_type, created_at) VALUES (?, 'image', 'url', 'https://cdn.example.com/a.jpg', 'image/jpeg', UTC_TIMESTAMP())", [W.workspaceId]);
  const edited = await h.api('PATCH', `/api/v1/social/content/${c.data.content.id}`, { token: W.token, body: { mediaAssetIds: [asset.lastID] } });
  await h.api('POST', `/api/v1/social/content/${c.data.content.id}/approve`, { token: W.token, body: {} });
  assert.equal(edited.data.content.version, 2);
  const queued = await h.api('POST', `/api/v1/social/content/${c.data.content.id}/publish-now`, { token: W.token, body: {} });
  assert.equal(queued.status, 202, JSON.stringify(queued.data));

  const meta = require('../modules/social/providers/meta');
  meta._pollDelayMs = 1;
  const mock = h.mockFetch([
    { match: (u, init) => init.method === 'POST' && u.endsWith(`/${ig.externalId}/media`), respond: () => h.json(200, { id: 'container-1' }) },
    { match: u => u.includes('/container-1?') && u.includes('status_code'), respond: () => h.json(200, { status_code: 'FINISHED' }) },
    { match: (u, init) => init.method === 'POST' && u.endsWith(`/${ig.externalId}/media_publish`), respond: () => h.json(200, { id: 'ig-media-1' }) },
    { match: u => u.includes('/ig-media-1?') && u.includes('permalink'), respond: () => h.json(200, { permalink: 'https://instagram.com/p/x' }) }
  ]);
  try { await runWorkerOnce(); } finally { mock.restore(); }
  const posted = mock.calls.find(c2 => c2.url.endsWith('/media'));
  assert.equal(new URLSearchParams(posted.body).get('image_url'), 'https://cdn.example.com/a.jpg');
  const detail = await h.api('GET', `/api/v1/social/content/${c.data.content.id}`, { token: W.token });
  assert.equal(detail.data.content.status, 'published');
  assert.equal(detail.data.content.externalPostId, 'ig-media-1');
});

test('platform rules are validated before queueing', async () => {
  const long = 'x'.repeat(70000);
  const c = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'facebook', socialAccountId: fb.id, caption: long.slice(0, 10000) } });
  await h.api('POST', `/api/v1/social/content/${c.data.content.id}/approve`, { token: W.token, body: {} });
  const igPost = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'linkedin', socialAccountId: fb.id, caption: 'wrong platform' } });
  await h.api('POST', `/api/v1/social/content/${igPost.data.content.id}/approve`, { token: W.token, body: {} });
  const mismatch = await h.api('POST', `/api/v1/social/content/${igPost.data.content.id}/publish-now`, { token: W.token, body: {} });
  assert.equal(mismatch.status, 400);
});

test('a crashed worker leaves the job in needs_review rather than re-posting', async () => {
  const post = await newApprovedPost({ caption: 'Crash test' });
  const job = await h.api('POST', `/api/v1/social/content/${post.id}/publish-now`, { token: W.token, body: {} });
  const { run, get } = h.db();
  await run("UPDATE publishing_jobs SET status = 'running', locked_by = 'dead-worker', locked_at = UTC_TIMESTAMP() - INTERVAL 30 MINUTE WHERE id = ?", [job.data.job.id]);
  await publishing().recoverStaleJobs();
  const row = await get('SELECT status FROM publishing_jobs WHERE id = ?', [job.data.job.id]);
  assert.equal(row.status, 'needs_review');
});

test('two workers cannot claim the same job', async () => {
  const post = await newApprovedPost({ caption: 'Race test' });
  await h.api('POST', `/api/v1/social/content/${post.id}/publish-now`, { token: W.token, body: {} });
  const [a, b] = await Promise.all([publishing().claimDueJobs('w1', 10), publishing().claimDueJobs('w2', 10)]);
  const ids = [...a, ...b].map(j => j.id);
  assert.equal(ids.length, new Set(ids).size);
  // Release them so later tests are unaffected.
  const { run } = h.db();
  await run("UPDATE publishing_jobs SET status = 'cancelled' WHERE id IN (" + ids.map(() => '?').join(',') + ')', ids);
});
