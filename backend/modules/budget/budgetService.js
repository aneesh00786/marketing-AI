const crypto = require('crypto');
const { z } = require('zod');
const { run, get, all } = require('../../db/database');
const { audit } = require('../../lib/audit');
const metaAds = require('./metaAdsSpend');

/**
 * Budget & ROI for Command Center campaigns.
 *
 * Kinds of numbers, never mixed:
 *   budget    what you plan to spend (configured; NEVER counted as spend)
 *   actual    spend reported by a connected provider (synced) or entered manually with evidence
 *   plan      the even-pacing line: budget × elapsed share of the period
 *   forecast  run-rate projection of actual spend to the period end (only with enough data)
 * ROI is calculated only from actual spend and revenue a person recorded, in one currency.
 * There is no currency conversion: entries must match the budget currency.
 */
const DEFAULT_THRESHOLDS = [50, 80, 100];
const STALE_HOURS = 48;
const MIN_FORECAST_DAYS = 3;

function httpError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const ws = ctx => ctx.auth.workspaceId;
const parse = (v, fb) => { try { return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
const dateOnly = v => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);
const todayUtc = () => new Date().toISOString().slice(0, 10);
const money = n => Math.round(Number(n) * 100) / 100;
const dayMs = 86400000;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / dayMs);

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const amount = z.number().min(0).max(1e10);

async function requireBudget(ctx, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw httpError('Invalid budget id.', 400, 'VALIDATION_ERROR');
  const b = await get('SELECT * FROM campaign_budgets WHERE id = ? AND workspace_id = ?', [id, ws(ctx)]);
  if (!b) throw httpError('Budget not found', 404, 'NOT_FOUND');
  return b;
}

