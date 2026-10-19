const { run, get, all } = require('../db/database');

const MONTHLY_BUDGET_CAP_USD = 10.00;

async function getUsageSummary(workspaceId = 1) {
  // 1. Total spend in usage ledger
  const totalRow = await get(
    'SELECT SUM(estimated_cost) as total_cost, count(*) as event_count FROM usage_ledger WHERE workspace_id = ?',
    [workspaceId]
  );
  const totalCost = parseFloat((totalRow?.total_cost || 0).toFixed(2));
  const remainingBudget = parseFloat((MONTHLY_BUDGET_CAP_USD - totalCost).toFixed(2));
  const budgetUsedPct = Math.min(100, parseFloat(((totalCost / MONTHLY_BUDGET_CAP_USD) * 100).toFixed(1)));

  // 2. Spend breakdown by category
  const breakdownRows = await all(
    `SELECT category, SUM(quantity) as total_qty, unit, SUM(estimated_cost) as category_cost, count(*) as count
     FROM usage_ledger WHERE workspace_id = ? GROUP BY category`,
    [workspaceId]
  );

  // 3. Telephony stats
  const phoneRow = await get(
    `SELECT count(*) as total_calls, SUM(duration_seconds) as total_seconds
     FROM call_records WHERE workspace_id = ?`,
    [workspaceId]
  );

  // 4. Client Reselling Margin Calculator
  const clientTiers = [
    { name: 'Starter Client', chargePerMonth: 29.00, estimatedCost: totalCost || 5.00 },
    { name: 'Growth Client', chargePerMonth: 49.00, estimatedCost: totalCost || 6.20 },
    { name: 'Enterprise Client', chargePerMonth: 89.00, estimatedCost: totalCost || 8.50 }
  ].map(t => {
    const profit = parseFloat((t.chargePerMonth - t.estimatedCost).toFixed(2));
    const marginPct = parseFloat(((profit / t.chargePerMonth) * 100).toFixed(1));
    return { ...t, profit, marginPct };
  });

  // 5. Recent ledger events
  const recentEvents = await all(
    'SELECT * FROM usage_ledger WHERE workspace_id = ? ORDER BY id DESC LIMIT 15',
    [workspaceId]
  );

  return {
    monthlyBudgetCap: MONTHLY_BUDGET_CAP_USD,
    totalCost,
    remainingBudget,
    budgetUsedPct,
    isUnderBudget: totalCost <= MONTHLY_BUDGET_CAP_USD,
    breakdown: breakdownRows,
    telephony: {
      totalCalls: phoneRow?.total_calls || 0,
      totalMinutes: Math.round((phoneRow?.total_seconds || 0) / 60)
    },
    clientTiers,
    recentEvents
  };
}

module.exports = {
  MONTHLY_BUDGET_CAP_USD,
  getUsageSummary
};
