const { run, get, all } = require('../../db/database');
const secretBox = require('../../lib/secretBox');
const { audit } = require('../../lib/audit');
const { toDbDateTime, nowDb } = require('../../lib/time');
const { getAdapter, ProviderError } = require('./providers');
const { ACCOUNT_TYPES, evaluateAccount } = require('./capabilities');
const providerAppService = require('./providerAppService');

const PUBLIC_COLUMNS = `id, workspace_id, provider_key, account_type, external_account_id, display_name, username, avatar_url,
  profile_url, parent_account_id, scopes_json, status, status_detail, token_expires_at, last_success_at,
  last_checked_at, last_error, created_at, updated_at`;

/** Sample-data accounts (seeded by scripts/seedDemoWorkspace.js) never talk to real providers. */
function isDemoAccount(row) {
  return !!row && /^demo_/.test(String(row.external_account_id || ''));
}

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** Shapes an account row for the API. Credentials are never included. */
function present(row) {
  const type = ACCOUNT_TYPES[row.account_type] || {};
  let scopes = [];
  try { scopes = JSON.parse(row.scopes_json || '[]'); } catch (e) { scopes = []; }
  return {
    id: row.id,
    providerKey: row.provider_key,
    accountType: row.account_type,
    accountTypeLabel: type.label || row.account_type,
    platformKey: type.platformKey || null,
    externalAccountId: row.external_account_id,
    displayName: row.display_name,
    username: row.username,
    avatarUrl: row.avatar_url,
    profileUrl: row.profile_url,
    parentAccountId: row.parent_account_id,
    grantedScopes: scopes,
    status: row.status,
    statusDetail: row.status_detail,
    tokenExpiresAt: row.token_expires_at,
    lastSuccessAt: row.last_success_at,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    connectedAt: row.created_at,
    capabilities: evaluateAccount(row)
  };
}

async function listAccounts(workspaceId, { includeDisconnected = false } = {}) {
  const rows = await all(
    `SELECT ${PUBLIC_COLUMNS} FROM social_accounts WHERE workspace_id = ? ${includeDisconnected ? '' : "AND status <> 'disconnected'"} ORDER BY provider_key, display_name`,
    [workspaceId]
  );
  return rows.map(present);
}

async function getAccountRow(workspaceId, accountId) {
  return get('SELECT * FROM social_accounts WHERE workspace_id = ? AND id = ?', [workspaceId, accountId]);
}

async function requireAccountRow(workspaceId, accountId) {
  const row = await getAccountRow(workspaceId, accountId);
  if (!row) throw httpError(404, 'Social account not found.', 'NOT_FOUND');
  return row;
}

/**
 * Persists accounts returned by an OAuth exchange. Each account gets its own encrypted
 * credential row; reconnecting updates the existing account and credential in place.
 */
async function upsertConnectedAccounts(ctx, providerKey, accounts) {
  const workspaceId = ctx.auth.workspaceId;
  const saved = [];
  const idByExternal = new Map();

  // Parents (e.g. Facebook Pages) first so children (Instagram) can reference them.
  const ordered = [...accounts].sort((a, b) => (a.parentExternalId ? 1 : 0) - (b.parentExternalId ? 1 : 0));
  for (const acct of ordered) {
    const ciphertext = secretBox.encryptJson(acct.secret);
    const existing = await get(
      'SELECT id, credential_id FROM social_accounts WHERE workspace_id = ? AND provider_key = ? AND external_account_id = ?',
      [workspaceId, providerKey, acct.external_account_id]
    );
    const tokenExpires = acct.token_expires_at ? toDbDateTime(acct.token_expires_at) : null;
    const refreshExpires = acct.secret.refresh_expires_at ? toDbDateTime(acct.secret.refresh_expires_at) : null;

    let credentialId = existing?.credential_id || null;
    if (credentialId) {
      await run(
        'UPDATE provider_credentials SET secret_ciphertext = ?, access_expires_at = ?, refresh_expires_at = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?',
        [ciphertext, tokenExpires, refreshExpires, workspaceId, credentialId]
      );
    } else {
      const cred = await run(
        'INSERT INTO provider_credentials (workspace_id, provider_key, secret_ciphertext, access_expires_at, refresh_expires_at, created_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())',
        [workspaceId, providerKey, ciphertext, tokenExpires, refreshExpires]
      );
      credentialId = cred.lastID;
    }

    const parentId = acct.parentExternalId ? (idByExternal.get(acct.parentExternalId) || null) : null;
    const values = [
      acct.account_type, acct.display_name || null, acct.username || null, acct.avatar_url || null, acct.profile_url || null,
      parentId, credentialId, JSON.stringify(acct.scopes || []), tokenExpires, JSON.stringify(acct.metadata || {}),
      acct.app_source || 'platform'
    ];
    let accountId;
    if (existing) {
      await run(
        `UPDATE social_accounts SET account_type = ?, display_name = ?, username = ?, avatar_url = ?, profile_url = ?,
           parent_account_id = ?, credential_id = ?, scopes_json = ?, token_expires_at = ?, metadata_json = ?, app_source = ?,
           status = 'connected', status_detail = NULL, last_error = NULL, last_success_at = UTC_TIMESTAMP(),
           last_checked_at = UTC_TIMESTAMP(), connected_by = ?, updated_at = UTC_TIMESTAMP()
         WHERE workspace_id = ? AND id = ?`,
        [...values, ctx.auth.userId, workspaceId, existing.id]
      );
      accountId = existing.id;
    } else {
      const ins = await run(
        `INSERT INTO social_accounts (account_type, display_name, username, avatar_url, profile_url, parent_account_id,
           credential_id, scopes_json, token_expires_at, metadata_json, app_source, workspace_id, provider_key, external_account_id,
           status, last_success_at, last_checked_at, connected_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?, UTC_TIMESTAMP())`,
        [...values, workspaceId, providerKey, acct.external_account_id, ctx.auth.userId]
      );
      accountId = ins.lastID;
    }
    idByExternal.set(acct.external_account_id, accountId);
    saved.push(accountId);
    await audit(ctx, 'social.account.connected', {
      resourceType: 'social_account',
      resourceId: accountId,
      metadata: { provider: providerKey, accountType: acct.account_type, displayName: acct.display_name, scopes: acct.scopes }
    });
  }
  return saved;
}