// ---------------------------------------------------------------------------
// Summary: actuals, plan, forecast, pacing, ROI
// ---------------------------------------------------------------------------
async function summarize(b) {
  const start = dateOnly(b.period_start);
  const end = dateOnly(b.period_end);
  const today = todayUtc();
  const totalDays = daysBetween(start, end) + 1;
  const elapsedDays = today < start ? 0 : Math.min(daysBetween(start, today) + 1, totalDays);
  const entries = await all('SELECT source_type, source_id, spend_date, amount FROM budget_spend_entries WHERE budget_id = ? AND workspace_id = ? AND voided_at IS NULL', [b.id, b.workspace_id]);
  const revenueRows = await all('SELECT amount FROM budget_revenue_entries WHERE budget_id = ? AND workspace_id = ? AND voided_at IS NULL', [b.id, b.workspace_id]);
  const sources = await all('SELECT id, provider_key, external_account_id, status, last_synced_at, last_error, created_at FROM budget_spend_sources WHERE budget_id = ? AND workspace_id = ?', [b.id, b.workspace_id]);
  const budget = money(b.amount);

  // One period rule for every spend figure (% used, remaining, pacing, forecast, ROI): only spend
  // dated inside the budget period counts. Spend dated outside it is reported separately.
  const sum = list => money(list.reduce((a, e) => a + Number(e.amount), 0));
  const inPeriod = entries.filter(e => dateOnly(e.spend_date) >= start && dateOnly(e.spend_date) <= end);
  const outOfPeriod = entries.filter(e => !inPeriod.includes(e));
  const actualTotal = sum(inPeriod);
  const bySource = {
    provider: sum(inPeriod.filter(e => e.source_type === 'provider')),
    manual: sum(inPeriod.filter(e => e.source_type === 'manual'))
  };
  const inPeriodActual = actualTotal;
  const hasActuals = inPeriod.length > 0;
  // A zero budget with spend is over budget; no percentage is computed (it would divide by zero).
  const zeroBudgetSpent = budget === 0 && actualTotal > 0;

  const plannedToDate = money(budget * (elapsedDays / totalDays));
  let pacing;
  if (!hasActuals) pacing = { status: 'no_data', reason: outOfPeriod.length ? 'No spend is dated inside the budget period.' : sources.length ? 'No spend has been reported by the connected source yet.' : 'No actual spend recorded: connect an ad account or enter spend manually.' };
  else if (zeroBudgetSpent) pacing = { status: 'over', ratio: null, reason: 'The budget is 0, so any spend is over budget.' };
  else if (elapsedDays === 0) pacing = { status: 'not_started', reason: 'The budget period has not started.' };
  else {
    const ratio = plannedToDate ? inPeriodActual / plannedToDate : null;
    pacing = { status: ratio === null ? 'no_data' : ratio > 1.1 ? 'over' : ratio < 0.9 ? 'under' : 'on_track', ratio };
  }

  let forecast;
  if (!hasActuals) forecast = { value: null, status: 'unavailable', reason: 'No actual spend to project from.' };
  else if (elapsedDays < MIN_FORECAST_DAYS) forecast = { value: null, status: 'unavailable', reason: `Needs at least ${MIN_FORECAST_DAYS} days of the period to project.` };
  else if (elapsedDays >= totalDays) forecast = { value: inPeriodActual, status: 'actual', reason: 'The period has ended; this is the final actual spend.' };
  else forecast = { value: money((inPeriodActual / elapsedDays) * totalDays), status: 'forecast', method: `Run-rate: actual spend so far ÷ ${elapsedDays} elapsed day(s) × ${totalDays} days. A projection, not spend.` };

  const revenueTotal = money(revenueRows.reduce((a, r) => a + Number(r.amount), 0));
  let roi;
  if (!revenueRows.length) roi = { value: null, status: 'unavailable', reason: 'No revenue recorded for this campaign. Record won deals or paid invoices to calculate ROI.' };
  else if (!hasActuals || actualTotal === 0) roi = { value: null, status: 'unavailable', reason: 'No actual spend recorded, so ROI cannot be calculated (the budget is not spend).' };
  else roi = { value: (revenueTotal - actualTotal) / actualTotal, status: 'available', basis: `(recorded revenue ${revenueTotal} − actual spend ${actualTotal}) ÷ actual spend` };

  // Stale: last successful sync is older than STALE_HOURS, or a new source is still unsynced after that long.
  const olderThan = t => t && Date.now() - new Date(t).getTime() > STALE_HOURS * 3600 * 1000;
  const stale = sources.filter(s => s.status === 'active' && (s.last_synced_at ? olderThan(s.last_synced_at) : olderThan(s.created_at)));
  return {
    period: { start, end, totalDays, elapsedDays },
    budget: { value: budget, currency: b.currency, status: 'budget', note: 'Configured budget. Not spend.' },
    actualSpend: {
      value: hasActuals ? actualTotal : 0, status: hasActuals ? 'actual' : 'none_recorded', currency: b.currency, bySource, inPeriod: inPeriodActual,
      outOfPeriod: { value: sum(outOfPeriod), entries: outOfPeriod.length, note: 'Spend dated outside the budget period; not counted in % used, remaining, pacing or ROI.' }
    },
    plannedToDate: { value: plannedToDate, status: 'plan', method: `Even pacing: budget × ${elapsedDays}/${totalDays} days.` },
    remaining: { value: money(budget - actualTotal), status: hasActuals ? 'actual' : 'none_recorded', note: 'Budget minus actual spend.' },
    percentUsed: zeroBudgetSpent
      ? { value: null, status: 'over_budget', reason: 'The budget is 0, so a percentage cannot be calculated; all spend is over budget.' }
      : { value: budget ? actualTotal / budget : null, status: hasActuals ? 'actual' : 'none_recorded', ...(budget ? {} : { reason: 'The budget is 0 and no spend is recorded.' }) },
    pacing,
    forecast,
    revenue: { value: revenueRows.length ? revenueTotal : null, status: revenueRows.length ? 'recorded' : 'unavailable', currency: b.currency, reason: revenueRows.length ? null : 'No revenue recorded.' },
    roi,
    sources: sources.map(s => ({ ...s, stale: stale.some(x => x.id === s.id) }))
  };
}

