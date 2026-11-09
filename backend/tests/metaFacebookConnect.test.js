/**
 * Facebook Page connection (Meta login with Facebook-only permissions), Page selection,
 * and text + image publishing to the selected Page. All Graph API calls are mocked.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const fx = require('./mediaFixtures');

const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-meta-connect-test-'));
process.env.SOCIAL_MEDIA_STORAGE_DIR = STORAGE;

const FACEBOOK_SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'];
const INSTAGRAM_SCOPES = ['instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights'];
const GRAPH = 'https://graph.facebook.com/';

let W;
let other;
let teammate;
const stamp = Date.now();
const PAGE_A = `7${stamp}1`;
const PAGE_B = `7${stamp}2`;

test.before(async () => {
  await h.prepareDatabase();
  process.env.META_APP_ID = 'thrivewoo-app-id';
  process.env.META_APP_SECRET = 'thrivewoo-APP-SECRET';
  delete process.env.META_INSTAGRAM_ENABLED;
  W = await h.createWorkspace({ name: 'ThriveWoo test' });
  other = await h.createWorkspace({ name: 'Another tenant' });
  teammate = await h.addMember(W.workspaceId, 'Workspace Admin');
});
test.after(async () => {
  delete process.env.META_INSTAGRAM_ENABLED;
  await h.shutdown();
  fs.rmSync(STORAGE, { recursive: true, force: true });
});

/** Mocked Graph API for the login: two Pages, each with its own Page token. */
function loginMock(seen = {}) {
  return h.mockFetch([
    { match: u => u.startsWith(GRAPH) && u.includes('/oauth/access_token') && u.includes('code=fb-code'), respond: u => { seen.secret = new URL(u).searchParams.get('client_secret'); return h.json(200, { access_token: 'short-user-token' }); } },
    { match: u => u.startsWith(GRAPH) && u.includes('grant_type=fb_exchange_token'), respond: () => h.json(200, { access_token: 'long-user-token' }) },
    { match: u => u.startsWith(GRAPH) && u.includes('/me/permissions'), respond: () => h.json(200, { data: FACEBOOK_SCOPES.map(permission => ({ permission, status: 'granted' })) }) },
    {
      match: u => u.startsWith(GRAPH) && u.includes('/me/accounts'),
      respond: u => {
        seen.pageFields = new URL(u).searchParams.get('fields');
        return h.json(200, { data: [
          { id: PAGE_A, name: 'ThriveWoo Store', access_token: 'page-token-A', link: 'https://facebook.com/thrivewoo', picture: { data: { url: 'https://cdn.example/a.png' } }, instagram_business_account: { id: 'ig-1', username: 'thrivewoo' } },
          { id: PAGE_B, name: 'ThriveWoo Blog', access_token: 'page-token-B' }
        ] });
      }
    },
    { match: u => u.startsWith(GRAPH) && u.includes('/me?'), respond: () => h.json(200, { id: 'fb-user-77', name: 'Owner' }) }
  ]);
}

async function loginAndGetSelection(token = W.token) {
  const start = await h.api('POST', '/api/v1/social/oauth/meta/start', { token });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const state = new URL(start.data.authorizeUrl).searchParams.get('state');
  const seen = {};
  const mock = loginMock(seen);
  let loc;
  try {
    const cb = await h.api('GET', `/api/v1/social/oauth/meta/callback?state=${state}&code=fb-code`);
    assert.equal(cb.status, 302);
    loc = cb.headers.get('location');
  } finally { mock.restore(); }
  return { loc, seen, selection: new URL(loc).searchParams.get('selection') };
}

test('Facebook OAuth requests only the three Page permissions and keeps the callback URL', async () => {
  const providers = await h.api('GET', '/api/v1/social/providers', { token: W.token });
  const m = providers.data.providers.find(p => p.providerKey === 'meta');
  assert.deepEqual(m.scopes, FACEBOOK_SCOPES);
  assert.equal(m.redirectUri, 'http://localhost:8000/api/v1/social/oauth/meta/callback');

  const start = await h.api('POST', '/api/v1/social/oauth/meta/start', { token: W.token });
  const url = new URL(start.data.authorizeUrl);
  assert.equal(url.hostname, 'www.facebook.com');
  assert.deepEqual(url.searchParams.get('scope').split(','), FACEBOOK_SCOPES);
  for (const s of INSTAGRAM_SCOPES) assert.ok(!url.searchParams.get('scope').includes(s), `${s} must not be requested`);
  assert.equal(url.searchParams.get('redirect_uri'), m.redirectUri);
  assert.equal(url.searchParams.get('client_id'), 'thrivewoo-app-id');
  assert.ok(!start.data.authorizeUrl.includes('SECRET'), 'the App Secret is never sent to the browser');
});

