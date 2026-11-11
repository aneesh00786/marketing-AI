const scoring = require('./scoring');
const targets = require('./targets');
const { all, get } = require('../../db/database');
const { audit } = require('../../lib/audit');

/**
 * Team performance (Workspace → Team Performance): what each member of the workspace did in a
 * period, counted only from what the app recorded. Nothing is estimated or scored by AI; the performance
 * score is a weighted average of rates the workspace's admins configure (scoring.js).
 *
 *   Leads        assigned now (and Won / Lost / open), created, imported, from AI Lead Discovery,
 *                assigned to them in the period, never contacted, updated, speed to first contact
 *   Follow-ups   due in the period: completed (on time / late), cancelled; overdue now; pending
 *   Calls        made in the period (from leads or campaigns of this workspace): answered, talk time
 *   Activities   notes, meetings, WhatsApp, SMS and other logged activities
 *   Email        one-to-one emails sent, product email batches and their emails, email campaigns
 *                created and sent, with recipients, delivered, opened and clicked
 *   Social       social campaigns, posts created, posts published, AI content generated
 *   Other        AI Lead Discovery searches, AI Campaign programs and outreach sequences created
 *
 * Owners and Admins see every member, as do members given "View team performance" (Members →
 * Permissions); anyone else sees only their own figures. Periods and days follow the workspace's time
 * zone (workspaces.timezone, else the social settings' time zone, else UTC). Former members appear when
 * they have work in the period, marked as former.
 */
const ws = ctx => ctx.auth.workspaceId;
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code, expose: true });
const has = (ctx, cap) => !!ctx.auth.capabilities?.has?.(cap);
const isAdmin = ctx => has(ctx, 'members.manage') || !!ctx.auth.platformAccess;
const isManager = ctx => !!ctx.auth.capabilities?.has?.('members.manage') || !!ctx.auth.capabilities?.has?.('performance.view_team') || !!ctx.auth.platformAccess;
/**
 * What this person may do in Team Performance. Owners/Admins: everything. Others start with their own figures;
 * "View team performance" adds the team and everyone's individual pages; compare, export (beyond their own),
 * call transcripts of others, scoring, targets and scheduled reports are each a separate permission
 * (Members → Permissions). Checked here, on the server, for every request.
 */
function permissions(ctx) {
  const admin = isAdmin(ctx);
  const team = isManager(ctx);
  return {
    team,
    compare: admin || (team && has(ctx, 'performance.compare')),
    exportTeam: admin || (team && has(ctx, 'performance.export')),
    transcripts: admin || (team && has(ctx, 'performance.view_transcripts')),
    targets: admin || has(ctx, 'performance.manage_targets'),
    scoring: admin || has(ctx, 'performance.configure_scoring'),
    schedule: admin || (team && has(ctx, 'performance.schedule_reports'))
  };
}

const CONTACT_TYPES = ['meeting', 'call', 'email', 'whatsapp', 'sms'];
const sqlTime = d => d.toISOString().slice(0, 19).replace('T', ' ');
const n = v => Number(v || 0);
const safe = p => p.catch(err => { if (!/ER_NO_SUCH_TABLE|ER_BAD_FIELD_ERROR/.test(err.code || '')) throw err; return []; });

/** Minutes the zone is ahead of UTC at a moment (Asia/Kolkata: +330). Unknown zones: 0. */
function offsetMinutes(tz, at = new Date()) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(at).map(x => [x.type, x.value]));
    return Math.round((Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - at.getTime()) / 60000);
  } catch { return 0; }
}

/** The workspace's time zone: its own setting, else the social settings' one, else UTC. */
async function workspaceTz(W) {
  const valid = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
  const w = await get('SELECT timezone FROM workspaces WHERE id = ?', [W]).catch(() => null);
  let tz = w?.timezone && w.timezone !== 'UTC' ? w.timezone : null;
  if (!tz) tz = (await get('SELECT timezone FROM social_settings WHERE workspace_id = ?', [W]).catch(() => null))?.timezone || null;
  return tz && valid(tz) ? tz : 'UTC';
}

/**
 * The period: from/to as local dates of the workspace (YYYY-MM-DD, inclusive), default the last 30 days;
 * at most 366 days. s/e are its UTC bounds for the database; off turns stored UTC times into local days.
 */
function period(query = {}, tz = 'UTC', { anyLength = false } = {}) {
  const off = offsetMinutes(tz);
  const day = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? new Date(`${v}T00:00:00Z`) : null);
  const today = new Date(new Date(Date.now() + off * 60000).toISOString().slice(0, 10) + 'T00:00:00Z');
  const to = day(query.to) || today;
  const from = day(query.from) || new Date(to.getTime() - 29 * 86400000);
  if (from > to) throw httpError(400, 'The start date is after the end date.', 'VALIDATION_ERROR');
  if (!anyLength && (to - from) / 86400000 > 366) throw httpError(400, 'Choose at most one year.', 'VALIDATION_ERROR');
  const s0 = new Date(from.getTime() - off * 60000);
  const e0 = new Date(to.getTime() + 86400000 - 1000 - off * 60000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), s: sqlTime(s0), e: sqlTime(e0), tz, off };
}

/** SQL for the local day of a stored UTC time (offset is an integer computed here, never user input). */
const localDay = (col, off) => `DATE(DATE_ADD(${col}, INTERVAL ${Number(off) | 0} MINUTE))`;

const byUser = (rows, key = 'u') => new Map(rows.map(r => [Number(r[key]), r]));

/** Calls of this workspace: from its leads or its email campaigns. */
const CALL_SCOPE = `(c.lead_workspace_id = ? OR c.campaign_id IN (SELECT id FROM mail_campaigns WHERE workspace_id = ?))`;

/**
 * Members shown: everyone active, plus former members who own leads or did something in the period
 * (so history is not lost when someone leaves); those are marked former.
 */
async function members(W, p) {
  const rows = await all(`SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.email) AS name, u.email, m.role, m.status, m.created_at joinedAt
    FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND (m.status = 'Active'
      OR EXISTS (SELECT 1 FROM leads l WHERE l.workspace_id = m.workspace_id AND l.owner_user_id = m.user_id)
      OR EXISTS (SELECT 1 FROM lead_followups f WHERE f.workspace_id = m.workspace_id AND f.assigned_user_id = m.user_id AND f.due_at BETWEEN ? AND ?)
      OR EXISTS (SELECT 1 FROM lead_activities a WHERE a.workspace_id = m.workspace_id AND a.performed_by = m.user_id AND a.activity_at BETWEEN ? AND ?)
      OR EXISTS (SELECT 1 FROM crm_call_logs c WHERE c.user_id = m.user_id AND (c.lead_workspace_id = m.workspace_id OR c.campaign_id IN (SELECT id FROM mail_campaigns WHERE workspace_id = m.workspace_id)) AND c.started_at BETWEEN ? AND ?)
      OR EXISTS (SELECT 1 FROM emails e WHERE e.workspace_id = m.workspace_id AND e.sent_by_user_id = m.user_id AND e.sent_at BETWEEN ? AND ?))
    ORDER BY (m.status = 'Active') DESC, name`, [W, p.s, p.e, p.s, p.e, p.s, p.e, p.s, p.e]).catch(() => all(`SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.email) AS name, u.email, m.role, m.status, m.created_at joinedAt
    FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.status = 'Active' ORDER BY name`, [W]));
  return rows.map(({ joinedAt, ...r }) => ({ ...r, former: r.status !== 'Active', joinedAt }));
}

/** "Contacted": a call, a contact activity (not a note) or an email sent to the lead's address. */
const CONTACT_EXISTS = alias => `(EXISTS (SELECT 1 FROM crm_call_logs c WHERE c.lead_workspace_id = ${alias}.workspace_id AND c.lead_id = ${alias}.id)
  OR EXISTS (SELECT 1 FROM lead_activities a WHERE a.workspace_id = ${alias}.workspace_id AND a.lead_id = ${alias}.id AND a.activity_type IN ('meeting', 'call', 'email', 'whatsapp', 'sms'))
  OR (${alias}.email IS NOT NULL AND ${alias}.email <> '' AND EXISTS (SELECT 1 FROM emails e WHERE e.workspace_id = ${alias}.workspace_id AND e.status = 'Sent' AND LOWER(TRIM(e.recipient_email)) = LOWER(TRIM(${alias}.email)))))`;


