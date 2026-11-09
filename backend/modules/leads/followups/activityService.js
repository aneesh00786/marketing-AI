const { z } = require('zod');
const { get, all, run } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const leadAccess = require('../../../lib/leadAccess');

/**
 * Lead follow-ups (Leads → a lead → Follow-ups): scheduled follow-up tasks, notes and logged
 * activities, plus the lead's emails and calls from the same history a campaign's Follow up shows
 * (campaignService.personHistory). Email (Compose) and calling (📞) are the existing features.
 *
 * Access (lib/leadAccess.js): anyone who can see the lead sees its history; the lead's owner,
 * members with Manage access and workspace Owners/Admins add and change it.
 */
const ws = ctx => ctx.auth.workspaceId;
const { httpError } = leadAccess;

const ACTIVITY_TYPES = ['note', 'meeting', 'call', 'email', 'whatsapp', 'sms', 'general'];
const NOTE_CATEGORIES = ['feedback', 'discussion', 'requirements', 'objections', 'internal', 'next_steps'];
const FOLLOWUP_TYPES = ['call', 'email', 'meeting', 'whatsapp', 'sms', 'general'];
const PRIORITIES = ['low', 'medium', 'high'];
const sqlTime = d => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
const iso = v => (v ? new Date(v instanceof Date ? v : `${String(v).replace(' ', 'T')}Z`).toISOString() : null);

/** Who can work on a lead: needs the role permission and Manage (owner, shared manage or admin). */
async function requireManage(ctx, leadId) {
  if (!ctx.auth.capabilities?.has?.('leads.manage') && !leadAccess.isLeadAdmin(ctx)) throw httpError(403, 'Your role cannot change leads.', 'FORBIDDEN');
  return leadAccess.requireLeadAccess(ctx, leadId, 'manage');
}
const requireView = (ctx, leadId) => leadAccess.requireLeadAccess(ctx, leadId, 'view');

const userSql = alias => `COALESCE(NULLIF(${alias}.display_name, ''), ${alias}.email)`;

// ---------------------------------------------------------------- activities and notes

const activitySchema = z.object({
  type: z.enum(ACTIVITY_TYPES),
  noteCategory: z.enum(NOTE_CATEGORIES).nullable().optional(),
  title: z.string().trim().max(255).optional().nullable(),
  description: z.string().trim().max(10000).optional().nullable(),
  status: z.enum(['completed', 'scheduled', 'no_answer', 'cancelled']).optional().nullable(),
  durationMinutes: z.number().int().min(0).max(1440).optional().nullable(),
  activityAt: z.string().datetime({ offset: true }).optional().nullable(),
  nextFollowupAt: z.string().datetime({ offset: true }).optional().nullable()
}).strict();

function presentActivity(r) {
  return {
    id: r.id, kind: r.activity_type === 'note' ? 'note' : 'activity', type: r.activity_type, noteCategory: r.note_category || null,
    title: r.title || null, description: r.description || null, status: r.status || null,
    durationMinutes: r.duration_minutes ?? null, nextFollowupAt: iso(r.next_followup_at), at: iso(r.activity_at),
    by: r.by_name || null, byUserId: r.performed_by, followupId: r.followup_id || null, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
  };
}