async function recordAccountSuccess(account) {
  await run(
    "UPDATE social_accounts SET last_success_at = UTC_TIMESTAMP(), last_checked_at = UTC_TIMESTAMP(), last_error = NULL, status = IF(status = 'disconnected', status, 'connected'), status_detail = NULL WHERE workspace_id = ? AND id = ?",
    [account.workspace_id, account.id]
  );
}

/** Updates connection health from a provider failure. */
async function recordAccountFailure(account, err) {
  let status = account.status;
  if (err?.code === 'AUTH_EXPIRED') status = 'expired';
  else if (err?.code === 'PERMISSION_DENIED') status = 'permission_error';
  const detail = err?.code === 'AUTH_EXPIRED'
    ? 'Access expired or was revoked. Reconnect this account.'
    : (err?.code === 'PERMISSION_DENIED' ? 'A required permission is missing or was removed. Reconnect and grant all requested permissions.' : null);
  await run(
    'UPDATE social_accounts SET status = ?, status_detail = COALESCE(?, status_detail), last_error = ?, last_checked_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?',
    [status, detail, String(err?.message || err).slice(0, 1000), account.workspace_id, account.id]
  );
}

/**
 * Returns a usable decrypted secret for an account, refreshing it first when it is
 * about to expire. Throws ProviderError(AUTH_EXPIRED) when the account must be reconnected.
 */
async function getUsableSecret(account) {
  if (account.status === 'disconnected' || !account.credential_id) {
    throw new ProviderError({ message: 'This account is disconnected.', code: 'AUTH_EXPIRED' });
  }
  const cred = await get('SELECT * FROM provider_credentials WHERE workspace_id = ? AND id = ?', [account.workspace_id, account.credential_id]);
  if (!cred) throw new ProviderError({ message: 'Credentials are missing; reconnect this account.', code: 'AUTH_EXPIRED' });
  let secret = secretBox.decryptJson(cred.secret_ciphertext);

  const expiresAt = secret.access_expires_at ? new Date(secret.access_expires_at) : null;
  const marginMs = account.provider_key === 'linkedin' ? 24 * 3600 * 1000 : 2 * 60 * 1000;
  if (expiresAt && expiresAt.getTime() - Date.now() < marginMs) {
    const adapter = getAdapter(account.provider_key);
    try {
      const app = await providerAppService.resolveApp(account.workspace_id, account.provider_key);
      secret = await adapter.refresh(secret, app || undefined);
    } catch (err) {
      if (expiresAt.getTime() <= Date.now()) {
        const expired = new ProviderError({ message: 'Access token expired and could not be refreshed. Reconnect this account.', code: 'AUTH_EXPIRED' });
        await recordAccountFailure(account, expired);
        throw expired;
      }
      // Not yet expired: keep using the current token and surface a warning.
      await run(
        'UPDATE social_accounts SET status_detail = ? WHERE workspace_id = ? AND id = ?',
        ['Token expires soon and cannot be refreshed automatically. Reconnect before it expires.', account.workspace_id, account.id]
      );
      return secret;
    }
    const newExpiry = secret.access_expires_at ? toDbDateTime(secret.access_expires_at) : null;
    await run(
      'UPDATE provider_credentials SET secret_ciphertext = ?, access_expires_at = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?',
      [secretBox.encryptJson(secret), newExpiry, account.workspace_id, cred.id]
    );
    await run('UPDATE social_accounts SET token_expires_at = ? WHERE workspace_id = ? AND credential_id = ?', [newExpiry, account.workspace_id, cred.id]);
  }
  return secret;
}