async function collect(W, s, e) {
  const q = (sql, params) => safe(all(sql, params));
  const [
    leadsNow, leadsCreated, assignedIn, leadUpdates, untouched,
    fuDue, fuOverdue, fuPending, calls, acts,
    oneToOne, batches, campCreated, campSent, social, posts, published, gens, discovery, programs, outreach,
    wonIn, contactedIn
  ] = await Promise.all([
    q(`SELECT owner_user_id u, COUNT(*) total, SUM(status = 'Won') won, SUM(status = 'Lost') lost FROM leads WHERE workspace_id = ? AND owner_user_id IS NOT NULL GROUP BY owner_user_id`, [W]),
    q(`SELECT created_by_user_id u, COUNT(*) total, SUM(lead_source = 'import') imported, SUM(lead_source = 'discovery') discovered
       FROM leads WHERE workspace_id = ? AND created_by_user_id IS NOT NULL AND created_at BETWEEN ? AND ? GROUP BY created_by_user_id`, [W, s, e]),
    q(`SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.owner')) AS UNSIGNED) u, COUNT(*) total FROM audit_logs
       WHERE workspace_id = ? AND action = 'leads.owner_changed' AND created_at BETWEEN ? AND ? AND JSON_EXTRACT(metadata_json, '$.owner') IS NOT NULL GROUP BY u`, [W, s, e]),
    q(`SELECT actor_user_id u, COUNT(*) total FROM audit_logs WHERE workspace_id = ? AND action = 'leads.updated' AND created_at BETWEEN ? AND ? GROUP BY actor_user_id`, [W, s, e]),
    q(`SELECT x.u, SUM(NOT x.c) total, SUM(x.c) contacted FROM (SELECT l.owner_user_id u, ${CONTACT_EXISTS('l')} c FROM leads l
       WHERE l.workspace_id = ? AND l.owner_user_id IS NOT NULL) x GROUP BY x.u`, [W]),
    q(`SELECT assigned_user_id u, COUNT(*) total, SUM(status = 'completed') done, SUM(status = 'completed' AND completed_at <= due_at) on_time,
         SUM(status = 'completed' AND completed_at > due_at) late, SUM(status = 'cancelled') cancelled, SUM(status = 'pending') pending,
         AVG(CASE WHEN status = 'completed' AND completed_at > due_at THEN TIMESTAMPDIFF(MINUTE, due_at, completed_at) END) late_minutes
       FROM lead_followups WHERE workspace_id = ? AND assigned_user_id IS NOT NULL AND due_at BETWEEN ? AND ? GROUP BY assigned_user_id`, [W, s, e]),
    q(`SELECT assigned_user_id u, COUNT(*) total FROM lead_followups WHERE workspace_id = ? AND status = 'pending' AND due_at < UTC_TIMESTAMP() GROUP BY assigned_user_id`, [W]),
    q(`SELECT assigned_user_id u, COUNT(*) total FROM lead_followups WHERE workspace_id = ? AND status = 'pending' AND due_at >= UTC_TIMESTAMP() GROUP BY assigned_user_id`, [W]),
    q(`SELECT c.user_id u, COUNT(*) total, SUM(c.answered = 1) answered, SUM(COALESCE(c.duration_seconds, 0)) seconds, SUM(c.transcript_status = 'done') transcribed,
         COUNT(DISTINCT c.lead_id) leads_called
       FROM crm_call_logs c WHERE ${CALL_SCOPE} AND c.started_at BETWEEN ? AND ? GROUP BY c.user_id`, [W, W, s, e]),
    q(`SELECT performed_by u, activity_type t, COUNT(*) total FROM lead_activities WHERE workspace_id = ? AND activity_at BETWEEN ? AND ? GROUP BY performed_by, activity_type`, [W, s, e]),
    // Every email sent from Mail Center (Compose, the lead panel, drafts and product emails), once each, by its sender.
    q(`SELECT e.sent_by_user_id u, COUNT(DISTINCT e.id) total,
         COUNT(DISTINCT CASE WHEN NOT EXISTS (SELECT 1 FROM email_drafts d WHERE d.workspace_id = e.workspace_id AND d.email_id = e.id AND d.batch_id IS NOT NULL) THEN e.id END) individual,
         COUNT(DISTINCT CASE WHEN t.delivered_at IS NOT NULL THEN e.id END) delivered, COUNT(DISTINCT CASE WHEN t.bounced_at IS NOT NULL THEN e.id END) bounced,
         COUNT(DISTINCT CASE WHEN t.track_opens = 1 AND t.first_open_at IS NOT NULL THEN e.id END) opened, COUNT(DISTINCT CASE WHEN t.track_opens = 1 THEN e.id END) openTracked,
         COUNT(DISTINCT CASE WHEN t.first_click_at IS NOT NULL THEN e.id END) clicked
       FROM emails e LEFT JOIN mail_message_tracking t ON t.workspace_id = e.workspace_id AND t.email_id = e.id
       WHERE e.workspace_id = ? AND e.status = 'Sent' AND e.sent_by_user_id IS NOT NULL AND e.sent_at BETWEEN ? AND ? GROUP BY e.sent_by_user_id`, [W, s, e]),
    q(`SELECT b.sent_by u, COUNT(DISTINCT b.id) batches, (SELECT COUNT(*) FROM email_drafts d WHERE d.workspace_id = b.workspace_id AND d.batch_id IN
         (SELECT id FROM mail_draft_batches x WHERE x.workspace_id = b.workspace_id AND x.sent_by = b.sent_by AND x.sent_at BETWEEN ? AND ?) AND d.status = 'Sent') emails
       FROM mail_draft_batches b WHERE b.workspace_id = ? AND b.sent_by IS NOT NULL AND b.sent_at BETWEEN ? AND ? GROUP BY b.workspace_id, b.sent_by`, [s, e, W, s, e]),
    q(`SELECT created_by u, COUNT(*) total FROM mail_campaigns WHERE workspace_id = ? AND created_at BETWEEN ? AND ? GROUP BY created_by`, [W, s, e]),
    q(`SELECT m.submitted_by u, COUNT(DISTINCT m.id) campaigns,
         (SELECT COUNT(*) FROM mail_campaign_recipients r WHERE r.campaign_id IN (SELECT id FROM mail_campaigns y WHERE y.workspace_id = m.workspace_id AND y.submitted_by = m.submitted_by AND y.submitted_at BETWEEN ? AND ?) AND r.status = 'sent') sent,
         (SELECT COUNT(*) FROM mail_message_tracking t WHERE t.workspace_id = m.workspace_id AND t.campaign_id IN (SELECT id FROM mail_campaigns y WHERE y.workspace_id = m.workspace_id AND y.submitted_by = m.submitted_by AND y.submitted_at BETWEEN ? AND ?) AND t.delivered_at IS NOT NULL) delivered,
         (SELECT COUNT(*) FROM mail_message_tracking t WHERE t.workspace_id = m.workspace_id AND t.campaign_id IN (SELECT id FROM mail_campaigns y WHERE y.workspace_id = m.workspace_id AND y.submitted_by = m.submitted_by AND y.submitted_at BETWEEN ? AND ?) AND t.first_open_at IS NOT NULL) opened,
         (SELECT COUNT(*) FROM mail_message_tracking t WHERE t.workspace_id = m.workspace_id AND t.campaign_id IN (SELECT id FROM mail_campaigns y WHERE y.workspace_id = m.workspace_id AND y.submitted_by = m.submitted_by AND y.submitted_at BETWEEN ? AND ?) AND t.first_click_at IS NOT NULL) clicked
       FROM mail_campaigns m WHERE m.workspace_id = ? AND m.submitted_by IS NOT NULL AND m.submitted_at BETWEEN ? AND ? GROUP BY m.workspace_id, m.submitted_by`, [s, e, s, e, s, e, s, e, W, s, e]),
    q(`SELECT created_by u, COUNT(*) total FROM campaigns WHERE workspace_id = ? AND created_at BETWEEN ? AND ? GROUP BY created_by`, [W, s, e]),
    q(`SELECT created_by u, COUNT(*) total FROM content_items WHERE workspace_id = ? AND created_at BETWEEN ? AND ? GROUP BY created_by`, [W, s, e]),
    q(`SELECT requested_by u, COUNT(*) total FROM publishing_jobs WHERE workspace_id = ? AND status = 'succeeded' AND completed_at BETWEEN ? AND ? GROUP BY requested_by`, [W, s, e]),
    q(`SELECT user_id u, COUNT(*) total FROM social_content_generations WHERE workspace_id = ? AND created_at BETWEEN ? AND ? GROUP BY user_id`, [W, s, e]),
    q(`SELECT created_by u, COUNT(*) total FROM lead_discovery_runs WHERE workspace_id = ? AND created_at BETWEEN ? AND ? GROUP BY created_by`, [W, s, e]),
    q(`SELECT created_by u, COUNT(*) total FROM campaign_programs WHERE workspace_id = ? AND created_at BETWEEN ? AND ? GROUP BY created_by`, [W, s, e]),
    q(`SELECT created_by u, COUNT(*) total FROM outreach_campaigns WHERE workspace_id = ? AND created_at BETWEEN ? AND ? GROUP BY created_by`, [W, s, e]),
    // Leads won in the period by their current owner (recorded status changes to Won).
    q(`SELECT l.owner_user_id u, COUNT(DISTINCT l.id) total FROM leads l JOIN automation_events ev ON ev.workspace_id = l.workspace_id AND ev.event_type = 'lead.status_changed'
         AND ev.subject_type = 'lead' AND ev.subject_id = l.id AND JSON_UNQUOTE(JSON_EXTRACT(ev.payload_json, '$.to')) = 'Won'
       WHERE l.workspace_id = ? AND l.owner_user_id IS NOT NULL AND l.status = 'Won' AND ev.created_at BETWEEN ? AND ? GROUP BY l.owner_user_id`, [W, s, e]),
    // Distinct leads each member contacted in the period: their calls, contact activities and emails to the lead's address.
    q(`SELECT x.u, COUNT(DISTINCT x.lead_ref) total FROM (
         SELECT c.user_id u, c.lead_id lead_ref FROM crm_call_logs c WHERE c.lead_workspace_id = ? AND c.lead_id IS NOT NULL AND c.started_at BETWEEN ? AND ?
         UNION ALL SELECT a.performed_by, a.lead_id FROM lead_activities a WHERE a.workspace_id = ? AND a.activity_type IN ('meeting', 'call', 'email', 'whatsapp', 'sms') AND a.activity_at BETWEEN ? AND ?
         UNION ALL SELECT e.sent_by_user_id, l.id FROM emails e JOIN leads l ON l.workspace_id = e.workspace_id AND l.email IS NOT NULL AND l.email <> '' AND LOWER(TRIM(l.email)) = LOWER(TRIM(e.recipient_email))
           WHERE e.workspace_id = ? AND e.status = 'Sent' AND e.sent_by_user_id IS NOT NULL AND e.sent_at BETWEEN ? AND ?) x WHERE x.u IS NOT NULL GROUP BY x.u`, [W, s, e, W, s, e, W, s, e])
  ]);
  return { leadsNow, leadsCreated, assignedIn, leadUpdates, untouched, fuDue, fuOverdue, fuPending, calls, acts, oneToOne, batches, campCreated, campSent, social, posts, published, gens, discovery, programs, outreach, wonIn, contactedIn };
}

/**
 * Speed to first contact, in one query: for each lead given to a member in the period (assigned by
 * someone, or created / imported by themselves and kept), the time until that member first called it,
 * logged a contact activity or emailed its address. Median hours and how many were contacted.
 */
async function firstContact(W, s, e) {
  const types = CONTACT_TYPES.map(() => '?').join(',');
  const rows = await safe(all(`SELECT x.lead_id, x.u, x.at,
      (SELECT MIN(c.started_at) FROM crm_call_logs c WHERE c.lead_workspace_id = ? AND c.lead_id = x.lead_id AND c.user_id = x.u AND c.started_at >= x.at) first_call,
      (SELECT MIN(a.activity_at) FROM lead_activities a WHERE a.workspace_id = ? AND a.lead_id = x.lead_id AND a.performed_by = x.u AND a.activity_type IN (${types}) AND a.activity_at >= x.at) first_activity,
      (SELECT MIN(m.sent_at) FROM emails m JOIN leads l2 ON l2.id = x.lead_id AND l2.workspace_id = m.workspace_id
         WHERE m.workspace_id = ? AND m.status = 'Sent' AND m.sent_by_user_id = x.u AND l2.email IS NOT NULL AND l2.email <> ''
           AND LOWER(TRIM(m.recipient_email)) = LOWER(TRIM(l2.email)) AND m.sent_at >= x.at) first_email
    FROM (
      SELECT CAST(a.resource_id AS UNSIGNED) lead_id, CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.owner')) AS UNSIGNED) u, MAX(a.created_at) at
        FROM audit_logs a WHERE a.workspace_id = ? AND a.action = 'leads.owner_changed' AND a.created_at BETWEEN ? AND ? AND JSON_EXTRACT(a.metadata_json, '$.owner') IS NOT NULL
        GROUP BY a.resource_id, u
      UNION ALL
      SELECT l.id, l.created_by_user_id, l.created_at FROM leads l
        WHERE l.workspace_id = ? AND l.created_by_user_id IS NOT NULL AND l.owner_user_id = l.created_by_user_id AND l.created_at BETWEEN ? AND ?
    ) x LIMIT 20000`, [W, W, ...CONTACT_TYPES, W, W, s, e, W, s, e]));
  // One entry per lead and member (the latest start if a lead was both created and assigned to them).
  const latest = new Map();
  for (const r of rows) {
    const k = `${r.lead_id}:${r.u}`;
    if (!latest.has(k) || new Date(r.at) > new Date(latest.get(k).at)) latest.set(k, r);
  }
  const out = new Map();
  for (const r of latest.values()) {
    const times = [r.first_call, r.first_activity, r.first_email].filter(Boolean).map(t => new Date(t).getTime());
    const m = out.get(Number(r.u)) || { given: 0, contacted: 0, hours: [] };
    m.given += 1;
    if (times.length) { m.contacted += 1; m.hours.push(Math.max(0, Math.min(...times) - new Date(r.at).getTime()) / 3600000); }
    out.set(Number(r.u), m);
  }
  const median = a => { if (!a.length) return null; const x = [...a].sort((p, q2) => p - q2); const mid = Math.floor(x.length / 2); return x.length % 2 ? x[mid] : (x[mid - 1] + x[mid]) / 2; };
  return new Map([...out].map(([u, m]) => [u, { given: m.given, contacted: m.contacted, medianHours: m.hours.length ? Math.round(median(m.hours) * 10) / 10 : null }]));
}

function rowFor(member, d, fc) {
  const g = (map, k = 'total') => n(map.get(member.id)?.[k]);
  const acts = {};
  for (const r of d.acts) if (Number(r.u) === member.id) acts[r.t] = n(r.total);
  const leads = byUser(d.leadsNow);
  const fu = byUser(d.fuDue);
  const calls = byUser(d.calls);
  const camp = byUser(d.campSent);
  const batch = byUser(d.batches);
  const assignedNow = g(leads);
  const won = g(leads, 'won');
  const fuTotal = g(fu);
  const fuDone = g(fu, 'done');
  const callsTotal = g(calls);
  const answered = g(calls, 'answered');
  const f = fc.get(member.id) || { given: 0, contacted: 0, medianHours: null };
  return {
    userId: member.id, name: member.name, email: member.email, role: member.role, former: !!member.former,
    leads: {
      assigned: assignedNow, won, lost: g(leads, 'lost'), open: assignedNow - won - g(leads, 'lost'),
      conversionRate: assignedNow ? Math.round((won / assignedNow) * 1000) / 10 : null,
      created: g(byUser(d.leadsCreated)), imported: g(byUser(d.leadsCreated), 'imported'), discovered: g(byUser(d.leadsCreated), 'discovered'),
      assignedInPeriod: g(byUser(d.assignedIn)), updated: g(byUser(d.leadUpdates)), neverContacted: g(byUser(d.untouched)), contacted: g(byUser(d.untouched), 'contacted'),
      // In the period: leads won (recorded change to Won) and distinct leads they contacted.
      wonInPeriod: g(byUser(d.wonIn || [])), contactedInPeriod: g(byUser(d.contactedIn || [])),
      periodConversionRate: g(byUser(d.contactedIn || [])) ? Math.round((g(byUser(d.wonIn || [])) / g(byUser(d.contactedIn || []))) * 1000) / 10 : null,
      firstContact: f
    },
    followups: {
      due: fuTotal, completed: fuDone, onTime: g(fu, 'on_time'), late: g(fu, 'late'), cancelled: g(fu, 'cancelled'), pending: g(fu, 'pending'),
      // Average lateness of the follow-ups completed after their due time (hours).
      avgDelayHours: fu.get(member.id)?.late_minutes == null ? null : Math.round(Number(fu.get(member.id).late_minutes) / 6) / 10,
      onTimeRate: fuDone ? Math.round((g(fu, 'on_time') / fuDone) * 1000) / 10 : null,
      completionRate: fuTotal ? Math.round((fuDone / fuTotal) * 1000) / 10 : null,
      overdueNow: g(byUser(d.fuOverdue)), upcoming: g(byUser(d.fuPending))
    },
    calls: {
      made: callsTotal, answered, missed: callsTotal - answered, answerRate: callsTotal ? Math.round((answered / callsTotal) * 1000) / 10 : null,
      leadsCalled: g(calls, 'leads_called'), perLead: g(calls, 'leads_called') ? Math.round((callsTotal / g(calls, 'leads_called')) * 10) / 10 : null,
      talkMinutes: Math.round(g(calls, 'seconds') / 6) / 10, avgMinutes: answered ? Math.round(g(calls, 'seconds') / answered / 6) / 10 : null,
      transcribed: g(calls, 'transcribed')
    },
    activities: {
      notes: acts.note || 0, meetings: acts.meeting || 0, whatsapp: acts.whatsapp || 0, sms: acts.sms || 0,
      other: (acts.call || 0) + (acts.email || 0) + (acts.general || 0),
      total: Object.values(acts).reduce((a, b) => a + b, 0)
    },
    emails: {
      // sent = individual emails (Compose, lead panel, drafts); productEmails = product email batches. Each email once.
      sent: g(byUser(d.oneToOne), 'individual'), productBatches: n(batch.get(member.id)?.batches), productEmails: g(byUser(d.oneToOne)) - g(byUser(d.oneToOne), 'individual'),
      openTracked: g(byUser(d.oneToOne), 'openTracked'), delivered: g(byUser(d.oneToOne), 'delivered'), bounced: g(byUser(d.oneToOne), 'bounced'), opened: g(byUser(d.oneToOne), 'opened'), clicked: g(byUser(d.oneToOne), 'clicked'),
      openRate: g(byUser(d.oneToOne), 'openTracked') ? Math.round((g(byUser(d.oneToOne), 'opened') / g(byUser(d.oneToOne), 'openTracked')) * 1000) / 10 : null,
      clickRate: g(byUser(d.oneToOne)) ? Math.round((g(byUser(d.oneToOne), 'clicked') / g(byUser(d.oneToOne))) * 1000) / 10 : null,
      campaignsCreated: g(byUser(d.campCreated)), campaignsSent: n(camp.get(member.id)?.campaigns),
      campaignRecipients: n(camp.get(member.id)?.sent), campaignDelivered: n(camp.get(member.id)?.delivered),
      campaignOpened: n(camp.get(member.id)?.opened), campaignClicked: n(camp.get(member.id)?.clicked)
    },
    social: { campaigns: g(byUser(d.social)), posts: g(byUser(d.posts)), published: g(byUser(d.published)), aiGenerations: g(byUser(d.gens)) },
    other: { discoverySearches: g(byUser(d.discovery)), aiCampaignPrograms: g(byUser(d.programs)), outreachSequences: g(byUser(d.outreach)) }
  };
}