async function addActivity(ctx, leadId, input) {
  const lead = await requireManage(ctx, leadId);
  const v = activitySchema.parse(input || {});
  if (v.type === 'note' && !v.description) throw httpError(400, 'Write the note first.', 'VALIDATION_ERROR');
  if (v.type !== 'note' && !v.title && !v.description) throw httpError(400, 'Add a title or a description.', 'VALIDATION_ERROR');
  const at = v.activityAt ? new Date(v.activityAt) : new Date();
  const ins = await run(
    `INSERT INTO lead_activities (workspace_id, lead_id, activity_type, note_category, title, description, status, duration_minutes, next_followup_at, activity_at, performed_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ws(ctx), lead.id, v.type, v.type === 'note' ? v.noteCategory || null : null, v.title || null, v.description || null, v.type === 'note' ? null : v.status || 'completed',
      v.durationMinutes ?? null, v.nextFollowupAt ? sqlTime(v.nextFollowupAt) : null, sqlTime(at), ctx.auth.userId || null]);
  // "Next follow-up" on an activity becomes a scheduled follow-up for the person who logged it.
  let followup = null;
  if (v.nextFollowupAt) {
    followup = (await createFollowup(ctx, lead.id, { title: `Follow up: ${v.title || v.type}`.slice(0, 255), type: v.type === 'note' ? 'general' : (FOLLOWUP_TYPES.includes(v.type) ? v.type : 'general'), dueAt: v.nextFollowupAt, priority: 'medium' })).followup;
    await run('UPDATE lead_activities SET followup_id = ? WHERE id = ?', [followup.id, ins.lastID]);
  }
  await audit(ctx, v.type === 'note' ? 'leads.note_added' : 'leads.activity_logged', { resourceType: 'lead', resourceId: lead.id, metadata: { activityId: ins.lastID, type: v.type } });
  return { activity: await activityById(ctx, lead.id, ins.lastID), followup };
}

async function activityById(ctx, leadId, id) {
  const r = await get(`SELECT a.*, ${userSql('u')} AS by_name FROM lead_activities a LEFT JOIN users u ON u.id = a.performed_by WHERE a.workspace_id = ? AND a.lead_id = ? AND a.id = ?`, [ws(ctx), leadId, Number(id)]);
  if (!r) throw httpError(404, 'Activity not found.', 'NOT_FOUND');
  return presentActivity(r);
}

async function updateActivity(ctx, leadId, id, input) {
  const lead = await requireManage(ctx, leadId);
  const cur = await activityById(ctx, lead.id, id);
  const v = activitySchema.partial().parse(input || {});
  const map = { title: 'title', description: 'description', status: 'status', durationMinutes: 'duration_minutes', noteCategory: 'note_category' };
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(map)) if (v[k] !== undefined) { sets.push(`${col} = ?`); params.push(v[k] ?? null); }
  if (v.activityAt) { sets.push('activity_at = ?'); params.push(sqlTime(v.activityAt)); }
  if (v.nextFollowupAt !== undefined) { sets.push('next_followup_at = ?'); params.push(v.nextFollowupAt ? sqlTime(v.nextFollowupAt) : null); }
  if (cur.type === 'note' && v.description !== undefined && !v.description) throw httpError(400, 'A note cannot be empty.', 'VALIDATION_ERROR');
  if (sets.length) await run(`UPDATE lead_activities SET ${sets.join(', ')}, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND lead_id = ? AND id = ?`, [...params, ws(ctx), lead.id, cur.id]);
  await audit(ctx, cur.type === 'note' ? 'leads.note_updated' : 'leads.activity_updated', { resourceType: 'lead', resourceId: lead.id, metadata: { activityId: cur.id } });
  return { activity: await activityById(ctx, lead.id, cur.id) };
}

async function deleteActivity(ctx, leadId, id) {
  const lead = await requireManage(ctx, leadId);
  const cur = await activityById(ctx, lead.id, id);
  await run('DELETE FROM lead_activities WHERE workspace_id = ? AND lead_id = ? AND id = ?', [ws(ctx), lead.id, cur.id]);
  await audit(ctx, cur.type === 'note' ? 'leads.note_deleted' : 'leads.activity_deleted', { resourceType: 'lead', resourceId: lead.id, metadata: { activityId: cur.id, type: cur.type } });
  return { deleted: true };
}

async function listNotes(ctx, leadId) {
  const lead = await requireView(ctx, leadId);
  const rows = await all(`SELECT a.*, ${userSql('u')} AS by_name FROM lead_activities a LEFT JOIN users u ON u.id = a.performed_by
    WHERE a.workspace_id = ? AND a.lead_id = ? AND a.activity_type = 'note' ORDER BY a.activity_at DESC, a.id DESC LIMIT 500`, [ws(ctx), lead.id]);
  return { notes: rows.map(presentActivity), canEdit: leadAccess.atLeast(lead.accessLevel, 'manage') };
}

// ---------------------------------------------------------------- follow-ups

const followupSchema = z.object({
  title: z.string().trim().min(1).max(255),
  type: z.enum(FOLLOWUP_TYPES),
  description: z.string().trim().max(5000).optional().nullable(),
  assignedUserId: z.number().int().positive().nullable().optional(),
  dueAt: z.string().datetime({ offset: true }),
  priority: z.enum(PRIORITIES).optional().default('medium'),
  reminderMinutes: z.number().int().min(0).max(10080).nullable().optional()
}).strict();

/** The assignee must be an active member who can see the lead (else share it with them first). */
async function requireAssignable(ctx, lead, userId) {
  const m = await get(`SELECT m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ? AND m.user_id = ? AND m.status = 'Active' AND (u.status IS NULL OR u.status = 'Active')`, [ws(ctx), userId]);
  if (!m) throw httpError(400, 'Choose an active member of this workspace.', 'INVALID_MEMBER');
  const admin = ['Workspace Owner', 'Workspace Admin'].includes(m.role);
  if (admin || Number(lead.owner_user_id) === Number(userId)) return;
  const g = await get("SELECT access_level FROM lead_user_access WHERE lead_id = ? AND user_id = ? AND access_level = 'manage'", [lead.id, userId]);
  if (!g) throw httpError(400, 'That member is not assigned this lead. Assign the lead to them first.', 'ASSIGNEE_NO_ACCESS');
}

function presentFollowup(r) {
  const due = iso(r.due_at);
  const overdue = r.status === 'pending' && new Date(due) < new Date();
  return {
    id: r.id, kind: 'followup', leadId: r.lead_id, leadName: r.lead_name || undefined, type: r.followup_type, title: r.title, description: r.description || null,
    priority: r.priority, dueAt: due, reminderMinutes: r.reminder_minutes ?? null,
    status: overdue ? 'overdue' : r.status, storedStatus: r.status,
    assignedUserId: r.assigned_user_id, assignedTo: r.assignee_name || null,
    completedAt: iso(r.completed_at), completedBy: r.completer_name || null, completionNotes: r.completion_notes || null,
    callLogId: r.call_log_id || null, createdBy: r.creator_name || null, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
  };
}

const FOLLOWUP_SELECT = `SELECT f.*, ${userSql('au')} AS assignee_name, ${userSql('cu')} AS creator_name, ${userSql('du')} AS completer_name
  FROM lead_followups f LEFT JOIN users au ON au.id = f.assigned_user_id LEFT JOIN users cu ON cu.id = f.created_by LEFT JOIN users du ON du.id = f.completed_by`;

async function followupById(ctx, leadId, id) {
  const r = await get(`${FOLLOWUP_SELECT} WHERE f.workspace_id = ? AND f.lead_id = ? AND f.id = ?`, [ws(ctx), leadId, Number(id)]);
  if (!r) throw httpError(404, 'Follow-up not found.', 'NOT_FOUND');
  return r;
}

async function createFollowup(ctx, leadId, input) {
  const lead = await requireManage(ctx, leadId);
  const v = followupSchema.parse(input || {});
  const assignee = v.assignedUserId || ctx.auth.userId || null;
  if (assignee) await requireAssignable(ctx, lead, assignee);
  const ins = await run(
    `INSERT INTO lead_followups (workspace_id, lead_id, assigned_user_id, followup_type, title, description, priority, due_at, reminder_minutes, status, created_by, assigned_by, assigned_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ws(ctx), lead.id, assignee, v.type, v.title, v.description || null, v.priority, sqlTime(v.dueAt), v.reminderMinutes ?? null, ctx.auth.userId || null, ctx.auth.userId || null]);
  await audit(ctx, 'leads.followup_scheduled', { resourceType: 'lead', resourceId: lead.id, metadata: { followupId: ins.lastID, type: v.type, assignedUserId: assignee, dueAt: v.dueAt } });
  return { followup: presentFollowup(await followupById(ctx, lead.id, ins.lastID)) };
}

