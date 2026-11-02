const { z } = require('zod');
const { run, get, all } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { ROLES } = require('../../lib/permissions');
const { LEGACY_WORKSPACE_ID } = require('../../middleware/auth');
const authService = require('../../services/authService');

/**
 * Platform admin: every workspace, user and activity across the platform. This deliberately crosses
 * workspace boundaries, so only the platform admin can reach it (routes.js) and each change or
 * workspace view is audited, in that workspace's own log too. These screens show who did what;
 * "Open workspace" gives the admin full rights inside one (see middleware/auth.js).
 */
const OWNER = 'Workspace Owner';
const MAX_LIST = 500;
const ACTIVITY_PAGE = 50;

const id = z.number().int().positive();
const createSchema = z.object({
  name: z.string().trim().min(2, 'Enter a workspace name (at least 2 characters).').max(100),
  industry: z.string().trim().max(100).optional().nullable(),
  ownerUserId: id
}).strict();
const assignSchema = z.object({ userId: id, role: z.enum(ROLES) }).strict();

function httpError(status, message, code = 'BAD_REQUEST') {
  return Object.assign(new Error(message), { status, code, expose: true });
}

const NAME_SQL = alias => `COALESCE(NULLIF(${alias}.display_name, ''), ${alias}.email)`;
const likeOf = q => `%${String(q).slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`;
const auditIn = (ctx, workspaceId, action, opts) => audit({ auth: { ...ctx.auth, workspaceId }, requestId: ctx.requestId, ip: ctx.ip }, action, opts);

function requireId(raw, label) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, `Invalid ${label} id.`, 'VALIDATION_ERROR');
  return n;
}

const WORKSPACE_SELECT = `SELECT w.id, w.name, w.plan, w.status, w.created_at,
    (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id AND m.status = 'Active') AS member_count,
    (SELECT GROUP_CONCAT(${NAME_SQL('u')} ORDER BY m.id SEPARATOR ', ') FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = w.id AND m.status = 'Active' AND m.role = '${OWNER}') AS owners,
    (SELECT COUNT(*) FROM leads l WHERE l.workspace_id = w.id) AS lead_count,
    (SELECT COUNT(*) FROM mail_campaigns c WHERE c.workspace_id = w.id) AS campaign_count,
    (SELECT MAX(a.created_at) FROM audit_logs a WHERE a.workspace_id = w.id) AS last_activity
  FROM workspaces w`;

function presentWorkspace(r) {
  return {
    id: r.id,
    name: r.name,
    plan: r.plan,
    status: r.status,
    createdAt: r.created_at,
    memberCount: Number(r.member_count),
    owners: r.owners || null,
    leadCount: Number(r.lead_count),
    campaignCount: Number(r.campaign_count),
    lastActivity: r.last_activity,
    protected: r.id === LEGACY_WORKSPACE_ID
  };
}

async function listWorkspaces(query = {}) {
  const where = query.q ? 'WHERE w.name LIKE ?' : '';
  const rows = await all(`${WORKSPACE_SELECT} ${where} ORDER BY w.id DESC LIMIT ${MAX_LIST + 1}`, query.q ? [likeOf(query.q)] : []);
  return { workspaces: rows.slice(0, MAX_LIST).map(presentWorkspace), truncated: rows.length > MAX_LIST, roles: ROLES };
}

async function requireWorkspace(rawId) {
  const row = await get(`${WORKSPACE_SELECT} WHERE w.id = ?`, [requireId(rawId, 'workspace')]);
  if (!row) throw httpError(404, 'Workspace not found.', 'NOT_FOUND');
  return row;
}

async function members(workspaceId) {
  const rows = await all(
    `SELECT m.user_id, m.role, m.created_at, u.email, ${NAME_SQL('u')} AS name, u.status AS user_status FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? AND m.status = 'Active' ORDER BY (m.role = '${OWNER}') DESC, m.id`,
    [workspaceId]
  );
  return rows.map(r => ({ userId: r.user_id, email: r.email, name: r.name, role: r.role, joinedAt: r.created_at, userStatus: r.user_status }));
}

