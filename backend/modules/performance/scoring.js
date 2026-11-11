const { get, run } = require('../../db/database');

/**
 * Performance score (0–100) from rates and speed, never from activity volume alone. Each measure scores
 * 0 at its minimum acceptable value and 100 at its target (linear between, capped), and the score is the
 * weighted average of the measures that have data. With too little data there is no score.
 *
 * The defaults below are a starting point shown to admins, who change measures, weights, minimums,
 * targets and level thresholds in Report Settings (stored per workspace).
 */
/** A rate needs at least this many cases to count (one lost lead is not a 0 % conversion rate). */
const MIN_SAMPLE = 3;
const enough = (n, v) => (Number(n) >= MIN_SAMPLE ? v : null);

const MEASURES = {
  // Won ÷ leads contacted in the period (the same rate the leaderboard shows).
  conversion: { label: 'Lead conversion (won ÷ contacted in the period)', unit: '%', get: r => enough(r.leads.contactedInPeriod, r.leads.periodConversionRate) },
  followupOnTime: { label: 'Follow-ups completed on time', unit: '%', get: r => enough(r.followups.completed, r.followups.onTimeRate) },
  followupCompletion: { label: 'Follow-ups completed', unit: '%', get: r => enough(r.followups.due, r.followups.completionRate) },
  contactCoverage: { label: 'Assigned leads contacted', unit: '%', get: r => enough(r.leads.assigned, r.leads.assigned ? Math.round((r.leads.contacted / r.leads.assigned) * 1000) / 10 : null) },
  firstContact: { label: 'Time to first contact (median)', unit: 'h', lowerIsBetter: true, get: r => r.leads.firstContact?.medianHours ?? null },
  productivity: { label: 'Recorded actions per working day', unit: '/day', get: r => r.productivity?.perDay ?? null },
  callAnswer: { label: 'Calls answered', unit: '%', get: r => enough(r.calls.made, r.calls.answerRate) },
  emailOpen: { label: 'Emails opened (estimate)', unit: '%', get: r => enough(r.emails.openTracked, r.emails.openRate) },
  // Average achievement of their targets; no targets, no data (left out of the score).
  targetAchievement: { label: 'Target achievement', unit: '%', get: r => (r.targets?.achievement ?? null) }
};

/** Score categories: each measure belongs to one; a category's score is the weighted average of its measures with data. */
const CATEGORIES = [
  { key: 'conversion', label: 'Conversion performance', measures: ['conversion'] },
  { key: 'followups', label: 'Follow-up discipline', measures: ['followupOnTime', 'followupCompletion'] },
  { key: 'leads', label: 'Lead management', measures: ['contactCoverage', 'firstContact'] },
  { key: 'communication', label: 'Communication', measures: ['callAnswer', 'emailOpen'] },
  { key: 'productivity', label: 'Productivity', measures: ['productivity'] },
  { key: 'targets', label: 'Target achievement', measures: ['targetAchievement'] }
];

const DEFAULTS = {
  workweek: 5,
  levels: { excellent: 80, onTrack: 60, needsImprovement: 40 },
  measures: {
    conversion: { enabled: true, weight: 30, min: 0, target: 20 },
    followupOnTime: { enabled: true, weight: 25, min: 50, target: 90 },
    followupCompletion: { enabled: true, weight: 15, min: 50, target: 95 },
    contactCoverage: { enabled: true, weight: 10, min: 50, target: 100 },
    firstContact: { enabled: true, weight: 10, min: 72, target: 4 },
    productivity: { enabled: true, weight: 10, min: 0, target: 15 },
    callAnswer: { enabled: false, weight: 0, min: 20, target: 60 },
    emailOpen: { enabled: false, weight: 0, min: 10, target: 40 },
    targetAchievement: { enabled: true, weight: 15, min: 50, target: 100 }
  }
};

const clone = o => JSON.parse(JSON.stringify(o));
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code, expose: true });

/** A stored config merged over the defaults (unknown keys dropped). */
function normalise(raw) {
  const c = clone(DEFAULTS);
  if (!raw || typeof raw !== 'object') return c;
  if ([5, 6, 7].includes(Number(raw.workweek))) c.workweek = Number(raw.workweek);
  for (const k of Object.keys(c.levels)) if (Number.isFinite(Number(raw.levels?.[k]))) c.levels[k] = Number(raw.levels[k]);
  for (const k of Object.keys(MEASURES)) {
    const m = raw.measures?.[k];
    if (!m) continue;
    c.measures[k] = { enabled: !!m.enabled, weight: Number(m.weight) || 0, min: Number(m.min), target: Number(m.target) };
  }
  return c;
}