async function checkAccountHealth(ctx, accountId) {
  const account = await requireAccountRow(ctx.auth.workspaceId, accountId);
  if (isDemoAccount(account)) return { ok: true, detail: 'Demo account (sample data) — not connected to a real provider.', account: present(account) };
  const adapter = getAdapter(account.provider_key);
  try {
    const secret = await getUsableSecret(account);
    const result = await adapter.checkHealth(account, secret);
    await recordAccountSuccess(account);
    return { ok: true, detail: result.detail, account: present(await getAccountRow(ctx.auth.workspaceId, accountId)) };
  } catch (err) {
    await recordAccountFailure(account, err);
    return { ok: false, detail: err.message, code: err.code || null, account: present(await getAccountRow(ctx.auth.workspaceId, accountId)) };
  }
}

/**
 * Disconnects an account: cancels its pending publications, deletes stored credentials
 * and revokes the provider grant when no other connected account still relies on it.
 */
async function disconnectAccount(ctx, accountId) {
  const workspaceId = ctx.auth.workspaceId;
  const account = await requireAccountRow(workspaceId, accountId);
  if (account.status === 'disconnected') return { revoked: false, alreadyDisconnected: true };

  let revoked = false;
  let revokeError = null;
  let secret = null;
  if (account.credential_id) {
    const cred = await get('SELECT secret_ciphertext FROM provider_credentials WHERE workspace_id = ? AND id = ?', [workspaceId, account.credential_id]);
    try { secret = cred ? secretBox.decryptJson(cred.secret_ciphertext) : null; } catch (e) { secret = null; }
  }

  // Meta grants are per Facebook user and shared by every Page/IG account from that login.
  let sharedGrantInUse = false;
  if (account.provider_key === 'meta' && secret?.meta_user_id) {
    const others = await all(
      "SELECT id, metadata_json FROM social_accounts WHERE workspace_id = ? AND provider_key = 'meta' AND status <> 'disconnected' AND id <> ?",
      [workspaceId, account.id]
    );
    sharedGrantInUse = others.some(o => {
      try { return JSON.parse(o.metadata_json || '{}').meta_user_id === secret.meta_user_id; } catch (e) { return false; }
    });
  }

  if (secret && !sharedGrantInUse) {
    try {
      const app = await providerAppService.resolveApp(workspaceId, account.provider_key);
      await getAdapter(account.provider_key).revoke(account, secret, app || undefined);
      revoked = true;
    } catch (err) {
      revokeError = err.message;
    }
  }

  await run(
    "UPDATE publishing_jobs SET status = 'cancelled', last_error = 'Account disconnected', updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND social_account_id = ? AND status = 'queued'",
    [workspaceId, account.id]
  );
  await run(
    `UPDATE content_items SET status = 'approved', scheduled_at = NULL, last_error = 'Scheduled account was disconnected; reschedule to publish.', updated_at = UTC_TIMESTAMP()
     WHERE workspace_id = ? AND social_account_id = ? AND status = 'scheduled'`,
    [workspaceId, account.id]
  );
  const credentialId = account.credential_id;
  await run(
    "UPDATE social_accounts SET status = 'disconnected', status_detail = NULL, credential_id = NULL, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?",
    [workspaceId, account.id]
  );
  if (credentialId) {
    const stillUsed = await get('SELECT id FROM social_accounts WHERE workspace_id = ? AND credential_id = ? LIMIT 1', [workspaceId, credentialId]);
    if (!stillUsed) await run('DELETE FROM provider_credentials WHERE workspace_id = ? AND id = ?', [workspaceId, credentialId]);
  }

  await audit(ctx, 'social.account.disconnected', {
    resourceType: 'social_account',
    resourceId: account.id,
    metadata: { provider: account.provider_key, revoked, revokeError, sharedGrantInUse }
  });
  return { revoked, revokeError, sharedGrantInUse };
}

module.exports = {
  isDemoAccount,
  present,
  listAccounts,
  getAccountRow,
  requireAccountRow,
  upsertConnectedAccounts,
  recordAccountSuccess,
  recordAccountFailure,
  getUsableSecret,
  checkAccountHealth,
  disconnectAccount,
  httpError,
  nowDb
};