async function getWorkspace(ctx, rawId) {
  const row = await requireWorkspace(rawId);
  await auditIn(ctx, row.id, 'platform.workspace_viewed', { resourceType: 'workspace', resourceId: row.id });
  return { workspace: presentWorkspace(row), members: await members(row.id), roles: ROLES };
}

async function requireActiveUser(userId) {
  const user = await get('SELECT id, email, status FROM users WHERE id = ?', [userId]);
  if (!user) throw httpError(400, 'Choose an existing user.', 'INVALID_USER');
  if (user.status && user.status !== 'Active') throw httpError(400, 'This user account is not active.', 'INVALID_USER');
  return user;
}

/** The new workspace belongs to the chosen user, who becomes its Owner. */
async function createWorkspace(ctx, input) {
  const v = createSchema.parse(input || {});
  await requireActiveUser(v.ownerUserId);
  const workspace = await authService.createWorkspaceForOwner(v.ownerUserId, v);
  await auditIn(ctx, workspace.id, 'platform.workspace_created', { resourceType: 'workspace', resourceId: workspace.id, metadata: { ownerUserId: v.ownerUserId } });
  return getWorkspace(ctx, workspace.id);
}

/** Full access inside a workspace, without joining it. Recorded in that workspace's own log. */
async function openWorkspace(ctx, rawId) {
  const row = await get('SELECT id, name, slug, plan FROM workspaces WHERE id = ?', [requireId(rawId, 'workspace')]);
  if (!row) throw httpError(404, 'Workspace not found.', 'NOT_FOUND');
  const user = await get('SELECT * FROM users WHERE id = ?', [ctx.auth.userId]);
  await auditIn(ctx, row.id, 'platform.workspace_entered', { resourceType: 'workspace', resourceId: row.id });
  return authService.platformAccessSession(user, row);
}

const activeMember = (workspaceId, userId) => get("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'Active'", [workspaceId, userId]);

async function assertKeepsAnOwner(workspaceId, userId) {
  const r = await get(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND status = 'Active' AND role = '${OWNER}' AND user_id <> ?`, [workspaceId, userId]);
  if (Number(r.n) < 1) throw httpError(409, 'A workspace must keep at least one Owner.', 'LAST_OWNER');
}

/** Owners of the platform workspace are platform admins: that is never changed from a screen. */
function assertNotAdminChange(workspaceId, currentRole, newRole) {
  if (workspaceId === LEGACY_WORKSPACE_ID && (newRole === OWNER || currentRole === OWNER)) {
    throw httpError(403, 'The Owner of the platform workspace is the platform admin, so it cannot be changed here.', 'PROTECTED_WORKSPACE');
  }
}

/** Grants belong to a member's role, so a change of role starts from none. */
const dropGrants = (workspaceId, userId) => run('DELETE FROM workspace_member_capability_grants WHERE workspace_id = ? AND user_id = ?', [workspaceId, userId]);

/** Adds a user to a workspace, brings a former member back, or changes a member's role. */
async function assignUser(ctx, rawId, input) {
  const row = await requireWorkspace(rawId);
  const v = assignSchema.parse(input || {});
  await requireActiveUser(v.userId);
  const current = await activeMember(row.id, v.userId);
  assertNotAdminChange(row.id, current?.role, v.role);
  if (current?.role === OWNER && v.role !== OWNER) await assertKeepsAnOwner(row.id, v.userId);
  if (current?.role !== v.role) {
    await run(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'Active', UTC_TIMESTAMP())
       ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'Active'`,
      [row.id, v.userId, v.role]
    );
    await dropGrants(row.id, v.userId);
    await auditIn(ctx, row.id, 'platform.member_assigned', { resourceType: 'workspace_member', resourceId: v.userId, metadata: { from: current?.role || null, to: v.role } });
  }
  return { members: await members(row.id) };
}

