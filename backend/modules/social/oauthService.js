const crypto = require('crypto');
const { run, get, all } = require('../../db/database');
const secretBox = require('../../lib/secretBox');
const { audit } = require('../../lib/audit');
const { toDbDateTime } = require('../../lib/time');
const { getAdapter } = require('./providers');
const { PROVIDERS } = require('./capabilities');
const providerAppService = require('./providerAppService');
const accountService = require('./accountService');

const STATE_TTL_MS = 10 * 60 * 1000;
const SELECTION_TTL_MS = 15 * 60 * 1000;
/** Providers whose login can return several Pages: the user picks which ones to connect. */
const SELECT_PROVIDERS = new Set(['meta']);

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
    if (SELECT_PROVIDERS.has(providerKey)) {
      // Nothing is connected yet: the Pages (and their tokens, encrypted) wait server-side for the user's choice.
      const selection = await createPendingSelection(stateRow, providerKey, accounts);
      await audit(ctx, 'social.oauth.selection_pending', { resourceType: 'provider', resourceId: providerKey, metadata: { pages: accounts.filter(a => !a.parentExternalId).length } });
      return resultRedirect({ oauth: 'select', provider: providerKey, selection });
    }
    const ids = await accountService.upsertConnectedAccounts(ctx, providerKey, accounts);
    return resultRedirect({ oauth: 'success', provider: providerKey, connected: String(ids.length) });
  } catch (err) {
    console.error(`[social] OAuth callback for ${providerKey} failed:`, err.code || '', err.message);
    await audit(ctx, 'social.oauth.failed', { resourceType: 'provider', resourceId: providerKey, metadata: { code: err.code, message: err.message } });
    return resultRedirect({ oauth: 'error', provider: providerKey, reason: err.code === 'ENCRYPTION_NOT_CONFIGURED' ? 'setup_required' : 'exchange_failed' });
  }
}

// ---------- Page selection (Meta) ----------

async function createPendingSelection(stateRow, providerKey, accounts) {
  const token = crypto.randomBytes(32).toString('base64url');
  await run(
    `INSERT INTO oauth_pending_selections (selection_hash, workspace_id, user_id, provider_key, accounts_ciphertext, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [secretBox.sha256(token), stateRow.workspace_id, stateRow.user_id, providerKey,
      secretBox.encrypt(JSON.stringify(accounts)), toDbDateTime(new Date(Date.now() + SELECTION_TTL_MS))]
  );
  await run('DELETE FROM oauth_pending_selections WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 1 DAY');
  return token;
}

/** Loads an unused, unexpired selection that belongs to this user in this workspace. */
async function loadSelection(ctx, providerKey, token) {
  if (!token || typeof token !== 'string' || token.length > 200) throw httpError(404, 'This Page selection expired. Connect again.', 'SELECTION_EXPIRED');
  const row = await get(
    `SELECT * FROM oauth_pending_selections
     WHERE selection_hash = ? AND provider_key = ? AND workspace_id = ? AND user_id = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()`,
    [secretBox.sha256(token), providerKey, ctx.auth.workspaceId, ctx.auth.userId]
  );
  if (!row) throw httpError(404, 'This Page selection expired or was already used. Connect again.', 'SELECTION_EXPIRED');
  return { row, accounts: JSON.parse(secretBox.decrypt(row.accounts_ciphertext)) };
}

/** What the browser may see: Page names and pictures only — never tokens. */
async function getPendingSelection(ctx, providerKey, token) {
  const { row, accounts } = await loadSelection(ctx, providerKey, token);
  const existing = await all(
    "SELECT external_account_id FROM social_accounts WHERE workspace_id = ? AND provider_key = ? AND status <> 'disconnected'",
    [ctx.auth.workspaceId, providerKey]
  );
  const connected = new Set(existing.map(r => String(r.external_account_id)));
  const pages = accounts.filter(a => !a.parentExternalId).map(a => {
    const ig = accounts.find(c => c.parentExternalId === a.external_account_id);
    return {
      externalId: a.external_account_id,
      accountType: a.account_type,
      name: a.display_name,
      avatarUrl: a.avatar_url || null,
      profileUrl: a.profile_url || null,
      alreadyConnected: connected.has(String(a.external_account_id)),
      instagram: ig ? { username: ig.username || ig.display_name } : null
    };
  });
  return { provider: providerKey, label: PROVIDERS[providerKey]?.label || providerKey, expiresAt: row.expires_at, pages };
}

/** Connects the chosen Page(s) (and, when Instagram is enabled, their linked Instagram accounts). Single-use. */
async function completeSelection(ctx, providerKey, token, externalIds) {
  const ids = [...new Set((Array.isArray(externalIds) ? externalIds : []).map(String))];
  if (!ids.length) throw httpError(400, 'Select at least one Page.', 'VALIDATION_ERROR');
  const { row, accounts } = await loadSelection(ctx, providerKey, token);
  const pageIds = new Set(accounts.filter(a => !a.parentExternalId).map(a => String(a.external_account_id)));
  const unknown = ids.filter(id => !pageIds.has(id));
  if (unknown.length) throw httpError(400, 'One of the selected Pages was not part of this login.', 'VALIDATION_ERROR');
  const chosen = accounts.filter(a => ids.includes(String(a.parentExternalId || a.external_account_id)));

  // Consume atomically so a double submit cannot connect twice.
  const res = await run('UPDATE oauth_pending_selections SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL', [row.id]);
  if (res.changes !== 1) throw httpError(409, 'This Page selection was already used.', 'SELECTION_EXPIRED');
  const saved = await accountService.upsertConnectedAccounts(ctx, providerKey, chosen);
  await audit(ctx, 'social.oauth.pages_selected', { resourceType: 'provider', resourceId: providerKey, metadata: { pages: ids.length, connected: saved.length } });
  return { connected: saved.length };
}

/** The user closed the picker: the pending Pages and their tokens are discarded. */
async function cancelSelection(ctx, providerKey, token) {
  const { row } = await loadSelection(ctx, providerKey, token);
  await run('UPDATE oauth_pending_selections SET used_at = UTC_TIMESTAMP(), accounts_ciphertext = ? WHERE id = ?', ['', row.id]);
  return { canceled: true };
}

module.exports = {
  redirectUri,
  getPendingSelection,
  completeSelection,
  cancelSelection,
  setupStatus,
  startAuthorization,
  consumeState,
  handleCallback
};
