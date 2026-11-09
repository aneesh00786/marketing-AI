const { z } = require('zod');
const { get, all, run, withTransaction } = require('../../db/database');
const { audit } = require('../../lib/audit');
const leadAccess = require('../../lib/leadAccess');

/**
 * Lead ownership and sharing (Leads → a lead → Ownership & access). Only workspace Owners/Admins
 * change who owns a lead or who it is shared with; everyone with access sees who created it, who
 * owns it and their own access level. Every change is audited with the previous and new value.
 */
const ws = ctx => ctx.auth.workspaceId;
const { httpError } = leadAccess;
const ADMIN_ROLES = ['Workspace Owner', 'Workspace Admin'];
const LEVELS = ['view', 'manage'];

function requireAdmin(ctx) {
  if (!leadAccess.isLeadAdmin(ctx)) throw httpError(403, 'Only workspace Owners and Admins can assign leads.', 'LEAD_ADMIN_ONLY');
}

const userName = r => r ? (r.display_name || r.email) : null;

/** Active members of the workspace, with whether their role already sees every lead. */
async function activeMembers(workspaceId) {
  const rows = await all(
    `SELECT u.id, u.email, u.display_name, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? AND m.status = 'Active' AND (u.status IS NULL OR u.status = 'Active') ORDER BY COALESCE(NULLIF(u.display_name, ''), u.email)`, [workspaceId]);
  return rows.map(r => ({ userId: r.id, name: userName(r), email: r.email, role: r.role, seesAllLeads: ADMIN_ROLES.includes(r.role) }));
}

async function requireActiveMember(workspaceId, userId) {
  const m = (await activeMembers(workspaceId)).find(x => x.userId === Number(userId));
  if (!m) throw httpError(400, 'Choose an active member of this workspace.', 'INVALID_MEMBER');
  return m;
}

const personOf = async (workspaceId, userId) => {
  if (!userId) return null;
  const r = await get(`SELECT u.id, u.email, u.display_name, m.role, m.status FROM users u
    LEFT JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = ? WHERE u.id = ?`, [workspaceId, userId]);
  return r ? { userId: r.id, name: userName(r), email: r.email, role: r.role || null, active: r.status === 'Active' } : { userId, name: null, email: null, role: null, active: false };
};

/** Who created and owns the lead, who it is shared with (admins) and this person's own access. */
async function getAccess(ctx, rawId) {
  const lead = await leadAccess.requireLeadAccess(ctx, rawId, 'view');
  const admin = leadAccess.isLeadAdmin(ctx);
  const grants = admin ? (await all(
    `SELECT a.user_id, a.access_level, a.updated_at, u.email, u.display_name, g.email AS g_email, g.display_name AS g_name, m.status AS member_status
     FROM lead_user_access a JOIN users u ON u.id = a.user_id LEFT JOIN users g ON g.id = a.granted_by_user_id
     LEFT JOIN workspace_members m ON m.workspace_id = a.workspace_id AND m.user_id = a.user_id
     WHERE a.workspace_id = ? AND a.lead_id = ? ORDER BY COALESCE(NULLIF(u.display_name, ''), u.email)`, [ws(ctx), lead.id]))
    .map(r => ({ userId: r.user_id, name: userName(r), email: r.email, level: r.access_level, grantedBy: r.g_name || r.g_email || null, updatedAt: r.updated_at, active: r.member_status === 'Active' })) : null;
  return {
    leadId: lead.id,
    leadName: lead.name,
    createdBy: await personOf(ws(ctx), lead.created_by_user_id),
    owner: await personOf(ws(ctx), lead.owner_user_id),
    source: lead.lead_source || null,
    yourAccess: lead.accessLevel,
    canManageAccess: admin,
    grants,
    members: admin ? await activeMembers(ws(ctx)) : null
  };
}

const grantSchema = z.object({
  userIds: z.array(z.number().int().positive()).min(1).max(100),
  level: z.enum(LEVELS)
}).strict();

