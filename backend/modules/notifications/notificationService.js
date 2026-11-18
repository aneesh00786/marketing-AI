const { all, get, run } = require('../../db/database');
const leadAccess = require('../../lib/leadAccess');

/**
 * The bell: notifications for the signed-in person in this workspace.
 *
 * Each source below finds what currently needs the person's attention (their overdue follow-ups, leads given to them,
 * a failed post they scheduled …). Every item has a stable key (e.g. "followup:42:overdue"), so it is stored once in
 * user_notifications, keeps its read state, and is marked resolved when the source no longer reports it (the
 * follow-up was completed, the draft approved). Only what the person may see is included: lead items follow lead
 * access, mail items need the mail capabilities, and one person's items are never shown to another.
 */
const SYNC_EVERY_MS = 30 * 1000;
const lastSync = new Map();
const LIST_LIMIT = 50;
const has = (ctx, cap) => !!ctx.auth.capabilities?.has?.(cap);
const ws = ctx => ctx.auth.workspaceId;
const me = ctx => Number(ctx.auth.userId) || 0;
const safe = p => p.catch(err => { if (/ER_NO_SUCH_TABLE|ER_BAD_FIELD_ERROR/.test(err.code || '')) return []; throw err; });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code, expose: true });

/** Each source: (ctx) → [{ key, kind, title, detail, tone, icon, link, at }]. */
const SOURCES = [
  // Follow-ups assigned to me: overdue, due within a day, and newly given to me by someone else.
  async ctx => {
    if (!has(ctx, 'leads.view')) return [];
    const vis = leadAccess.visibleSql(ctx, 'l');
    const rows = await safe(all(`SELECT f.id, f.title, f.due_at, f.assigned_by, f.assigned_at, l.id lead_id, l.name lead_name,
        CASE WHEN f.due_at < UTC_TIMESTAMP() THEN 'overdue' WHEN f.due_at <= UTC_TIMESTAMP() + INTERVAL 1 DAY THEN 'due' ELSE 'later' END state
      FROM lead_followups f JOIN leads l ON l.id = f.lead_id AND l.workspace_id = f.workspace_id
      WHERE f.workspace_id = ? AND f.assigned_user_id = ? AND f.status = 'pending' AND ${vis.sql}
        AND (f.due_at <= UTC_TIMESTAMP() + INTERVAL 1 DAY OR (f.assigned_by IS NOT NULL AND f.assigned_by <> f.assigned_user_id AND f.assigned_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY))
      ORDER BY f.due_at LIMIT 100`, [ws(ctx), me(ctx), ...vis.params]));
    const out = [];
    for (const f of rows) {
      const link = { route: 'leads', leadId: f.lead_id };
      if (f.state === 'overdue') out.push({ key: `followup:${f.id}:overdue`, kind: 'followup_overdue', title: `Overdue follow-up: ${clip(f.title, 80)}`, detail: f.lead_name, tone: 'danger', icon: 'calendar', link, at: f.due_at });
      else if (f.state === 'due') out.push({ key: `followup:${f.id}:due`, kind: 'followup_due', title: `Follow-up due soon: ${clip(f.title, 80)}`, detail: f.lead_name, tone: 'warning', icon: 'calendar', link, at: f.due_at });
      if (f.assigned_by && f.assigned_by !== me(ctx) && f.assigned_at && new Date(f.assigned_at) >= new Date(Date.now() - 7 * 86400000)) {
        out.push({ key: `followup:${f.id}:assigned`, kind: 'followup_assigned', title: `Follow-up assigned to you: ${clip(f.title, 80)}`, detail: f.lead_name, tone: 'info', icon: 'leads', link, at: f.assigned_at });
      }
    }
    return out;
  },
  // Leads given to me by someone else in the last 7 days (one item per assignment, however many leads it moved).
  async ctx => {
    if (!has(ctx, 'leads.view')) return [];
    const rows = await safe(all(`SELECT MIN(a.id) id, a.actor_user_id actor, MIN(a.created_at) at, COUNT(*) n, MIN(CAST(a.resource_id AS UNSIGNED)) lead_id,
        COALESCE(NULLIF(u.display_name, ''), u.email) actor_name
      FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.workspace_id = ? AND a.action = 'leads.owner_changed' AND a.created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.owner')) AS UNSIGNED) = ? AND (a.actor_user_id IS NULL OR a.actor_user_id <> ?)
      GROUP BY a.actor_user_id, actor_name, DATE_FORMAT(a.created_at, '%Y%m%d%H%i') ORDER BY at DESC LIMIT 20`, [ws(ctx), me(ctx), me(ctx)]));
    return rows.map(r => ({
      key: `lead_assigned:${r.id}`, kind: 'lead_assigned', title: r.n > 1 ? `${plural(Number(r.n), 'lead')} assigned to you` : 'A lead was assigned to you',
      detail: r.actor_name ? `by ${r.actor_name}` : null, tone: 'info', icon: 'leads', link: r.n > 1 ? { route: 'leads', leadView: 'mine' } : { route: 'leads', leadId: Number(r.lead_id) }, at: r.at
    }));
  },
  // New hot leads of mine (AI category Hot, added in the last 7 days).
  async ctx => {
    if (!has(ctx, 'leads.view')) return [];
    const rows = await safe(all(`SELECT l.id, l.name, l.company_name, l.created_at FROM leads l
      WHERE l.workspace_id = ? AND l.owner_user_id = ? AND l.ai_category = 'Hot' AND l.created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY ORDER BY l.id DESC LIMIT 20`, [ws(ctx), me(ctx)]));
    return rows.map(l => ({ key: `hot:${l.id}`, kind: 'hot_lead', title: `Hot lead: ${clip(l.name, 80)}`, detail: l.company_name || 'High purchase intent', tone: 'info', icon: 'leads', link: { route: 'leads', leadId: l.id }, at: l.created_at }));
  },
  // My calls whose transcript failed (last 7 days).
  async ctx => {
    const rows = await safe(all(`SELECT c.id, c.started_at, c.lead_id, COALESCE(l.name, c.name, c.phone) who FROM crm_call_logs c LEFT JOIN leads l ON l.id = c.lead_id
      WHERE c.user_id = ? AND c.transcript_status = 'failed' AND c.started_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY
        AND (c.lead_workspace_id = ? OR c.campaign_id IN (SELECT id FROM mail_campaigns WHERE workspace_id = ?)) ORDER BY c.id DESC LIMIT 20`, [me(ctx), ws(ctx), ws(ctx)]));
    return rows.map(c => ({ key: `call:${c.id}:transcript`, kind: 'transcript_failed', title: 'Call transcript failed', detail: c.who, tone: 'warning', icon: 'phone',
      link: c.lead_id ? { route: 'leads', leadId: c.lead_id } : { route: 'emails', mailSection: 'campaigns' }, at: c.started_at }));
  },
  // Unread urgent emails in the inbox (people who read mail).
  async ctx => {
    if (!has(ctx, 'mail.view') && !has(ctx, 'inbox.view')) return [];
    const rows = await safe(all(`SELECT id, subject, sender, sender_email, received_at FROM emails
      WHERE workspace_id = ? AND COALESCE(is_read, 0) = 0 AND (is_urgent = 1 OR ai_priority = 'Urgent') AND received_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY
      ORDER BY received_at DESC LIMIT 20`, [ws(ctx)]));
    return rows.map(e => ({ key: `email:${e.id}:urgent`, kind: 'email_urgent', title: `Urgent email: ${clip(e.subject || '(no subject)', 80)}`, detail: e.sender || e.sender_email,
      tone: 'danger', icon: 'mail', link: { route: 'emails', mailSection: 'inbox', emailId: e.id }, at: e.received_at }));
  },
  // Drafts waiting for approval (people who may approve and send).
  async ctx => {
    if (!has(ctx, 'mail.send')) return [];
    const rows = await safe(all(`SELECT id, subject, recipient_name, recipient_email, updated_at FROM email_drafts
      WHERE workspace_id = ? AND status = 'Pending Approval' ORDER BY updated_at DESC LIMIT 20`, [ws(ctx)]));
    return rows.map(d => ({ key: `draft:${d.id}:approval`, kind: 'draft_approval', title: `Draft awaiting approval: ${clip(d.subject || '(no subject)', 80)}`,
      detail: d.recipient_name || d.recipient_email, tone: 'warning', icon: 'drafts', link: { route: 'emails', mailSection: 'approvals' }, at: d.updated_at }));
  },
  // Social posts I scheduled that failed or need review (last 7 days).
  async ctx => {
    const rows = await safe(all(`SELECT j.id, j.status, j.last_error, j.updated_at, c.title FROM publishing_jobs j LEFT JOIN content_items c ON c.id = j.content_item_id
      WHERE j.workspace_id = ? AND j.requested_by = ? AND j.status IN ('failed', 'needs_review') AND j.updated_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY ORDER BY j.id DESC LIMIT 20`, [ws(ctx), me(ctx)]));
    return rows.map(j => ({ key: `publish:${j.id}:${j.status}`, kind: 'publish_failed', title: j.status === 'failed' ? `Post failed to publish: ${clip(j.title || 'Social post', 70)}` : `Post needs review: ${clip(j.title || 'Social post', 70)}`,
      detail: clip(j.last_error, 120) || null, tone: 'danger', icon: 'social', link: { route: 'social', section: 'queue', status: 'failed' }, at: j.updated_at }));
  },
  // My AI generations (posters, videos …) that finished or failed in the last 3 days.
  async ctx => {
    const rows = await safe(all(`SELECT id, kind, purpose, status, error, updated_at, completed_at, campaign_id FROM social_content_generations
      WHERE workspace_id = ? AND user_id = ? AND status IN ('completed', 'failed') AND updated_at >= UTC_TIMESTAMP() - INTERVAL 3 DAY
        AND kind IN ('image', 'video', 'carousel') ORDER BY id DESC LIMIT 20`, [ws(ctx), me(ctx)]));
    const what = k => ({ image: 'Poster', video: 'Video', carousel: 'Carousel' })[k] || 'Content';
    return rows.map(g => ({ key: `gen:${g.id}:${g.status}`, kind: g.status === 'failed' ? 'generation_failed' : 'generation_done',
      title: g.status === 'failed' ? `${what(g.kind)} generation failed` : `${what(g.kind)} is ready`, detail: g.status === 'failed' ? clip(g.error, 120) : 'Review it in the content library',
      tone: g.status === 'failed' ? 'warning' : 'info', icon: 'sparkles', link: g.campaign_id ? { route: 'social', section: 'campaigns', campaignId: g.campaign_id } : { route: 'social', section: 'library' },
      at: g.completed_at || g.updated_at }));
  },
  // Demos booked for the next two days (the Demos module), for people who work with leads.
  async ctx => {
    if (!has(ctx, 'leads.view')) return [];
    const rows = await safe(all(`SELECT id, customer_name, contact_name, service, COALESCE(appointment_time, TIMESTAMP(date, COALESCE(time, '09:00:00'))) at FROM appointments
      WHERE workspace_id = ? AND COALESCE(status, '') NOT IN ('Cancelled', 'Completed', 'cancelled', 'completed')
        AND COALESCE(appointment_time, TIMESTAMP(date, COALESCE(time, '09:00:00'))) BETWEEN UTC_TIMESTAMP() AND UTC_TIMESTAMP() + INTERVAL 2 DAY ORDER BY at LIMIT 20`, [ws(ctx)]));
    return rows.map(a => ({ key: `appt:${a.id}`, kind: 'demo_scheduled', title: `Demo: ${clip(a.customer_name || a.contact_name || 'Customer', 80)}`, detail: a.service || 'Scheduled demo',
      tone: 'info', icon: 'calendar', link: { route: 'appointments' }, at: a.at }));
  },
  // Scheduled performance reports I set up that could not be sent.
  async ctx => {
    const rows = await safe(all(`SELECT id, name, last_error, last_sent_at FROM performance_report_schedules
      WHERE workspace_id = ? AND created_by = ? AND last_error IS NOT NULL AND last_sent_at >= UTC_TIMESTAMP() - INTERVAL 14 DAY`, [ws(ctx), me(ctx)]));
    return rows.map(s => ({ key: `report:${s.id}:${new Date(s.last_sent_at).getTime()}`, kind: 'report_failed', title: `Scheduled report not sent: ${clip(s.name, 80)}`,
      detail: clip(s.last_error, 120), tone: 'warning', icon: 'dashboard', link: { route: 'performance' }, at: s.last_sent_at }));
  }
];