const followupUpdateSchema = followupSchema.partial().extend({
  action: z.enum(['complete', 'cancel', 'reopen']).optional(),
  completionNotes: z.string().trim().max(5000).optional().nullable()
}).strict();

/** Edit, reschedule (dueAt), reassign, complete (with notes), cancel or reopen. */
async function updateFollowup(ctx, leadId, id, input) {
  const lead = await requireManage(ctx, leadId);
  const cur = await followupById(ctx, lead.id, id);
  const v = followupUpdateSchema.parse(input || {});
  const sets = [];
  const params = [];
  const map = { title: 'title', type: 'followup_type', description: 'description', priority: 'priority', reminderMinutes: 'reminder_minutes' };
  for (const [k, col] of Object.entries(map)) if (v[k] !== undefined) { sets.push(`${col} = ?`); params.push(v[k] ?? null); }
  if (v.dueAt) { sets.push('due_at = ?'); params.push(sqlTime(v.dueAt)); }
  let reassigned = false;
  if (v.assignedUserId !== undefined && Number(v.assignedUserId || 0) !== Number(cur.assigned_user_id || 0)) {
    if (v.assignedUserId) await requireAssignable(ctx, lead, v.assignedUserId);
    sets.push('assigned_user_id = ?', 'assigned_by = ?', 'assigned_at = UTC_TIMESTAMP()');
    params.push(v.assignedUserId || null, ctx.auth.userId || null);
    reassigned = true;
  }
  let action = null;
  if (v.action === 'complete') {
    if (cur.status !== 'pending') throw httpError(409, `This follow-up is already ${cur.status}.`, 'INVALID_STATE');
    sets.push("status = 'completed'", 'completed_at = UTC_TIMESTAMP()', 'completed_by = ?', 'completion_notes = ?');
    params.push(ctx.auth.userId || null, v.completionNotes || null);
    action = 'leads.followup_completed';
  } else if (v.action === 'cancel') {
    if (cur.status !== 'pending') throw httpError(409, `This follow-up is already ${cur.status}.`, 'INVALID_STATE');
    sets.push("status = 'cancelled'", 'completion_notes = COALESCE(?, completion_notes)');
    params.push(v.completionNotes || null);
    action = 'leads.followup_cancelled';
  } else if (v.action === 'reopen') {
    sets.push("status = 'pending'", 'completed_at = NULL', 'completed_by = NULL');
    action = 'leads.followup_reopened';
  } else if (v.completionNotes !== undefined) {
    sets.push('completion_notes = ?'); params.push(v.completionNotes || null);
  }
  if (sets.length) await run(`UPDATE lead_followups SET ${sets.join(', ')}, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND lead_id = ? AND id = ?`, [...params, ws(ctx), lead.id, cur.id]);
  await audit(ctx, action || (v.dueAt ? 'leads.followup_rescheduled' : 'leads.followup_updated'), { resourceType: 'lead', resourceId: lead.id,
    metadata: { followupId: cur.id, ...(v.dueAt ? { previousDueAt: iso(cur.due_at), dueAt: v.dueAt } : {}), ...(reassigned ? { previousAssignee: cur.assigned_user_id, assignedUserId: v.assignedUserId || null } : {}) } });
  return { followup: presentFollowup(await followupById(ctx, lead.id, cur.id)) };
}