/** Rejects configs that would give a meaningless score. */
function validate(raw) {
  const c = normalise(raw);
  const on = Object.entries(c.measures).filter(([, m]) => m.enabled && m.weight > 0);
  if (on.length < 2) throw httpError(400, 'Turn on at least two measures with a weight above 0.', 'VALIDATION_ERROR');
  for (const [k, m] of Object.entries(c.measures)) {
    if (m.weight < 0 || m.weight > 100) throw httpError(400, `${MEASURES[k].label}: the weight must be 0–100.`, 'VALIDATION_ERROR');
    if (!Number.isFinite(m.min) || !Number.isFinite(m.target) || m.min === m.target) throw httpError(400, `${MEASURES[k].label}: the minimum and the target must be different numbers.`, 'VALIDATION_ERROR');
    if (MEASURES[k].lowerIsBetter ? m.target > m.min : m.target < m.min) throw httpError(400, `${MEASURES[k].label}: the target must be ${MEASURES[k].lowerIsBetter ? 'below' : 'above'} the minimum.`, 'VALIDATION_ERROR');
  }
  const L = c.levels;
  if (!(L.excellent > L.onTrack && L.onTrack > L.needsImprovement && L.needsImprovement > 0 && L.excellent <= 100)) {
    throw httpError(400, 'Levels must go down: Excellent > On track > Needs improvement > 0.', 'VALIDATION_ERROR');
  }
  return c;
}

async function getConfig(workspaceId) {
  const row = await get('SELECT config_json FROM performance_scoring_configs WHERE workspace_id = ?', [workspaceId]).catch(() => null);
  let raw = null;
  try { raw = row ? JSON.parse(row.config_json) : null; } catch { raw = null; }
  return { ...normalise(raw), customised: !!row };
}

async function saveConfig(workspaceId, userId, raw) {
  const c = validate(raw);
  await run(`INSERT INTO performance_scoring_configs (workspace_id, config_json, updated_by, updated_at) VALUES (?, ?, ?, UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE config_json = VALUES(config_json), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`, [workspaceId, JSON.stringify(c), userId || null]);
  return { ...c, customised: true };
}

async function resetConfig(workspaceId) {
  await run('DELETE FROM performance_scoring_configs WHERE workspace_id = ?', [workspaceId]);
  return { ...clone(DEFAULTS), customised: false };
}

function level(score, L) {
  if (score === null) return null;
  return score >= L.excellent ? 'excellent' : score >= L.onTrack ? 'on_track' : score >= L.needsImprovement ? 'needs_improvement' : 'critical';
}

/**
 * The score of one member row: { score, level, coverage, parts }. No score when fewer than two measures
 * have data or they carry under half of the total weight.
 */
function score(row, cfg) {
  const parts = [];
  let total = 0; let covered = 0; let sum = 0; let withData = 0;
  for (const [k, m] of Object.entries(cfg.measures)) {
    if (!m.enabled || !(m.weight > 0)) continue;
    total += m.weight;
    const v = MEASURES[k].get(row);
    if (v === null || v === undefined || !Number.isFinite(Number(v))) { parts.push({ key: k, label: MEASURES[k].label, value: null, points: null, weight: m.weight }); continue; }
    const t = (Number(v) - m.min) / (m.target - m.min);
    const pts = Math.round(Math.max(0, Math.min(1, t)) * 100);
    parts.push({ key: k, label: MEASURES[k].label, value: Number(v), points: pts, weight: m.weight });
    covered += m.weight; sum += pts * m.weight; withData++;
  }
  const enough = withData >= 2 && total > 0 && covered / total >= 0.5;
  const s = enough ? Math.round(sum / covered) : null;
  const categories = CATEGORIES.map(c => {
    const ps = parts.filter(p => c.measures.includes(p.key));
    const w = ps.filter(p => p.points !== null).reduce((a, p) => a + p.weight, 0);
    return { key: c.key, label: c.label, weight: ps.reduce((a, p) => a + p.weight, 0), score: w ? Math.round(ps.filter(p => p.points !== null).reduce((a, p) => a + p.points * p.weight, 0) / w) : null };
  }).filter(c => c.weight > 0);
  return { score: s, level: level(s, cfg.levels), coverage: total ? Math.round((covered / total) * 100) : 0, parts, categories };
}

module.exports = { MIN_SAMPLE, MEASURES, CATEGORIES, DEFAULTS, normalise, validate, getConfig, saveConfig, resetConfig, score, level };