/** Runs the sources and stores what they report; items no source reports any more are marked resolved. */
async function sync(ctx) {
  const k = `${ws(ctx)}:${me(ctx)}`;
  if (Date.now() - (lastSync.get(k) || 0) < SYNC_EVERY_MS) return;
  lastSync.set(k, Date.now());
  const results = await Promise.all(SOURCES.map(s => s(ctx).catch(err => { console.warn('[notifications] source failed:', err.message); return null; })));
  if (results.some(r => r === null)) lastSync.delete(k); // try again next time; do not resolve what a failed source would report
  const items = results.filter(Boolean).flat().filter(i => i.at);
  for (const i of items) {
    await run(`INSERT INTO user_notifications (workspace_id, user_id, kind, ref_key, title, detail, tone, icon, link_json, occurred_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE title = VALUES(title), detail = VALUES(detail), tone = VALUES(tone), icon = VALUES(icon), link_json = VALUES(link_json), resolved_at = NULL`,
    [ws(ctx), me(ctx), i.kind, i.key.slice(0, 120), clip(i.title, 200), i.detail ? clip(i.detail, 300) : null, i.tone, i.icon, JSON.stringify(i.link).slice(0, 500), i.at]);
  }
  // Resolve what is no longer current (only when every source answered).
  if (!results.some(r => r === null)) {
    const keys = items.map(i => i.key.slice(0, 120));
    await run(`UPDATE user_notifications SET resolved_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND user_id = ? AND resolved_at IS NULL
      ${keys.length ? `AND ref_key NOT IN (${keys.map(() => '?').join(',')})` : ''}`, [ws(ctx), me(ctx), ...keys]);
  }
  // Housekeeping: resolved items older than 30 days are removed.
  await run('DELETE FROM user_notifications WHERE workspace_id = ? AND user_id = ? AND resolved_at < UTC_TIMESTAMP() - INTERVAL 30 DAY', [ws(ctx), me(ctx)]);
}