/**
 * A call made for a scheduled "call" follow-up: linked to it, and the follow-up completed when the
 * call was answered (system update from the call log; the caller had Manage access when starting).
 */
async function linkCallToFollowup(workspaceId, leadId, followupId, callLogId, answered, userId) {
  if (!followupId) return;
  const f = await get("SELECT id, status FROM lead_followups WHERE workspace_id = ? AND lead_id = ? AND id = ?", [workspaceId, leadId, followupId]);
  if (!f) return;
  if (answered && f.status === 'pending') {
    await run("UPDATE lead_followups SET call_log_id = ?, status = 'completed', completed_at = UTC_TIMESTAMP(), completed_by = ?, completion_notes = COALESCE(completion_notes, 'Completed with a call.'), updated_at = UTC_TIMESTAMP() WHERE id = ?", [callLogId, userId || null, f.id]);
  } else {
    await run('UPDATE lead_followups SET call_log_id = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [callLogId, f.id]);
  }
}

/** My pending follow-ups (assigned to me, on leads I can still see), for the notification bell. */
async function myFollowups(ctx) {
  const vis = leadAccess.visibleSql(ctx, 'l');
  const rows = await all(`${FOLLOWUP_SELECT.replace('FROM lead_followups f', ', l.name AS lead_name FROM lead_followups f JOIN leads l ON l.id = f.lead_id AND l.workspace_id = f.workspace_id')}
    WHERE f.workspace_id = ? AND f.assigned_user_id = ? AND f.status = 'pending' AND ${vis.sql} AND f.due_at <= UTC_TIMESTAMP() + INTERVAL 1 DAY
    ORDER BY f.due_at LIMIT 50`, [ws(ctx), ctx.auth.userId || 0, ...vis.params]);
  const assigned = await all(`${FOLLOWUP_SELECT.replace('FROM lead_followups f', ', l.name AS lead_name FROM lead_followups f JOIN leads l ON l.id = f.lead_id AND l.workspace_id = f.workspace_id')}
    WHERE f.workspace_id = ? AND f.assigned_user_id = ? AND f.status = 'pending' AND f.assigned_by IS NOT NULL AND f.assigned_by <> f.assigned_user_id
      AND f.assigned_at >= UTC_TIMESTAMP() - INTERVAL 3 DAY AND ${vis.sql} ORDER BY f.assigned_at DESC LIMIT 20`, [ws(ctx), ctx.auth.userId || 0, ...vis.params]);
  const failed = await all(`SELECT c.id, c.lead_id, c.started_at, l.name AS lead_name FROM crm_call_logs c JOIN leads l ON l.id = c.lead_id AND l.workspace_id = c.lead_workspace_id
    WHERE c.lead_workspace_id = ? AND c.user_id = ? AND c.transcript_status = 'failed' AND c.started_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY AND ${vis.sql} ORDER BY c.id DESC LIMIT 10`,
  [ws(ctx), ctx.auth.userId || 0, ...vis.params]);
  const list = rows.map(presentFollowup);
  return {
    overdue: list.filter(f => f.status === 'overdue'),
    upcoming: list.filter(f => f.status === 'pending'),
    newlyAssigned: assigned.map(presentFollowup),
    failedTranscripts: failed.map(c => ({ callId: c.id, leadId: c.lead_id, leadName: c.lead_name, startedAt: iso(c.started_at) }))
  };
}

// ---------------------------------------------------------------- timeline and summary

/** Emails and calls with this lead: the same history as a campaign's Follow up → History. */
async function history(ctx, lead) {
  return require('../../mail/campaigns/campaignService').personHistory(ws(ctx), { email: lead.email, phone: lead.phone, leadId: lead.id });
}

async function timeline(ctx, leadId, query = {}) {
  const lead = await requireView(ctx, leadId);
  const types = String(query.types || '').split(',').map(s => s.trim()).filter(Boolean);
  const want = t => !types.length || types.includes(t);
  const items = [];
  if (want('call') || want('email')) {
    const h = await history(ctx, lead);
    if (want('call')) items.push(...h.calls.map(c => ({ ...c, kind: 'call', type: 'call', at: iso(c.startedAt), status: c.answered ? 'completed' : 'missed', by: c.callerName || null })));
    if (want('email')) items.push(...h.emails.map(e => ({ ...e, kind: 'email', type: 'email', title: e.subject, at: iso(e.at), summary: e.preview })));
    await audit(ctx, 'leads.history_viewed', { resourceType: 'lead', resourceId: lead.id, metadata: { emails: h.emails.length, calls: h.calls.length } });
  }
  if (want('followup')) {
    const fs = await all(`${FOLLOWUP_SELECT} WHERE f.workspace_id = ? AND f.lead_id = ? ORDER BY f.due_at DESC LIMIT 500`, [ws(ctx), lead.id]);
    items.push(...fs.map(r => ({ ...presentFollowup(r), at: iso(r.completed_at || r.due_at) })));
  }
  const actTypes = ACTIVITY_TYPES.filter(t => want(t) || want('activity'));
  if (actTypes.length) {
    const acts = await all(`SELECT a.*, ${userSql('u')} AS by_name FROM lead_activities a LEFT JOIN users u ON u.id = a.performed_by
      WHERE a.workspace_id = ? AND a.lead_id = ? AND a.activity_type IN (${actTypes.map(() => '?').join(',')}) ORDER BY a.activity_at DESC LIMIT 500`, [ws(ctx), lead.id, ...actTypes]);
    items.push(...acts.map(presentActivity));
  }
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;
  const inRange = it => (!from || isNaN(from) || new Date(it.at) >= from) && (!to || isNaN(to) || new Date(it.at) <= to);
  const list = items.filter(it => it.at && inRange(it)).sort((a, b) => new Date(b.at) - new Date(a.at));
  return { leadId: lead.id, items: list, yourAccess: lead.accessLevel, canAct: leadAccess.atLeast(lead.accessLevel, 'manage') };
}

/** The summary cards, computed from the records themselves. */
async function summary(ctx, leadId) {
  const lead = await requireView(ctx, leadId);
  const W = ws(ctx);
  const h = await history(ctx, lead);
  const sent = h.emails.filter(e => e.direction === 'sent');
  const f = await get(`SELECT SUM(status = 'completed') AS done, SUM(status = 'pending' AND due_at >= UTC_TIMESTAMP()) AS pending,
      SUM(status = 'pending' AND due_at < UTC_TIMESTAMP()) AS overdue FROM lead_followups WHERE workspace_id = ? AND lead_id = ?`, [W, lead.id]);
  // Last contact: the latest call, email (either way) or logged contact activity (notes are not contact).
  const lastAct = await get("SELECT activity_at AS at, activity_type AS t FROM lead_activities WHERE workspace_id = ? AND lead_id = ? AND activity_type IN ('meeting', 'call', 'email', 'whatsapp', 'sms') AND (status IS NULL OR status = 'completed') ORDER BY activity_at DESC LIMIT 1", [W, lead.id]);
  const contacts = [
    h.calls[0] && { at: iso(h.calls[0].startedAt), type: 'call' },
    h.emails[0] && { at: iso(h.emails[0].at), type: h.emails[0].direction === 'received' ? 'email (received)' : 'email' },
    lastAct && { at: iso(lastAct.at), type: lastAct.t }
  ].filter(x => x && x.at);
  const lastContacted = contacts.sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null;
  const next = await get(`${FOLLOWUP_SELECT} WHERE f.workspace_id = ? AND f.lead_id = ? AND f.status = 'pending' ORDER BY f.due_at LIMIT 1`, [W, lead.id]);
  // Last call: its transcript's opening lines when it was transcribed (no AI summary is invented).
  const lastCall = h.calls.find(c => c.answered) || null;
  const lastCallText = lastCall?.conversation?.length ? lastCall.conversation.slice(0, 3).map(l => l.text).join(' ').slice(0, 300) : null;
  return {
    totalCalls: h.calls.length, totalEmails: sent.length,
    completedFollowups: Number(f.done || 0), pendingFollowups: Number(f.pending || 0), overdueFollowups: Number(f.overdue || 0),
    lastContacted, nextFollowup: next ? presentFollowup(next) : null,
    lastCall: lastCall ? { callId: lastCall.id, at: iso(lastCall.startedAt), durationSeconds: lastCall.durationSeconds, by: lastCall.callerName, transcriptStart: lastCallText } : null,
    yourAccess: lead.accessLevel, canAct: leadAccess.atLeast(lead.accessLevel, 'manage')
  };
}

module.exports = {
  ACTIVITY_TYPES, FOLLOWUP_TYPES, NOTE_CATEGORIES, PRIORITIES,
  requireManage, requireView, addActivity, updateActivity, deleteActivity, listNotes,
  createFollowup, updateFollowup, linkCallToFollowup, myFollowups, timeline, summary, iso
};