test('Instagram permissions are added back only when META_INSTAGRAM_ENABLED=1', async () => {
  process.env.META_INSTAGRAM_ENABLED = '1';
  try {
    const start = await h.api('POST', '/api/v1/social/oauth/meta/start', { token: W.token });
    assert.deepEqual(new URL(start.data.authorizeUrl).searchParams.get('scope').split(','), [...FACEBOOK_SCOPES, ...INSTAGRAM_SCOPES]);
  } finally { delete process.env.META_INSTAGRAM_ENABLED; }
});

test('the callback retrieves the Pages but connects nothing until the user selects one', async () => {
  const { loc, seen, selection } = await loginAndGetSelection();
  assert.match(loc, /^http:\/\/localhost:4200\/\?/);
  assert.match(loc, /oauth=select/);
  assert.ok(selection && selection.length >= 40);
  assert.ok(!/token|SECRET/.test(loc), 'no token or secret in the redirect');
  assert.equal(seen.secret, 'thrivewoo-APP-SECRET', 'the code exchange uses the App Secret server-side');
  assert.ok(!seen.pageFields.includes('instagram'), 'Instagram fields are not requested on a Facebook-only login');

  const { all, get } = h.db();
  assert.equal((await all("SELECT id FROM social_accounts WHERE workspace_id = ? AND provider_key = 'meta'", [W.workspaceId])).length, 0);
  const pending = await get('SELECT accounts_ciphertext FROM oauth_pending_selections WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [W.workspaceId]);
  assert.ok(pending.accounts_ciphertext.startsWith('enc:v1:'));
  assert.ok(!pending.accounts_ciphertext.includes('page-token-A'));

  // Page retrieval: names only, never tokens; no Instagram account while Instagram is off.
  const list = await h.api('GET', `/api/v1/social/oauth/meta/selection/${selection}`, { token: W.token });
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.deepEqual(list.data.pages.map(p => p.name), ['ThriveWoo Store', 'ThriveWoo Blog']);
  assert.equal(list.data.pages[0].avatarUrl, 'https://cdn.example/a.png');
  assert.equal(list.data.pages[0].instagram, null);
  assert.ok(!/page-token|user-token|access_token|SECRET/.test(JSON.stringify(list.data)));

  // Bound to the user and workspace that started the login.
  assert.equal((await h.api('GET', `/api/v1/social/oauth/meta/selection/${selection}`, { token: other.token })).status, 404);
  assert.equal((await h.api('GET', `/api/v1/social/oauth/meta/selection/${selection}`, { token: teammate.token })).status, 404);
  assert.equal((await h.api('POST', `/api/v1/social/oauth/meta/selection/${selection}`, { token: other.token, body: { pageIds: [PAGE_A] } })).status, 404);
  assert.equal((await h.api('GET', '/api/v1/social/oauth/meta/selection/forged', { token: W.token })).status, 404);
});

let page;

test('selecting a Page connects only that Page, with its Page token encrypted, once', async () => {
  const { selection } = await loginAndGetSelection();
  const none = await h.api('POST', `/api/v1/social/oauth/meta/selection/${selection}`, { token: W.token, body: { pageIds: [] } });
  assert.equal(none.status, 400);
  const foreign = await h.api('POST', `/api/v1/social/oauth/meta/selection/${selection}`, { token: W.token, body: { pageIds: ['123'] } });
  assert.equal(foreign.status, 400);

  const done = await h.api('POST', `/api/v1/social/oauth/meta/selection/${selection}`, { token: W.token, body: { pageIds: [PAGE_A] } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.connected, 1);
  assert.ok(!JSON.stringify(done.data).includes('token-'));

  const replay = await h.api('POST', `/api/v1/social/oauth/meta/selection/${selection}`, { token: W.token, body: { pageIds: [PAGE_B] } });
  assert.equal(replay.status, 404);

  const accounts = (await h.api('GET', '/api/v1/social/accounts', { token: W.token })).data.accounts.filter(a => a.providerKey === 'meta');
  assert.deepEqual(accounts.map(a => a.externalAccountId || a.externalId), [PAGE_A]);
  page = accounts[0];
  assert.equal(page.accountType, 'facebook_page');
  assert.equal(page.displayName, 'ThriveWoo Store');
  assert.equal(page.capabilities.publish_text.status, 'available');
  assert.equal(page.capabilities.publish_image.status, 'available');
  assert.ok(!JSON.stringify(accounts).includes('page-token-A'));

  const { get } = h.db();
  const row = await get('SELECT c.secret_ciphertext, a.workspace_id FROM social_accounts a JOIN provider_credentials c ON c.id = a.credential_id WHERE a.id = ?', [page.id]);
  assert.equal(row.workspace_id, W.workspaceId);
  assert.ok(row.secret_ciphertext.startsWith('enc:v1:'));
  assert.equal(require('../lib/secretBox').decryptJson(row.secret_ciphertext).access_token, 'page-token-A');
  // The other tenant does not see it.
  const theirs = (await h.api('GET', '/api/v1/social/accounts', { token: other.token })).data.accounts;
  assert.equal(theirs.length, 0);
});

test('canceling the picker discards the pending Pages', async () => {
  const { selection } = await loginAndGetSelection();
  assert.equal((await h.api('DELETE', `/api/v1/social/oauth/meta/selection/${selection}`, { token: W.token })).status, 200);
  assert.equal((await h.api('GET', `/api/v1/social/oauth/meta/selection/${selection}`, { token: W.token })).status, 404);
});

async function approveAndPublish(body) {
  const c = await h.api('POST', '/api/v1/social/content', { token: W.token, body: { platformKey: 'facebook', socialAccountId: page.id, ...body } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal((await h.api('POST', `/api/v1/social/content/${c.data.content.id}/approve`, { token: W.token, body: {} })).status, 200);
  const job = await h.api('POST', `/api/v1/social/content/${c.data.content.id}/publish-now`, { token: W.token, body: {} });
  assert.equal(job.status, 202, JSON.stringify(job.data));
  return c.data.content.id;
}

test('publishes a text post to the selected Page with its Page token (mocked)', async () => {
  const id = await approveAndPublish({ caption: 'Hello from ThriveWoo' });
  let posted;
  const mock = h.mockFetch([
    { match: (u, i) => i.method === 'POST' && u.endsWith(`/${PAGE_A}/feed`), respond: (u, i) => { posted = new URLSearchParams(i.body); return h.json(200, { id: `${PAGE_A}_1` }); } },
    { match: u => u.includes('fields=permalink_url'), respond: () => h.json(200, { permalink_url: 'https://www.facebook.com/thrivewoo/posts/1' }) }
  ]);
  try {
    await require('../workers/socialWorker').processPublishing();
  } finally { mock.restore(); }
  assert.ok(posted, 'the feed endpoint was called');
  assert.match(posted.get('message'), /Hello from ThriveWoo/);
  assert.equal(posted.get('access_token'), 'page-token-A');
  const content = (await h.api('GET', `/api/v1/social/content/${id}`, { token: W.token })).data.content;
  assert.equal(content.status, 'published');
  assert.equal(content.externalPostId, `${PAGE_A}_1`);
});

test('publishes an image post to the selected Page (mocked)', async () => {
  const s = await h.startApp();
  const up = await globalThis.__realFetch(`http://127.0.0.1:${s.address().port}/api/v1/social/media/upload?filename=launch.jpg`, {
    method: 'POST', headers: { Authorization: `Bearer ${W.token}`, 'Content-Type': 'application/octet-stream' }, body: fx.jpeg(1080, 1080)
  });
  const asset = (await up.json()).asset;
  assert.ok(asset?.id, 'image uploaded');

  const id = await approveAndPublish({ caption: 'New arrivals', mediaAssetIds: [asset.id] });
  let photo;
  const mock = h.mockFetch([
    { match: (u, i) => i.method === 'POST' && u.includes(`/${PAGE_A}/photos`), respond: (u, i) => { photo = i.body; return h.json(200, { id: 'photo-9', post_id: `${PAGE_A}_9` }); } },
    { match: u => u.includes('fields=permalink_url'), respond: () => h.json(200, { permalink_url: 'https://www.facebook.com/thrivewoo/posts/9' }) }
  ]);
  try {
    await require('../workers/socialWorker').processPublishing();
  } finally { mock.restore(); }
  assert.ok(photo, 'the photos endpoint was called');
  assert.equal(photo.get('access_token'), 'page-token-A');
  assert.equal(photo.get('published'), 'true');
  assert.match(photo.get('caption'), /New arrivals/);
  assert.ok(photo.get('source'), 'the image file is uploaded');
  const content = (await h.api('GET', `/api/v1/social/content/${id}`, { token: W.token })).data.content;
  assert.equal(content.status, 'published');
  assert.equal(content.externalPostId, `${PAGE_A}_9`);
});
