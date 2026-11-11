const { all, get, run } = require('../../db/database');
const { ROLES } = require('../../lib/permissions');

/**
 * Staff targets: definitions (stored in staff_targets) and the pure rules that turn a target plus the recorded
 * figures into progress and a status. The figures themselves come from the performance report (performanceService),
 * so a target always agrees with the dashboard.
 */
const METRICS = {
  leads_assigned: { label: 'Leads assigned', get: r => r.leads.assignedInPeriod },
  leads_generated: { label: 'Leads generated', get: r => r.leads.created },
  leads_contacted: { label: 'Leads contacted', get: r => r.leads.contactedInPeriod },
  leads_converted: { label: 'Leads converted', get: r => r.leads.wonInPeriod },
  followups_completed: { label: 'Follow-ups completed', get: r => r.followups.completed },
  followup_on_time_rate: { label: 'On-time follow-ups', unit: '%', rate: true, get: r => r.followups.onTimeRate },
  calls_made: { label: 'Calls made', get: r => r.calls.made },
  calls_connected: { label: 'Calls connected', get: r => r.calls.answered },
  talk_minutes: { label: 'Call talk time', unit: 'min', get: r => r.calls.talkMinutes },
  emails_sent: { label: 'Emails sent', get: r => r.emails.sent + r.emails.productEmails },
  // Email campaigns sent plus social campaigns created in the period.
  campaign_contributions: { label: 'Campaign contributions', get: r => r.emails.campaignsSent + r.social.campaigns }
};
const PERIODS = ['daily', 'weekly', 'monthly', 'quarterly', 'custom'];
const PERIOD_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', custom: 'Custom' };

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code, expose: true });
const D = s => new Date(`${s}T00:00:00Z`);
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(D(s).getTime() + n * 86400000));
const isYmd = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(D(v).getTime());
const toYmd = v => (v instanceof Date ? ymd(v) : String(v || '').slice(0, 10));

/** The cycle of a period type that contains the anchor day: { from, to } as local dates. */
function cycleFor(type, anchor, target) {
  const a = D(anchor);
  if (type === 'daily') return { from: anchor, to: anchor };
  if (type === 'weekly') { const from = addDays(anchor, -((a.getUTCDay() + 6) % 7)); return { from, to: addDays(from, 6) }; }
  if (type === 'monthly') {
    const from = ymd(new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1)));
    return { from, to: ymd(new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 0))) };
  }
  if (type === 'quarterly') {
    const q = Math.floor(a.getUTCMonth() / 3) * 3;
    return { from: ymd(new Date(Date.UTC(a.getUTCFullYear(), q, 1))), to: ymd(new Date(Date.UTC(a.getUTCFullYear(), q + 3, 0))) };
  }
  return { from: toYmd(target.start_date), to: toYmd(target.end_date) };
}

/** The cycle just before one (same length for custom ranges). */
function previousCycle(type, cycle) {
  if (type === 'custom') {
    const days = Math.round((D(cycle.to) - D(cycle.from)) / 86400000) + 1;
    return { from: addDays(cycle.from, -days), to: addDays(cycle.from, -1) };
  }
  return cycleFor(type, addDays(cycle.from, -1));
}

function cycleLabel(type, c) {
  const f = D(c.from);
  const mon = d => d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  if (type === 'daily') return `${f.getUTCDate()} ${mon(f)}`;
  if (type === 'monthly') return `${mon(f)} ${f.getUTCFullYear()}`;
  if (type === 'quarterly') return `Q${Math.floor(f.getUTCMonth() / 3) + 1} ${f.getUTCFullYear()}`;
  const t = D(c.to);
  return `${f.getUTCDate()} ${mon(f)} – ${t.getUTCDate()} ${mon(t)}`;
}

/** Does the target apply in this cycle (its effective dates overlap the cycle)? */
function applies(target, cycle) {
  const start = toYmd(target.start_date);
  const end = target.end_date ? toYmd(target.end_date) : null;
  return cycle.to >= start && (!end || cycle.from <= end);
}

/**
 * Status of a target in a cycle, given the actual value and today (local date):
 * not_started · on_track · at_risk · achieved · exceeded · missed (the cycle ended short of the target).
 * Counts are judged against the pace (share of the cycle gone by); a rate against the target itself.
 */