/**
 * Day by day in the period (for the trend chart): calls made, follow-ups completed, emails sent
 * (one-to-one + product emails) and notes/activities, for the given members (null = everyone).
 */
async function daily(W, p, userIds = null) {
  const D = col => localDay(col, p.off);
  const only = (col) => (userIds ? ` AND ${col} IN (${userIds.map(() => '?').join(',')})` : '');
  const ids = userIds || [];
  const days = [];
  for (let d = new Date(`${p.from}T00:00:00Z`); d <= new Date(`${p.to}T00:00:00Z`); d = new Date(d.getTime() + 86400000)) days.push(d.toISOString().slice(0, 10));
  const dayKey = v => (v instanceof Date ? `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}` : String(v).slice(0, 10));
  const series = async (sql, params) => new Map((await safe(all(sql, params))).map(r => [dayKey(r.d), n(r.n)]));
  const [calls, followups, emails, acts, notes, meetings, created, assigned, contacted, connected, won] = await Promise.all([
    series(`SELECT ${D('c.started_at')} d, COUNT(*) n FROM crm_call_logs c WHERE ${CALL_SCOPE} AND c.started_at BETWEEN ? AND ?${only('c.user_id')} GROUP BY d`, [W, W, p.s, p.e, ...ids]),
    series(`SELECT ${D('completed_at')} d, COUNT(*) n FROM lead_followups WHERE workspace_id = ? AND status = 'completed' AND completed_at BETWEEN ? AND ?${only('assigned_user_id')} GROUP BY d`, [W, p.s, p.e, ...ids]),
    // One count per email from the Sent table (individual and product emails alike): no double counting.
    series(`SELECT ${D('sent_at')} d, COUNT(*) n FROM emails WHERE workspace_id = ? AND status = 'Sent' AND sent_by_user_id IS NOT NULL AND sent_at BETWEEN ? AND ?${only('sent_by_user_id')} GROUP BY d`, [W, p.s, p.e, ...ids]),
    series(`SELECT ${D('activity_at')} d, COUNT(*) n FROM lead_activities WHERE workspace_id = ? AND activity_at BETWEEN ? AND ?${only('performed_by')} GROUP BY d`, [W, p.s, p.e, ...ids]),
    series(`SELECT ${D('activity_at')} d, COUNT(*) n FROM lead_activities WHERE workspace_id = ? AND activity_type = 'note' AND activity_at BETWEEN ? AND ?${only('performed_by')} GROUP BY d`, [W, p.s, p.e, ...ids]),
    series(`SELECT ${D('activity_at')} d, COUNT(*) n FROM lead_activities WHERE workspace_id = ? AND activity_type = 'meeting' AND activity_at BETWEEN ? AND ?${only('performed_by')} GROUP BY d`, [W, p.s, p.e, ...ids]),
    series(`SELECT ${D('created_at')} d, COUNT(*) n FROM leads WHERE workspace_id = ? AND created_at BETWEEN ? AND ?${only('created_by_user_id')} GROUP BY d`, [W, p.s, p.e, ...ids]),
    series(`SELECT ${D('created_at')} d, COUNT(*) n FROM audit_logs WHERE workspace_id = ? AND action = 'leads.owner_changed' AND created_at BETWEEN ? AND ?
      AND JSON_EXTRACT(metadata_json, '$.owner') IS NOT NULL${only("CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.owner')) AS UNSIGNED)")} GROUP BY d`, [W, p.s, p.e, ...ids]),
    // Leads contacted that day (each lead once per day): a call, a contact activity or an email to its address.
    series(`SELECT x.d, COUNT(DISTINCT x.lead_ref) n FROM (
        SELECT ${D('c.started_at')} d, c.lead_id lead_ref FROM crm_call_logs c WHERE c.lead_workspace_id = ? AND c.lead_id IS NOT NULL AND c.started_at BETWEEN ? AND ?${only('c.user_id')}
        UNION ALL SELECT ${D('a.activity_at')} d, a.lead_id FROM lead_activities a WHERE a.workspace_id = ? AND a.activity_type IN ('meeting', 'call', 'email', 'whatsapp', 'sms') AND a.activity_at BETWEEN ? AND ?${only('a.performed_by')}
        UNION ALL SELECT ${D('e.sent_at')} d, l.id FROM emails e JOIN leads l ON l.workspace_id = e.workspace_id AND l.email IS NOT NULL AND l.email <> '' AND LOWER(TRIM(l.email)) = LOWER(TRIM(e.recipient_email))
          WHERE e.workspace_id = ? AND e.status = 'Sent' AND e.sent_by_user_id IS NOT NULL AND e.sent_at BETWEEN ? AND ?${only('e.sent_by_user_id')}) x GROUP BY x.d`,
      [W, p.s, p.e, ...ids, W, p.s, p.e, ...ids, W, p.s, p.e, ...ids]),
    series(`SELECT ${D('c.started_at')} d, COUNT(*) n FROM crm_call_logs c WHERE ${CALL_SCOPE} AND c.answered = 1 AND c.started_at BETWEEN ? AND ?${only('c.user_id')} GROUP BY d`, [W, W, p.s, p.e, ...ids]),
    // Leads won that day (recorded change to Won), by their current owner.
    series(`SELECT ${D('ev.created_at')} d, COUNT(DISTINCT l.id) n FROM automation_events ev JOIN leads l ON l.workspace_id = ev.workspace_id AND l.id = ev.subject_id
      WHERE ev.workspace_id = ? AND ev.event_type = 'lead.status_changed' AND ev.subject_type = 'lead' AND JSON_UNQUOTE(JSON_EXTRACT(ev.payload_json, '$.to')) = 'Won'
        AND ev.created_at BETWEEN ? AND ?${only('l.owner_user_id')} GROUP BY d`, [W, p.s, p.e, ...ids])
  ]);
  return days.map(day => ({ day, calls: calls.get(day) || 0, followupsCompleted: followups.get(day) || 0, emails: emails.get(day) || 0, activities: acts.get(day) || 0,
    notes: notes.get(day) || 0, meetings: meetings.get(day) || 0, leadsCreated: created.get(day) || 0, leadsAssigned: assigned.get(day) || 0, leadsContacted: contacted.get(day) || 0,
    callsConnected: connected.get(day) || 0, won: won.get(day) || 0 }));
}

/** Totals across the members shown (sums; rates recomputed from the sums). */
function totals(rows) {
  const sum = path => rows.reduce((a, r) => a + n(path.split('.').reduce((o, k) => o?.[k], r)), 0);
  const t = {
    staff: rows.length,
    leads: { contacted: sum('leads.contacted'), contactedInPeriod: sum('leads.contactedInPeriod'), wonInPeriod: sum('leads.wonInPeriod'), assigned: sum('leads.assigned'), won: sum('leads.won'), lost: sum('leads.lost'), created: sum('leads.created'), neverContacted: sum('leads.neverContacted'), assignedInPeriod: sum('leads.assignedInPeriod') },
    followups: { cancelled: sum('followups.cancelled'), due: sum('followups.due'), completed: sum('followups.completed'), onTime: sum('followups.onTime'), late: sum('followups.late'), overdueNow: sum('followups.overdueNow'), upcoming: sum('followups.upcoming') },
    calls: { made: sum('calls.made'), answered: sum('calls.answered'), missed: sum('calls.missed'), talkMinutes: Math.round(sum('calls.talkMinutes') * 10) / 10 },
    activities: { total: sum('activities.total'), notes: sum('activities.notes'), meetings: sum('activities.meetings') },
    emails: { openTracked: sum('emails.openTracked'), campaignDelivered: sum('emails.campaignDelivered'), sent: sum('emails.sent'), productEmails: sum('emails.productEmails'), delivered: sum('emails.delivered'), opened: sum('emails.opened'), clicked: sum('emails.clicked'), campaignsSent: sum('emails.campaignsSent'), campaignRecipients: sum('emails.campaignRecipients'), campaignOpened: sum('emails.campaignOpened'), campaignClicked: sum('emails.campaignClicked') },
    social: { posts: sum('social.posts'), published: sum('social.published'), campaigns: sum('social.campaigns') }
  };
  t.leads.conversionRate = t.leads.assigned ? Math.round((t.leads.won / t.leads.assigned) * 1000) / 10 : null;
  t.followups.onTimeRate = t.followups.completed ? Math.round((t.followups.onTime / t.followups.completed) * 1000) / 10 : null;
  t.calls.answerRate = t.calls.made ? Math.round((t.calls.answered / t.calls.made) * 1000) / 10 : null;
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  t.followups.completionRate = pct(t.followups.completed, t.followups.due);
  // Won in the period out of the leads contacted in it.
  t.leads.periodConversionRate = pct(t.leads.wonInPeriod, t.leads.contactedInPeriod);
  // Opens (an estimate) of tracked individual/product emails and of delivered campaign emails.
  t.emails.engagementRate = pct(t.emails.opened + t.emails.campaignOpened, t.emails.openTracked + t.emails.campaignDelivered);
  t.emails.totalSent = t.emails.sent + t.emails.productEmails;
  // Score levels across the team (members without enough data are counted apart).
  const scored = rows.map(r => r.score?.score).filter(v => v !== null && v !== undefined);
  t.score = { average: scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null, scored: scored.length,
    levels: ['excellent', 'on_track', 'needs_improvement', 'critical'].reduce((o, k) => ({ ...o, [k]: rows.filter(r => r.score?.level === k).length }), {}) };
  return t;
}

const localToday = tz => new Date(Date.now() + offsetMinutes(tz) * 60000).toISOString().slice(0, 10);

/**
 * Progress of every target that applies to these members, in the cycle that contains the anchor day (the report's
 * last day, or today if earlier) and in the cycle before it. Figures come from the same counts as the report.
 * Returns { byMember: Map(id → { current, previous }), totals, team }.
 */
async function evaluateTargets(W, list, anchorDay, tz) {
  const defs = await targets.listDefinitions(W);
  const empty = { total: 0, met: 0, atRisk: 0, achievement: null, items: [] };
  if (!defs.length || !list.length) return { byMember: new Map(list.map(m => [m.id, { current: empty, previous: empty }])), totals: null, team: [] };
  const today = localToday(tz);
  const anchor = anchorDay < today ? anchorDay : today;
  const assigned = targets.forMembers(defs, list);
  const cache = new Map();
  const dataFor = c => {
    const k = `${c.from}|${c.to}`;
    if (!cache.has(k)) { const pp = period({ from: c.from, to: c.to }, tz, { anyLength: true }); cache.set(k, collect(W, pp.s, pp.e)); }
    return cache.get(k);
  };
  const noFc = new Map();
  const byMember = new Map();
  const summary = items => {
    const live = items.filter(i => i.status !== 'not_started' || i.actual);
    const counted = items.filter(i => i.pct !== null);
    return { items, total: live.length, met: items.filter(i => ['achieved', 'exceeded'].includes(i.status)).length, atRisk: items.filter(i => i.status === 'at_risk').length,
      // Average achievement across their targets (each capped at 200 % so one big number does not hide the rest).
      achievement: counted.length ? Math.round(counted.reduce((a, i) => a + Math.min(200, i.pct), 0) / counted.length) : null };
  };
  for (const m of list) {
    const cur = []; const prev = [];
    for (const t of assigned.get(m.id) || []) {
      const c = targets.cycleFor(t.periodType, anchor, { start_date: t.startDate, end_date: t.endDate });
      if (!targets.applies({ start_date: t.startDate, end_date: t.endDate }, c)) continue;
      const pc = targets.previousCycle(t.periodType, c);
      const metric = targets.METRICS[t.metric];
      const [d, dp] = await Promise.all([dataFor(c), dataFor(pc)]);
      const actual = metric.get(rowFor(m, d, noFc));
      const pActual = metric.get(rowFor(m, dp, noFc));
      const st = targets.status({ actual, target: t.target, rate: !!metric.rate, cycle: c, today });
      const pst = targets.status({ actual: pActual, target: t.target, rate: !!metric.rate, cycle: pc, today });
      const base = { targetId: t.id, metric: t.metric, label: t.metricLabel, unit: t.unit, periodType: t.periodType, periodLabel: t.periodLabel, from: t.scope === 'member' ? 'person' : 'role', target: t.target };
      cur.push({ ...base, cycle: { ...c, label: targets.cycleLabel(t.periodType, c) }, actual, remaining: metric.rate ? null : Math.max(0, Math.round((t.target - (actual || 0)) * 10) / 10),
        pct: st.pct, status: st.status, expected: st.expected, elapsed: Math.round(st.elapsed * 100) });
      if (targets.applies({ start_date: t.startDate, end_date: t.endDate }, pc)) prev.push({ ...base, cycle: { ...pc, label: targets.cycleLabel(t.periodType, pc) }, actual: pActual, pct: pst.pct, status: pst.status });
    }
    byMember.set(m.id, { current: summary(cur), previous: summary(prev) });
  }
  const all0 = [...byMember.values()];
  const tot = key => {
    const total = all0.reduce((a, x) => a + x[key].total, 0); const met = all0.reduce((a, x) => a + x[key].met, 0);
    return { total, met, rate: total ? Math.round((met / total) * 1000) / 10 : null, atRisk: all0.reduce((a, x) => a + x[key].atRisk, 0) };
  };
  // Team targets: the sum of everyone's targets and results, per measure and period (counts only).
  const team = new Map();
  for (const x of all0) for (const i of x.current.items) {
    if (targets.METRICS[i.metric].rate) continue;
    const k = `${i.metric}|${i.periodType}|${i.cycle.from}`;
    const g = team.get(k) || { metric: i.metric, label: i.label, unit: i.unit, periodType: i.periodType, periodLabel: i.periodLabel, cycle: i.cycle, target: 0, actual: 0, people: 0 };
    g.target += i.target; g.actual += Number(i.actual) || 0; g.people++;
    team.set(k, g);
  }
  const teamRows = [...team.values()].map(g => ({ ...g, target: Math.round(g.target * 10) / 10, actual: Math.round(g.actual * 10) / 10,
    remaining: Math.max(0, Math.round((g.target - g.actual) * 10) / 10), pct: g.target ? Math.round((g.actual / g.target) * 1000) / 10 : null }))
    .sort((a, b) => b.people - a.people || a.label.localeCompare(b.label));
  return { byMember, totals: { ...tot('current'), previous: tot('previous') }, team: teamRows };
}

