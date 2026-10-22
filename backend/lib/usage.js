const { run, get } = require('../db/database');

/**
 * Usage metering for paid operations. Provider pricing is not configured in code,
 * so costs are recorded as estimates (AI_COST_PER_REQUEST_USD, default 0) with is_estimate = 1.
 */
// Read on each check so a changed setting applies without code changes (default as documented in .env.example).
const aiMonthlyRequestLimit = () => parseInt(process.env.SOCIAL_AI_MONTHLY_REQUEST_LIMIT || '500', 10);

// Old TradeSage labels kept so usage rows recorded before the rename still count as fallbacks.
const FALLBACK_PROVIDERS = new Set(['Marketech.ai Conversational AI', 'Marketech.ai Core', 'TradeSage Conversational AI', 'TradeSage Core']);

function isRealAiProvider(provider) {
  return !!provider && !FALLBACK_PROVIDERS.has(provider);
}

function monthStartUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().replace('T', ' ').substring(0, 19);
}

async function aiRequestsThisMonth(workspaceId) {
  const row = await get(
    "SELECT COUNT(*) AS c FROM usage_ledger WHERE workspace_id = ? AND category = 'ai_text' AND created_at >= ?",
    [workspaceId, monthStartUtc()]
  );
  return Number(row?.c || 0);
}

async function assertAiQuota(workspaceId) {
  const limit = aiMonthlyRequestLimit();
  const used = await aiRequestsThisMonth(workspaceId);
  if (used >= limit) {
    const err = new Error(`Monthly AI request limit reached (${used}/${limit}). Increase SOCIAL_AI_MONTHLY_REQUEST_LIMIT or wait until next month.`);
    err.status = 429;
    err.code = 'QUOTA_EXCEEDED';
    throw err;
  }
  return { used, limit };
}

async function recordUsage({ workspaceId, category, providerKey = null, modelKey = null, quantity = 1, unit = 'request', referenceType = null, referenceId = null }) {
  const unitCost = category === 'ai_text' ? parseFloat(process.env.AI_COST_PER_REQUEST_USD || '0') : 0;
  const cost = Number((unitCost * quantity).toFixed(4));
  await run(
    `INSERT INTO usage_ledger (workspace_id, category, quantity, unit, estimated_cost, provider_key, model_key, is_estimate,
                               metric_type, units_consumed, cost_usd, reference_type, reference_id, created_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [workspaceId, category, quantity, unit, cost, providerKey, modelKey, category, quantity, cost, referenceType, referenceId]
  );
}

module.exports = {
  get AI_MONTHLY_REQUEST_LIMIT() { return aiMonthlyRequestLimit(); },
  isRealAiProvider,
  aiRequestsThisMonth,
  assertAiQuota,
  recordUsage
};
