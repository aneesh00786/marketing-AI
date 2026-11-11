const { all, get, run } = require('../../db/database');
const { audit } = require('../../lib/audit');

/**
 * Scheduled Team Performance reports (performance_report_schedules): a weekly report of the last full week or a
 * monthly report of the last full month, emailed to chosen members through the workspace's own mail settings
 * (emailService.sendRealEmail, not saved in Sent mail). Recipients must still be active members with team access
 * when it is sent; anyone else is skipped. The worker enqueues due reports once per period (idempotent) and
 * sends them as background jobs. Content is the same report as the dashboard; nothing is invented.
 */
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code, expose: true });
const svc = () => require('./performanceService');
const D = s => new Date(`${s}T00:00:00Z`);
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(D(s).getTime() + n * 86400000));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

const present = r => ({
  id: r.id, name: r.name, frequency: r.frequency, weekday: r.weekday, dayOfMonth: r.day_of_month, sendHour: r.send_hour,
  recipients: parse(r.recipients_json, []), scope: r.scope, scopeRole: r.scope_role, scopeMembers: parse(r.scope_members_json, []),
  format: r.format, active: !!r.active, lastSentAt: r.last_sent_at, lastPeriodKey: r.last_period_key, lastError: r.last_error
});

async function validate(W, b) {
  const name = String(b?.name || '').trim().slice(0, 120);
  if (!name) throw httpError(400, 'Give the report a name.', 'VALIDATION_ERROR');
  const frequency = b.frequency === 'monthly' ? 'monthly' : b.frequency === 'weekly' ? 'weekly' : null;
  if (!frequency) throw httpError(400, 'Choose weekly or monthly.', 'VALIDATION_ERROR');
  const weekday = frequency === 'weekly' ? Number(b.weekday ?? 1) : null;
  if (frequency === 'weekly' && !(weekday >= 1 && weekday <= 7)) throw httpError(400, 'Choose the day of the week (1 Monday … 7 Sunday).', 'VALIDATION_ERROR');
  const dayOfMonth = frequency === 'monthly' ? Number(b.dayOfMonth ?? 1) : null;
  if (frequency === 'monthly' && !(dayOfMonth >= 1 && dayOfMonth <= 28)) throw httpError(400, 'Choose a day of the month from 1 to 28.', 'VALIDATION_ERROR');
  const sendHour = Number(b.sendHour ?? 9);
  if (!(Number.isInteger(sendHour) && sendHour >= 0 && sendHour <= 23)) throw httpError(400, 'Choose an hour from 0 to 23.', 'VALIDATION_ERROR');
  const recipients = [...new Set((Array.isArray(b.recipients) ? b.recipients : []).map(Number).filter(Number.isInteger))];
  if (!recipients.length) throw httpError(400, 'Choose at least one recipient.', 'VALIDATION_ERROR');
  if (recipients.length > 50) throw httpError(400, 'At most 50 recipients.', 'VALIDATION_ERROR');
  const found = await all(`SELECT user_id FROM workspace_members WHERE workspace_id = ? AND status = 'Active' AND user_id IN (${recipients.map(() => '?').join(',')})`, [W, ...recipients]);
  if (found.length !== recipients.length) throw httpError(400, 'Recipients must be active members of this workspace.', 'VALIDATION_ERROR');
  const scope = ['team', 'role', 'members'].includes(b.scope) ? b.scope : 'team';
  const scopeRole = scope === 'role' ? String(b.scopeRole || '') : null;
  if (scope === 'role' && !scopeRole) throw httpError(400, 'Choose the role the report covers.', 'VALIDATION_ERROR');
  const scopeMembers = scope === 'members' ? [...new Set((b.scopeMembers || []).map(Number).filter(Number.isInteger))] : [];
  if (scope === 'members' && !scopeMembers.length) throw httpError(400, 'Choose the people the report covers.', 'VALIDATION_ERROR');
  const format = b.format === 'detailed' ? 'detailed' : 'summary';
  return { name, frequency, weekday, dayOfMonth, sendHour, recipients, scope, scopeRole, scopeMembers, format, active: b.active === false ? 0 : 1 };
}

async function list(W) { return (await all('SELECT * FROM performance_report_schedules WHERE workspace_id = ? ORDER BY id', [W]).catch(() => [])).map(present); }