function status({ actual, target, rate, cycle, today }) {
  const days = Math.round((D(cycle.to) - D(cycle.from)) / 86400000) + 1;
  const started = today >= cycle.from;
  const ended = today > cycle.to;
  const elapsed = !started ? 0 : ended ? 1 : (Math.round((D(today) - D(cycle.from)) / 86400000) + 1) / days;
  if (!started) return { status: 'not_started', pct: null, elapsed: 0, expected: 0 };
  if (rate) {
    if (actual === null || actual === undefined) return { status: ended ? 'missed' : 'not_started', pct: null, elapsed, expected: target };
    const pct = Math.round((actual / target) * 1000) / 10;
    if (actual >= target) return { status: actual >= Math.min(100, target * 1.1) && actual > target ? 'exceeded' : 'achieved', pct, elapsed, expected: target };
    return { status: ended ? 'missed' : 'at_risk', pct, elapsed, expected: target };
  }
  const v = Number(actual) || 0;
  const pct = Math.round((v / target) * 1000) / 10;
  if (pct >= 110) return { status: 'exceeded', pct, elapsed, expected: target * elapsed };
  if (pct >= 100) return { status: 'achieved', pct, elapsed, expected: target * elapsed };
  if (ended) return { status: 'missed', pct, elapsed, expected: target };
  if (v === 0 && elapsed < 0.25) return { status: 'not_started', pct, elapsed, expected: target * elapsed };
  return { status: pct >= elapsed * 100 * 0.9 ? 'on_track' : 'at_risk', pct, elapsed, expected: Math.round(target * elapsed * 10) / 10 };
}

// ------------------------------------------------------------------ definitions (CRUD)

const present = t => ({
  id: t.id, scope: t.scope, userId: t.user_id, role: t.role, metric: t.metric, metricLabel: METRICS[t.metric]?.label || t.metric,
  unit: METRICS[t.metric]?.unit || null, periodType: t.period_type, periodLabel: PERIOD_LABEL[t.period_type] || t.period_type,
  target: Number(t.target_value), startDate: toYmd(t.start_date), endDate: t.end_date ? toYmd(t.end_date) : null, note: t.note || null,
  updatedAt: t.updated_at
});

async function listDefinitions(workspaceId) {
  return (await all('SELECT * FROM staff_targets WHERE workspace_id = ? ORDER BY scope, role, user_id, metric, period_type', [workspaceId]).catch(() => [])).map(present);
}

