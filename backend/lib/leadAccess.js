const { get, all } = require('../db/database');

/**
 * Who may see and work on which lead. Every lead API and every screen that lists or counts leads
 * goes through here; the database query itself is limited, so changing a lead id in a request
 * never reaches someone else's lead.
 *
 *   Lead admins   Workspace Owners and Admins (members.manage), the platform admin while viewing a
 *                 workspace, and the voice agent tool: every lead in the workspace, full control.
 *   Owner         the member who owns the lead (owner_user_id): view, edit, status, notes, delete.
 *   Manage        shared with 'manage': view, edit, status, notes. Not delete, owner or sharing.
 *   View          shared with 'view': read only.
 *   Anyone else   nothing; the lead is reported as not found.
 *
 * Unassigned leads (no owner) are visible to lead admins only. Members who are removed or
 * deactivated cannot sign in to the workspace, so their access ends at once; their shares are
 * removed when they leave (memberService), and leads they owned stay with the admins.
 * The member's role still applies on top (e.g. leads.manage is needed to edit at all).
 */
const LEVELS = { none: 0, view: 1, manage: 2, owner: 3, admin: 4 };

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

const authOf = ctx => ctx?.auth || ctx || {};

/** Owners/Admins of the workspace (and system callers): every lead. */
function isLeadAdmin(ctx) {
  const a = authOf(ctx);
  if (a.isToolCall || a.platformAccess || a.system) return true;
  return !!a.capabilities?.has?.('members.manage');
}

/**
 * SQL limiting a leads query (alias `l`) to the leads this person may see.
 * Returns { sql, params } to AND into the WHERE clause.
 */
function visibleSql(ctx, alias = 'l') {
  if (isLeadAdmin(ctx)) return { sql: '1 = 1', params: [] };
  const userId = Number(authOf(ctx).userId) || 0;
  return {
    sql: `(${alias}.owner_user_id = ? OR EXISTS (SELECT 1 FROM lead_user_access lua WHERE lua.lead_id = ${alias}.id AND lua.workspace_id = ${alias}.workspace_id AND lua.user_id = ?))`,
    params: [userId, userId]
  };
}

/** This person's access to one lead row: 'admin' | 'owner' | 'manage' | 'view' | 'none'. */
async function levelFor(ctx, lead) {
  if (!lead) return 'none';
  if (isLeadAdmin(ctx)) return 'admin';
  const userId = Number(authOf(ctx).userId) || 0;
  if (userId && Number(lead.owner_user_id) === userId) return 'owner';
  const g = userId ? await get('SELECT access_level FROM lead_user_access WHERE lead_id = ? AND workspace_id = ? AND user_id = ?', [lead.id, lead.workspace_id, userId]) : null;
  return g && (g.access_level === 'manage' || g.access_level === 'view') ? g.access_level : 'none';
}

const atLeast = (level, need) => LEVELS[level] >= LEVELS[need];

/**
 * Loads a lead of the session's workspace the person may use at `need` level ('view' | 'manage' |
 * 'owner' | 'admin'). Not visible at all: 404 (its existence is not revealed). Visible but not
 * enough: 403. Returns the row with `accessLevel`.
 */
async function requireLeadAccess(ctx, rawId, need = 'view', { select = 'SELECT * FROM leads l' } = {}) {
  const leadId = Number(rawId);
  if (!Number.isInteger(leadId) || leadId <= 0) throw httpError(400, 'Invalid lead id.', 'BAD_REQUEST');
  const row = await get(`${select} WHERE l.workspace_id = ? AND l.id = ?`, [authOf(ctx).workspaceId, leadId]);
  const level = await levelFor(ctx, row);
  if (!row || level === 'none') throw httpError(404, 'Lead not found.', 'NOT_FOUND');
  if (!atLeast(level, need)) {
    const what = { manage: 'edit this lead', owner: 'delete this lead', admin: 'change who owns or can see this lead' }[need] || 'do this';
    throw httpError(403, `You have ${level === 'view' ? 'view-only' : level} access: you cannot ${what}.`, 'LEAD_ACCESS_DENIED');
  }
  return Object.assign(row, { accessLevel: level });
}

/** The ids (of those given) this person may use at `need` level, in the session's workspace. */
async function allowedLeadIds(ctx, ids, need = 'view') {
  const list = [...new Set((ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!list.length) return [];
  const ph = list.map(() => '?').join(',');
  const ws = authOf(ctx).workspaceId;
  if (isLeadAdmin(ctx)) return (await all(`SELECT id FROM leads WHERE workspace_id = ? AND id IN (${ph})`, [ws, ...list])).map(r => r.id);
  const userId = Number(authOf(ctx).userId) || 0;
  const rows = await all(
    `SELECT l.id FROM leads l WHERE l.workspace_id = ? AND l.id IN (${ph}) AND (l.owner_user_id = ? OR EXISTS (
       SELECT 1 FROM lead_user_access a WHERE a.lead_id = l.id AND a.workspace_id = l.workspace_id AND a.user_id = ?${need === 'manage' ? " AND a.access_level = 'manage'" : ''}))`,
    [ws, ...list, userId, userId]);
  return rows.map(r => r.id);
}

/** Ownership recorded on a new lead: the person creating it owns it (system callers leave it unassigned). */
function newLeadOwnership(ctx, source) {
  const a = authOf(ctx);
  const userId = a.isToolCall || a.system ? null : Number(a.userId) || null;
  return { created_by_user_id: userId, owner_user_id: userId, lead_source: source };
}

module.exports = { LEVELS, isLeadAdmin, visibleSql, levelFor, requireLeadAccess, allowedLeadIds, newLeadOwnership, atLeast, httpError };
