const { run, get, all } = require('../../db/database');
const secretBox = require('../../lib/secretBox');
const { audit } = require('../../lib/audit');
const { providerRequest } = require('./providers/http');
const { PROVIDERS } = require('./capabilities');

/**
 * Resolves the OAuth app credentials a workspace uses for a provider:
 *   1. the workspace's own app (configured in Social Settings → Connected Accounts → Set up), else
 *   2. the platform default app from environment variables (optional, for a shared SaaS app).
 * Secrets are decrypted only here, for server-side use.
 */
const ENV_KEYS = {
  meta: ['META_APP_ID', 'META_APP_SECRET'],
  linkedin: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  youtube: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
};

const LABELS = {
  meta: { id: 'App ID', secret: 'App Secret' },
  linkedin: { id: 'Client ID', secret: 'Client Secret' },
  youtube: { id: 'OAuth Client ID', secret: 'OAuth Client Secret' }
};

function httpError(status, message, code = 'BAD_REQUEST') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function platformApp(providerKey) {
  const [idKey, secretKey] = ENV_KEYS[providerKey] || [];
  if (!idKey || !process.env[idKey] || !process.env[secretKey]) return null;
  return { clientId: process.env[idKey], clientSecret: process.env[secretKey], source: 'platform' };
}

async function workspaceApp(workspaceId, providerKey) {
  const row = await get('SELECT * FROM provider_apps WHERE workspace_id = ? AND provider_key = ?', [workspaceId, providerKey]);
  if (!row) return null;
  return { clientId: row.client_id, clientSecret: secretBox.decrypt(row.client_secret_ciphertext), source: 'workspace', row };
}

/** @returns {Promise<{clientId:string, clientSecret:string, source:'workspace'|'platform'} | null>} */
async function resolveApp(workspaceId, providerKey) {
  return (await workspaceApp(workspaceId, providerKey)) || platformApp(providerKey);
}

/** Every Meta app secret that may sign webhooks (all workspace apps + the platform app). */
async function allMetaSecrets() {
  const rows = await all("SELECT client_secret_ciphertext FROM provider_apps WHERE provider_key = 'meta'");
  const secrets = rows.map(r => { try { return secretBox.decrypt(r.client_secret_ciphertext); } catch (e) { return null; } }).filter(Boolean);
  if (process.env.META_APP_SECRET) secrets.push(process.env.META_APP_SECRET);
  return [...new Set(secrets)];
}

/** Checks the credentials with the provider where an app-only check exists. */
async function verifyCredentials(providerKey, clientId, clientSecret) {
  if (providerKey === 'meta') {
    const version = process.env.META_GRAPH_VERSION || 'v23.0';
    try {
      await providerRequest(`https://graph.facebook.com/${version}/oauth/access_token?${new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' })}`, { label: 'Meta' });
      return { verified: true, note: 'Meta accepted the App ID and App Secret.' };
    } catch (err) {
      if (err.code === 'NETWORK' || err.code === 'TIMEOUT') return { verified: false, note: 'Could not reach Meta to verify; saved without verification.' };
      throw httpError(400, 'Meta rejected these credentials. Check the App ID and App Secret (App settings → Basic).', 'INVALID_CREDENTIALS');
    }
  }
  // LinkedIn and Google have no app-only check for standard apps; they are validated on first Connect.
  return { verified: false, note: 'Saved. These credentials are checked when you click Connect.' };
}

/** Public setup status for one provider in a workspace. Never includes the secret. */
async function getStatus(workspaceId, providerKey) {
  const ws = await get('SELECT client_id, verified_at, verification_note, updated_at FROM provider_apps WHERE workspace_id = ? AND provider_key = ?', [workspaceId, providerKey]);
  const platform = platformApp(providerKey);
  return {
    source: ws ? 'workspace' : (platform ? 'platform' : null),
    workspaceApp: ws ? {
      clientId: ws.client_id,
      verifiedAt: ws.verified_at,
      verificationNote: ws.verification_note,
      updatedAt: ws.updated_at
    } : null,
    platformAppAvailable: !!platform,
    labels: LABELS[providerKey]
  };
}

async function saveApp(ctx, providerKey, { clientId, clientSecret }) {
  if (!PROVIDERS[providerKey]) throw httpError(404, 'Unknown provider.', 'NOT_FOUND');
  if (!secretBox.isConfigured()) throw httpError(409, 'Credential encryption is not configured on the server (SOCIAL_TOKEN_ENCRYPTION_KEY).', 'SETUP_REQUIRED');
  const id = String(clientId || '').trim();
  const existing = await get('SELECT id, client_id, client_secret_ciphertext FROM provider_apps WHERE workspace_id = ? AND provider_key = ?', [ctx.auth.workspaceId, providerKey]);
  // Allow updating only the ID while keeping the stored secret.
  let secret = String(clientSecret || '').trim();
  if (!secret && existing && existing.client_id === id) secret = secretBox.decrypt(existing.client_secret_ciphertext);
  if (!id || !secret) throw httpError(400, `${LABELS[providerKey].id} and ${LABELS[providerKey].secret} are required.`);
  if (providerKey === 'meta' && !/^\d{5,25}$/.test(id)) throw httpError(400, 'A Meta App ID is a number (App settings → Basic).');
  if (id.length > 255 || secret.length > 500) throw httpError(400, 'Credential value is too long.');

  const check = await verifyCredentials(providerKey, id, secret);
  await run(
    `INSERT INTO provider_apps (workspace_id, provider_key, client_id, client_secret_ciphertext, verified_at, verification_note, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE client_id = VALUES(client_id), client_secret_ciphertext = VALUES(client_secret_ciphertext),
       verified_at = VALUES(verified_at), verification_note = VALUES(verification_note), updated_at = UTC_TIMESTAMP()`,
    [ctx.auth.workspaceId, providerKey, id, secretBox.encrypt(secret), check.verified ? new Date() : null, check.note, ctx.auth.userId]
  );
  await audit(ctx, 'social.provider_app.saved', { resourceType: 'provider', resourceId: providerKey, metadata: { clientId: id, verified: check.verified } });
  return { ...(await getStatus(ctx.auth.workspaceId, providerKey)), verification: check };
}

async function removeApp(ctx, providerKey) {
  const res = await run('DELETE FROM provider_apps WHERE workspace_id = ? AND provider_key = ?', [ctx.auth.workspaceId, providerKey]);
  const affected = await get(
    "SELECT COUNT(*) AS c FROM social_accounts WHERE workspace_id = ? AND provider_key = ? AND status <> 'disconnected' AND app_source = 'workspace'",
    [ctx.auth.workspaceId, providerKey]
  );
  await audit(ctx, 'social.provider_app.removed', { resourceType: 'provider', resourceId: providerKey });
  return { removed: res.changes > 0, accountsUsingIt: Number(affected?.c || 0) };
}

module.exports = { resolveApp, platformApp, allMetaSecrets, getStatus, saveApp, removeApp, verifyCredentials, LABELS };
