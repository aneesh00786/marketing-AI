const { get, all, run } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { isPlatformAdmin, isPlatformAdminSql } = require('../../lib/platformAdmin');

/**
 * Who may use the global CRM. This sits on top of the normal sign-in and does not change it.
 *
 * CRM permissions are deliberately not in lib/permissions.js. Those belong to workspace roles, and
 * anyone who registers is the Owner of their own workspace, so a capability added there would open
 * this shared data to every account. Access here is a per-user grant, read on each request so that
 * removing it takes effect at once. The workspace the user is signed in to plays no part.
 *
 * One exception: the Owner of the platform's own workspace (LEGACY_WORKSPACE_ID, admin@tradesage.ai)
 * is the platform admin and always has full access, with no grant. It is that one workspace and
 * not an email address, because registering does not prove an address is yours; a new account
 * always gets a new workspace, so it can never become this Owner.
 *
 *   crm.view     read everything in the CRM
 *   crm.manage   create and edit contacts and companies, and their notes and tasks
 *   crm.deals    create, edit, move and delete deals
 *   crm.support  create and update support tickets
 */
const CRM_ROLES = {
  viewer: ['crm.view'],
  sales: ['crm.view', 'crm.manage', 'crm.deals'],
  support: ['crm.view', 'crm.manage', 'crm.support'],
  manager: ['crm.view', 'crm.manage', 'crm.deals', 'crm.support']
};

function httpError(status, message, code = 'BAD_REQUEST', details) {
  return Object.assign(new Error(message), { status, code, expose: true, details });
}

async function accessFor(userId) {
  if (!userId) return null;
  if (await isPlatformAdmin(userId)) {
    return { role: 'manager', capabilities: CRM_ROLES.manager, platformAdmin: true };
  }
  const row = await get('SELECT role FROM crm_user_access WHERE user_id = ?', [userId]);
  if (!row || !CRM_ROLES[row.role]) return null; // an unknown role grants nothing
  return { role: row.role, capabilities: CRM_ROLES[row.role] };
}

/** Audit entries belong to no workspace: workspace admins must not see CRM activity in their log. */
function crmAudit(ctx, action, opts) {
  return audit({ auth: { ...ctx.auth, workspaceId: null }, requestId: ctx.requestId, ip: ctx.ip }, action, opts);
}

/** Stops the request unless the user has a CRM grant. Sets req.crm. */
function requireCrmAccess() {
  return async function requireCrmAccessMiddleware(req, res, next) {
    try {
      req.crm = await accessFor(req.auth?.userId);
      if (!req.crm) return res.status(403).json({ success: false, error: 'You do not have access to the CRM.', code: 'CRM_ACCESS_REQUIRED' });
      next();
    } catch (err) {
      next(err);
    }
  };
}

function requireCrm(capability) {
  return function requireCrmMiddleware(req, res, next) {
    if (!req.crm?.capabilities.includes(capability)) {
      return res.status(403).json({ success: false, error: `Missing permission: ${capability}`, code: 'FORBIDDEN' });
    }
    next();
  };
}

function assertCrm(ctx, capability) {
  if (!ctx.crm?.capabilities.includes(capability)) throw httpError(403, `Missing permission: ${capability}`, 'FORBIDDEN');
}

const HAS_ACCESS_SQL = `u.status = 'Active' AND (EXISTS (SELECT 1 FROM crm_user_access a WHERE a.user_id = u.id) OR ${isPlatformAdminSql('u')})`;

/** People records can be assigned to: active users with CRM access. */
async function team() {
  const rows = await all(`SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.email) AS name FROM users u WHERE ${HAS_ACCESS_SQL} ORDER BY name`);
  return rows.map(r => ({ id: r.id, name: r.name }));
}

async function requireAssignable(userId) {
  if (userId === null || userId === undefined) return;
  const ok = await get(`SELECT 1 AS x FROM users u WHERE u.id = ? AND ${HAS_ACCESS_SQL}`, [userId]);
  if (!ok) throw httpError(400, 'Choose someone with CRM access.', 'INVALID_ASSIGNEE');
}

/** Used by scripts/crmAccess.js. */
async function grant(userId, role, grantedBy = null) {
  if (!CRM_ROLES[role]) throw new Error(`Unknown CRM role. Use one of: ${Object.keys(CRM_ROLES).join(', ')}.`);
  await run(
    `INSERT INTO crm_user_access (user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by), updated_at = UTC_TIMESTAMP()`,
    [userId, role, grantedBy]
  );
}

async function revoke(userId) {
  return (await run('DELETE FROM crm_user_access WHERE user_id = ?', [userId])).changes > 0;
}

module.exports = { CRM_ROLES, httpError, accessFor, crmAudit, requireCrmAccess, requireCrm, assertCrm, team, requireAssignable, grant, revoke };