// ---------------------------------------------------------------------------
// Alerts (each fires once per budget + key)
// ---------------------------------------------------------------------------
async function evaluateAlerts(b, summary = null) {
  const s = summary || await summarize(b);
  const candidates = [];
  const thresholds = parse(b.alert_thresholds_json, DEFAULT_THRESHOLDS);
  const used = s.percentUsed.value;
  if (s.actualSpend.status === 'actual' && used !== null) {
    for (const t of thresholds) {
      if (used * 100 >= t) candidates.push({ key: `threshold_${t}`, severity: t >= 100 ? 'critical' : t >= 80 ? 'warning' : 'info', message: `Actual spend reached ${Math.round(used * 100)}% of the budget (${s.actualSpend.value} of ${s.budget.value} ${b.currency}).` });
    }
  }
  if (s.percentUsed.status === 'over_budget') {
    candidates.push({ key: 'threshold_100', severity: 'critical', message: `Actual spend of ${s.actualSpend.value} ${b.currency} was recorded against a budget of 0.` });
  }
  if (s.forecast.status === 'forecast' && s.forecast.value > s.budget.value) {
    candidates.push({ key: 'forecast_overrun', severity: 'warning', message: `At the current run-rate, spend is forecast to reach ${s.forecast.value} ${b.currency}, above the ${s.budget.value} ${b.currency} budget (forecast, not actual).` });
  }
  for (const src of s.sources) {
    if (src.last_error) candidates.push({ key: `sync_error_${src.id}`, severity: 'warning', message: `Spend sync from ${src.provider_key} (${src.external_account_id}) failed: ${src.last_error}` });
    if (src.stale) candidates.push({ key: `stale_${src.id}_${todayUtc()}`, severity: 'info', message: `Spend from ${src.provider_key} (${src.external_account_id}) has not synced in over ${STALE_HOURS} hours; totals may be incomplete.` });
  }
  if (s.actualSpend.status !== 'actual' && s.period.elapsedDays >= 7) {
    candidates.push({ key: 'no_actuals_7d', severity: 'info', message: 'A week into the budget period and no actual spend has been recorded. Connect an ad account or enter spend so pacing can be measured.' });
  }
  const created = [];
  for (const c of candidates) {
    const r = await run('INSERT IGNORE INTO budget_alerts (workspace_id, budget_id, alert_key, severity, message, metrics_json, created_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
      [b.workspace_id, b.id, c.key, c.severity, c.message.slice(0, 1000), JSON.stringify({ actual: s.actualSpend.value, budget: s.budget.value, forecast: s.forecast.value })]);
    if (r.changes) {
      created.push(c.key);
      await audit({ workspaceId: b.workspace_id, actorType: 'system' }, 'budget.alert', { resourceType: 'campaign_budget', resourceId: b.id, metadata: { key: c.key, severity: c.severity } });
    }
  }
  return created;
}