/**
 * Adds what the score needs: working days (from the day they joined, in the configured working week), recorded
 * actions and actions per working day; then the performance score and level.
 */
function enrich(row, m, p, cfg, tgt = null) {
  const wd = workingDays(p, m.joinedAt, cfg.workweek);
  const actions = row.calls.made + row.followups.completed + row.emails.sent + row.emails.productEmails + row.activities.total;
  const out = { ...row, productivity: { workingDays: wd, actions, perDay: wd ? Math.round((actions / wd) * 10) / 10 : null },
    targets: tgt || { total: 0, met: 0, atRisk: 0, achievement: null, items: [] } };
  return { ...out, score: scoring.score(out, cfg) };
}

/** The comparison period: the one asked for (compareFrom / compareTo), else the same length just before. */
function comparisonPeriod(p, query) {
  const ok = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  if (ok(query.compareFrom) && ok(query.compareTo)) return period({ from: query.compareFrom, to: query.compareTo }, p.tz);
  return previousPeriod(p);
}

async function report(ctx, query = {}) {
  const W = ws(ctx);
  const p = period(query, await workspaceTz(W));
  const manager = isManager(ctx);
  const prev = comparisonPeriod(p, query);
  const cfg = await scoring.getConfig(W);
  let list = await members(W, p);
  let prevList = await members(W, prev);
  if (!manager) {
    list = list.filter(m => m.id === Number(ctx.auth.userId));
    prevList = prevList.filter(m => m.id === Number(ctx.auth.userId));
  }
  // Roles of everyone visible, for the filter (before filtering).
  const roles = [...new Set(list.map(m => m.role).filter(Boolean))].sort();
  // Filters: role (designation) and particular staff.
  const role = String(query.role || '').trim();
  const staff = String(query.staff || '').split(',').map(Number).filter(x => Number.isInteger(x) && x > 0);
  const keep = m => (!role || m.role === role) && (!staff.length || staff.includes(m.id));
  const filtered = role || staff.length;
  list = list.filter(keep);
  prevList = prevList.filter(keep);
  const ids = list.map(m => m.id);
  const who = manager && !filtered ? null : (ids.length ? ids : [0]);
  const [d, fc, trend, dPrev, fcPrev, prevTrend] = await Promise.all([collect(W, p.s, p.e), firstContact(W, p.s, p.e),
    daily(W, p, who), collect(W, prev.s, prev.e), firstContact(W, prev.s, prev.e), daily(W, prev, who)]);
  const tg = await evaluateTargets(W, list, p.to, p.tz);
  const tOf = (id, k) => tg.byMember.get(id)?.[k];
  const rows = list.map(m => ({ ...enrich(rowFor(m, d, fc), m, p, cfg, tOf(m.id, 'current')), previous: enrich(rowFor(m, dPrev, fcPrev), m, prev, cfg, tOf(m.id, 'previous')) }));
  // The comparison period's team: the members listed for it (people who left or joined since change the count).
  const prevRows = prevList.map(m => enrich(rowFor(m, dPrev, fcPrev), m, prev, cfg));
  await audit(ctx, 'performance.viewed', { resourceType: 'workspace', resourceId: W, metadata: { from: p.from, to: p.to, members: rows.length } });
  return { from: p.from, to: p.to, timezone: p.tz, scope: manager ? 'team' : 'self', members: rows, totals: { ...totals(rows), targets: tg.totals }, daily: trend,
    teamTargets: tg.team, canManageTargets: canManageTargets(ctx), permissions: permissions(ctx), me: Number(ctx.auth.userId) || null,
    previous: { from: prev.from, to: prev.to, totals: totals(prevRows), daily: prevTrend }, roles,
    scoring: { levels: cfg.levels, workweek: cfg.workweek, customised: cfg.customised, conversionTarget: cfg.measures.conversion.enabled ? cfg.measures.conversion.target : null,
      // Minimum and target of the rates shown in the leaderboard, to colour them (below minimum / at target).
      thresholds: { conversion: { min: cfg.measures.conversion.min, target: cfg.measures.conversion.target }, followupOnTime: { min: cfg.measures.followupOnTime.min, target: cfg.measures.followupOnTime.target } } } };
}

const LIST_LIMIT = 300;

/** Last contact of a lead: its latest call, contact activity or email to its address. */
const LAST_CONTACT = alias => `NULLIF(GREATEST(
  COALESCE((SELECT MAX(c.started_at) FROM crm_call_logs c WHERE c.lead_workspace_id = ${alias}.workspace_id AND c.lead_id = ${alias}.id), '1970-01-01'),
  COALESCE((SELECT MAX(a.activity_at) FROM lead_activities a WHERE a.workspace_id = ${alias}.workspace_id AND a.lead_id = ${alias}.id AND a.activity_type IN ('meeting', 'call', 'email', 'whatsapp', 'sms')), '1970-01-01'),
  COALESCE((SELECT MAX(e.sent_at) FROM emails e WHERE e.workspace_id = ${alias}.workspace_id AND e.status = 'Sent' AND ${alias}.email IS NOT NULL AND ${alias}.email <> ''
    AND LOWER(TRIM(e.recipient_email)) = LOWER(TRIM(${alias}.email))), '1970-01-01')), '1970-01-01')`;

/** First contact of a lead: its earliest call, contact activity or email to its address. */
const FIRST_CONTACT = alias => `NULLIF(LEAST(
  COALESCE((SELECT MIN(c.started_at) FROM crm_call_logs c WHERE c.lead_workspace_id = ${alias}.workspace_id AND c.lead_id = ${alias}.id), '2999-01-01'),
  COALESCE((SELECT MIN(a.activity_at) FROM lead_activities a WHERE a.workspace_id = ${alias}.workspace_id AND a.lead_id = ${alias}.id AND a.activity_type IN ('meeting', 'call', 'email', 'whatsapp', 'sms')), '2999-01-01'),
  COALESCE((SELECT MIN(e.sent_at) FROM emails e WHERE e.workspace_id = ${alias}.workspace_id AND e.status = 'Sent' AND ${alias}.email IS NOT NULL AND ${alias}.email <> ''
    AND LOWER(TRIM(e.recipient_email)) = LOWER(TRIM(${alias}.email))), '2999-01-01')), '2999-01-01')`;

/**
 * Everything behind one member's numbers. Each list returns at most 300 rows (newest first) with its
 * full count, so the screen says when it shows only part of it.
 */
/** The member a person may look at (themselves, or anyone when they see the team), in the period. */
async function memberScope(ctx, rawUserId, query) {
  const userId = Number(rawUserId);
  if (!Number.isInteger(userId) || userId <= 0) throw httpError(400, 'Invalid member.', 'VALIDATION_ERROR');
  if (!isManager(ctx) && userId !== Number(ctx.auth.userId)) throw httpError(403, 'You can see only your own performance.', 'FORBIDDEN');
  const W = ws(ctx);
  const p = period(query, await workspaceTz(W));
  const m = (await members(W, p)).find(x => x.id === userId);
  if (!m) throw httpError(404, 'Not a member of this workspace.', 'NOT_FOUND');
  return { W, p, m, userId };
}