/** Shares the lead with members at a level (or changes their level). Owners/Admins only. */
async function grantAccess(ctx, rawId, input) {
  requireAdmin(ctx);
  const v = grantSchema.parse(input || {});
  const lead = await leadAccess.requireLeadAccess(ctx, rawId, 'admin');
  const members = await activeMembers(ws(ctx));
  const results = [];
  for (const userId of [...new Set(v.userIds)]) {
    const m = members.find(x => x.userId === userId);
    if (!m) throw httpError(400, 'Choose active members of this workspace.', 'INVALID_MEMBER');
    if (userId === Number(lead.owner_user_id)) { results.push({ userId, skipped: 'Owns this lead' }); continue; }
    if (m.seesAllLeads) { results.push({ userId, skipped: `${m.role}s already see every lead` }); continue; }
    const prev = await get('SELECT access_level FROM lead_user_access WHERE lead_id = ? AND user_id = ?', [lead.id, userId]);
    if (prev?.access_level === v.level) { results.push({ userId, level: v.level, unchanged: true }); continue; }
    await run(`INSERT INTO lead_user_access (workspace_id, lead_id, user_id, access_level, granted_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE access_level = VALUES(access_level), granted_by_user_id = VALUES(granted_by_user_id), updated_at = UTC_TIMESTAMP()`,
    [ws(ctx), lead.id, userId, v.level, ctx.auth.userId || null]);
    await audit(ctx, prev ? 'leads.access_changed' : 'leads.access_granted', { resourceType: 'lead', resourceId: lead.id, metadata: { userId, previous: prev?.access_level || null, level: v.level } });
    results.push({ userId, level: v.level, previous: prev?.access_level || null });
  }
  return { results, access: await getAccess(ctx, lead.id) };
}

/** Removes a member's shared access; their next request is refused. Owners/Admins only. */
async function revokeAccess(ctx, rawId, rawUserId) {
  requireAdmin(ctx);
  const lead = await leadAccess.requireLeadAccess(ctx, rawId, 'admin');
  const userId = Number(rawUserId);
  const prev = await get('SELECT access_level FROM lead_user_access WHERE lead_id = ? AND user_id = ? AND workspace_id = ?', [lead.id, userId, ws(ctx)]);
  if (!prev) throw httpError(404, 'This lead is not shared with that member.', 'NOT_FOUND');
  await run('DELETE FROM lead_user_access WHERE lead_id = ? AND user_id = ? AND workspace_id = ?', [lead.id, userId, ws(ctx)]);
  await audit(ctx, 'leads.access_revoked', { resourceType: 'lead', resourceId: lead.id, metadata: { userId, previous: prev.access_level } });
  return { revoked: true, access: await getAccess(ctx, lead.id) };
}

const ownerSchema = z.object({
  ownerUserId: z.number().int().positive().nullable(),
  // What the previous owner keeps after the transfer (default: nothing).
  previousOwnerAccess: z.enum(['none', 'view', 'manage']).optional().default('none')
}).strict();

/** Moves ownership in one transaction: the new owner's share (now redundant) goes; the previous owner keeps what was chosen. */
async function transfer(tx, ctx, lead, ownerUserId, previousOwnerAccess) {
  const prevOwner = lead.owner_user_id ? Number(lead.owner_user_id) : null;
  if (prevOwner === ownerUserId) return { unchanged: true };
  await tx.run('UPDATE leads SET owner_user_id = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?', [ownerUserId, ws(ctx), lead.id]);
  if (ownerUserId) await tx.run('DELETE FROM lead_user_access WHERE lead_id = ? AND user_id = ?', [lead.id, ownerUserId]);
  if (prevOwner && previousOwnerAccess !== 'none') {
    const prevMember = await tx.get("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'Active'", [ws(ctx), prevOwner]);
    if (prevMember && !ADMIN_ROLES.includes(prevMember.role)) {
      await tx.run(`INSERT INTO lead_user_access (workspace_id, lead_id, user_id, access_level, granted_by_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE access_level = VALUES(access_level), updated_at = UTC_TIMESTAMP()`,
      [ws(ctx), lead.id, prevOwner, previousOwnerAccess, ctx.auth.userId || null]);
    }
  }
  return { from: prevOwner, to: ownerUserId };
}

