const crypto = require('crypto');
const { z } = require('zod');
const { run, get, all, withTransaction } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { ROLES } = require('../../lib/permissions');
const emailService = require('../../services/emailService');
const authService = require('../../services/authService');

/**
 * Workspace members and invitations. The workspace is always the caller's session workspace;
 * roles, statuses and target workspaces are never taken from the client without checks.
 *
 * Invitations: one workspace, one email, an expiry and a random single-use token whose SHA-256 is
 * stored (the token itself never is). Accepting needs BOTH the token (from the invitation link)
 * and a signed-in account whose email equals the invited email: account emails are not verified
 * at registration, so the email match alone must never grant access.
 *
 * Rules: Owners and Admins manage members (members.manage). Only Owners grant, change or remove
 * the Owner role. Nobody changes their own role or removes themselves, so a workspace always
 * keeps an Owner. Removing a member sets status 'Removed'; every request re-checks membership,
 * so their tokens stop working for this workspace immediately.
 */
const OWNER = 'Workspace Owner';
const TTL_DAYS = () => Math.min(Math.max(parseInt(process.env.INVITATION_TTL_DAYS || '7', 10) || 7, 1), 30);
const MAX_PENDING = () => parseInt(process.env.MAX_PENDING_INVITATIONS || '50', 10);
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const ws = ctx => ctx.auth.workspaceId;
const isOwner = ctx => ctx.auth.role === OWNER;
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const sqlTime = d => d.toISOString().replace('T', ' ').substring(0, 19);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{40,64}$/, 'Invalid invitation link.');

