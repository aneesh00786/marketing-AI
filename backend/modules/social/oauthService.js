const crypto = require('crypto');
const { run, get } = require('../../db/database');
const secretBox = require('../../lib/secretBox');
const { audit } = require('../../lib/audit');
const { toDbDateTime } = require('../../lib/time');
const { getAdapter } = require('./providers');
const { PROVIDERS } = require('./capabilities');
const providerAppService = require('./providerAppService');
const accountService = require('./accountService');

const STATE_TTL_MS = 10 * 60 * 1000;

function appBaseUrl() {
  return (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 8000}`).replace(/\/$/, '');
}

function frontendUrl() {
  return (process.env.FRONTEND_URL || appBaseUrl()).replace(/\/$/, '');
}

function redirectUri(providerKey) {
  return `${appBaseUrl()}/api/v1/social/oauth/${providerKey}/callback`;
}

/** Setup status for a provider in one workspace (its own app, or the platform default app). */
async function setupStatus(workspaceId, providerKey) {
  const p = PROVIDERS[providerKey];
  const app = await providerAppService.getStatus(workspaceId, providerKey);
  return {
    providerKey,
    label: p?.label || providerKey,
    configured: !!p && !!app.source && secretBox.isConfigured(),
    encryptionConfigured: secretBox.isConfigured(),
    appSource: app.source,
    workspaceApp: app.workspaceApp,
    platformAppAvailable: app.platformAppAvailable,
    labels: app.labels,
    redirectUri: redirectUri(providerKey),
    scopes: p?.scopes || [],
    docs: p?.docs || null
  };
}

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** Creates a single-use, expiring OAuth state bound to the user and workspace. */
async function startAuthorization(ctx, providerKey) {
  if (!PROVIDERS[providerKey]) throw httpError(404, 'Unknown provider.', 'NOT_FOUND');
  const app = await providerAppService.resolveApp(ctx.auth.workspaceId, providerKey);
  if (!secretBox.isConfigured()) throw httpError(409, 'Credential encryption is not configured on the server.', 'SETUP_REQUIRED');
  if (!app) {
    throw httpError(409, `Setup required: click "Set up" on the ${PROVIDERS[providerKey].label} card and enter your app credentials, then register ${redirectUri(providerKey)} as the OAuth redirect URL.`, 'SETUP_REQUIRED');
  }
  const adapter = getAdapter(providerKey);
  const state = crypto.randomBytes(32).toString('base64url');
  let codeVerifier = null;
  let codeChallenge = null;
  if (adapter.usesPkce) {
    codeVerifier = crypto.randomBytes(48).toString('base64url');
    codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  }
  await run(
    `INSERT INTO oauth_states (state_hash, workspace_id, user_id, provider_key, code_verifier_ciphertext, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [secretBox.sha256(state), ctx.auth.workspaceId, ctx.auth.userId, providerKey,
      codeVerifier ? secretBox.encrypt(codeVerifier) : null, toDbDateTime(new Date(Date.now() + STATE_TTL_MS))]
  );
  await run('DELETE FROM oauth_states WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 1 DAY');
  await audit(ctx, 'social.oauth.started', { resourceType: 'provider', resourceId: providerKey });
  return {
    authorizeUrl: adapter.buildAuthorizeUrl({
      state,
      redirectUri: redirectUri(providerKey),
      scopes: PROVIDERS[providerKey].scopes,
      codeChallenge,
      app
    })
  };
}

/** Atomically consumes a state; returns null if unknown, expired, already used or for another provider. */
async function consumeState(providerKey, state) {
  if (!state || typeof state !== 'string' || state.length > 200) return null;
  const hash = secretBox.sha256(state);
  const res = await run(
    `UPDATE oauth_states SET used_at = UTC_TIMESTAMP()
     WHERE state_hash = ? AND provider_key = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()`,
    [hash, providerKey]
  );
  if (res.changes !== 1) return null;
  return get('SELECT * FROM oauth_states WHERE state_hash = ?', [hash]);
}

function resultRedirect(params) {
  return `${frontendUrl()}/?${new URLSearchParams({ view: 'social', section: 'accounts', ...params })}`;
}

/**
 * Handles the provider redirect. Never puts tokens in the redirect URL;
 * the browser only learns success/failure and how many accounts were connected.
 */
async function handleCallback(providerKey, query) {
  if (!PROVIDERS[providerKey]) return resultRedirect({ oauth: 'error', reason: 'unknown_provider' });

  const stateRow = await consumeState(providerKey, query.state);
  if (!stateRow) return resultRedirect({ oauth: 'error', provider: providerKey, reason: 'invalid_state' });

  // Membership is re-checked: the user may have lost access since starting the flow.
  const member = await get(
    "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'Active'",
    [stateRow.workspace_id, stateRow.user_id]
  );
  const ctx = { auth: { workspaceId: stateRow.workspace_id, userId: stateRow.user_id } };
  if (!member) return resultRedirect({ oauth: 'error', provider: providerKey, reason: 'not_a_member' });

  if (query.error) {
    await audit(ctx, 'social.oauth.denied', { resourceType: 'provider', resourceId: providerKey, metadata: { error: String(query.error).slice(0, 100) } });
    return resultRedirect({ oauth: 'error', provider: providerKey, reason: 'denied' });
  }
  if (!query.code || typeof query.code !== 'string') {
    return resultRedirect({ oauth: 'error', provider: providerKey, reason: 'missing_code' });
  }

  try {
    const adapter = getAdapter(providerKey);
    const app = await providerAppService.resolveApp(stateRow.workspace_id, providerKey);
    if (!app) return resultRedirect({ oauth: 'error', provider: providerKey, reason: 'setup_required' });
    const codeVerifier = stateRow.code_verifier_ciphertext ? secretBox.decrypt(stateRow.code_verifier_ciphertext) : null;
    const { accounts } = await adapter.exchangeCode({ code: query.code, redirectUri: redirectUri(providerKey), codeVerifier, app });
    for (const a of accounts) a.app_source = app.source;
    if (!accounts || accounts.length === 0) {
      await audit(ctx, 'social.oauth.no_accounts', { resourceType: 'provider', resourceId: providerKey });
      return resultRedirect({ oauth: 'error', provider: providerKey, reason: 'no_eligible_accounts' });
    }
    const ids = await accountService.upsertConnectedAccounts(ctx, providerKey, accounts);
    return resultRedirect({ oauth: 'success', provider: providerKey, connected: String(ids.length) });
  } catch (err) {
    console.error(`[social] OAuth callback for ${providerKey} failed:`, err.code || '', err.message);
    await audit(ctx, 'social.oauth.failed', { resourceType: 'provider', resourceId: providerKey, metadata: { code: err.code, message: err.message } });
    return resultRedirect({ oauth: 'error', provider: providerKey, reason: err.code === 'ENCRYPTION_NOT_CONFIGURED' ? 'setup_required' : 'exchange_failed' });
  }
}

module.exports = {
  redirectUri,
  setupStatus,
  startAuthorization,
  consumeState,
  handleCallback
};
