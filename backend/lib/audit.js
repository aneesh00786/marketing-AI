const { run } = require('../db/database');

const SECRET_KEYS = /token|secret|password|authorization|code_verifier|access|refresh|cookie/i;

/** Recursively removes secret-looking fields before anything is persisted or logged. */
function redact(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

/**
 * Records an auditable action. ctx is an Express request (with req.auth) or
 * { workspaceId, userId, actorType } for worker-originated actions.
 * Audit failures are logged but never break the business operation.
 */
async function audit(ctx, action, { resourceType = null, resourceId = null, metadata = null } = {}) {
  const auth = ctx?.auth || ctx || {};
  try {
    await run(
      `INSERT INTO audit_logs (workspace_id, actor_user_id, actor_type, action, resource_type, resource_id, request_id, ip_address, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        auth.workspaceId ?? null,
        auth.userId ?? null,
        auth.actorType || (auth.isToolCall ? 'tool' : 'user'),
        action,
        resourceType,
        resourceId === null ? null : String(resourceId),
        ctx?.requestId || null,
        ctx?.ip || null,
        metadata ? JSON.stringify(redact(metadata)) : null
      ]
    );
  } catch (err) {
    console.error(`[audit] failed to record ${action}:`, err.message);
  }
}

module.exports = { audit, redact };