function linkFor(token) {
  const base = (process.env.APP_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:8000').replace(/\/$/, '');
  return `${base}/?invite=${token}`;
}

function presentInvitation(r) {
  return {
    id: r.id, email: r.email, role: r.role, status: r.status,
    expiresAt: r.expires_at, createdAt: r.created_at, invitedBy: r.inviter_name || r.inviter_email || null
  };
}

/** Pending invitations past their expiry become 'expired' (keeps history, frees the pending slot). */
async function expireStale(db, where = '', params = []) {
  await db.run(`UPDATE workspace_invitations SET status = 'expired', updated_at = UTC_TIMESTAMP() WHERE status = 'pending' AND expires_at < UTC_TIMESTAMP()${where}`, params);
}

// ---------------------------------------------------------------- members of the current workspace
async function listMembers(ctx) {
  const members = await all(
    `SELECT m.user_id, m.role, m.status, m.created_at, u.email, u.display_name
     FROM workspace_members m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? ORDER BY (m.status = 'Active') DESC, m.id ASC`, [ws(ctx)]);
  const manage = ctx.auth.capabilities.has('members.manage');
  let invitations = [];
  if (manage) {
    await expireStale({ run }, ' AND workspace_id = ?', [ws(ctx)]);
    invitations = (await all(
      `SELECT i.*, u.display_name AS inviter_name, u.email AS inviter_email FROM workspace_invitations i
       LEFT JOIN users u ON u.id = i.invited_by WHERE i.workspace_id = ? AND i.status = 'pending' ORDER BY i.id DESC`, [ws(ctx)])).map(presentInvitation);
  }
  return {
    members: members.map(m => ({ userId: m.user_id, email: m.email, displayName: m.display_name, role: m.role, status: m.status, joinedAt: m.created_at, isYou: m.user_id === ctx.auth.userId })),
    invitations,
    roles: ROLES,
    canManage: manage,
    canManageOwners: manage && isOwner(ctx)
  };
}

function assertRoleAllowed(ctx, role) {
  if (!ROLES.includes(role)) throw httpError(400, `Role must be one of: ${ROLES.join(', ')}.`, 'VALIDATION_ERROR');
  if (role === OWNER && !isOwner(ctx)) throw httpError(403, 'Only a Workspace Owner can grant the Owner role.', 'OWNER_ONLY');
}

async function sendInvitationEmail(ctx, inv, token) {
  const workspace = await get('SELECT name FROM workspaces WHERE id = ?', [ws(ctx)]);
  const inviter = await get('SELECT display_name, email FROM users WHERE id = ?', [ctx.auth.userId]);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const link = linkFor(token);
  const who = inviter?.display_name || inviter?.email || 'A teammate';
  // The pool reads DATETIME as UTC (timezone 'Z').
  const expires = (inv.expires_at instanceof Date ? inv.expires_at : new Date(`${String(inv.expires_at).replace(' ', 'T')}Z`)).toUTCString();
  const text = `${who} invited you to join the workspace "${workspace?.name}" on Marketech.ai as ${inv.role}.\n\n`
    + `Accept the invitation: ${link}\n\nSign in (or create an account) with ${inv.email}, then open the link. It expires on ${expires} and works once.`;
  const html = `<p>${esc(who)} invited you to join the workspace <strong>${esc(workspace?.name)}</strong> on Marketech.ai as <strong>${esc(inv.role)}</strong>.</p>`
    + `<p><a href="${esc(link)}">Accept the invitation</a></p>`
    + `<p style="color:#64748b;font-size:13px">Sign in (or create an account) with ${esc(inv.email)}, then open the link. It expires on ${esc(expires)} and works once.</p>`;
  try {
    await emailService.sendRealEmail(ws(ctx), { to: inv.email, subject: `Invitation to join ${workspace?.name} on Marketech.ai`, html, text });
    return { emailed: true, emailError: null };
  } catch (err) {
    // No workspace mailbox (or the provider refused): the link is still shown to the inviter.
    return { emailed: false, emailError: err.message };
  }
}

async function invite(ctx, input) {
  const v = z.object({ email: z.string().trim().toLowerCase().max(255).refine(e => EMAIL_RE.test(e), 'Enter a valid email address.'), role: z.string() }).strict().parse(input || {});
  assertRoleAllowed(ctx, v.role);
  const member = await get(
    `SELECT m.status FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND LOWER(u.email) = ?`, [ws(ctx), v.email]);
  if (member && member.status === 'Active') throw httpError(409, 'This person is already a member of the workspace.', 'ALREADY_MEMBER');
  await expireStale({ run }, ' AND workspace_id = ?', [ws(ctx)]);
  const pending = await get("SELECT COUNT(*) AS n FROM workspace_invitations WHERE workspace_id = ? AND status = 'pending'", [ws(ctx)]);
  if (Number(pending.n) >= MAX_PENDING()) throw httpError(409, `At most ${MAX_PENDING()} pending invitations per workspace.`, 'INVITATION_LIMIT');

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = sqlTime(new Date(Date.now() + TTL_DAYS() * 86400000));
  let id;
  try {
    id = (await run(
      `INSERT INTO workspace_invitations (workspace_id, email, role, token_hash, status, invited_by, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [ws(ctx), v.email, v.role, hashToken(token), ctx.auth.userId, expiresAt])).lastID;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw httpError(409, 'There is already a pending invitation for this email. Resend or cancel it instead.', 'INVITATION_EXISTS');
    throw err;
  }
  const inv = await get('SELECT * FROM workspace_invitations WHERE id = ?', [id]);
  const delivery = await sendInvitationEmail(ctx, inv, token);
  await audit(ctx, 'workspace.member_invited', { resourceType: 'workspace_invitation', resourceId: id, metadata: { email: v.email, role: v.role, emailed: delivery.emailed } });
  return { invitation: presentInvitation(inv), link: linkFor(token), ...delivery };
}

async function requirePendingInvitation(ctx, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid invitation id.', 'VALIDATION_ERROR');
  await expireStale({ run }, ' AND workspace_id = ?', [ws(ctx)]);
  const inv = await get('SELECT * FROM workspace_invitations WHERE id = ? AND workspace_id = ?', [id, ws(ctx)]);
  if (!inv) throw httpError(404, 'Invitation not found.', 'NOT_FOUND');
  if (inv.status !== 'pending') throw httpError(409, `This invitation is ${inv.status}.`, 'INVITATION_NOT_PENDING');
  if (inv.role === OWNER && !isOwner(ctx)) throw httpError(403, 'Only a Workspace Owner can manage an Owner invitation.', 'OWNER_ONLY');
  return inv;
}

/** New token and expiry (the previous link stops working), sent again. */
async function resend(ctx, rawId) {
  const inv = await requirePendingInvitation(ctx, rawId);
  const token = crypto.randomBytes(32).toString('base64url');
  await run("UPDATE workspace_invitations SET token_hash = ?, expires_at = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'pending'",
    [hashToken(token), sqlTime(new Date(Date.now() + TTL_DAYS() * 86400000)), inv.id]);
  const fresh = await get('SELECT * FROM workspace_invitations WHERE id = ?', [inv.id]);
  const delivery = await sendInvitationEmail(ctx, fresh, token);
  await audit(ctx, 'workspace.invitation_resent', { resourceType: 'workspace_invitation', resourceId: inv.id, metadata: { emailed: delivery.emailed } });
  return { invitation: presentInvitation(fresh), link: linkFor(token), ...delivery };
}

async function cancel(ctx, rawId) {
  const inv = await requirePendingInvitation(ctx, rawId);
  await run("UPDATE workspace_invitations SET status = 'cancelled', responded_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'pending'", [inv.id]);
  await audit(ctx, 'workspace.invitation_cancelled', { resourceType: 'workspace_invitation', resourceId: inv.id });
  return { cancelled: true };
}

async function requireOtherMember(ctx, rawUserId) {
  const userId = Number(rawUserId);
  if (!Number.isInteger(userId) || userId <= 0) throw httpError(400, 'Invalid member.', 'VALIDATION_ERROR');
  if (userId === ctx.auth.userId) throw httpError(409, 'You cannot change your own role or remove yourself.', 'SELF_CHANGE');
  const m = await get("SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'Active'", [ws(ctx), userId]);
  if (!m) throw httpError(404, 'Member not found in this workspace.', 'NOT_FOUND');
  if (m.role === OWNER && !isOwner(ctx)) throw httpError(403, 'Only a Workspace Owner can change or remove an Owner.', 'OWNER_ONLY');
  return m;
}

async function ownersLeftAfter(workspaceId, excludingUserId) {
  const r = await get("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND status = 'Active' AND role = ? AND user_id <> ?", [workspaceId, OWNER, excludingUserId]);
  return Number(r.n);
}

async function changeRole(ctx, rawUserId, input) {
  const { role } = z.object({ role: z.string() }).strict().parse(input || {});
  assertRoleAllowed(ctx, role);
  const m = await requireOtherMember(ctx, rawUserId);
  if (m.role === role) return { userId: m.user_id, role };
  if (m.role === OWNER && await ownersLeftAfter(ws(ctx), m.user_id) < 1) throw httpError(409, 'A workspace must keep at least one Owner.', 'LAST_OWNER');
  await run("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ? AND status = 'Active'", [role, ws(ctx), m.user_id]);
  await audit(ctx, 'workspace.member_role_changed', { resourceType: 'workspace_member', resourceId: m.user_id, metadata: { from: m.role, to: role } });
  return { userId: m.user_id, role };
}

async function removeMember(ctx, rawUserId) {
  const m = await requireOtherMember(ctx, rawUserId);
  if (m.role === OWNER && await ownersLeftAfter(ws(ctx), m.user_id) < 1) throw httpError(409, 'A workspace must keep at least one Owner.', 'LAST_OWNER');
  await run("UPDATE workspace_members SET status = 'Removed' WHERE workspace_id = ? AND user_id = ? AND status = 'Active'", [ws(ctx), m.user_id]);
  await audit(ctx, 'workspace.member_removed', { resourceType: 'workspace_member', resourceId: m.user_id, metadata: { role: m.role } });
  return { removed: true };
}

// ---------------------------------------------------------------- the invited person
async function myEmail(ctx) {
  const u = await get('SELECT email FROM users WHERE id = ?', [ctx.auth.userId]);
  if (!u) throw httpError(401, 'Authentication required.', 'UNAUTHENTICATED');
  return String(u.email).toLowerCase();
}

// Expiry is decided by the database clock, in UTC.
const INVITE_SELECT = `SELECT i.*, (i.expires_at < UTC_TIMESTAMP()) AS is_expired, w.name AS workspace_name, w.status AS workspace_status,
  u.display_name AS inviter_name, u.email AS inviter_email
  FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN users u ON u.id = i.invited_by`;

/** Pending invitations sent to the signed-in account's email. Accepting still needs the link. */
async function myInvitations(ctx) {
  const email = await myEmail(ctx);
  await expireStale({ run }, ' AND email = ?', [email]);
  const rows = await all(`${INVITE_SELECT} WHERE i.email = ? AND i.status = 'pending' ORDER BY i.id DESC`, [email]);
  return rows.map(r => ({ ...presentInvitation(r), workspaceId: r.workspace_id, workspaceName: r.workspace_name }));
}

async function findByToken(token) {
  const t = tokenSchema.parse(token);
  return get(`${INVITE_SELECT} WHERE i.token_hash = ?`, [hashToken(t)]);
}

function invitationProblem(inv, email) {
  if (!inv) return [404, 'This invitation link is not valid.', 'INVITATION_INVALID'];
  if (inv.status === 'expired' || (inv.status === 'pending' && Number(inv.is_expired) === 1)) return [410, 'This invitation has expired. Ask for a new one.', 'INVITATION_EXPIRED'];
  if (inv.status !== 'pending') return [409, `This invitation was already ${inv.status}.`, 'INVITATION_USED'];
  if (inv.workspace_status && inv.workspace_status !== 'Active') return [410, 'The workspace is no longer active.', 'WORKSPACE_INACTIVE'];
  if (String(inv.email).toLowerCase() !== email) return [403, `This invitation was sent to ${inv.email}. Sign in with that email address to accept it.`, 'INVITATION_EMAIL_MISMATCH'];
  return null;
}

async function preview(ctx, input) {
  const { token } = z.object({ token: z.string() }).strict().parse(input || {});
  const inv = await findByToken(token);
  const problem = invitationProblem(inv, await myEmail(ctx));
  if (problem && problem[2] !== 'INVITATION_EMAIL_MISMATCH') throw httpError(...problem);
  return {
    invitation: { ...presentInvitation(inv), workspaceId: inv.workspace_id, workspaceName: inv.workspace_name },
    canAccept: !problem,
    reason: problem ? problem[1] : null
  };
}

/**
 * Accepts with the token, atomically: the invitation row is locked (FOR UPDATE) so two concurrent
 * accepts cannot both succeed; the membership is created, or a removed one re-activated.
 */
async function accept(ctx, input) {
  const { token } = z.object({ token: z.string() }).strict().parse(input || {});
  const t = tokenSchema.parse(token);
  const email = await myEmail(ctx);
  const result = await withTransaction(async tx => {
    // Lock only the invitation row; workspace details are read separately.
    const row = await tx.get('SELECT i.*, (i.expires_at < UTC_TIMESTAMP()) AS is_expired FROM workspace_invitations i WHERE i.token_hash = ? FOR UPDATE', [hashToken(t)]);
    const wsRow = row ? await tx.get('SELECT name, status FROM workspaces WHERE id = ?', [row.workspace_id]) : null;
    const inv = row ? { ...row, workspace_name: wsRow?.name, workspace_status: wsRow?.status } : null;
    const problem = invitationProblem(inv, email);
    if (problem) {
      if (problem[2] === 'INVITATION_EXPIRED') await tx.run("UPDATE workspace_invitations SET status = 'expired', updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'pending'", [inv.id]);
      return { error: problem };
    }
    const existing = await tx.get('SELECT status FROM workspace_members WHERE workspace_id = ? AND user_id = ? FOR UPDATE', [inv.workspace_id, ctx.auth.userId]);
    if (existing && existing.status === 'Active') {
      await tx.run("UPDATE workspace_invitations SET status = 'accepted', accepted_by = ?, responded_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?", [ctx.auth.userId, inv.id]);
      return { workspaceId: inv.workspace_id, alreadyMember: true, inv };
    }
    if (existing) {
      await tx.run("UPDATE workspace_members SET status = 'Active', role = ? WHERE workspace_id = ? AND user_id = ?", [inv.role, inv.workspace_id, ctx.auth.userId]);
    } else {
      await tx.run("INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'Active', UTC_TIMESTAMP())", [inv.workspace_id, ctx.auth.userId, inv.role]);
    }
    await tx.run("UPDATE workspace_invitations SET status = 'accepted', accepted_by = ?, responded_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?", [ctx.auth.userId, inv.id]);
    return { workspaceId: inv.workspace_id, alreadyMember: false, inv };
  });
  if (result.error) throw httpError(...result.error);
  await audit({ auth: { ...ctx.auth, workspaceId: result.workspaceId }, requestId: ctx.requestId, ip: ctx.ip }, 'workspace.invitation_accepted',
    { resourceType: 'workspace_invitation', resourceId: result.inv.id, metadata: { role: result.inv.role, alreadyMember: result.alreadyMember } });
  // A session for the joined workspace (membership is re-checked by switchWorkspace).
  const session = await authService.switchWorkspace(ctx.auth.userId, result.workspaceId);
  return { joined: !result.alreadyMember, alreadyMember: result.alreadyMember, workspaceName: result.inv.workspace_name, session };
}

/** Declines by token or, for invitations to the signed-in email, by id. Declining grants nothing. */
async function decline(ctx, input) {
  const v = z.object({ token: z.string().optional(), id: z.number().int().positive().optional() }).strict().parse(input || {});
  const email = await myEmail(ctx);
  let inv;
  if (v.token) inv = await findByToken(v.token);
  else if (v.id) inv = await get(`${INVITE_SELECT} WHERE i.id = ? AND i.email = ?`, [v.id, email]);
  else throw httpError(400, 'Give the invitation link or id.', 'VALIDATION_ERROR');
  const problem = invitationProblem(inv, email);
  if (problem) throw httpError(...problem);
  const r = await run("UPDATE workspace_invitations SET status = 'declined', responded_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'pending'", [inv.id]);
  if (!r.changes) throw httpError(409, 'This invitation was already answered.', 'INVITATION_USED');
  await audit({ auth: { ...ctx.auth, workspaceId: inv.workspace_id }, requestId: ctx.requestId, ip: ctx.ip }, 'workspace.invitation_declined', { resourceType: 'workspace_invitation', resourceId: inv.id });
  return { declined: true };
}

module.exports = { listMembers, invite, resend, cancel, changeRole, removeMember, myInvitations, preview, accept, decline, hashToken, OWNER };
