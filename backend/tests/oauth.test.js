const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let W;

test.before(async () => {
  await h.prepareDatabase();
  W = await h.createWorkspace({ name: 'OAuth' });
});
test.after(() => h.shutdown());

function stateFrom(url) {
  return new URL(url).searchParams.get('state');
}

test('without any app credentials the provider shows Set up and Connect is refused', async () => {
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  const res = await h.api('POST', '/api/v1/social/oauth/meta/start', { token: W.token });
  assert.equal(res.status, 409);
  assert.equal(res.data.code, 'SETUP_REQUIRED');
  const providers = await h.api('GET', '/api/v1/social/providers', { token: W.token });
  const metaStatus = providers.data.providers.find(p => p.providerKey === 'meta');
  assert.equal(metaStatus.configured, false);
  assert.equal(metaStatus.appSource, null);
  assert.equal(metaStatus.redirectUri, 'http://localhost:8000/api/v1/social/oauth/meta/callback');
});

test('each workspace sets up its own app from the UI; the secret is verified, encrypted and never returned', async () => {
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  const T = await h.createWorkspace({ name: 'Own app' });
  const other = await h.createWorkspace({ name: 'Other tenant' });

  const reject = h.mockFetch([{ match: u => u.includes('grant_type=client_credentials'), respond: () => h.json(400, { error: { code: 101, message: 'Error validating client secret.' } }) }]);
  try {
    const bad = await h.api('PUT', '/api/v1/social/provider-apps/meta', { token: T.token, body: { clientId: '1234567890', clientSecret: 'wrong' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.code, 'INVALID_CREDENTIALS');
  } finally { reject.restore(); }

  const accept = h.mockFetch([{ match: u => u.includes('grant_type=client_credentials') && u.includes('client_id=1234567890'), respond: () => h.json(200, { access_token: 'app|token' }) }]);
  let saved;
  try {
    saved = await h.api('PUT', '/api/v1/social/provider-apps/meta', { token: T.token, body: { clientId: '1234567890', clientSecret: 'tenant-app-SECRET' } });
  } finally { accept.restore(); }
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.provider.configured, true);
  assert.equal(saved.data.provider.appSource, 'workspace');
  assert.equal(saved.data.provider.workspaceApp.clientId, '1234567890');
  assert.ok(saved.data.provider.workspaceApp.verifiedAt);
  assert.ok(!JSON.stringify(saved.data).includes('tenant-app-SECRET'));

  const { get } = h.db();
  const row = await get("SELECT client_secret_ciphertext FROM provider_apps WHERE workspace_id = ? AND provider_key = 'meta'", [T.workspaceId]);
  assert.ok(row.client_secret_ciphertext.startsWith('enc:v1:'));

  // Connect now uses this workspace's App ID.
  const start = await h.api('POST', '/api/v1/social/oauth/meta/start', { token: T.token });
  assert.equal(start.status, 200);
  assert.equal(new URL(start.data.authorizeUrl).searchParams.get('client_id'), '1234567890');

  // Another tenant does not inherit it.
  const otherStart = await h.api('POST', '/api/v1/social/oauth/meta/start', { token: other.token });
  assert.equal(otherStart.status, 409);
  const otherProviders = await h.api('GET', '/api/v1/social/providers', { token: other.token });
  assert.equal(otherProviders.data.providers.find(p => p.providerKey === 'meta').workspaceApp, null);

  // The callback exchanges the code with the same workspace app secret.
  const state = new URL(start.data.authorizeUrl).searchParams.get('state');
  const graph = 'https://graph.facebook.com/';
  const mock = h.mockFetch([
    { match: u => u.startsWith(graph) && u.includes('code=c1'), respond: u => (new URL(u).searchParams.get('client_secret') === 'tenant-app-SECRET' ? h.json(200, { access_token: 's' }) : h.json(400, { error: { code: 1 } })) },
    { match: u => u.includes('fb_exchange_token'), respond: () => h.json(200, { access_token: 'l' }) },
    { match: u => u.includes('/me/permissions'), respond: () => h.json(200, { data: [{ permission: 'pages_manage_posts', status: 'granted' }] }) },
    { match: u => u.includes('/me/accounts'), respond: () => h.json(200, { data: [{ id: '5150', name: 'Tenant Page', access_token: 'pt' }] }) },
    { match: u => u.includes('/me?'), respond: () => h.json(200, { id: 'u-own' }) }
  ]);
  try {
    const cb = await h.api('GET', `/api/v1/social/oauth/meta/callback?state=${state}&code=c1`);
    assert.match(cb.headers.get('location'), /oauth=success/);
  } finally { mock.restore(); }
  const acct = await get("SELECT app_source FROM social_accounts WHERE workspace_id = ? AND external_account_id = '5150'", [T.workspaceId]);
  assert.equal(acct.app_source, 'workspace');

  // Members without integrations.manage cannot change app credentials.
  const member = await h.addMember(T.workspaceId, 'Marketing Manager');
  const denied = await h.api('PUT', '/api/v1/social/provider-apps/meta', { token: member.token, body: { clientId: '999999', clientSecret: 'x' } });
  assert.equal(denied.status, 403);

  const removed = await h.api('DELETE', '/api/v1/social/provider-apps/meta', { token: T.token });
  assert.equal(removed.data.removed, true);
  assert.equal(removed.data.accountsUsingIt, 1);
});

test('the platform default app (environment) is used only when a workspace has none', async () => {
  process.env.META_APP_ID = '5555555';
  process.env.META_APP_SECRET = 'platform-secret';
  const P = await h.createWorkspace({ name: 'Uses platform app' });
  const providers = await h.api('GET', '/api/v1/social/providers', { token: P.token });
  const m = providers.data.providers.find(p => p.providerKey === 'meta');
  assert.equal(m.appSource, 'platform');
  const start = await h.api('POST', '/api/v1/social/oauth/meta/start', { token: P.token });
  assert.equal(new URL(start.data.authorizeUrl).searchParams.get('client_id'), '5555555');
});

test('callback rejects unknown, replayed and expired state', async () => {
  process.env.META_APP_ID = 'app-id';
  process.env.META_APP_SECRET = 'app-secret';
  const unknown = await h.api('GET', '/api/v1/social/oauth/meta/callback?state=forged&code=abc');
  assert.equal(unknown.status, 302);
  assert.match(unknown.headers.get('location'), /reason=invalid_state/);

  const start = await h.api('POST', '/api/v1/social/oauth/meta/start', { token: W.token });
  assert.equal(start.status, 200);
  const state = stateFrom(start.data.authorizeUrl);
  assert.ok(state && state.length >= 40);

  // Provider-side denial consumes the state.
  const denied = await h.api('GET', `/api/v1/social/oauth/meta/callback?state=${state}&error=access_denied`);
  assert.match(denied.headers.get('location'), /reason=denied/);
  const replay = await h.api('GET', `/api/v1/social/oauth/meta/callback?state=${state}&code=abc`);
  assert.match(replay.headers.get('location'), /reason=invalid_state/);

  // State issued for one provider cannot be used on another.
  const start2 = await h.api('POST', '/api/v1/social/oauth/meta/start', { token: W.token });
  const crossProvider = await h.api('GET', `/api/v1/social/oauth/linkedin/callback?state=${stateFrom(start2.data.authorizeUrl)}&code=abc`);
  assert.match(crossProvider.headers.get('location'), /reason=invalid_state/);

  // Expired state.
  const start3 = await h.api('POST', '/api/v1/social/oauth/meta/start', { token: W.token });
  const { run } = h.db();
  const secretBox = require('../lib/secretBox');
  await run('UPDATE oauth_states SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE state_hash = ?', [secretBox.sha256(stateFrom(start3.data.authorizeUrl))]);
  const expired = await h.api('GET', `/api/v1/social/oauth/meta/callback?state=${stateFrom(start3.data.authorizeUrl)}&code=abc`);
  assert.match(expired.headers.get('location'), /reason=invalid_state/);
});

test('a valid Meta callback stores Page + Instagram accounts with encrypted tokens (mocked Graph API)', async () => {
  process.env.META_APP_ID = 'app-id';
  process.env.META_APP_SECRET = 'app-secret';
  const start = await h.api('POST', '/api/v1/social/oauth/meta/start', { token: W.token });
  const authorize = new URL(start.data.authorizeUrl);
  assert.equal(authorize.hostname, 'www.facebook.com');
  assert.ok(authorize.searchParams.get('scope').includes('pages_manage_posts'));
  const state = authorize.searchParams.get('state');

  const graph = 'https://graph.facebook.com/';
  const mock = h.mockFetch([
    { match: u => u.startsWith(graph) && u.includes('/oauth/access_token') && u.includes('code=good-code'), respond: () => h.json(200, { access_token: 'short-user-token' }) },
    { match: u => u.startsWith(graph) && u.includes('grant_type=fb_exchange_token'), respond: () => h.json(200, { access_token: 'long-user-token', expires_in: 5184000 }) },
    { match: u => u.startsWith(graph) && u.includes('/me/permissions'), respond: () => h.json(200, { data: [{ permission: 'pages_manage_posts', status: 'granted' }, { permission: 'instagram_basic', status: 'granted' }, { permission: 'read_insights', status: 'declined' }] }) },
    { match: u => u.startsWith(graph) && u.includes('/me/accounts'), respond: () => h.json(200, { data: [{ id: '111', name: 'Acme Page', access_token: 'page-token-111', link: 'https://facebook.com/acme', instagram_business_account: { id: '999', username: 'acme' } }] }) },
    { match: u => u.startsWith(graph) && u.includes('/me?'), respond: () => h.json(200, { id: 'fb-user-1', name: 'Owner' }) }
  ]);
  try {
    const cb = await h.api('GET', `/api/v1/social/oauth/meta/callback?state=${state}&code=good-code`);
    assert.equal(cb.status, 302);
    const loc = cb.headers.get('location');
    assert.match(loc, /^http:\/\/localhost:4200\/\?/);
    assert.match(loc, /oauth=success/);
    assert.match(loc, /connected=2/);
    assert.ok(!loc.includes('token'), 'tokens must never appear in redirect URLs');
  } finally {
    mock.restore();
  }

  const accounts = await h.api('GET', '/api/v1/social/accounts', { token: W.token });
  const page = accounts.data.accounts.find(a => a.accountType === 'facebook_page');
  const ig = accounts.data.accounts.find(a => a.accountType === 'instagram_business');
  assert.equal(page.displayName, 'Acme Page');
  assert.equal(ig.username, 'acme');
  assert.equal(ig.parentAccountId, page.id);
  assert.deepEqual(page.grantedScopes.sort(), ['instagram_basic', 'pages_manage_posts']);
  // Declined permission is reflected honestly in capabilities.
  assert.equal(page.capabilities.analytics_post.status, 'missing_permission');
  assert.equal(page.capabilities.publish_text.status, 'available');

  const { all } = h.db();
  const creds = await all('SELECT secret_ciphertext FROM provider_credentials WHERE workspace_id = ?', [W.workspaceId]);
  assert.ok(creds.length >= 2);
  for (const c of creds) {
    assert.ok(c.secret_ciphertext.startsWith('enc:v1:'));
    assert.ok(!c.secret_ciphertext.includes('page-token-111'));
  }
  const audit = await all("SELECT action FROM audit_logs WHERE workspace_id = ? AND action = 'social.account.connected'", [W.workspaceId]);
  assert.equal(audit.length, 2);
});

test('disconnect deletes credentials, cancels queued posts and revokes the grant when unused', async () => {
  process.env.META_APP_ID = 'app-id';
  process.env.META_APP_SECRET = 'app-secret';
  const X = await h.createWorkspace();
  const acct = await h.createAccount(X.workspaceId, { secret: { access_token: 'p', user_access_token: 'u', meta_user_id: 'solo-user' } });
  const mock = h.mockFetch([
    { match: (u, init) => init.method === 'DELETE' && u.includes('/solo-user/permissions'), respond: () => h.json(200, { success: true }) }
  ]);
  try {
    const res = await h.api('DELETE', `/api/v1/social/accounts/${acct.id}`, { token: X.token });
    assert.equal(res.status, 200);
    assert.equal(res.data.revoked, true);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
  const { get } = h.db();
  assert.equal(await get('SELECT id FROM provider_credentials WHERE id = ?', [acct.credentialId]), null);
  const row = await get('SELECT status, credential_id FROM social_accounts WHERE id = ?', [acct.id]);
  assert.equal(row.status, 'disconnected');
  assert.equal(row.credential_id, null);
});

test('expiring LinkedIn tokens are refreshed before use and re-encrypted', async () => {
  process.env.LINKEDIN_CLIENT_ID = 'li-id';
  process.env.LINKEDIN_CLIENT_SECRET = 'li-secret';
  const L = await h.createWorkspace();
  const soon = new Date(Date.now() + 3600 * 1000).toISOString();
  const acct = await h.createAccount(L.workspaceId, {
    providerKey: 'linkedin',
    accountType: 'linkedin_organization',
    scopes: ['w_organization_social', 'r_organization_social', 'rw_organization_admin'],
    secret: { access_token: 'old-li-token', refresh_token: 'li-refresh', access_expires_at: soon }
  });
  const accountService = require('../modules/social/accountService');
  const mock = h.mockFetch([
    { match: u => u === 'https://www.linkedin.com/oauth/v2/accessToken', respond: () => h.json(200, { access_token: 'new-li-token', expires_in: 5184000 }) }
  ]);
  try {
    const row = await accountService.getAccountRow(L.workspaceId, acct.id);
    const secret = await accountService.getUsableSecret(row);
    assert.equal(secret.access_token, 'new-li-token');
  } finally {
    mock.restore();
  }
  const { get } = h.db();
  const cred = await get('SELECT secret_ciphertext FROM provider_credentials WHERE id = ?', [acct.credentialId]);
  assert.ok(!cred.secret_ciphertext.includes('new-li-token'));
  assert.equal(require('../lib/secretBox').decryptJson(cred.secret_ciphertext).access_token, 'new-li-token');
});

test('an expired token that cannot be refreshed marks the account expired', async () => {
  const E = await h.createWorkspace();
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  const acct = await h.createAccount(E.workspaceId, {
    providerKey: 'linkedin',
    accountType: 'linkedin_organization',
    scopes: ['w_organization_social'],
    secret: { access_token: 'dead', refresh_token: null, access_expires_at: past }
  });
  const accountService = require('../modules/social/accountService');
  const row = await accountService.getAccountRow(E.workspaceId, acct.id);
  await assert.rejects(() => accountService.getUsableSecret(row), err => err.code === 'AUTH_EXPIRED');
  const after = await accountService.getAccountRow(E.workspaceId, acct.id);
  assert.equal(after.status, 'expired');
});