/** Changes (or clears) the owner of a lead. Owners/Admins only. */
async function changeOwner(ctx, rawId, input) {
  requireAdmin(ctx);
  const v = ownerSchema.parse(input || {});
  const lead = await leadAccess.requireLeadAccess(ctx, rawId, 'admin');
  if (v.ownerUserId) await requireActiveMember(ws(ctx), v.ownerUserId);
  const r = await withTransaction(tx => transfer(tx, ctx, lead, v.ownerUserId, v.previousOwnerAccess));
  if (!r.unchanged) {
    await audit(ctx, 'leads.owner_changed', { resourceType: 'lead', resourceId: lead.id, metadata: { previous: r.from, owner: r.to, previousOwnerAccess: v.previousOwnerAccess } });
  }
  return { changed: !r.unchanged, access: await getAccess(ctx, lead.id) };
}

/** Gives several leads to one owner (e.g. the unassigned leads from before ownership existed). */
async function bulkChangeOwner(ctx, input) {
  requireAdmin(ctx);
  const v = z.object({ leadIds: z.array(z.number().int().positive()).min(1).max(1000), ownerUserId: z.number().int().positive().nullable() }).strict().parse(input || {});
  if (v.ownerUserId) await requireActiveMember(ws(ctx), v.ownerUserId);
  const ids = await leadAccess.allowedLeadIds(ctx, v.leadIds);
  const rows = ids.length ? await all(`SELECT id, owner_user_id FROM leads WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [ws(ctx), ...ids]) : [];
  const changes = await withTransaction(async tx => {
    const out = [];
    for (const lead of rows) {
      const r = await transfer(tx, ctx, lead, v.ownerUserId, 'none');
      if (!r.unchanged) out.push({ leadId: lead.id, ...r });
    }
    return out;
  });
  for (const c of changes) await audit(ctx, 'leads.owner_changed', { resourceType: 'lead', resourceId: c.leadId, metadata: { previous: c.from, owner: c.to, bulk: true } });
  return { changed: changes.length, notFound: v.leadIds.length - ids.length };
}

/** Shares several leads with several members at one level (Owners/Admins only). */
async function bulkGrant(ctx, input) {
  requireAdmin(ctx);
  const v = z.object({ leadIds: z.array(z.number().int().positive()).min(1).max(1000), userIds: z.array(z.number().int().positive()).min(1).max(100), level: z.enum(LEVELS) }).strict().parse(input || {});
  const members = await activeMembers(ws(ctx));
  const targets = [...new Set(v.userIds)].map(id => members.find(m => m.userId === id));
  if (targets.some(m => !m)) throw httpError(400, 'Choose active members of this workspace.', 'INVALID_MEMBER');
  const ids = await leadAccess.allowedLeadIds(ctx, v.leadIds);
  const rows = ids.length ? await all(`SELECT id, owner_user_id FROM leads WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [ws(ctx), ...ids]) : [];
  let granted = 0;
  let skipped = 0;
  for (const lead of rows) {
    for (const m of targets) {
      if (m.seesAllLeads || m.userId === Number(lead.owner_user_id)) { skipped++; continue; }
      const prev = await get('SELECT access_level FROM lead_user_access WHERE lead_id = ? AND user_id = ?', [lead.id, m.userId]);
      if (prev?.access_level === v.level) continue;
      await run(`INSERT INTO lead_user_access (workspace_id, lead_id, user_id, access_level, granted_by_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE access_level = VALUES(access_level), granted_by_user_id = VALUES(granted_by_user_id), updated_at = UTC_TIMESTAMP()`,
      [ws(ctx), lead.id, m.userId, v.level, ctx.auth.userId || null]);
      await audit(ctx, prev ? 'leads.access_changed' : 'leads.access_granted', { resourceType: 'lead', resourceId: lead.id, metadata: { userId: m.userId, previous: prev?.access_level || null, level: v.level, bulk: true } });
      granted++;
    }
  }
  return { granted, skipped, notFound: v.leadIds.length - ids.length };
}

/** A member leaving the workspace loses every share at once (owned leads stay, for the admins to reassign). */
async function dropMemberShares(workspaceId, userId) {
  await run('DELETE FROM lead_user_access WHERE workspace_id = ? AND user_id = ?', [workspaceId, userId]).catch(() => null);
}

module.exports = { getAccess, grantAccess, revokeAccess, changeOwner, bulkChangeOwner, bulkGrant, activeMembers, dropMemberShares };