async function save(ctx, id, body) {
  const W = ctx.auth.workspaceId;
  const v = await validate(W, body);
  const args = [v.name, v.frequency, v.weekday, v.dayOfMonth, v.sendHour, JSON.stringify(v.recipients), v.scope, v.scopeRole, JSON.stringify(v.scopeMembers), v.format, v.active];
  let sid = Number(id) || null;
  if (sid) {
    const r = await run(`UPDATE performance_report_schedules SET name = ?, frequency = ?, weekday = ?, day_of_month = ?, send_hour = ?, recipients_json = ?, scope = ?, scope_role = ?, scope_members_json = ?, format = ?, active = ?, updated_at = UTC_TIMESTAMP()
      WHERE id = ? AND workspace_id = ?`, [...args, sid, W]);
    if (!r.changes) throw httpError(404, 'Schedule not found.', 'NOT_FOUND');
  } else {
    sid = (await run(`INSERT INTO performance_report_schedules (name, frequency, weekday, day_of_month, send_hour, recipients_json, scope, scope_role, scope_members_json, format, active, workspace_id, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [...args, W, ctx.auth.userId || null])).lastID;
  }
  await audit(ctx, id ? 'performance.schedule_updated' : 'performance.schedule_created', { resourceType: 'performance_schedule', resourceId: sid, metadata: { frequency: v.frequency, recipients: v.recipients.length } });
  return present(await get('SELECT * FROM performance_report_schedules WHERE id = ?', [sid]));
}

async function remove(ctx, id) {
  const r = await run('DELETE FROM performance_report_schedules WHERE id = ? AND workspace_id = ?', [Number(id), ctx.auth.workspaceId]);
  if (!r.changes) throw httpError(404, 'Schedule not found.', 'NOT_FOUND');
  await audit(ctx, 'performance.schedule_deleted', { resourceType: 'performance_schedule', resourceId: Number(id) });
}

// ------------------------------------------------------------------ timing

/** Local date and hour now in the workspace's time zone. */
function localNow(tz, now = Date.now()) {
  const d = new Date(now + svc().offsetMinutes(tz, new Date(now)) * 60000);
  return { day: ymd(d), hour: d.getUTCHours() };
}

/**
 * The most recent send moment on or before now, and the period it reports: weekly → the full week (Mon–Sun) before
 * the send day; monthly → the full month before. Returns { sendDay, from, to, key }.
 */
function currentCycle(s, today) {
  const t = D(today);
  if (s.frequency === 'weekly') {
    const wd = ((t.getUTCDay() + 6) % 7) + 1; // 1 Monday … 7 Sunday
    const sendDay = addDays(today, -((wd - s.weekday + 7) % 7));
    const monday = addDays(sendDay, -(((D(sendDay).getUTCDay() + 6) % 7)));
    const from = addDays(monday, -7);
    return { sendDay, from, to: addDays(from, 6), key: `W${from}` };
  }
  let y = t.getUTCFullYear(); let m = t.getUTCMonth();
  if (t.getUTCDate() < s.day_of_month) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const sendDay = ymd(new Date(Date.UTC(y, m, s.day_of_month)));
  const from = ymd(new Date(Date.UTC(y, m - 1, 1)));
  const to = ymd(new Date(Date.UTC(y, m, 0)));
  return { sendDay, from, to, key: `M${from.slice(0, 7)}` };
}

function isDue(s, tz, now = Date.now()) {
  const { day, hour } = localNow(tz, now);
  const c = currentCycle(s, day);
  const reached = day > c.sendDay || (day === c.sendDay && hour >= s.send_hour);
  return reached && s.last_period_key !== c.key ? c : null;
}

/** Worker: enqueue every due report once per period (the idempotency key makes repeats harmless). */
async function enqueueDue(now = Date.now()) {
  const rows = await all(`SELECT s.*, COALESCE(NULLIF(w.timezone, ''), 'UTC') tz FROM performance_report_schedules s JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.active = 1 AND w.status = 'Active'`).catch(() => []);
  const jobs = require('../social/jobsService');
  let n = 0;
  for (const s of rows) {
    const c = isDue(s, s.tz, now);
    if (!c) continue;
    await jobs.enqueue(s.workspace_id, 'performance_report', { scheduleId: s.id, from: c.from, to: c.to, key: c.key }, { idempotencyKey: `perf_report:${s.id}:${c.key}`, maxAttempts: 2 });
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ content

function workerCtx(s) {
  return { auth: { workspaceId: s.workspace_id, userId: s.created_by || null, actorType: 'worker', capabilities: new Set(['members.manage', 'analytics.view']) } };
}

async function buildReport(s, from, to) {
  const q = { from, to };
  if (s.scope === 'role') q.role = s.scope_role;
  if (s.scope === 'members') q.staff = parse(s.scope_members_json, []).join(',');
  return svc().report(workerCtx(s), q);
}

const LEVEL = { excellent: 'Excellent', on_track: 'On track', needs_improvement: 'Needs improvement', critical: 'Critical' };

/** Plain, factual sentences from the figures (no AI). */
function observations(r) {
  const t = r.totals; const p = r.previous?.totals || {};
  const out = [];
  const pt = (a, b) => (a === null || b === null || a === undefined || b === undefined ? null : Math.round((a - b) * 10) / 10);
  const conv = pt(t.leads.periodConversionRate, p.leads?.periodConversionRate);
  if (conv) out.push(`Conversion ${conv > 0 ? 'rose' : 'fell'} by ${Math.abs(conv)} points to ${t.leads.periodConversionRate}%.`);
  const ot = pt(t.followups.onTimeRate, p.followups?.onTimeRate);
  if (ot) out.push(`Follow-ups on time ${ot > 0 ? 'improved' : 'slipped'} by ${Math.abs(ot)} points to ${t.followups.onTimeRate}%.`);
  const overdue = r.members.filter(m => m.followups.overdueNow);
  if (overdue.length) out.push(`${overdue.length} ${overdue.length === 1 ? 'person has' : 'people have'} overdue follow-ups (${overdue.reduce((a, m) => a + m.followups.overdueNow, 0)} in all).`);
  if (t.leads.neverContacted) out.push(`${t.leads.neverContacted} assigned lead${t.leads.neverContacted === 1 ? ' has' : 's have'} never been contacted.`);
  const ranked = r.members.filter(m => m.score?.score !== null && m.score?.score !== undefined).sort((a, b) => b.score.score - a.score.score);
  if (ranked[0]) out.push(`Highest score: ${ranked[0].name} (${ranked[0].score.score}).`);
  const moved = r.members.filter(m => m.score?.score != null && m.previous?.score?.score != null).map(m => ({ m, d: m.score.score - m.previous.score.score }));
  const down = moved.sort((a, b) => a.d - b.d)[0];
  if (down && down.d < 0) out.push(`Largest score decline: ${down.m.name} (${down.d}).`);
  if (t.targets?.total) out.push(`${t.targets.met} of ${t.targets.total} targets met; ${t.targets.atRisk} at risk.`);
  return out;
}

function renderHtml(r, s, title) {
  const t = r.totals; const p = r.previous?.totals || {};
  const cell = 'padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;';
  const num = cell + 'text-align:right;font-variant-numeric:tabular-nums;';
  const head = 'padding:6px 10px;border-bottom:2px solid #d1d5db;font-size:12px;color:#6b7280;text-align:left;';
  const pct = v => (v === null || v === undefined ? '—' : `${v}%`);
  const ch = (a, b, isRate) => {
    if (a === null || a === undefined || b === null || b === undefined) return '—';
    if (a === b) return 'no change';
    const d = isRate ? `${Math.round((a - b) * 10) / 10} pts` : b ? `${Math.round(((a - b) / b) * 1000) / 10}%` : 'new';
    return `${a > b ? '▲ +' : '▼ '}${d.replace(/^-/, '')}`;
  };
  const kpi = [
    ['Staff', t.staff, p.staff, false], ['Leads converted', t.leads.wonInPeriod, p.leads?.wonInPeriod, false], ['Conversion rate', t.leads.periodConversionRate, p.leads?.periodConversionRate, true],
    ['Follow-ups completed', t.followups.completed, p.followups?.completed, false], ['Follow-ups on time', t.followups.onTimeRate, p.followups?.onTimeRate, true],
    ['Calls connected', t.calls.answered, p.calls?.answered, false], ['Emails sent', t.emails.totalSent, p.emails?.totalSent, false]
  ];
  if (t.targets?.total) kpi.push(['Targets met', t.targets.rate, p.targets?.rate, true]);
  const ranked = [...r.members].sort((a, b) => (b.score?.score ?? -1) - (a.score?.score ?? -1));
  const top = s.format === 'detailed' ? ranked : ranked.slice(0, 10);
  const overdue = r.members.filter(m => m.followups.overdueNow).sort((a, b) => b.followups.overdueNow - a.followups.overdueNow);
  const uncontacted = r.members.filter(m => m.leads.neverContacted).sort((a, b) => b.leads.neverContacted - a.leads.neverContacted);
  const atRisk = r.members.flatMap(m => (m.targets?.items || []).filter(i => i.status === 'at_risk' || i.status === 'missed').map(i => ({ m, i })));
  const moved = r.members.filter(m => m.score?.score != null && m.previous?.score?.score != null).map(m => ({ m, d: m.score.score - m.previous.score.score })).sort((a, b) => b.d - a.d);
  const section = (h, body) => `<h3 style="font-size:15px;margin:22px 0 8px;color:#111827">${esc(h)}</h3>${body}`;
  const list = items => (items.length ? `<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.6">${items.join('')}</ul>` : '<p style="font-size:13px;color:#6b7280;margin:0">None.</p>');
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:Segoe UI,Arial,sans-serif;color:#111827">
<div style="max-width:760px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:24px">
<h2 style="margin:0 0 4px;font-size:20px">${esc(title)}</h2>
<p style="margin:0;color:#6b7280;font-size:13px">${esc(r.from)} to ${esc(r.to)} (${esc(r.timezone)}), compared with ${esc(r.previous?.from)} to ${esc(r.previous?.to)}. Counted from recorded activity.</p>
${section('Key observations', list(observations(r).map(o => `<li>${esc(o)}</li>`)))}
${section('Overall performance', `<table style="border-collapse:collapse;width:100%"><tr><th style="${head}">Measure</th><th style="${head}text-align:right">This period</th><th style="${head}text-align:right">Before</th><th style="${head}text-align:right">Change</th></tr>
${kpi.map(([l, a, b, rate]) => `<tr><td style="${cell}">${esc(l)}</td><td style="${num}">${esc(rate ? pct(a) : a ?? '—')}</td><td style="${num}">${esc(rate ? pct(b) : b ?? '—')}</td><td style="${num}">${esc(ch(a, b, rate))}</td></tr>`).join('')}</table>`)}
${section(s.format === 'detailed' ? 'Staff rankings' : 'Staff rankings (top 10)', `<table style="border-collapse:collapse;width:100%"><tr><th style="${head}">#</th><th style="${head}">Staff</th><th style="${head}">Performance</th><th style="${head}text-align:right">Converted</th><th style="${head}text-align:right">Conv.</th><th style="${head}text-align:right">On time</th><th style="${head}text-align:right">Calls connected</th><th style="${head}text-align:right">Target</th></tr>
${top.map((m, i) => `<tr><td style="${cell}">${m.score?.score != null ? i + 1 : '—'}</td><td style="${cell}"><b>${esc(m.name)}</b><br><span style="color:#6b7280;font-size:12px">${esc(m.role)}</span></td>
<td style="${cell}">${m.score?.score != null ? `${esc(LEVEL[m.score.level] || '')} (${m.score.score})` : 'Not enough data'}</td><td style="${num}">${m.leads.wonInPeriod}</td><td style="${num}">${esc(pct(m.leads.periodConversionRate))}</td>
<td style="${num}">${esc(pct(m.followups.onTimeRate))}</td><td style="${num}">${m.calls.answered}</td><td style="${num}">${m.targets?.total ? esc(pct(m.targets.achievement)) : 'No target'}</td></tr>`).join('')}</table>`)}
${t.targets?.total ? section('Target achievement', `<p style="font-size:13px;margin:0 0 6px">${t.targets.met} of ${t.targets.total} targets met (${esc(pct(t.targets.rate))}).</p>` + list(atRisk.slice(0, 20).map(({ m, i }) => `<li>${esc(m.name)}: ${esc(i.label)} ${esc(i.actual ?? 0)} of ${esc(i.target)} (${esc(i.cycle.label)}, ${i.status === 'missed' ? 'missed' : 'at risk'})</li>`))) : ''}
${section('Improving', list(moved.filter(x => x.d > 0).slice(0, 5).map(x => `<li>${esc(x.m.name)}: score +${x.d} (${x.m.previous.score.score} → ${x.m.score.score})</li>`)))}
${section('Declining', list(moved.filter(x => x.d < 0).reverse().slice(0, 5).map(x => `<li>${esc(x.m.name)}: score ${x.d} (${x.m.previous.score.score} → ${x.m.score.score})</li>`)))}
${section('Overdue follow-ups', list(overdue.map(m => `<li>${esc(m.name)}: ${m.followups.overdueNow}</li>`)))}
${section('Leads without contact', list(uncontacted.map(m => `<li>${esc(m.name)}: ${m.leads.neverContacted}</li>`)))}
<p style="margin:24px 0 0;color:#9ca3af;font-size:11px">Sent by Marketech.ai Team Performance (${esc(s.name)}). Open Team Performance for the details behind these figures.</p>
</div></body></html>`;
}

/** Who may receive it now: active members with team access (Owners/Admins or "View team performance"). */
async function eligibleRecipients(s) {
  const ids = parse(s.recipients_json, []);
  if (!ids.length) return [];
  const rows = await all(`SELECT u.id, u.email, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.status = 'Active' AND u.id IN (${ids.map(() => '?').join(',')})`, [s.workspace_id, ...ids]);
  const grants = require('../../lib/capabilityGrants');
  const out = [];
  for (const r of rows) {
    const caps = await grants.effectiveCapabilities(s.workspace_id, r.id, r.role);
    if (caps.has('members.manage') || caps.has('performance.view_team')) out.push(r);
  }
  return out;
}

async function sendFor(s, from, to, recipients) {
  const r = await buildReport(s, from, to);
  const title = `${s.frequency === 'weekly' ? 'Weekly' : 'Monthly'} team performance · ${from} to ${to}`;
  const html = renderHtml(r, s, title);
  const mail = require('../../services/emailService');
  const sent = []; const failed = [];
  for (const rcp of recipients) {
    try { await mail.sendRealEmail(s.workspace_id, { to: rcp.email, subject: title, html, record: false }); sent.push(rcp.id); }
    catch (err) { failed.push({ userId: rcp.id, error: String(err.message || err).slice(0, 200) }); }
  }
  return { sent, failed };
}

/** Background job: send one period's report. Marks the period as sent so it is never sent twice. */
async function runReportJob(job) {
  const { scheduleId, from, to, key } = JSON.parse(job.payload_json || '{}');
  const s = await get('SELECT * FROM performance_report_schedules WHERE id = ? AND workspace_id = ?', [scheduleId, job.workspace_id]);
  if (!s || !s.active || s.last_period_key === key) return { skipped: true };
  const recipients = await eligibleRecipients(s);
  const all0 = parse(s.recipients_json, []);
  const res = recipients.length ? await sendFor(s, from, to, recipients) : { sent: [], failed: [] };
  const skipped = all0.filter(id => !recipients.some(r => r.id === id));
  const error = res.failed.length ? `Not sent to ${res.failed.length}: ${res.failed[0].error}` : !recipients.length ? 'No recipient has team access any more.' : null;
  await run('UPDATE performance_report_schedules SET last_period_key = ?, last_sent_at = UTC_TIMESTAMP(), last_error = ? WHERE id = ?', [key, error, s.id]);
  await audit({ auth: { workspaceId: s.workspace_id, actorType: 'worker' } }, 'performance.report_sent', { resourceType: 'performance_schedule', resourceId: s.id, metadata: { key, sent: res.sent.length, failed: res.failed.length, skipped: skipped.length } }).catch(() => null);
  return { sent: res.sent.length, failed: res.failed.length, skipped: skipped.length };
}

/** Preview (HTML) or a test send to the person asking, for the last full period. */
async function preview(ctx, id) {
  const s = await get('SELECT * FROM performance_report_schedules WHERE id = ? AND workspace_id = ?', [Number(id), ctx.auth.workspaceId]);
  if (!s) throw httpError(404, 'Schedule not found.', 'NOT_FOUND');
  const tz = await svc().workspaceTz(s.workspace_id);
  const c = currentCycle(s, localNow(tz).day);
  const r = await buildReport(s, c.from, c.to);
  return { from: c.from, to: c.to, html: renderHtml(r, s, `${s.frequency === 'weekly' ? 'Weekly' : 'Monthly'} team performance · ${c.from} to ${c.to}`) };
}

async function sendTest(ctx, id) {
  const s = await get('SELECT * FROM performance_report_schedules WHERE id = ? AND workspace_id = ?', [Number(id), ctx.auth.workspaceId]);
  if (!s) throw httpError(404, 'Schedule not found.', 'NOT_FOUND');
  const me = await get('SELECT id, email FROM users WHERE id = ?', [ctx.auth.userId]);
  if (!me?.email) throw httpError(400, 'Your account has no email address.', 'VALIDATION_ERROR');
  const tz = await svc().workspaceTz(s.workspace_id);
  const c = currentCycle(s, localNow(tz).day);
  const res = await sendFor(s, c.from, c.to, [me]);
  if (res.failed.length) throw httpError(502, `The test report could not be sent: ${res.failed[0].error}`, 'MAIL_FAILED');
  await audit(ctx, 'performance.report_test_sent', { resourceType: 'performance_schedule', resourceId: s.id });
  return { sentTo: me.email, from: c.from, to: c.to };
}

module.exports = { list, save, remove, enqueueDue, runReportJob, preview, sendTest, currentCycle, isDue, renderHtml, observations };