async function removeUser(ctx, rawId, rawUserId) {
  const row = await requireWorkspace(rawId);
  const userId = requireId(rawUserId, 'user');
  const current = await activeMember(row.id, userId);
  if (!current) throw httpError(404, 'This user is not a member of the workspace.', 'NOT_FOUND');
  assertNotAdminChange(row.id, current.role);
  if (current.role === OWNER) await assertKeepsAnOwner(row.id, userId);
  await run("UPDATE workspace_members SET status = 'Removed' WHERE workspace_id = ? AND user_id = ? AND status = 'Active'", [row.id, userId]);
  await dropGrants(row.id, userId);
  await auditIn(ctx, row.id, 'platform.member_removed', { resourceType: 'workspace_member', resourceId: userId, metadata: { role: current.role } });
  return { members: await members(row.id) };
}

async function listUsers(query = {}) {
  const where = query.q ? 'WHERE u.email LIKE ? OR u.display_name LIKE ?' : '';
  const rows = await all(
    `SELECT u.id, u.email, ${NAME_SQL('u')} AS name, u.status, u.created_at,
       (SELECT MAX(a.created_at) FROM audit_logs a WHERE a.actor_user_id = u.id) AS last_activity
     FROM users u ${where} ORDER BY u.id DESC LIMIT ${MAX_LIST + 1}`,
    query.q ? [likeOf(query.q), likeOf(query.q)] : []
  );
  const shown = rows.slice(0, MAX_LIST);
  const ids = shown.map(r => r.id);
  const memberships = ids.length ? await all(
    `SELECT m.user_id, m.role, w.id, w.name FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.status = 'Active' AND m.user_id IN (${ids.map(() => '?').join(',')}) ORDER BY m.id`, ids
  ) : [];
  return {
    users: shown.map(r => ({
      id: r.id, email: r.email, name: r.name, status: r.status, createdAt: r.created_at, lastActivity: r.last_activity,
      workspaces: memberships.filter(m => m.user_id === r.id).map(m => ({ id: m.id, name: m.name, role: m.role }))
    })),
    truncated: rows.length > MAX_LIST
  };
}

/** The audit log across the platform, newest first. Details stored with an entry are not returned. */
async function listActivity(query = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (query.workspaceId) { where.push('a.workspace_id = ?'); params.push(requireId(query.workspaceId, 'workspace')); }
  if (query.userId) { where.push('a.actor_user_id = ?'); params.push(requireId(query.userId, 'user')); }
  for (const [key, sql] of [['from', 'a.created_at >= ?'], ['to', 'a.created_at < DATE_ADD(?, INTERVAL 1 DAY)']]) {
    if (!query[key]) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(query[key]))) throw httpError(400, 'Use a date like 2026-12-31.', 'VALIDATION_ERROR');
    where.push(sql);
    params.push(query[key]);
  }
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const rows = await all(
    `SELECT a.id, a.action, a.actor_type, a.resource_type, a.resource_id, a.created_at, a.workspace_id, a.actor_user_id, w.name AS workspace_name, ${NAME_SQL('u')} AS user_name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id LEFT JOIN workspaces w ON w.id = a.workspace_id
     WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ${ACTIVITY_PAGE + 1} OFFSET ${(page - 1) * ACTIVITY_PAGE}`,
    params
  );
  return {
    activity: rows.slice(0, ACTIVITY_PAGE).map(r => ({
      id: r.id, action: r.action, actorType: r.actor_type, resourceType: r.resource_type, resourceId: r.resource_id, createdAt: r.created_at,
      workspaceId: r.workspace_id, workspaceName: r.workspace_name || null, userId: r.actor_user_id, userName: r.user_name || null
    })),
    page,
    hasMore: rows.length > ACTIVITY_PAGE
  };
}

module.exports = { listWorkspaces, getWorkspace, openWorkspace, createWorkspace, assignUser, removeUser, listUsers, listActivity };