const present = r => {
  let link = null;
  try { link = r.link_json ? JSON.parse(r.link_json) : null; } catch { link = null; }
  return { id: r.id, kind: r.kind, title: r.title, detail: r.detail, tone: r.tone, icon: r.icon, link, at: r.occurred_at, createdAt: r.created_at, read: !!r.read_at };
};

/** The person's current notifications (newest first) and how many are unread. */
async function list(ctx) {
  if (!me(ctx)) throw httpError(401, 'Authentication required.', 'UNAUTHENTICATED');
  await sync(ctx);
  const rows = await all(`SELECT * FROM user_notifications WHERE workspace_id = ? AND user_id = ? AND resolved_at IS NULL
    ORDER BY (read_at IS NULL) DESC, occurred_at DESC LIMIT ${LIST_LIMIT}`, [ws(ctx), me(ctx)]);
  const unread = await get('SELECT COUNT(*) n FROM user_notifications WHERE workspace_id = ? AND user_id = ? AND resolved_at IS NULL AND read_at IS NULL', [ws(ctx), me(ctx)]);
  return { notifications: rows.map(present), unread: Number(unread?.n || 0) };
}

async function markRead(ctx, id) {
  const r = await run('UPDATE user_notifications SET read_at = COALESCE(read_at, UTC_TIMESTAMP()) WHERE id = ? AND workspace_id = ? AND user_id = ?', [Number(id), ws(ctx), me(ctx)]);
  if (!r.changes) throw httpError(404, 'Notification not found.', 'NOT_FOUND');
  return { read: true };
}

async function markAllRead(ctx) {
  const r = await run('UPDATE user_notifications SET read_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND user_id = ? AND resolved_at IS NULL AND read_at IS NULL', [ws(ctx), me(ctx)]);
  return { marked: r.changes || 0 };
}

/** For tests: forget when each person was last synced. */
function resetThrottle() { lastSync.clear(); }

module.exports = { list, markRead, markAllRead, sync, resetThrottle, SOURCES };