async function alertsFor(b) {
  return (await all('SELECT id, alert_key, severity, message, created_at, acknowledged_at FROM budget_alerts WHERE budget_id = ? AND workspace_id = ? ORDER BY id DESC LIMIT 50', [b.id, b.workspace_id]))
    .map(a => ({ id: a.id, key: a.alert_key, severity: a.severity, message: a.message, createdAt: a.created_at, acknowledgedAt: a.acknowledged_at }));
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------
function present(b) {
  return { id: b.id, programId: b.program_id, amount: money(b.amount), currency: b.currency, periodStart: dateOnly(b.period_start), periodEnd: dateOnly(b.period_end),
    alertThresholds: parse(b.alert_thresholds_json, DEFAULT_THRESHOLDS), status: b.status, createdAt: b.created_at, updatedAt: b.updated_at };
}

async function listBudgets(ctx) {
  const rows = await all(`SELECT b.*, p.name AS program_name FROM campaign_budgets b JOIN campaign_programs p ON p.id = b.program_id AND p.workspace_id = b.workspace_id
    WHERE b.workspace_id = ? ORDER BY b.id DESC`, [ws(ctx)]);
  const out = [];
  for (const b of rows) {
    const s = await summarize(b);
    await evaluateAlerts(b, s);
    const open = await get('SELECT COUNT(*) AS n FROM budget_alerts WHERE budget_id = ? AND acknowledged_at IS NULL', [b.id]);
    out.push({ ...present(b), programName: b.program_name, summary: s, openAlerts: Number(open.n) });
  }
  // Campaigns without a budget, so the UI can offer to add one (planning budget shown as a hint only).
  const without = await all(`SELECT p.id, p.name, p.budget_amount, p.budget_currency, p.start_date, p.end_date FROM campaign_programs p
    LEFT JOIN campaign_budgets b ON b.program_id = p.id WHERE p.workspace_id = ? AND b.id IS NULL AND p.status <> 'archived' ORDER BY p.id DESC`, [ws(ctx)]);
  return { budgets: out, programsWithoutBudget: without.map(p => ({ id: p.id, name: p.name, plannedBudget: p.budget_amount !== null ? { amount: Number(p.budget_amount), currency: p.budget_currency } : null, startDate: dateOnly(p.start_date), endDate: dateOnly(p.end_date) })) };
}

async function getBudget(ctx, id) {
  const b = await requireBudget(ctx, id);
  const program = await get('SELECT id, name, outreach_campaign_id, social_campaign_id FROM campaign_programs WHERE id = ? AND workspace_id = ?', [b.program_id, ws(ctx)]);
  const s = await summarize(b);
  await evaluateAlerts(b, s);
  const spend = await all('SELECT * FROM budget_spend_entries WHERE budget_id = ? AND workspace_id = ? ORDER BY spend_date DESC, id DESC LIMIT 500', [b.id, ws(ctx)]);
  const revenue = await all('SELECT * FROM budget_revenue_entries WHERE budget_id = ? AND workspace_id = ? ORDER BY received_date DESC, id DESC LIMIT 500', [b.id, ws(ctx)]);
  // Daily cumulative actual vs. plan for the chart.
  const days = [];
  const perDay = {};
  for (const e of spend.filter(x => !x.voided_at)) perDay[dateOnly(e.spend_date)] = (perDay[dateOnly(e.spend_date)] || 0) + Number(e.amount);
  let cum = 0;
  for (let i = 0; i < s.period.totalDays; i++) {
    const d = new Date(Date.parse(`${s.period.start}T00:00:00Z`) + i * dayMs).toISOString().slice(0, 10);
    cum += perDay[d] || 0;
    days.push({ date: d, actualCumulative: d <= todayUtc() ? money(cum) : null, planCumulative: money(Number(b.amount) * ((i + 1) / s.period.totalDays)) });
  }
  const presentEntry = e => ({ id: e.id, sourceType: e.source_type, sourceId: e.source_id, date: dateOnly(e.spend_date || e.received_date), amount: money(e.amount), currency: e.currency,
    description: e.description, evidenceRef: e.evidence_ref, leadId: e.lead_id || null, enteredBy: e.entered_by, createdAt: e.created_at, voided: !!e.voided_at, voidReason: e.void_reason });
  return { ...present(b), program, summary: s, daily: days, spend: spend.map(presentEntry), revenue: revenue.map(presentEntry), alerts: await alertsFor(b) };
}

const budgetSchema = z.object({
  programId: z.number().int().positive(),
  amount,
  currency,
  periodStart: dateStr,
  periodEnd: dateStr,
  alertThresholds: z.array(z.number().int().min(1).max(200)).max(6).optional()
}).strict();

async function createBudget(ctx, input) {
  const v = budgetSchema.parse(input);
  if (v.periodEnd < v.periodStart) throw httpError('The period must end on or after it starts.', 400, 'VALIDATION_ERROR');
  const p = await get('SELECT id FROM campaign_programs WHERE id = ? AND workspace_id = ?', [v.programId, ws(ctx)]);
  if (!p) throw httpError('Campaign not found in this workspace.', 404, 'NOT_FOUND');
  if (await get('SELECT id FROM campaign_budgets WHERE program_id = ?', [v.programId])) throw httpError('This campaign already has a budget.', 409, 'EXISTS');
  const r = await run(
    'INSERT INTO campaign_budgets (workspace_id, program_id, amount, currency, period_start, period_end, alert_thresholds_json, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'active\', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
    [ws(ctx), v.programId, money(v.amount), v.currency, v.periodStart, v.periodEnd, JSON.stringify([...new Set(v.alertThresholds || DEFAULT_THRESHOLDS)].sort((a, b) => a - b)), ctx.auth.userId || null]
  );
  await audit(ctx, 'budget.created', { resourceType: 'campaign_budget', resourceId: r.lastID, metadata: { programId: v.programId, amount: v.amount, currency: v.currency } });
  return getBudget(ctx, r.lastID);
}

async function updateBudget(ctx, id, input) {
  const b = await requireBudget(ctx, id);
  const v = budgetSchema.partial().omit({ programId: true }).strict().parse(input);
  if (v.currency && v.currency !== b.currency) {
    const spend = await get('SELECT COUNT(*) AS n FROM budget_spend_entries WHERE budget_id = ? AND voided_at IS NULL', [b.id]);
    const revenue = await get('SELECT COUNT(*) AS n FROM budget_revenue_entries WHERE budget_id = ? AND voided_at IS NULL', [b.id]);
    if (Number(spend.n) || Number(revenue.n)) throw httpError('The currency cannot change once spend or revenue is recorded (there is no currency conversion).', 409, Number(spend.n) ? 'HAS_SPEND' : 'HAS_REVENUE');
  }
  const next = { amount: v.amount ?? Number(b.amount), currency: v.currency ?? b.currency, periodStart: v.periodStart ?? dateOnly(b.period_start), periodEnd: v.periodEnd ?? dateOnly(b.period_end), thresholds: v.alertThresholds ?? parse(b.alert_thresholds_json, DEFAULT_THRESHOLDS) };
  if (next.periodEnd < next.periodStart) throw httpError('The period must end on or after it starts.', 400, 'VALIDATION_ERROR');
  await run('UPDATE campaign_budgets SET amount = ?, currency = ?, period_start = ?, period_end = ?, alert_thresholds_json = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?',
    [money(next.amount), next.currency, next.periodStart, next.periodEnd, JSON.stringify([...new Set(next.thresholds)].sort((a, c) => a - c)), b.id, ws(ctx)]);
  await audit(ctx, 'budget.updated', { resourceType: 'campaign_budget', resourceId: b.id, metadata: { before: present(b), after: next } });
  return getBudget(ctx, b.id);
}

// ---------------------------------------------------------------------------
// Actual spend: manual entries (with evidence) and voiding
// ---------------------------------------------------------------------------
const entrySchema = z.object({
  date: dateStr,
  amount: z.number().positive().max(1e10),
  currency,
  description: z.string().trim().min(1).max(500),
  evidenceRef: z.string().trim().max(255).optional().nullable()
}).strict();

async function addSpend(ctx, id, input) {
  const b = await requireBudget(ctx, id);
  const v = entrySchema.parse(input);
  if (v.currency !== b.currency) throw httpError(`Spend must be in the budget currency (${b.currency}); there is no currency conversion.`, 400, 'CURRENCY_MISMATCH');
  if (v.date > todayUtc()) throw httpError('Actual spend cannot be in the future. Planned spend belongs in the budget, not in actuals.', 400, 'FUTURE_SPEND');
  const r = await run(
    `INSERT INTO budget_spend_entries (workspace_id, budget_id, source_type, source_id, spend_date, amount, currency, external_ref, description, evidence_ref, entered_by, created_at)
     VALUES (?, ?, 'manual', NULL, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [ws(ctx), b.id, v.date, money(v.amount), v.currency, `manual:${crypto.randomUUID()}`, v.description, v.evidenceRef || null, ctx.auth.userId || null]
  );
  await audit(ctx, 'budget.spend_recorded', { resourceType: 'campaign_budget', resourceId: b.id, metadata: { entryId: r.lastID, amount: v.amount, currency: v.currency, date: v.date, source: 'manual' } });
  await evaluateAlerts(b);
  return getBudget(ctx, b.id);
}

async function voidEntry(ctx, id, table, entryId, input = {}) {
  const b = await requireBudget(ctx, id);
  const reason = z.object({ reason: z.string().trim().min(3).max(500) }).strict().parse(input).reason;
  const t = table === 'revenue' ? 'budget_revenue_entries' : 'budget_spend_entries';
  const e = await get(`SELECT * FROM ${t} WHERE id = ? AND budget_id = ? AND workspace_id = ?`, [Number(entryId), b.id, ws(ctx)]);
  if (!e) throw httpError('Entry not found', 404, 'NOT_FOUND');
  if (e.voided_at) throw httpError('This entry is already voided.', 409, 'ALREADY_VOIDED');
  if (t === 'budget_spend_entries' && e.source_type === 'provider') throw httpError('Provider-reported spend cannot be voided here; it is corrected by the next sync.', 409, 'PROVIDER_ENTRY');
  await run(`UPDATE ${t} SET voided_at = UTC_TIMESTAMP(), voided_by = ?, void_reason = ? WHERE id = ? AND workspace_id = ?`, [ctx.auth.userId || null, reason, e.id, ws(ctx)]);
  await audit(ctx, `budget.${table === 'revenue' ? 'revenue' : 'spend'}_voided`, { resourceType: 'campaign_budget', resourceId: b.id, metadata: { entryId: e.id, amount: Number(e.amount), reason } });
  return getBudget(ctx, b.id);
}

// ---------------------------------------------------------------------------
// Revenue a person recorded (never inferred)
// ---------------------------------------------------------------------------
async function addRevenue(ctx, id, input) {
  const b = await requireBudget(ctx, id);
  const v = z.object({
    date: dateStr, amount: z.number().positive().max(1e10), currency,
    description: z.string().trim().min(1).max(500), evidenceRef: z.string().trim().max(255).optional().nullable(),
    leadId: z.number().int().positive().optional().nullable()
  }).strict().parse(input);
  if (v.currency !== b.currency) throw httpError(`Revenue must be in the budget currency (${b.currency}); there is no currency conversion.`, 400, 'CURRENCY_MISMATCH');
  if (v.date > todayUtc()) throw httpError('Recorded revenue cannot be in the future.', 400, 'FUTURE_REVENUE');
  if (v.leadId && !(await get('SELECT id FROM leads WHERE id = ? AND workspace_id = ?', [v.leadId, ws(ctx)]))) throw httpError('Lead not found in this workspace.', 404, 'NOT_FOUND');
  const r = await run(
    'INSERT INTO budget_revenue_entries (workspace_id, budget_id, lead_id, amount, currency, received_date, description, evidence_ref, entered_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
    [ws(ctx), b.id, v.leadId || null, money(v.amount), v.currency, v.date, v.description, v.evidenceRef || null, ctx.auth.userId || null]
  );
  await audit(ctx, 'budget.revenue_recorded', { resourceType: 'campaign_budget', resourceId: b.id, metadata: { entryId: r.lastID, amount: v.amount, currency: v.currency, leadId: v.leadId || null } });
  return getBudget(ctx, b.id);
}

// ---------------------------------------------------------------------------
// Provider spend sources (Meta Ads via the existing Meta connection)
// ---------------------------------------------------------------------------
async function connectSource(ctx, id, input) {
  const b = await requireBudget(ctx, id);
  const v = z.object({
    provider: z.literal('meta_ads'),
    socialAccountId: z.number().int().positive(),
    adAccountId: z.string().trim().regex(/^(act_)?\d{3,30}$/, 'must be a Meta ad account id (digits, optionally prefixed act_)'),
    campaignIds: z.array(z.string().regex(/^\d{3,30}$/)).max(50).optional()
  }).strict().parse(input);
  const account = await get('SELECT * FROM social_accounts WHERE id = ? AND workspace_id = ?', [v.socialAccountId, ws(ctx)]);
  if (!account) throw httpError('Connected account not found in this workspace.', 404, 'NOT_FOUND');
  const check = metaAds.canReadSpend(account);
  if (!check.ok) throw httpError(check.reason, 400, 'SPEND_NOT_AVAILABLE');
  const adAccount = metaAds.normalizeAdAccount(v.adAccountId);
  try {
    const r = await run(
      `INSERT INTO budget_spend_sources (workspace_id, budget_id, provider_key, social_account_id, external_account_id, external_campaign_ids_json, status, created_by, created_at)
       VALUES (?, ?, 'meta_ads', ?, ?, ?, 'active', ?, UTC_TIMESTAMP())`,
      [ws(ctx), b.id, account.id, adAccount, JSON.stringify(v.campaignIds || []), ctx.auth.userId || null]
    );
    await audit(ctx, 'budget.source_connected', { resourceType: 'campaign_budget', resourceId: b.id, metadata: { sourceId: r.lastID, provider: 'meta_ads', adAccount } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw httpError('This ad account is already linked to the budget.', 409, 'EXISTS');
    throw err;
  }
  return getBudget(ctx, b.id);
}

/** Pulls actual daily spend; one entry per source + day (re-syncs update, never duplicate). */
async function syncSource(source, actor) {
  const b = await get('SELECT * FROM campaign_budgets WHERE id = ? AND workspace_id = ?', [source.budget_id, source.workspace_id]);
  const account = await get('SELECT * FROM social_accounts WHERE id = ? AND workspace_id = ?', [source.social_account_id, source.workspace_id]);
  const since = dateOnly(b.period_start);
  const until = [dateOnly(b.period_end), todayUtc()].sort()[0];
  if (until < since) return { synced: 0, note: 'The budget period has not started.' };
  try {
    const rows = await metaAds.fetchDailySpend(account, { adAccountId: source.external_account_id, campaignIds: parse(source.external_campaign_ids_json, []), since, until });
    if (rows.length && rows.some(r => !r.currency)) throw httpError(`Meta did not report the ad account currency, so the spend cannot be checked against the ${b.currency} budget. Nothing was imported.`, 409, 'CURRENCY_UNKNOWN');
    const wrong = rows.find(r => r.currency && r.currency !== b.currency);
    if (wrong) throw httpError(`The ad account reports spend in ${wrong.currency}, but the budget is in ${b.currency}. No conversion is applied; nothing was imported.`, 409, 'CURRENCY_MISMATCH');
    for (const r of rows) {
      await run(
        `INSERT INTO budget_spend_entries (workspace_id, budget_id, source_type, source_id, spend_date, amount, currency, external_ref, description, created_at)
         VALUES (?, ?, 'provider', ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE amount = VALUES(amount), updated_at = UTC_TIMESTAMP()`,
        [b.workspace_id, b.id, source.id, r.date, r.amount, b.currency, `meta_ads:${source.id}:${r.date}`, `Meta Ads spend · act_${source.external_account_id}`]
      );
    }
    await run('UPDATE budget_spend_sources SET last_synced_at = UTC_TIMESTAMP(), last_error = NULL WHERE id = ?', [source.id]);
    await audit(actor || { workspaceId: b.workspace_id, actorType: 'system' }, 'budget.spend_synced', { resourceType: 'campaign_budget', resourceId: b.id, metadata: { sourceId: source.id, days: rows.length } });
    await evaluateAlerts(b);
    return { synced: rows.length };
  } catch (err) {
    await run('UPDATE budget_spend_sources SET last_error = ? WHERE id = ?', [String(err.message).slice(0, 1000), source.id]);
    if (['CURRENCY_UNKNOWN', 'CURRENCY_MISMATCH'].includes(err.code)) {
      await audit(actor || { workspaceId: b.workspace_id, actorType: 'system' }, 'budget.spend_sync_rejected', { resourceType: 'campaign_budget', resourceId: b.id, metadata: { sourceId: source.id, reason: err.code } });
    }
    await evaluateAlerts(b);
    throw err;
  }
}

async function syncNow(ctx, id, sourceId) {
  const b = await requireBudget(ctx, id);
  const src = await get('SELECT * FROM budget_spend_sources WHERE id = ? AND budget_id = ? AND workspace_id = ?', [Number(sourceId), b.id, ws(ctx)]);
  if (!src) throw httpError('Spend source not found', 404, 'NOT_FOUND');
  try {
    const r = await syncSource(src, ctx);
    return { ...r, budget: await getBudget(ctx, b.id) };
  } catch (err) {
    if (!err.status) err.status = 502;
    throw err;
  }
}

async function acknowledgeAlert(ctx, id, alertId) {
  const b = await requireBudget(ctx, id);
  const r = await run('UPDATE budget_alerts SET acknowledged_at = UTC_TIMESTAMP(), acknowledged_by = ? WHERE id = ? AND budget_id = ? AND workspace_id = ? AND acknowledged_at IS NULL', [ctx.auth.userId || null, Number(alertId), b.id, ws(ctx)]);
  if (!r.changes) throw httpError('Alert not found or already acknowledged', 404, 'NOT_FOUND');
  await audit(ctx, 'budget.alert_acknowledged', { resourceType: 'campaign_budget', resourceId: b.id, metadata: { alertId: Number(alertId) } });
  return { acknowledged: true };
}

/** Worker: sync provider sources every few hours and evaluate alerts for active budgets. */
const lastRun = { at: 0 };
async function processBudgets({ force = false } = {}) {
  if (!force && Date.now() - lastRun.at < 6 * 3600 * 1000) return 0;
  lastRun.at = Date.now();
  let n = 0;
  for (const src of await all("SELECT s.* FROM budget_spend_sources s JOIN campaign_budgets b ON b.id = s.budget_id WHERE s.status = 'active' AND b.status = 'active'")) {
    try { await syncSource(src); } catch (e) { /* recorded on the source and raised as an alert */ }
    n++;
  }
  for (const b of await all("SELECT * FROM campaign_budgets WHERE status = 'active'")) { await evaluateAlerts(b); n++; }
  return n;
}

module.exports = {
  listBudgets, getBudget, createBudget, updateBudget, addSpend, voidEntry, addRevenue,
  connectSource, syncNow, syncSource, acknowledgeAlert, evaluateAlerts, summarize, processBudgets
};