async function memberDetail(ctx, rawUserId, query = {}) {
  const { W, p, m, userId } = await memberScope(ctx, rawUserId, query);
  const q = (sql, params) => safe(all(sql, params));
  const count = async (sql, params) => n((await safe(all(sql, params)))[0]?.n);
  const L = LIST_LIMIT;
  const [overdue, untouched, calls, followupsDone, leads, followupsAll, activities, emails, campaigns, posts, trend,
    nLeads, nFollowups, nActivities, nCalls, nEmails] = await Promise.all([
    q(`SELECT f.id, f.title, f.followup_type type, f.due_at dueAt, f.priority, l.id leadId, l.name leadName FROM lead_followups f JOIN leads l ON l.id = f.lead_id
      WHERE f.workspace_id = ? AND f.assigned_user_id = ? AND f.status = 'pending' AND f.due_at < UTC_TIMESTAMP() ORDER BY f.due_at LIMIT ${L}`, [W, userId]),
    q(`SELECT l.id leadId, l.name leadName, l.company_name company, l.status, l.created_at createdAt FROM leads l WHERE l.workspace_id = ? AND l.owner_user_id = ? AND NOT ${CONTACT_EXISTS('l')}
      ORDER BY l.id DESC LIMIT ${L}`, [W, userId]),
    q(`SELECT c.id, c.started_at startedAt, c.answered, c.duration_seconds durationSeconds, c.transcript_status transcriptStatus, c.lead_id leadId, COALESCE(l.name, c.name) leadName
      FROM crm_call_logs c LEFT JOIN leads l ON l.id = c.lead_id WHERE ${CALL_SCOPE} AND c.user_id = ? AND c.started_at BETWEEN ? AND ? ORDER BY c.id DESC LIMIT ${L}`, [W, W, userId, p.s, p.e]),
    q(`SELECT f.id, f.title, f.due_at dueAt, f.completed_at completedAt, (f.completed_at <= f.due_at) onTime, l.id leadId, l.name leadName FROM lead_followups f JOIN leads l ON l.id = f.lead_id
      WHERE f.workspace_id = ? AND f.assigned_user_id = ? AND f.status = 'completed' AND f.due_at BETWEEN ? AND ? ORDER BY f.completed_at DESC LIMIT ${L}`, [W, userId, p.s, p.e]),
    q(`SELECT l.id leadId, l.name leadName, l.company_name company, l.status, l.lead_source source, l.created_at createdAt, ${LAST_CONTACT('l')} lastContact,
        (SELECT COUNT(*) FROM lead_followups f WHERE f.workspace_id = l.workspace_id AND f.lead_id = l.id AND f.status = 'pending') pendingFollowups
      FROM leads l WHERE l.workspace_id = ? AND l.owner_user_id = ? ORDER BY l.id DESC LIMIT ${L}`, [W, userId]),
    q(`SELECT f.id, f.title, f.followup_type type, f.priority, f.status, f.due_at dueAt, f.completed_at completedAt, f.completion_notes completionNotes, l.id leadId, l.name leadName
      FROM lead_followups f JOIN leads l ON l.id = f.lead_id WHERE f.workspace_id = ? AND f.assigned_user_id = ? AND (f.due_at BETWEEN ? AND ? OR f.status = 'pending') ORDER BY f.due_at DESC LIMIT ${L}`, [W, userId, p.s, p.e]),
    q(`SELECT a.id, a.activity_type type, a.note_category category, a.title, a.description, a.activity_at at, a.duration_minutes durationMinutes, l.id leadId, l.name leadName
      FROM lead_activities a JOIN leads l ON l.id = a.lead_id WHERE a.workspace_id = ? AND a.performed_by = ? AND a.activity_at BETWEEN ? AND ? ORDER BY a.activity_at DESC LIMIT ${L}`, [W, userId, p.s, p.e]),
    // Individual emails they sent (Compose, lead panel, drafts); product emails are counted in the summary.
    q(`SELECT e.id, e.subject, e.recipient_email recipient, e.recipient_name recipientName, e.sent_at sentAt, e.body,
        (SELECT l.id FROM leads l WHERE l.workspace_id = e.workspace_id AND l.email IS NOT NULL AND l.email <> '' AND LOWER(TRIM(l.email)) = LOWER(TRIM(e.recipient_email)) ORDER BY l.id LIMIT 1) leadId,
        t.delivered_at deliveredAt, t.first_open_at openedAt, t.first_click_at clickedAt, t.track_opens trackOpens, t.bounced_at bouncedAt
      FROM emails e LEFT JOIN mail_message_tracking t ON t.workspace_id = e.workspace_id AND t.email_id = e.id
      WHERE e.workspace_id = ? AND e.status = 'Sent' AND e.sent_by_user_id = ? AND e.sent_at BETWEEN ? AND ?
        AND NOT EXISTS (SELECT 1 FROM email_drafts d WHERE d.workspace_id = e.workspace_id AND d.email_id = e.id AND d.batch_id IS NOT NULL)
      ORDER BY e.sent_at DESC LIMIT ${L}`, [W, userId, p.s, p.e]),
    q(`SELECT m.id, m.name, m.subject, m.status, m.submitted_at submittedAt,
        (SELECT COUNT(*) FROM mail_campaign_recipients r WHERE r.campaign_id = m.id AND r.status = 'sent') recipients,
        (SELECT COUNT(*) FROM mail_message_tracking t WHERE t.campaign_id = m.id AND t.delivered_at IS NOT NULL) delivered,
        (SELECT COUNT(*) FROM mail_message_tracking t WHERE t.campaign_id = m.id AND t.first_open_at IS NOT NULL) opened,
        (SELECT COUNT(*) FROM mail_message_tracking t WHERE t.campaign_id = m.id AND t.first_click_at IS NOT NULL) clicked
      FROM mail_campaigns m WHERE m.workspace_id = ? AND (m.submitted_by = ? OR m.created_by = ?) AND COALESCE(m.submitted_at, m.created_at) BETWEEN ? AND ? ORDER BY COALESCE(m.submitted_at, m.created_at) DESC LIMIT ${L}`, [W, userId, userId, p.s, p.e]),
    q(`SELECT c.id, c.title, c.platform, c.status, c.created_at createdAt, c.external_url url FROM content_items c
      WHERE c.workspace_id = ? AND c.created_by = ? AND c.created_at BETWEEN ? AND ? ORDER BY c.id DESC LIMIT ${L}`, [W, userId, p.s, p.e]),
    daily(W, p, [userId]),
    count('SELECT COUNT(*) n FROM leads WHERE workspace_id = ? AND owner_user_id = ?', [W, userId]),
    count("SELECT COUNT(*) n FROM lead_followups WHERE workspace_id = ? AND assigned_user_id = ? AND (due_at BETWEEN ? AND ? OR status = 'pending')", [W, userId, p.s, p.e]),
    count('SELECT COUNT(*) n FROM lead_activities WHERE workspace_id = ? AND performed_by = ? AND activity_at BETWEEN ? AND ?', [W, userId, p.s, p.e]),
    count(`SELECT COUNT(*) n FROM crm_call_logs c WHERE ${CALL_SCOPE} AND c.user_id = ? AND c.started_at BETWEEN ? AND ?`, [W, W, userId, p.s, p.e]),
    count(`SELECT COUNT(*) n FROM emails e WHERE e.workspace_id = ? AND e.status = 'Sent' AND e.sent_by_user_id = ? AND e.sent_at BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM email_drafts d WHERE d.workspace_id = e.workspace_id AND d.email_id = e.id AND d.batch_id IS NOT NULL)`, [W, userId, p.s, p.e])
  ]);
  const [byStatus, bySource, outcomes, transcripts, summary] = await Promise.all([
    q('SELECT COALESCE(status, \'(none)\') status, COUNT(*) n FROM leads WHERE workspace_id = ? AND owner_user_id = ? GROUP BY status ORDER BY n DESC', [W, userId]),
    q(`SELECT COALESCE(NULLIF(x.src, ''), 'unknown') source, COUNT(*) n, SUM(x.status = 'Won') won, SUM(x.status = 'Lost') lost, SUM(x.c) contacted
       FROM (SELECT l.lead_source src, l.status, ${CONTACT_EXISTS('l')} c FROM leads l WHERE l.workspace_id = ? AND l.owner_user_id = ?) x GROUP BY source ORDER BY n DESC`, [W, userId]),
    q(`SELECT SUM(c.answered = 1) connected, SUM(COALESCE(c.answered, 0) = 0) notAnswered, SUM(c.answered = 1 AND COALESCE(c.duration_seconds, 0) < 30) shortConnected
       FROM crm_call_logs c WHERE ${CALL_SCOPE} AND c.user_id = ? AND c.started_at BETWEEN ? AND ?`, [W, W, userId, p.s, p.e]),
    q(`SELECT COALESCE(c.transcript_status, 'none') status, COUNT(*) n FROM crm_call_logs c WHERE ${CALL_SCOPE} AND c.user_id = ? AND c.started_at BETWEEN ? AND ? GROUP BY status`, [W, W, userId, p.s, p.e]),
    (async () => {
      const cfg = await scoring.getConfig(W);
      const prev = comparisonPeriod(p, query);
      const [d, fc, dp, fcp] = await Promise.all([collect(W, p.s, p.e), firstContact(W, p.s, p.e), collect(W, prev.s, prev.e), firstContact(W, prev.s, prev.e)]);
      const tg = await evaluateTargets(W, [m], p.to, p.tz);
      const t0 = tg.byMember.get(m.id);
      return { ...enrich(rowFor(m, d, fc), m, p, cfg, t0?.current), previous: { ...enrich(rowFor(m, dp, fcp), m, prev, cfg, t0?.previous), from: prev.from, to: prev.to } };
    })()
  ]);
  const o = outcomes[0] || {};
  return {
    member: { userId: m.id, name: m.name, email: m.email, role: m.role, former: m.former }, from: p.from, to: p.to, timezone: p.tz,
    // The same figures as this member's row in the team report, so the two always agree.
    summary,
    leadStatus: byStatus.map(x => ({ status: x.status, count: n(x.n) })),
    leadSources: bySource.map(x => ({ source: x.source, count: n(x.n), won: n(x.won), lost: n(x.lost), contacted: n(x.contacted),
      conversionRate: n(x.n) ? Math.round((n(x.won) / n(x.n)) * 1000) / 10 : null })),
    // Outcomes from what the call log records (answered, duration); there is no separate outcome field.
    callOutcomes: { connected: n(o.connected), notAnswered: n(o.notAnswered), shortConnected: n(o.shortConnected),
      transcripts: Object.fromEntries(transcripts.map(t => [t.status, n(t.n)])) },
    // No AI call summaries are produced anywhere in the system yet; say so rather than show anything made up.
    callSummaries: { available: false },
    // shown / total per list: the screen says "showing the latest 300 of N" when a list is cut.
    limits: { perList: L, leads: nLeads, followups: nFollowups, activities: nActivities, calls: nCalls, emails: nEmails },
    overdueFollowups: overdue, neverContactedLeads: untouched, calls: calls.map(c => ({ ...c, answered: !!c.answered })),
    completedFollowups: followupsDone.map(f => ({ ...f, onTime: !!Number(f.onTime) })),
    leads: leads.map(l => ({ ...l, lastContact: l.lastContact && !String(l.lastContact).startsWith('1970') ? l.lastContact : null, pendingFollowups: n(l.pendingFollowups) })),
    followups: followupsAll.map(f => ({ ...f, status: f.status === 'pending' && new Date(f.dueAt) < new Date() ? 'overdue' : f.status })),
    activities, daily: trend,
    emails: emails.map(e => ({ id: e.id, subject: e.subject, recipient: e.recipient, recipientName: e.recipientName, sentAt: e.sentAt, leadId: e.leadId || null,
      preview: String(e.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400),
      status: e.bouncedAt ? 'bounced' : e.deliveredAt ? 'delivered' : 'sent', openedAt: e.trackOpens ? e.openedAt : null, clickedAt: e.clickedAt })),
    campaigns: campaigns.map(c => ({ ...c, recipients: n(c.recipients), delivered: n(c.delivered), opened: n(c.opened), clicked: n(c.clicked) })),
    posts
  };
}

const RECORD_KINDS = ['leads', 'followups', 'calls', 'activities', 'emails', 'timeline'];
const ymd = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
/** UTC bounds of local dates (inclusive) for the workspace offset. */
const localBounds = (from, to, off) => ({
  s: from ? sqlTime(new Date(new Date(`${from}T00:00:00Z`).getTime() - off * 60000)) : null,
  e: to ? sqlTime(new Date(new Date(`${to}T00:00:00Z`).getTime() + 86400000 - 1000 - off * 60000)) : null
});
const ASSIGNED_AT = alias => `COALESCE((SELECT MAX(a.created_at) FROM audit_logs a WHERE a.workspace_id = ${alias}.workspace_id AND a.action = 'leads.owner_changed'
  AND CAST(a.resource_id AS UNSIGNED) = ${alias}.id AND CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.owner')) AS UNSIGNED) = ${alias}.owner_user_id), ${alias}.created_at)`;
const IS_BATCH = alias => `EXISTS (SELECT 1 FROM email_drafts d WHERE d.workspace_id = ${alias}.workspace_id AND d.email_id = ${alias}.id AND d.batch_id IS NOT NULL)`;

/**
 * One page of a member's records, filtered on the server: leads (status, source, contacted, created / assigned
 * dates), follow-ups (status), calls (answered), notes & activities (type) and emails (kind, engagement).
 */
