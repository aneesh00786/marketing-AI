const crypto = require('crypto');
const { run, get } = require('../../../db/database');
const secretBox = require('../../../lib/secretBox');
const { audit } = require('../../../lib/audit');
const { toDbDateTime } = require('../../../lib/time');
const { capabilitiesForRole } = require('../../../lib/permissions');
const zoho = require('./zohoClient');

/**
 * Zoho Campaigns connection of one workspace (OAuth, data center, encrypted refresh token) and
 * the authenticated calls the Marketech.ai campaign module makes to deliver through Zoho.
 * Campaigns are written, approved and managed in Marketech.ai (modules/mail/campaigns); recipient
 * lists and their consent stay in Zoho. No contacts are ever uploaded.
 */
const PROVIDER = 'zoho_campaigns';
const STATE_TTL_MS = 10 * 60 * 1000;
const ws = ctx => ctx.auth.workspaceId;

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.expose = true;
  return err;
}

function frontendUrl() {
  return (process.env.FRONTEND_URL || process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 8000}`).replace(/\/$/, '');
}

const resultRedirect = params => `${frontendUrl()}/?${new URLSearchParams({ view: 'mail', section: 'zoho', ...params })}`;

// ------------------------------------------------------------------ OAuth client (Settings or .env)

/**
 * The Zoho API client a workspace uses: the one its Owner/Admin entered in Mail Center → Settings,
 * otherwise the server's ZOHO_CAMPAIGNS_CLIENT_ID / _SECRET. null when neither exists. The secret
 * is decrypted only here, for the calls to Zoho's token endpoint.
 */
async function appConfig(workspaceId) {
  const row = await get('SELECT client_id, client_secret_ciphertext FROM mail_provider_apps WHERE workspace_id = ? AND provider = ?', [workspaceId, PROVIDER]);
  if (row) {
    const clientSecret = secretBox.decrypt(row.client_secret_ciphertext);
    return clientSecret ? { clientId: row.client_id, clientSecret, source: 'workspace' } : null;
  }
  const server = zoho.clientConfig();
  return server ? { ...server, source: 'server' } : null;
}

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{8,150}$/;
const CLIENT_SECRET_RE = /^[A-Za-z0-9._-]{8,200}$/;
/** Shows enough of a Client ID to recognise it, never the whole value. */
const maskId = id => (id.length <= 10 ? `${id.slice(0, 2)}…` : `${id.slice(0, 6)}…${id.slice(-4)}`);

/** What Settings shows about the OAuth client: never the secret. */
async function getApp(ctx) {
  const row = await get('SELECT client_id, updated_at, updated_by FROM mail_provider_apps WHERE workspace_id = ? AND provider = ?', [ws(ctx), PROVIDER]);
  const server = zoho.clientConfig();
  return {
    source: row ? 'workspace' : server ? 'server' : null,
    clientIdHint: row ? maskId(row.client_id) : null,
    hasSecret: !!row,
    updatedAt: row ? row.updated_at : null,
    serverFallback: !!server,
    encryptionReady: secretBox.isConfigured(),
    redirectUri: zoho.redirectUri(),
    homepageUrl: frontendUrl(),
    scopes: zoho.SCOPES
  };
}

/** Deletes the stored connection: its refresh token belongs to the previous OAuth client. */
async function dropConnection(ctx, reason) {
  const row = await connectionRow(ws(ctx));
  if (!row || row.status === 'disconnected') return false;
  await run("UPDATE mail_provider_connections SET status = 'disconnected', refresh_token_ciphertext = NULL, last_error = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?", [row.id, ws(ctx)]);
  tokenCache.delete(ws(ctx));
  await audit(ctx, 'mail.zoho.disconnected', { resourceType: 'mail_provider', resourceId: PROVIDER, metadata: { reason } });
  return true;
}

/**
 * Saves the workspace's Zoho Client ID and Secret (Owners/Admins). The secret may be left out to
 * keep the saved one. A different client disconnects Zoho, which must then be connected again.
 */
async function saveApp(ctx, input = {}) {
  if (!secretBox.isConfigured()) throw httpError(409, 'Credential encryption is not configured on the server (SOCIAL_TOKEN_ENCRYPTION_KEY), so the Zoho secret cannot be stored safely.', 'SETUP_REQUIRED');
  const clientId = String(input.clientId ?? '').trim();
  const secretIn = input.clientSecret === undefined || input.clientSecret === null ? '' : String(input.clientSecret).trim();
  if (!CLIENT_ID_RE.test(clientId)) throw httpError(400, 'Enter the Client ID exactly as shown in the Zoho API Console.', 'VALIDATION_ERROR');
  if (secretIn && !CLIENT_SECRET_RE.test(secretIn)) throw httpError(400, 'Enter the Client Secret exactly as shown in the Zoho API Console.', 'VALIDATION_ERROR');
  const existing = await get('SELECT client_id, client_secret_ciphertext FROM mail_provider_apps WHERE workspace_id = ? AND provider = ?', [ws(ctx), PROVIDER]);
  if (!existing && !secretIn) throw httpError(400, 'Enter the Client Secret too.', 'VALIDATION_ERROR');
  const oldSecret = existing ? secretBox.decrypt(existing.client_secret_ciphertext) : null;
  const clientSecret = secretIn || oldSecret;
  const changed = !existing || existing.client_id !== clientId || oldSecret !== clientSecret;
  if (!changed) return { saved: true, changed: false, disconnected: false, app: await getApp(ctx) };
  await run(
    `INSERT INTO mail_provider_apps (workspace_id, provider, client_id, client_secret_ciphertext, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE client_id = VALUES(client_id), client_secret_ciphertext = VALUES(client_secret_ciphertext), updated_by = VALUES(updated_by), updated_at = UTC_TIMESTAMP()`,
    [ws(ctx), PROVIDER, clientId, secretBox.encrypt(clientSecret), ctx.auth.userId || null]
  );
  const disconnected = await dropConnection(ctx, 'oauth_client_changed');
  await audit(ctx, existing ? 'mail.zoho.app_updated' : 'mail.zoho.app_saved', { resourceType: 'mail_provider', resourceId: PROVIDER, metadata: { clientIdHint: maskId(clientId) } });
  return { saved: true, changed: true, disconnected, app: await getApp(ctx) };
}

/** Removes the workspace's own client (the server's, if any, is used again); disconnects Zoho. */
async function removeApp(ctx) {
  const res = await run('DELETE FROM mail_provider_apps WHERE workspace_id = ? AND provider = ?', [ws(ctx), PROVIDER]);
  if (!res.changes) throw httpError(404, 'No Zoho credentials are saved for this workspace.', 'NOT_FOUND');
  const disconnected = await dropConnection(ctx, 'oauth_client_removed');
  await audit(ctx, 'mail.zoho.app_removed', { resourceType: 'mail_provider', resourceId: PROVIDER });
  return { removed: true, disconnected, app: await getApp(ctx) };
}

// ------------------------------------------------------------------ connection

async function connectionRow(workspaceId) {
  return get('SELECT * FROM mail_provider_connections WHERE workspace_id = ? AND provider = ?', [workspaceId, PROVIDER]);
}

/** Zoho returns granted scopes separated by spaces; older rows may use commas. */
const parseScopes = value => String(value || '').split(/[\s,]+/).filter(Boolean);

function missingScopes(row) {
  const granted = new Set(parseScopes(row?.scopes));
  return zoho.DELIVERY_SCOPES.filter(sc => !granted.has(sc));
}

const canSyncContacts = row => parseScopes(row?.scopes).includes(zoho.CONTACT_SYNC_SCOPE);
/** True when the connection may update contact fields (names) in Zoho. */
const canSyncNames = row => parseScopes(row?.scopes).includes(zoho.CONTACT_UPDATE_SCOPE);
const canDeleteLists = row => parseScopes(row?.scopes).includes(zoho.CONTACT_DELETE_SCOPE);

function presentConnection(row) {
  if (!row || row.status === 'disconnected') return { connected: false, status: row ? row.status : 'not_connected' };
  return {
    connected: row.status === 'connected',
    status: row.status,
    location: row.location,
    // Zoho Campaigns' web address for this account's region (links that open a campaign in Zoho).
    webUrl: zoho.resolveDataCenter(row.location, row.accounts_server)?.campaigns || null,
    scopes: parseScopes(row.scopes),
    // Connections made before campaign delivery was added lack some scopes: reconnect to grant them.
    missingScopes: missingScopes(row),
    canSyncContacts: canSyncContacts(row),
    canSyncNames: canSyncNames(row),
    canDeleteLists: canDeleteLists(row),
    connectedAt: row.connected_at,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error
  };
}

async function status(ctx) {
  const caps = ctx.auth.capabilities;
  const cfg = await appConfig(ws(ctx));
  return {
    // Ready to connect: an OAuth client (Settings or .env) and token encryption are available.
    serverConfigured: !!cfg && secretBox.isConfigured(),
    credentialsSource: cfg ? cfg.source : null,
    redirectUri: zoho.redirectUri(),
    connection: presentConnection(await connectionRow(ws(ctx))),
    canConfigure: caps.has('mail.configure'),
    canCompose: caps.has('mail.compose'),
    canSend: caps.has('mail.send'),
    // The Zoho API does not report plan or sending limits; they are not assumed here.
    limits: { known: false, note: 'Sending limits depend on your Zoho Campaigns plan and Zoho\'s policies; Marketech.ai cannot read them from the API.' }
  };
}

async function startConnect(ctx) {
  const cfg = await appConfig(ws(ctx));
  if (!cfg) throw httpError(409, 'Zoho Campaigns is not set up yet: enter the Zoho Client ID and Client Secret in Mail Center → Settings → Zoho Campaigns.', 'SETUP_REQUIRED');
  if (!secretBox.isConfigured()) throw httpError(409, 'Credential encryption is not configured on the server.', 'SETUP_REQUIRED');
  const state = crypto.randomBytes(32).toString('base64url');
  await run(
    `INSERT INTO oauth_states (state_hash, workspace_id, user_id, provider_key, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [secretBox.sha256(state), ws(ctx), ctx.auth.userId, PROVIDER, toDbDateTime(new Date(Date.now() + STATE_TTL_MS))]
  );
  await audit(ctx, 'mail.zoho.connect_started', { resourceType: 'mail_provider', resourceId: PROVIDER });
  return { authorizeUrl: zoho.authorizeUrl(state, cfg) };
}

/** Single use, unexpired, for this provider. */
async function consumeState(state) {
  if (!state || typeof state !== 'string' || state.length > 200) return null;
  const hash = secretBox.sha256(state);
  const res = await run(
    `UPDATE oauth_states SET used_at = UTC_TIMESTAMP()
     WHERE state_hash = ? AND provider_key = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()`,
    [hash, PROVIDER]
  );
  if (res.changes !== 1) return null;
  return get('SELECT * FROM oauth_states WHERE state_hash = ?', [hash]);
}

/** Zoho's redirect. Returns the frontend URL to send the browser to; never exposes tokens. */
async function handleCallback(query) {
  const stateRow = await consumeState(query.state);
  if (!stateRow) return resultRedirect({ zoho: 'error', reason: 'invalid_state' });
  const ctx = { auth: { workspaceId: stateRow.workspace_id, userId: stateRow.user_id } };

  // The person who started must still be an active member allowed to configure mail.
  const m = await get(
    "SELECT m.role, m.status, u.status AS user_status FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ?",
    [stateRow.workspace_id, stateRow.user_id]
  );
  if (!m || m.status !== 'Active' || (m.user_status && m.user_status !== 'Active') || !capabilitiesForRole(m.role).has('mail.configure')) {
    return resultRedirect({ zoho: 'error', reason: 'not_allowed' });
  }
  if (query.error) {
    await audit(ctx, 'mail.zoho.connect_denied', { resourceType: 'mail_provider', resourceId: PROVIDER, metadata: { error: String(query.error).slice(0, 60) } });
    return resultRedirect({ zoho: 'error', reason: 'denied' });
  }
  const dc = zoho.resolveDataCenter(query.location, query['accounts-server']);
  if (!dc) return resultRedirect({ zoho: 'error', reason: 'unknown_region' });
  if (!query.code || typeof query.code !== 'string' || query.code.length > 500) return resultRedirect({ zoho: 'error', reason: 'missing_code' });

  try {
    const cfg = await appConfig(ctx.auth.workspaceId);
    if (!cfg) throw Object.assign(new Error('No Zoho OAuth client.'), { code: 'ZOHO_NOT_CONFIGURED' });
    const tokens = await zoho.exchangeCode(dc, query.code, cfg);
    await run(
      `INSERT INTO mail_provider_connections (workspace_id, provider, location, accounts_server, api_host, refresh_token_ciphertext, scopes, status, last_error, connected_by, connected_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', NULL, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE location = VALUES(location), accounts_server = VALUES(accounts_server), api_host = VALUES(api_host),
         refresh_token_ciphertext = VALUES(refresh_token_ciphertext), scopes = VALUES(scopes), status = 'connected', last_error = NULL,
         connected_by = VALUES(connected_by), connected_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP()`,
      [ctx.auth.workspaceId, PROVIDER, dc.location, dc.accounts, dc.campaigns, secretBox.encrypt(tokens.refreshToken), String(tokens.scope).slice(0, 500), ctx.auth.userId]
    );
    tokenCache.delete(ctx.auth.workspaceId);
    await audit(ctx, 'mail.zoho.connected', { resourceType: 'mail_provider', resourceId: PROVIDER, metadata: { location: dc.location } });
    // One-time copy of the Zoho lists and contacts into Marketech.ai (runs in the worker).
    await require('../contacts/zohoImport').queueImport(ctx.auth.workspaceId, ctx.auth.userId).catch(() => null);
    return resultRedirect({ zoho: 'connected' });
  } catch (err) {
    await audit(ctx, 'mail.zoho.connect_failed', { resourceType: 'mail_provider', resourceId: PROVIDER, metadata: { code: err.code || 'ERROR' } });
    return resultRedirect({ zoho: 'error', reason: err.code === 'ZOHO_NO_REFRESH_TOKEN' ? 'no_refresh_token' : 'exchange_failed' });
  }
}

async function disconnect(ctx) {
  const row = await connectionRow(ws(ctx));
  if (!row || row.status === 'disconnected') throw httpError(409, 'Zoho Campaigns is not connected.', 'NOT_CONNECTED');
  await run(
    "UPDATE mail_provider_connections SET status = 'disconnected', refresh_token_ciphertext = NULL, last_error = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?",
    [row.id, ws(ctx)]
  );
  tokenCache.delete(ws(ctx));
  await audit(ctx, 'mail.zoho.disconnected', { resourceType: 'mail_provider', resourceId: PROVIDER });
  return { disconnected: true, note: 'The stored Zoho token was deleted. To revoke Marketech.ai\'s access in Zoho as well, remove it under Connected Apps in your Zoho account.' };
}

// Access tokens live 1 hour; Zoho allows few refreshes per 10 minutes, so they are reused.
const tokenCache = new Map();

async function session(workspaceId) {
  const row = await connectionRow(workspaceId);
  if (!row || row.status === 'disconnected' || !row.refresh_token_ciphertext) throw httpError(409, 'Connect Zoho Campaigns first (Mail Settings).', 'NOT_CONNECTED');
  if (row.status === 'reauth_required') throw httpError(409, 'The Zoho connection expired or was revoked. Reconnect Zoho Campaigns.', 'ZOHO_REAUTH_REQUIRED');
  const dc = zoho.resolveDataCenter(row.location, row.accounts_server);
  if (!dc) throw httpError(409, 'The saved Zoho region is not supported. Reconnect Zoho Campaigns.', 'ZOHO_REAUTH_REQUIRED');
  const cached = tokenCache.get(workspaceId);
  if (cached && cached.connectionId === row.id && cached.connectedAt === String(row.connected_at) && cached.expiresAt > Date.now() + 60000) {
    return { row, dc, accessToken: cached.accessToken };
  }
  try {
    const t = await zoho.refreshAccessToken(dc, secretBox.decrypt(row.refresh_token_ciphertext), await appConfig(workspaceId));
    tokenCache.set(workspaceId, { connectionId: row.id, connectedAt: String(row.connected_at), accessToken: t.accessToken, expiresAt: Date.now() + t.expiresIn * 1000 });
    return { row, dc, accessToken: t.accessToken };
  } catch (err) {
    if (err.reauth) await markReauth(workspaceId, row.id, err.message);
    throw err;
  }
}

async function markReauth(workspaceId, connectionId, message) {
  tokenCache.delete(workspaceId);
  await run("UPDATE mail_provider_connections SET status = 'reauth_required', last_error = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ? AND status = 'connected'",
    [String(message).slice(0, 500), connectionId, workspaceId]);
}

/** One read call; an expired token is refreshed once. */
async function readCall(workspaceId, endpoint, params) {
  let s = await session(workspaceId);
  try {
    return await zoho.call(s.dc, s.accessToken, endpoint, params);
  } catch (err) {
    if (err.code !== 'ZOHO_UNAUTHORIZED') throw err;
    tokenCache.delete(workspaceId);
    s = await session(workspaceId);
    try {
      return await zoho.call(s.dc, s.accessToken, endpoint, params);
    } catch (again) {
      if (again.reauth) await markReauth(workspaceId, s.row.id, again.message);
      throw again;
    }
  }
}

async function testConnection(ctx) {
  const data = await readCall(ws(ctx), 'getmailinglists', { sort: 'asc', fromindex: '1', range: '1' }).catch(err => {
    if (err.providerCode === '2203' || err.providerCode === '995') return {};
    throw err;
  });
  await run('UPDATE mail_provider_connections SET last_checked_at = UTC_TIMESTAMP(), last_error = NULL WHERE workspace_id = ? AND provider = ?', [ws(ctx), PROVIDER]);
  await audit(ctx, 'mail.zoho.tested', { resourceType: 'mail_provider', resourceId: PROVIDER });
  return { ok: true, listsVisible: Array.isArray(data.list_of_details) && data.list_of_details.length > 0, message: 'Zoho Campaigns answered. Mailing lists can be read with this connection.' };
}

/** One write call (delivery or contact sync). Never retried here after it may have reached Zoho. */
async function writeCall(workspaceId, endpoint, params) {
  const s = await session(workspaceId);
  try {
    return await zoho.call(s.dc, s.accessToken, endpoint, params);
  } catch (err) {
    if (err.reauth) await markReauth(workspaceId, s.row.id, err.message);
    throw err;
  }
}

/** Hands a Zoho campaign (by its numeric id) to Zoho's content review; Zoho sends it once approved. */
async function reviewAndLaunch(workspaceId, campaignId) {
  const s = await session(workspaceId);
  return zoho.reviewAndLaunch(s.dc, s.accessToken, campaignId);
}

/** Throws unless the workspace is connected with every scope campaign delivery needs. */
async function assertReady(workspaceId) {
  const row = await connectionRow(workspaceId);
  if (!row || row.status === 'disconnected') throw httpError(409, 'Connect Zoho Campaigns first (Email Campaigns > Zoho connection).', 'NOT_CONNECTED');
  if (row.status === 'reauth_required') throw httpError(409, 'The Zoho connection expired or was revoked. Reconnect Zoho Campaigns.', 'ZOHO_REAUTH_REQUIRED');
  const missing = missingScopes(row);
  if (missing.length) throw httpError(409, `Reconnect Zoho Campaigns to grant: ${missing.join(', ')}.`, 'ZOHO_SCOPES_MISSING');
  return row;
}

/** Throws unless the connection may add contacts. Connections made before this feature must reconnect. */
async function assertContactSync(workspaceId) {
  const row = await assertReady(workspaceId);
  if (!canSyncContacts(row)) throw httpError(409, 'Reconnect Zoho Campaigns to allow adding selected contacts to Zoho.', 'ZOHO_SCOPES_MISSING');
  return row;
}

module.exports = {
  reviewAndLaunch,
  PROVIDER,
  canSyncNames,
  canDeleteLists,
  canSyncContacts,
  connectionRow,
  appConfig,
  getApp,
  saveApp,
  removeApp,
  status,
  startConnect,
  handleCallback,
  disconnect,
  testConnection,
  readCall,
  writeCall,
  assertReady,
  assertContactSync,
  httpError,
  _tokenCache: tokenCache
};