/** Checks and normalises a target from the request body. */
async function validate(workspaceId, body) {
  const b = body || {};
  const scope = b.scope === 'role' ? 'role' : b.scope === 'member' ? 'member' : null;
  if (!scope) throw httpError(400, 'Choose whether the target is for a person or a role.', 'VALIDATION_ERROR');
  let userId = null; let role = null;
  if (scope === 'member') {
    userId = Number(b.userId);
    const m = Number.isInteger(userId) && await get('SELECT user_id FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [workspaceId, userId]);
    if (!m) throw httpError(400, 'That person is not a member of this workspace.', 'VALIDATION_ERROR');
  } else {
    role = String(b.role || '');
    if (!ROLES.includes(role)) throw httpError(400, 'Unknown role.', 'VALIDATION_ERROR');
  }
  const metric = String(b.metric || '');
  if (!METRICS[metric]) throw httpError(400, 'Unknown measure.', 'VALIDATION_ERROR');
  const periodType = String(b.periodType || '');
  if (!PERIODS.includes(periodType)) throw httpError(400, 'Choose daily, weekly, monthly, quarterly or custom.', 'VALIDATION_ERROR');
  const value = Number(b.target);
  if (!Number.isFinite(value) || value <= 0) throw httpError(400, 'The target must be a number above 0.', 'VALIDATION_ERROR');
  if (METRICS[metric].rate && value > 100) throw httpError(400, 'A percentage target cannot be above 100.', 'VALIDATION_ERROR');
  if (value > 1e9) throw httpError(400, 'The target is too large.', 'VALIDATION_ERROR');
  const startDate = b.startDate ? String(b.startDate) : null;
  const endDate = b.endDate ? String(b.endDate) : null;
  if (startDate && !isYmd(startDate)) throw httpError(400, 'The start date is not valid.', 'VALIDATION_ERROR');
  if (endDate && !isYmd(endDate)) throw httpError(400, 'The end date is not valid.', 'VALIDATION_ERROR');
  if (periodType === 'custom' && (!startDate || !endDate)) throw httpError(400, 'A custom target needs a start and an end date.', 'VALIDATION_ERROR');
  if (startDate && endDate && endDate < startDate) throw httpError(400, 'The end date is before the start date.', 'VALIDATION_ERROR');
  return { scope, userId, role, metric, periodType, value, startDate, endDate, note: b.note ? String(b.note).slice(0, 300) : null };
}

async function createTarget(workspaceId, actorId, body, today) {
  const t = await validate(workspaceId, body);
  // One target per person (or role), measure and period type: replace instead of duplicating.
  const dup = await get(`SELECT id FROM staff_targets WHERE workspace_id = ? AND scope = ? AND metric = ? AND period_type = ? AND ${t.scope === 'member' ? 'user_id = ?' : 'role = ?'}
    AND (period_type <> 'custom' OR (start_date = ? AND end_date = ?))`, [workspaceId, t.scope, t.metric, t.periodType, t.scope === 'member' ? t.userId : t.role, t.startDate, t.endDate]);
  if (dup) return updateTarget(workspaceId, actorId, dup.id, body);
  const r = await run(`INSERT INTO staff_targets (workspace_id, scope, user_id, role, metric, period_type, target_value, start_date, end_date, note, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [workspaceId, t.scope, t.userId, t.role, t.metric, t.periodType, t.value, t.startDate || cycleFor(t.periodType === 'custom' ? 'daily' : t.periodType, today).from, t.endDate, t.note, actorId, actorId]);
  return present(await get('SELECT * FROM staff_targets WHERE id = ?', [r.lastID]));
}

async function updateTarget(workspaceId, actorId, id, body) {
  const row = await get('SELECT * FROM staff_targets WHERE id = ? AND workspace_id = ?', [Number(id), workspaceId]);
  if (!row) throw httpError(404, 'Target not found.', 'NOT_FOUND');
  const t = await validate(workspaceId, { scope: row.scope, userId: row.user_id, role: row.role, metric: row.metric, periodType: row.period_type,
    startDate: toYmd(row.start_date), endDate: row.end_date ? toYmd(row.end_date) : null, note: row.note, ...body, target: body?.target ?? row.target_value });
  await run(`UPDATE staff_targets SET scope = ?, user_id = ?, role = ?, metric = ?, period_type = ?, target_value = ?, start_date = COALESCE(?, start_date), end_date = ?, note = ?, updated_by = ?, updated_at = UTC_TIMESTAMP()
    WHERE id = ? AND workspace_id = ?`, [t.scope, t.userId, t.role, t.metric, t.periodType, t.value, t.startDate, t.endDate, t.note, actorId, row.id, workspaceId]);
  return present(await get('SELECT * FROM staff_targets WHERE id = ?', [row.id]));
}

async function deleteTarget(workspaceId, id) {
  const r = await run('DELETE FROM staff_targets WHERE id = ? AND workspace_id = ?', [Number(id), workspaceId]);
  if (!r.changes) throw httpError(404, 'Target not found.', 'NOT_FOUND');
}

/**
 * The targets that apply to each member: their own, else their role's (per measure and period type).
 * Returns Map(userId → [definition]).
 */
function forMembers(definitions, members) {
  const out = new Map();
  for (const m of members) {
    const own = definitions.filter(t => t.scope === 'member' && t.userId === m.id);
    const ownKeys = new Set(own.map(t => `${t.metric}|${t.periodType}`));
    const byRole = definitions.filter(t => t.scope === 'role' && t.role === m.role && !ownKeys.has(`${t.metric}|${t.periodType}`));
    out.set(m.id, [...own, ...byRole]);
  }
  return out;
}

module.exports = { METRICS, PERIODS, PERIOD_LABEL, cycleFor, previousCycle, cycleLabel, applies, status, listDefinitions, createTarget, updateTarget, deleteTarget, forMembers, present };