async function memberRecords(ctx, rawUserId, kind, query = {}) {
  if (!RECORD_KINDS.includes(kind)) throw httpError(400, 'Unknown list.', 'VALIDATION_ERROR');
  const { W, p, userId } = await memberScope(ctx, rawUserId, query);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));
  const page = Math.max(1, Number(query.page) || 1);
  const where = [];
  const args = [];
  const add = (sql, ...v) => { where.push(sql); args.push(...v); };
  let base;
  let order;
  if (kind === 'leads') {
    base = `SELECT * FROM (SELECT l.id leadId, l.name leadName, l.company_name company, l.status, COALESCE(NULLIF(l.lead_source, ''), 'unknown') source, l.created_at createdAt,
        ${ASSIGNED_AT('l')} assignedAt, ${LAST_CONTACT('l')} lastContact, ${FIRST_CONTACT('l')} firstContactAt, ${CONTACT_EXISTS('l')} contacted,
        (SELECT COUNT(*) FROM lead_followups f WHERE f.workspace_id = l.workspace_id AND f.lead_id = l.id AND f.status = 'pending' AND f.due_at < UTC_TIMESTAMP()) overdueFollowups,
        (SELECT COUNT(*) FROM lead_followups f WHERE f.workspace_id = l.workspace_id AND f.lead_id = l.id AND f.status = 'pending') pendingFollowups
      FROM leads l WHERE l.workspace_id = ? AND l.owner_user_id = ?) x`;
    args.push(W, userId);
    if (query.status === 'open') add("COALESCE(x.status, '') NOT IN ('Won', 'Lost')");
    else if (query.status) add('x.status = ?', String(query.status));
    if (query.source) add('x.source = ?', String(query.source));
    if (query.contacted === 'yes') add('x.contacted = 1');
    if (query.contacted === 'no') add('x.contacted = 0');
    for (const [col, f, t] of [['createdAt', 'createdFrom', 'createdTo'], ['assignedAt', 'assignedFrom', 'assignedTo']]) {
      const b = localBounds(ymd(query[f]), ymd(query[t]), p.off);
      if (b.s) add(`x.${col} >= ?`, b.s);
      if (b.e) add(`x.${col} <= ?`, b.e);
    }
    order = 'x.leadId DESC';
  } else if (kind === 'followups') {
    base = `SELECT f.id, f.title, f.followup_type type, f.priority, f.status, f.due_at dueAt, f.completed_at completedAt, f.completion_notes completionNotes, l.id leadId, l.name leadName,
        CASE WHEN f.status = 'completed' AND f.completed_at > f.due_at THEN TIMESTAMPDIFF(MINUTE, f.due_at, f.completed_at) END lateMinutes
      FROM lead_followups f JOIN leads l ON l.id = f.lead_id WHERE f.workspace_id = ? AND f.assigned_user_id = ? AND (f.due_at BETWEEN ? AND ? OR f.status = 'pending')`;
    args.push(W, userId, p.s, p.e);
    const st = String(query.status || '');
    if (st === 'overdue') add("f.status = 'pending' AND f.due_at < UTC_TIMESTAMP()");
    else if (st === 'pending') add("f.status = 'pending' AND f.due_at >= UTC_TIMESTAMP()");
    else if (st === 'on_time') add("f.status = 'completed' AND f.completed_at <= f.due_at");
    else if (st === 'late') add("f.status = 'completed' AND f.completed_at > f.due_at");
    else if (['completed', 'cancelled'].includes(st)) add('f.status = ?', st);
    order = 'f.due_at DESC';
  } else if (kind === 'calls') {
    base = `SELECT c.id, c.started_at startedAt, c.answered, c.duration_seconds durationSeconds, c.transcript_status transcriptStatus, c.lead_id leadId, COALESCE(l.name, c.name) leadName
      FROM crm_call_logs c LEFT JOIN leads l ON l.id = c.lead_id WHERE ${CALL_SCOPE} AND c.user_id = ? AND c.started_at BETWEEN ? AND ?`;
    args.push(W, W, userId, p.s, p.e);
    if (query.answered === 'yes') add('c.answered = 1');
    if (query.answered === 'no') add('COALESCE(c.answered, 0) = 0');
    if (query.transcript === 'yes') add("c.transcript_status = 'done'");
    order = 'c.started_at DESC';
  } else if (kind === 'activities') {
    base = `SELECT a.id, a.activity_type type, a.note_category category, a.title, a.description, a.activity_at at, a.duration_minutes durationMinutes, l.id leadId, l.name leadName
      FROM lead_activities a JOIN leads l ON l.id = a.lead_id WHERE a.workspace_id = ? AND a.performed_by = ? AND a.activity_at BETWEEN ? AND ?`;
    args.push(W, userId, p.s, p.e);
    if (query.type) add('a.activity_type = ?', String(query.type));
    order = 'a.activity_at DESC';
  } else if (kind === 'timeline') {
    // Everything they did, newest first: calls, emails, notes & activities (meetings, WhatsApp, SMS …) and lead updates.
    base = `SELECT * FROM (
        SELECT 'call' kind, c.id, c.started_at at, COALESCE(l.name, c.name) leadName, c.lead_id leadId,
          CASE WHEN c.answered = 1 THEN CONCAT('Connected · ', COALESCE(c.duration_seconds, 0), ' s') ELSE 'Not answered' END detail, c.transcript_status extra
        FROM crm_call_logs c LEFT JOIN leads l ON l.id = c.lead_id WHERE ${CALL_SCOPE} AND c.user_id = ? AND c.started_at BETWEEN ? AND ?
        UNION ALL SELECT CASE WHEN ${IS_BATCH('e')} THEN 'product_email' ELSE 'email' END, e.id, e.sent_at, COALESCE(e.recipient_name, e.recipient_email), NULL, e.subject, NULL
        FROM emails e WHERE e.workspace_id = ? AND e.status = 'Sent' AND e.sent_by_user_id = ? AND e.sent_at BETWEEN ? AND ?
        UNION ALL SELECT a.activity_type, a.id, a.activity_at, l.name, l.id, COALESCE(NULLIF(a.title, ''), LEFT(a.description, 200)), NULL
        FROM lead_activities a JOIN leads l ON l.id = a.lead_id WHERE a.workspace_id = ? AND a.performed_by = ? AND a.activity_at BETWEEN ? AND ?
        UNION ALL SELECT 'lead_update', au.id, au.created_at, l.name, l.id, JSON_UNQUOTE(JSON_EXTRACT(au.metadata_json, '$.fields')), NULL
        FROM audit_logs au JOIN leads l ON l.workspace_id = au.workspace_id AND l.id = CAST(au.resource_id AS UNSIGNED)
        WHERE au.workspace_id = ? AND au.action = 'leads.updated' AND au.actor_user_id = ? AND au.created_at BETWEEN ? AND ?) x`;
    args.push(W, W, userId, p.s, p.e, W, userId, p.s, p.e, W, userId, p.s, p.e, W, userId, p.s, p.e);
    if (query.type) add('x.kind = ?', String(query.type));
    order = 'x.at DESC';
  } else {
    base = `SELECT e.id, e.subject, e.recipient_email recipient, e.recipient_name recipientName, e.sent_at sentAt,
        CASE WHEN ${IS_BATCH('e')} THEN 'product' ELSE 'individual' END kind,
        (SELECT l.id FROM leads l WHERE l.workspace_id = e.workspace_id AND l.email IS NOT NULL AND l.email <> '' AND LOWER(TRIM(l.email)) = LOWER(TRIM(e.recipient_email)) ORDER BY l.id LIMIT 1) leadId,
        t.delivered_at deliveredAt, t.bounced_at bouncedAt, CASE WHEN t.track_opens = 1 THEN t.first_open_at END openedAt, t.first_click_at clickedAt
      FROM emails e LEFT JOIN mail_message_tracking t ON t.workspace_id = e.workspace_id AND t.email_id = e.id
      WHERE e.workspace_id = ? AND e.status = 'Sent' AND e.sent_by_user_id = ? AND e.sent_at BETWEEN ? AND ?`;
    args.push(W, userId, p.s, p.e);
    if (query.kind === 'individual') add(`NOT ${IS_BATCH('e')}`);
    if (query.kind === 'product') add(IS_BATCH('e'));
    if (query.engagement === 'opened') add('t.track_opens = 1 AND t.first_open_at IS NOT NULL');
    if (query.engagement === 'clicked') add('t.first_click_at IS NOT NULL');
    if (query.engagement === 'bounced') add('t.bounced_at IS NOT NULL');
    order = 'e.sent_at DESC';
  }
  const filtered = where.length ? `${base} ${/\) x$/.test(base) ? 'WHERE' : 'AND'} ${where.join(' AND ')}` : base;
  const [rows, total] = await Promise.all([
    safe(all(`${filtered} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, args)),
    safe(all(`SELECT COUNT(*) n FROM (${filtered}) z`, args))
  ]);
  const fix = r => {
    const o = { ...r };
    if ('answered' in o) o.answered = !!o.answered;
    if ('contacted' in o) o.contacted = !!Number(o.contacted);
    if ('lastContact' in o && o.lastContact && String(o.lastContact).startsWith('1970')) o.lastContact = null;
    if ('pendingFollowups' in o) o.pendingFollowups = n(o.pendingFollowups);
    if ('overdueFollowups' in o) o.overdueFollowups = n(o.overdueFollowups);
    if ('firstContactAt' in o && o.firstContactAt && String(o.firstContactAt).startsWith('2999')) o.firstContactAt = null;
    if (kind === 'followups' && o.status === 'pending' && new Date(o.dueAt) < new Date()) o.status = 'overdue';
    if ('lateMinutes' in o) o.lateMinutes = o.lateMinutes == null ? null : n(o.lateMinutes);
    if (kind === 'emails') o.status = o.bouncedAt ? 'bounced' : o.deliveredAt ? 'delivered' : 'sent';
    return o;
  };
  return { kind, page, pageSize, total: n(total[0]?.n), rows: rows.map(fix), from: p.from, to: p.to, timezone: p.tz };
}

/** What a member actually did on one day (workspace time): the records behind that day's figures. */
async function memberDay(ctx, rawUserId, query = {}) {
  const date = ymd(query.date);
  if (!date) throw httpError(400, 'Pick a date (YYYY-MM-DD).', 'VALIDATION_ERROR');
  const { W, p, userId } = await memberScope(ctx, rawUserId, { from: date, to: date });
  const { s, e } = { s: p.s, e: p.e };
  const L = 200;
  const q = (sql, params) => safe(all(sql, params));
  const [leadsCreated, leadsAssigned, calls, followups, emails, activities] = await Promise.all([
    q(`SELECT l.id leadId, l.name leadName, l.status, COALESCE(NULLIF(l.lead_source, ''), 'unknown') source, l.created_at at FROM leads l
       WHERE l.workspace_id = ? AND l.created_by_user_id = ? AND l.created_at BETWEEN ? AND ? ORDER BY l.created_at LIMIT ${L}`, [W, userId, s, e]),
    q(`SELECT l.id leadId, l.name leadName, l.status, a.created_at at FROM audit_logs a JOIN leads l ON l.workspace_id = a.workspace_id AND l.id = CAST(a.resource_id AS UNSIGNED)
       WHERE a.workspace_id = ? AND a.action = 'leads.owner_changed' AND CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.owner')) AS UNSIGNED) = ? AND a.created_at BETWEEN ? AND ?
       ORDER BY a.created_at LIMIT ${L}`, [W, userId, s, e]),
    q(`SELECT c.id, c.started_at at, c.answered, c.duration_seconds durationSeconds, c.transcript_status transcriptStatus, c.lead_id leadId, COALESCE(l.name, c.name) leadName
       FROM crm_call_logs c LEFT JOIN leads l ON l.id = c.lead_id WHERE ${CALL_SCOPE} AND c.user_id = ? AND c.started_at BETWEEN ? AND ? ORDER BY c.started_at LIMIT ${L}`, [W, W, userId, s, e]),
    q(`SELECT f.id, f.title, f.due_at dueAt, f.completed_at at, (f.completed_at <= f.due_at) onTime, l.id leadId, l.name leadName FROM lead_followups f JOIN leads l ON l.id = f.lead_id
       WHERE f.workspace_id = ? AND f.assigned_user_id = ? AND f.status = 'completed' AND f.completed_at BETWEEN ? AND ? ORDER BY f.completed_at LIMIT ${L}`, [W, userId, s, e]),
    q(`SELECT e.id, e.subject, e.recipient_email recipient, e.sent_at at, CASE WHEN ${IS_BATCH('e')} THEN 'product' ELSE 'individual' END kind FROM emails e
       WHERE e.workspace_id = ? AND e.status = 'Sent' AND e.sent_by_user_id = ? AND e.sent_at BETWEEN ? AND ? ORDER BY e.sent_at LIMIT ${L}`, [W, userId, s, e]),
    q(`SELECT a.id, a.activity_type type, a.title, a.description, a.activity_at at, l.id leadId, l.name leadName FROM lead_activities a JOIN leads l ON l.id = a.lead_id
       WHERE a.workspace_id = ? AND a.performed_by = ? AND a.activity_at BETWEEN ? AND ? ORDER BY a.activity_at LIMIT ${L}`, [W, userId, s, e])
  ]);
  return { date, timezone: p.tz, leadsCreated, leadsAssigned, calls: calls.map(c => ({ ...c, answered: !!c.answered })),
    followupsCompleted: followups.map(f => ({ ...f, onTime: !!Number(f.onTime) })), emails, activities };
}

/** The period of the same length just before (e.g. the 30 days before these 30). */
function previousPeriod(p) {
  const days = Math.round((new Date(`${p.to}T00:00:00Z`) - new Date(`${p.from}T00:00:00Z`)) / 86400000) + 1;
  const to = new Date(new Date(`${p.from}T00:00:00Z`).getTime() - 86400000);
  const from = new Date(to.getTime() - (days - 1) * 86400000);
  return period({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }, p.tz);
}

/**
 * Working days of a member in the period: weekdays of the chosen working week (Mon–Fri, Mon–Sat or every
 * day) from the later of the period start and the day they joined, up to today. There is no attendance
 * or leave record in the system, so leave and holidays are not subtracted.
 */
function workingDays(p, joinedAt, week = 5) {
  const start = new Date(`${p.from}T00:00:00Z`);
  const joined = joinedAt ? new Date(new Date(joinedAt).getTime() + p.off * 60000) : null;
  const joinDay = joined ? new Date(`${joined.toISOString().slice(0, 10)}T00:00:00Z`) : null;
  const today = new Date(`${new Date(Date.now() + p.off * 60000).toISOString().slice(0, 10)}T00:00:00Z`);
  const end = new Date(Math.min(new Date(`${p.to}T00:00:00Z`).getTime(), today.getTime()));
  let n0 = 0;
  for (let d = joinDay && joinDay > start ? joinDay : start; d <= end; d = new Date(d.getTime() + 86400000)) {
    const wd = d.getUTCDay(); // 0 Sunday … 6 Saturday
    if (week >= 7 || (week === 6 ? wd !== 0 : wd !== 0 && wd !== 6)) n0++;
  }
  return n0;
}

/** Per member and day: calls, follow-ups completed, emails, notes & activities and leads created (five grouped queries). */
async function dailyByUser(W, p, ids) {
  const D = col => localDay(col, p.off);
  const IN = `(${ids.map(() => '?').join(',')})`;
  const dayKey = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  const q = (sql, params) => safe(all(sql, params));
  const [calls, fu, em, acts, leads] = await Promise.all([
    q(`SELECT c.user_id u, ${D('c.started_at')} d, COUNT(*) n FROM crm_call_logs c WHERE ${CALL_SCOPE} AND c.user_id IN ${IN} AND c.started_at BETWEEN ? AND ? GROUP BY u, d`, [W, W, ...ids, p.s, p.e]),
    q(`SELECT assigned_user_id u, ${D('completed_at')} d, COUNT(*) n FROM lead_followups WHERE workspace_id = ? AND status = 'completed' AND assigned_user_id IN ${IN} AND completed_at BETWEEN ? AND ? GROUP BY u, d`, [W, ...ids, p.s, p.e]),
    q(`SELECT sent_by_user_id u, ${D('sent_at')} d, COUNT(*) n FROM emails WHERE workspace_id = ? AND status = 'Sent' AND sent_by_user_id IN ${IN} AND sent_at BETWEEN ? AND ? GROUP BY u, d`, [W, ...ids, p.s, p.e]),
    q(`SELECT performed_by u, ${D('activity_at')} d, COUNT(*) n FROM lead_activities WHERE workspace_id = ? AND performed_by IN ${IN} AND activity_at BETWEEN ? AND ? GROUP BY u, d`, [W, ...ids, p.s, p.e]),
    q(`SELECT created_by_user_id u, ${D('created_at')} d, COUNT(*) n FROM leads WHERE workspace_id = ? AND created_by_user_id IN ${IN} AND created_at BETWEEN ? AND ? GROUP BY u, d`, [W, ...ids, p.s, p.e])
  ]);
  const days = [];
  for (let d = new Date(`${p.from}T00:00:00Z`); d <= new Date(`${p.to}T00:00:00Z`); d = new Date(d.getTime() + 86400000)) days.push(d.toISOString().slice(0, 10));
  const out = new Map(ids.map(id => [id, new Map(days.map(day => [day, { day, calls: 0, followupsCompleted: 0, emails: 0, activities: 0, leadsCreated: 0, total: 0 }]))]));
  for (const [rows, key] of [[calls, 'calls'], [fu, 'followupsCompleted'], [em, 'emails'], [acts, 'activities'], [leads, 'leadsCreated']]) {
    for (const r of rows) {
      const cell = out.get(Number(r.u))?.get(dayKey(r.d));
      if (cell) { cell[key] += n(r.n); cell.total += n(r.n); }
    }
  }
  return new Map([...out].map(([id, m]) => [id, [...m.values()]]));
}

/** Monday-start weeks from daily rows: the sum of each measure per week. */
function weekly(daily) {
  const weeks = new Map();
  for (const d of daily) {
    const t = new Date(`${d.day}T00:00:00Z`);
    const monday = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
    const w = weeks.get(monday) || { week: monday, calls: 0, followupsCompleted: 0, emails: 0, activities: 0, leadsCreated: 0, total: 0 };
    for (const k of ['calls', 'followupsCompleted', 'emails', 'activities', 'leadsCreated', 'total']) w[k] += d[k];
    weeks.set(monday, w);
  }
  return [...weeks.values()];
}

/**
 * Average hours from a lead being given to (or created by) its current owner to its recorded change to Won,
 * for leads won in the period. Only wins recorded as status changes can be measured; "measured" says how many.
 */
async function conversionTimes(W, p, ids) {
  const IN = `(${ids.map(() => '?').join(',')})`;
  const rows = await safe(all(`SELECT x.u, AVG(TIMESTAMPDIFF(MINUTE, x.since, x.won)) minutes, COUNT(*) measured FROM (
      SELECT l.owner_user_id u, ${ASSIGNED_AT('l')} since, MIN(ev.created_at) won
      FROM leads l JOIN automation_events ev ON ev.workspace_id = l.workspace_id AND ev.event_type = 'lead.status_changed' AND ev.subject_type = 'lead' AND ev.subject_id = l.id
        AND JSON_UNQUOTE(JSON_EXTRACT(ev.payload_json, '$.to')) = 'Won'
      WHERE l.workspace_id = ? AND l.owner_user_id IN ${IN} AND l.status = 'Won'
      GROUP BY l.id, l.owner_user_id, since HAVING won BETWEEN ? AND ? AND won >= since) x GROUP BY x.u`, [W, ...ids, p.s, p.e]));
  return new Map(rows.map(r => [Number(r.u), { avgHours: r.minutes == null ? null : Math.round(Number(r.minutes) / 6) / 10, measured: n(r.measured) }]));
}

/**
 * Staff comparison: 2–10 members side by side for the period, with the previous period of the same length
 * (growth), working days (for per-working-day figures), day-by-day and weekly activity, and conversion time.
 * Team view only; every member must belong to this workspace.
 */
async function compare(ctx, query = {}) {
  if (!permissions(ctx).compare) throw httpError(403, 'Comparing staff needs the "Compare staff" permission.', 'FORBIDDEN');
  const ids = [...new Set(String(query.ids || '').split(',').map(Number).filter(x => Number.isInteger(x) && x > 0))];
  if (ids.length < 2 || ids.length > 10) throw httpError(400, 'Pick 2 to 10 staff to compare.', 'VALIDATION_ERROR');
  const week = [5, 6, 7].includes(Number(query.workweek)) ? Number(query.workweek) : 5;
  const W = ws(ctx);
  const p = period(query, await workspaceTz(W));
  const prev = previousPeriod(p);
  const all0 = await members(W, p);
  const prevAll = await members(W, prev);
  const chosen = ids.map(id => all0.find(m => m.id === id) || prevAll.find(m => m.id === id));
  if (chosen.some(m => !m)) throw httpError(404, 'One of these people is not a member of this workspace.', 'NOT_FOUND');
  const cfg = await scoring.getConfig(W);
  const tg = await evaluateTargets(W, chosen, p.to, p.tz);
  const [d, fc, dPrev, fcPrev, days, conv] = await Promise.all([
    collect(W, p.s, p.e), firstContact(W, p.s, p.e), collect(W, prev.s, prev.e), firstContact(W, prev.s, prev.e), dailyByUser(W, p, ids), conversionTimes(W, p, ids)
  ]);
  const rows = chosen.map(m => {
    const daily = days.get(m.id) || [];
    const wd = workingDays(p, m.joinedAt, week);
    return {
      ...enrich(rowFor(m, d, fc), m, p, cfg, tg.byMember.get(m.id)?.current), joinedAt: m.joinedAt,
      workingDays: wd, activeDays: daily.filter(x => x.total > 0).length,
      conversion: conv.get(m.id) || { avgHours: null, measured: 0 },
      previous: enrich(rowFor(m, dPrev, fcPrev), m, prev, cfg, tg.byMember.get(m.id)?.previous),
      daily, weekly: weekly(daily)
    };
  });
  await audit(ctx, 'performance.compared', { resourceType: 'workspace', resourceId: W, metadata: { from: p.from, to: p.to, members: ids } });
  return { from: p.from, to: p.to, timezone: p.tz, previous: { from: prev.from, to: prev.to }, workweek: week, members: rows,
    targets: tg.totals };
}

/**
 * Drill-down: the records behind one figure on the dashboard, for the people the viewer may see (and the role /
 * staff filters), in the period or one day / bucket of it. Paged; each kind returns its own columns. The totals
 * match the dashboard's figures because the conditions are the same.
 */
const DRILL = {
  leads_assigned: 'Leads assigned', never_contacted: 'Leads never contacted', leads_created: 'Leads created', leads_contacted: 'Leads contacted',
  leads_converted: 'Leads converted', followups_due: 'Follow-ups due', followups_completed: 'Follow-ups completed', followups_on_time: 'Follow-ups completed on time',
  followups_overdue: 'Overdue follow-ups', followups_late: 'Follow-ups completed late', followups_upcoming: 'Upcoming follow-ups', calls: 'Calls', calls_connected: 'Calls connected', emails_sent: 'Emails sent', activities: 'Notes & activities'
};
async function drill(ctx, query = {}) {
  const kind = String(query.kind || '');
  if (!DRILL[kind]) throw httpError(400, 'Unknown figure.', 'VALIDATION_ERROR');
  const W = ws(ctx);
  const tz = await workspaceTz(W);
  const base = period(query, tz);
  // A day or bucket inside the period (e.g. a point of the trend).
  const okD = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const p = okD(query.dayFrom) ? period({ from: query.dayFrom, to: okD(query.dayTo) ? query.dayTo : query.dayFrom }, tz) : base;
  let list = await members(W, base);
  if (!isManager(ctx)) list = list.filter(m => m.id === Number(ctx.auth.userId));
  const role = String(query.role || '').trim();
  const staff = String(query.staff || '').split(',').map(Number).filter(x => Number.isInteger(x) && x > 0);
  list = list.filter(m => (!role || m.role === role) && (!staff.length || staff.includes(m.id)));
  if (query.userId) {
    const uid = Number(query.userId);
    if (!list.some(m => m.id === uid)) throw httpError(isManager(ctx) ? 404 : 403, isManager(ctx) ? 'Not a member of this workspace.' : 'You can see only your own performance.', isManager(ctx) ? 'NOT_FOUND' : 'FORBIDDEN');
    list = list.filter(m => m.id === uid);
  }
  const names = new Map(list.map(m => [m.id, m.name]));
  const ids = list.length ? list.map(m => m.id) : [0];
  const IN = `(${ids.map(() => '?').join(',')})`;
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));
  const page = Math.max(1, Number(query.page) || 1);
  const st = String(query.status || '');
  let sql; let args; let order; let columns;
  const leadCols = [['person', 'Staff'], ['lead', 'Lead'], ['company', 'Company'], ['status', 'Status'], ['source', 'Source']];
  if (kind === 'leads_assigned' || kind === 'never_contacted') {
    sql = `SELECT l.owner_user_id userId, l.id leadId, l.name leadName, l.company_name company, l.status, COALESCE(NULLIF(l.lead_source, ''), 'unknown') source, l.created_at at, ${LAST_CONTACT('l')} lastContact
      FROM leads l WHERE l.workspace_id = ? AND l.owner_user_id IN ${IN}`;
    args = [W, ...ids];
    if (kind === 'never_contacted') sql += ` AND NOT ${CONTACT_EXISTS('l')}`;
    if (st === 'contacted') sql += ` AND ${CONTACT_EXISTS('l')}`;
    if (st === 'won') sql += " AND l.status = 'Won'";
    if (st === 'lost') sql += " AND l.status = 'Lost'";
    if (st === 'open') sql += " AND COALESCE(l.status, '') NOT IN ('Won', 'Lost')";
    order = 'l.id DESC'; columns = [...leadCols, ['at', 'Added', 'date'], ['lastContact', 'Last contact', 'date']];
  } else if (kind === 'leads_created') {
    sql = `SELECT l.created_by_user_id userId, l.id leadId, l.name leadName, l.company_name company, l.status, COALESCE(NULLIF(l.lead_source, ''), 'unknown') source, l.created_at at
      FROM leads l WHERE l.workspace_id = ? AND l.created_by_user_id IN ${IN} AND l.created_at BETWEEN ? AND ?`;
    args = [W, ...ids, p.s, p.e]; order = 'l.created_at DESC'; columns = [...leadCols, ['at', 'Created', 'date']];
  } else if (kind === 'leads_contacted') {
    sql = `SELECT x.u userId, l.id leadId, l.name leadName, l.company_name company, l.status, COALESCE(NULLIF(l.lead_source, ''), 'unknown') source, MIN(x.at) at, COUNT(*) touches,
        GROUP_CONCAT(DISTINCT x.how ORDER BY x.how SEPARATOR ', ') how
      FROM (SELECT c.user_id u, c.lead_id lead_ref, c.started_at at, 'call' how FROM crm_call_logs c WHERE c.lead_workspace_id = ? AND c.lead_id IS NOT NULL AND c.started_at BETWEEN ? AND ?
        UNION ALL SELECT a.performed_by, a.lead_id, a.activity_at, a.activity_type FROM lead_activities a WHERE a.workspace_id = ? AND a.activity_type IN ('meeting', 'call', 'email', 'whatsapp', 'sms') AND a.activity_at BETWEEN ? AND ?
        UNION ALL SELECT e.sent_by_user_id, l2.id, e.sent_at, 'email' FROM emails e JOIN leads l2 ON l2.workspace_id = e.workspace_id AND l2.email IS NOT NULL AND l2.email <> '' AND LOWER(TRIM(l2.email)) = LOWER(TRIM(e.recipient_email))
          WHERE e.workspace_id = ? AND e.status = 'Sent' AND e.sent_by_user_id IS NOT NULL AND e.sent_at BETWEEN ? AND ?) x
      JOIN leads l ON l.id = x.lead_ref AND l.workspace_id = ? WHERE x.u IN ${IN} GROUP BY x.u, l.id, l.name, l.company_name, l.status, source`;
    args = [W, p.s, p.e, W, p.s, p.e, W, p.s, p.e, W, ...ids]; order = 'at DESC';
    columns = [...leadCols, ['at', 'First contact in period', 'date'], ['how', 'How'], ['touches', 'Contacts']];
  } else if (kind === 'leads_converted') {
    sql = `SELECT l.owner_user_id userId, l.id leadId, l.name leadName, l.company_name company, l.status, COALESCE(NULLIF(l.lead_source, ''), 'unknown') source, MIN(ev.created_at) at
      FROM leads l JOIN automation_events ev ON ev.workspace_id = l.workspace_id AND ev.event_type = 'lead.status_changed' AND ev.subject_type = 'lead' AND ev.subject_id = l.id
        AND JSON_UNQUOTE(JSON_EXTRACT(ev.payload_json, '$.to')) = 'Won'
      WHERE l.workspace_id = ? AND l.owner_user_id IN ${IN} AND l.status = 'Won' AND ev.created_at BETWEEN ? AND ? GROUP BY l.id, l.owner_user_id, l.name, l.company_name, l.status, source`;
    args = [W, ...ids, p.s, p.e]; order = 'at DESC'; columns = [...leadCols, ['at', 'Won on', 'date']];
  } else if (kind.startsWith('followups_')) {
    sql = `SELECT f.assigned_user_id userId, f.id, f.title, f.followup_type type, f.priority, f.status, f.due_at due, f.completed_at at, f.completion_notes notes, l.id leadId, l.name leadName
      FROM lead_followups f JOIN leads l ON l.id = f.lead_id WHERE f.workspace_id = ? AND f.assigned_user_id IN ${IN}`;
    args = [W, ...ids];
    if (kind === 'followups_overdue') sql += " AND f.status = 'pending' AND f.due_at < UTC_TIMESTAMP()";
    else if (kind === 'followups_upcoming') sql += " AND f.status = 'pending' AND f.due_at >= UTC_TIMESTAMP()";
    else {
      // by=completed: completed in the range (the trend counts follow-ups by the day they were done); else due in it.
      sql += query.by === 'completed' ? ' AND f.completed_at BETWEEN ? AND ?' : ' AND f.due_at BETWEEN ? AND ?'; args.push(p.s, p.e);
      if (kind === 'followups_completed') sql += " AND f.status = 'completed'";
      if (kind === 'followups_on_time') sql += " AND f.status = 'completed' AND f.completed_at <= f.due_at";
      if (kind === 'followups_late') sql += " AND f.status = 'completed' AND f.completed_at > f.due_at";
    }
    order = 'f.due_at DESC';
    columns = [['person', 'Staff'], ['title', 'Follow-up'], ['lead', 'Lead'], ['due', 'Due', 'date'], ['at', 'Completed', 'date'], ['state', 'Status'], ['notes', 'Notes']];
  } else if (kind === 'calls' || kind === 'calls_connected') {
    sql = `SELECT c.user_id userId, c.id callId, c.started_at at, c.answered, c.duration_seconds seconds, c.transcript_status transcript, c.lead_id leadId, COALESCE(l.name, c.name, c.phone) leadName
      FROM crm_call_logs c LEFT JOIN leads l ON l.id = c.lead_id WHERE ${CALL_SCOPE} AND c.user_id IN ${IN} AND c.started_at BETWEEN ? AND ?${kind === 'calls_connected' ? ' AND c.answered = 1' : ''}`;
    args = [W, W, ...ids, p.s, p.e]; order = 'c.started_at DESC';
    columns = [['person', 'Staff'], ['lead', 'Lead'], ['at', 'When', 'date'], ['result', 'Result'], ['duration', 'Duration'], ['transcriptLabel', 'Transcript']];
  } else if (kind === 'emails_sent') {
    sql = `SELECT e.sent_by_user_id userId, e.id, e.subject, e.recipient_email recipient, e.sent_at at, CASE WHEN ${IS_BATCH('e')} THEN 'Product email' ELSE 'One-to-one' END kindLabel,
        (SELECT l.id FROM leads l WHERE l.workspace_id = e.workspace_id AND l.email IS NOT NULL AND l.email <> '' AND LOWER(TRIM(l.email)) = LOWER(TRIM(e.recipient_email)) ORDER BY l.id LIMIT 1) leadId,
        CASE WHEN t.bounced_at IS NOT NULL THEN 'Bounced' WHEN t.first_click_at IS NOT NULL THEN 'Clicked' WHEN t.track_opens = 1 AND t.first_open_at IS NOT NULL THEN 'Opened' WHEN t.delivered_at IS NOT NULL THEN 'Delivered' ELSE 'Sent' END state
      FROM emails e LEFT JOIN mail_message_tracking t ON t.workspace_id = e.workspace_id AND t.email_id = e.id
      WHERE e.workspace_id = ? AND e.status = 'Sent' AND e.sent_by_user_id IN ${IN} AND e.sent_at BETWEEN ? AND ?`;
    args = [W, ...ids, p.s, p.e]; order = 'e.sent_at DESC';
    columns = [['person', 'Staff'], ['subject', 'Subject'], ['recipient', 'To'], ['at', 'Sent', 'date'], ['kindLabel', 'Kind'], ['state', 'Status']];
  } else {
    sql = `SELECT a.performed_by userId, a.id, a.activity_type type, COALESCE(NULLIF(a.title, ''), LEFT(a.description, 160)) title, a.activity_at at, l.id leadId, l.name leadName
      FROM lead_activities a JOIN leads l ON l.id = a.lead_id WHERE a.workspace_id = ? AND a.performed_by IN ${IN} AND a.activity_at BETWEEN ? AND ?`;
    args = [W, ...ids, p.s, p.e];
    if (query.type) { sql += ' AND a.activity_type = ?'; args.push(String(query.type)); }
    order = 'a.activity_at DESC';
    columns = [['person', 'Staff'], ['typeLabel', 'Type'], ['title', 'Note'], ['lead', 'Lead'], ['at', 'When', 'date']];
  }
  const [rows, total] = await Promise.all([
    safe(all(`${sql} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, args)),
    safe(all(`SELECT COUNT(*) n FROM (${sql}) z`, args))
  ]);
  const dur = s0 => (!s0 ? '—' : s0 >= 60 ? `${Math.floor(s0 / 60)}m ${s0 % 60}s` : `${s0}s`);
  const out = rows.map(r => {
    // The lead's name is selected as leadName (LEAD is a reserved word in MySQL 8).
    const o = { ...r, lead: r.leadName, person: names.get(Number(r.userId)) || `Member ${r.userId}` };
    delete o.leadName;
    if (o.lastContact && String(o.lastContact).startsWith('1970')) o.lastContact = null;
    if ('answered' in o) { o.answered = !!o.answered; o.result = o.answered ? 'Connected' : 'Not answered'; o.duration = o.answered ? dur(o.seconds) : '—';
      o.transcriptLabel = o.transcript === 'done' ? 'Available' : o.transcript === 'failed' ? 'Failed' : o.transcript === 'pending' ? 'Processing' : '—'; }
    if (kind.startsWith('followups_')) o.state = o.status === 'pending' && new Date(o.due) < new Date() ? 'Overdue' : o.status === 'completed' ? (new Date(o.at) <= new Date(o.due) ? 'On time' : 'Late') : o.status;
    if (kind === 'activities') o.typeLabel = ({ note: 'Note', meeting: 'Meeting', call: 'Call', email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' })[o.type] || o.type;
    if ('touches' in o) o.touches = n(o.touches);
    return o;
  });
  return { kind, title: DRILL[kind], from: p.from, to: p.to, timezone: tz, page, pageSize, total: n(total[0]?.n),
    columns: columns.filter(c => c[0] !== 'person' || list.length > 1).map(([key, label, type]) => ({ key, label, type: type || 'text' })), rows: out };
}

const EXPORT_LIMIT = 20000;

/**
 * The detailed export: the summary and the records behind it (leads, follow-ups, calls, emails, notes &
 * activities) for every member the person may see, in the period. Each sheet holds at most 20,000 rows
 * and says when it was cut.
 */
async function exportReport(ctx, query = {}) {
  if (isManager(ctx) && !permissions(ctx).exportTeam) throw httpError(403, 'Exporting the team report needs the "Export reports" permission.', 'FORBIDDEN');
  const r = await report(ctx, { ...query, staff: query.ids || query.staff });
  const W = ws(ctx);
  const p = period(query, r.timezone);
  const ids = r.members.map(m => m.userId);
  if (!ids.length) return { ...r, sheets: {} };
  const IN = `(${ids.map(() => '?').join(',')})`;
  const X = EXPORT_LIMIT + 1;
  const q = (sql, params) => safe(all(sql, params));
  const [leads, followups, calls, emails, activities] = await Promise.all([
    q(`SELECT l.owner_user_id userId, l.id leadId, l.name, l.company_name company, l.email, l.phone, l.status, l.lead_source source, l.created_at createdAt, ${LAST_CONTACT('l')} lastContact
       FROM leads l WHERE l.workspace_id = ? AND l.owner_user_id IN ${IN} ORDER BY l.owner_user_id, l.id DESC LIMIT ${X}`, [W, ...ids]),
    q(`SELECT f.assigned_user_id userId, f.id, f.title, f.followup_type type, f.priority, f.status, f.due_at dueAt, f.completed_at completedAt, f.completion_notes completionNotes, l.name leadName
       FROM lead_followups f JOIN leads l ON l.id = f.lead_id WHERE f.workspace_id = ? AND f.assigned_user_id IN ${IN} AND (f.due_at BETWEEN ? AND ? OR f.status = 'pending') ORDER BY f.assigned_user_id, f.due_at DESC LIMIT ${X}`, [W, ...ids, p.s, p.e]),
    q(`SELECT c.user_id userId, c.id, c.started_at startedAt, c.answered, c.duration_seconds durationSeconds, c.transcript_status transcriptStatus, COALESCE(l.name, c.name) leadName, c.phone
       FROM crm_call_logs c LEFT JOIN leads l ON l.id = c.lead_id WHERE ${CALL_SCOPE} AND c.user_id IN ${IN} AND c.started_at BETWEEN ? AND ? ORDER BY c.user_id, c.started_at DESC LIMIT ${X}`, [W, W, ...ids, p.s, p.e]),
    q(`SELECT e.sent_by_user_id userId, e.id, e.subject, e.recipient_email recipient, e.sent_at sentAt,
         CASE WHEN EXISTS (SELECT 1 FROM email_drafts d WHERE d.workspace_id = e.workspace_id AND d.email_id = e.id AND d.batch_id IS NOT NULL) THEN 'Product email' ELSE 'Individual' END kind,
         t.delivered_at deliveredAt, t.bounced_at bouncedAt, CASE WHEN t.track_opens = 1 THEN t.first_open_at END openedAt, t.first_click_at clickedAt
       FROM emails e LEFT JOIN mail_message_tracking t ON t.workspace_id = e.workspace_id AND t.email_id = e.id
       WHERE e.workspace_id = ? AND e.status = 'Sent' AND e.sent_by_user_id IN ${IN} AND e.sent_at BETWEEN ? AND ? ORDER BY e.sent_by_user_id, e.sent_at DESC LIMIT ${X}`, [W, ...ids, p.s, p.e]),
    q(`SELECT a.performed_by userId, a.id, a.activity_type type, a.title, a.description, a.activity_at at, a.duration_minutes durationMinutes, l.name leadName
       FROM lead_activities a JOIN leads l ON l.id = a.lead_id WHERE a.workspace_id = ? AND a.performed_by IN ${IN} AND a.activity_at BETWEEN ? AND ? ORDER BY a.performed_by, a.activity_at DESC LIMIT ${X}`, [W, ...ids, p.s, p.e])
  ]);
  const cut = rows => ({ rows: rows.slice(0, EXPORT_LIMIT), truncated: rows.length > EXPORT_LIMIT });
  await audit(ctx, 'performance.exported', { resourceType: 'workspace', resourceId: W, metadata: { from: p.from, to: p.to, members: ids.length } });
  return { ...r, sheets: { leads: cut(leads), followups: cut(followups), calls: cut(calls), emails: cut(emails), activities: cut(activities) }, exportLimit: EXPORT_LIMIT };
}

/**
 * One call with its transcript, from the performance drill-down. Owners/Admins: any call of this
 * workspace (made from its leads or campaigns); others: only their own. Reading it is audited.
 */
async function callTranscript(ctx, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid call.', 'VALIDATION_ERROR');
  const logs = require('../calling/callLogService');
  const W = ws(ctx);
  const row = await get(`${logs.SELECT} WHERE l.id = ? AND (l.lead_workspace_id = ? OR l.campaign_id IN (SELECT id FROM mail_campaigns WHERE workspace_id = ?))`, [id, W, W]);
  const own = row && Number(row.user_id) === Number(ctx.auth.userId);
  if (!row || (!own && !isManager(ctx))) throw httpError(404, 'Call not found.', 'NOT_FOUND');
  if (!own && !permissions(ctx).transcripts) throw httpError(403, 'Opening other people\'s call transcripts needs the "View call transcripts" permission.', 'FORBIDDEN');
  const lead = row.lead_id ? await get('SELECT id, name, company_name, phone FROM leads WHERE id = ? AND workspace_id = ?', [row.lead_id, W]) : null;
  await audit(ctx, 'performance.transcript_viewed', { resourceType: 'call', resourceId: id });
  return { call: { ...logs.present(row), leadId: row.lead_id || null, leadName: lead?.name || null, company: lead?.company_name || null, conversation: logs.conversation(row) } };
}

const canManageTargets = ctx => permissions(ctx).targets;

/** Targets & Goals: the definitions and everyone's progress (staff without team access: only their own). */
async function listTargets(ctx, query = {}) {
  const W = ws(ctx);
  const tz = await workspaceTz(W);
  const p = period(query, tz);
  let list = await members(W, p);
  const manager = isManager(ctx);
  if (!manager) list = list.filter(m => m.id === Number(ctx.auth.userId));
  let defs = await targets.listDefinitions(W);
  if (!manager) { const me = list[0]; defs = defs.filter(t => (t.scope === 'member' && t.userId === me?.id) || (t.scope === 'role' && t.role === me?.role)); }
  const tg = await evaluateTargets(W, list, p.to, tz);
  return {
    canManage: canManageTargets(ctx), asOf: p.to < localToday(tz) ? p.to : localToday(tz), timezone: tz,
    metrics: Object.entries(targets.METRICS).map(([key, m]) => ({ key, label: m.label, unit: m.unit || null, rate: !!m.rate })),
    periods: targets.PERIODS.map(k => ({ key: k, label: targets.PERIOD_LABEL[k] })),
    roles: [...new Set(list.map(m => m.role).filter(Boolean))].sort(),
    members: list.map(m => ({ userId: m.id, name: m.name, role: m.role, former: m.former, targets: tg.byMember.get(m.id)?.current })),
    definitions: defs, totals: tg.totals, team: tg.team
  };
}

async function saveTarget(ctx, id, body) {
  if (!canManageTargets(ctx)) throw httpError(403, 'Setting targets needs the "Manage staff targets" permission.', 'FORBIDDEN');
  const W = ws(ctx);
  const today = localToday(await workspaceTz(W));
  const t = id ? await targets.updateTarget(W, ctx.auth.userId, id, body) : await targets.createTarget(W, ctx.auth.userId, body, today);
  await audit(ctx, id ? 'performance.target_updated' : 'performance.target_set', { resourceType: 'staff_target', resourceId: t.id, metadata: { scope: t.scope, userId: t.userId, role: t.role, metric: t.metric, periodType: t.periodType, target: t.target } });
  return { target: t };
}

async function removeTarget(ctx, id) {
  if (!canManageTargets(ctx)) throw httpError(403, 'Setting targets needs the "Manage staff targets" permission.', 'FORBIDDEN');
  await targets.deleteTarget(ws(ctx), id);
  await audit(ctx, 'performance.target_deleted', { resourceType: 'staff_target', resourceId: Number(id) });
  return { deleted: true };
}

/** Scheduled reports: Owners/Admins, or team viewers with "Schedule performance reports". */
function requireSchedule(ctx) { if (!permissions(ctx).schedule) throw httpError(403, 'Scheduling reports needs the "Schedule performance reports" permission.', 'FORBIDDEN'); }
const schedules = () => require('./scheduledReports');
async function listSchedules(ctx) {
  requireSchedule(ctx);
  const W = ws(ctx);
  const people = await all(`SELECT u.id userId, COALESCE(NULLIF(u.display_name, ''), u.email) name, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ? AND m.status = 'Active' ORDER BY name`, [W]);
  return { schedules: await schedules().list(W), members: people, roles: [...new Set(people.map(p => p.role))].sort(), timezone: await workspaceTz(W) };
}
async function saveSchedule(ctx, id, body) { requireSchedule(ctx); return { schedule: await schedules().save(ctx, id, body) }; }
async function removeSchedule(ctx, id) { requireSchedule(ctx); await schedules().remove(ctx, id); return { deleted: true }; }
async function previewSchedule(ctx, id) { requireSchedule(ctx); return schedules().preview(ctx, id); }
async function testSchedule(ctx, id) { requireSchedule(ctx); return schedules().sendTest(ctx, id); }

async function getScoring(ctx) {
  if (!isManager(ctx)) throw httpError(403, 'Scoring settings need team access.', 'FORBIDDEN');
  const cfg = await scoring.getConfig(ws(ctx));
  return { config: cfg, defaults: scoring.DEFAULTS, measures: Object.fromEntries(Object.entries(scoring.MEASURES).map(([k, m]) => [k, { label: m.label, unit: m.unit, lowerIsBetter: !!m.lowerIsBetter }])),
    canEdit: permissions(ctx).scoring };
}
async function saveScoring(ctx, body) {
  if (!permissions(ctx).scoring) throw httpError(403, 'Changing the scoring needs the "Configure scoring" permission.', 'FORBIDDEN');
  const cfg = body?.reset ? await scoring.resetConfig(ws(ctx)) : await scoring.saveConfig(ws(ctx), ctx.auth.userId, body?.config);
  await audit(ctx, 'performance.scoring_changed', { resourceType: 'workspace', resourceId: ws(ctx), metadata: { reset: !!body?.reset } });
  return { config: cfg };
}

module.exports = { drill, listSchedules, saveSchedule, removeSchedule, previewSchedule, testSchedule, permissions, listTargets, saveTarget, removeTarget, evaluateTargets, getScoring, saveScoring, report, compare, memberDetail, memberRecords, memberDay, callTranscript, exportReport, period, previousPeriod, workingDays, offsetMinutes, workspaceTz };
