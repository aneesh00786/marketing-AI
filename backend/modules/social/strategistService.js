const { all, get } = require('../../db/database');
const { generateText, AiUnavailableError } = require('../../lib/aiStructured');
const analyticsService = require('./analyticsService');
const accountService = require('./accountService');

/**
 * Roger AI Strategist: answers marketing questions from retrieved workspace data only.
 * The model sees a compact, factual data pack; it cannot query anything itself.
 */

function resolveRange(question) {
  const q = String(question || '').toLowerCase();
  const now = new Date();
  if (/this month/.test(q)) return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now, label: 'this month' };
  if (/last month/.test(q)) {
    return {
      from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
      to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 1000),
      label: 'last month'
    };
  }
  if (/this week|last 7 days|past week/.test(q)) return { from: new Date(now.getTime() - 7 * 86400000), to: now, label: 'the last 7 days' };
  if (/90 days|quarter/.test(q)) return { from: new Date(now.getTime() - 90 * 86400000), to: now, label: 'the last 90 days' };
  return { from: new Date(now.getTime() - 30 * 86400000), to: now, label: 'the last 30 days' };
}

function metricText(m) {
  if (m.value === null) {
    if (m.availableFor === 0 && m.notCollectedFor > 0 && m.unavailableFor === 0) return 'not collected yet';
    return 'unavailable';
  }
  const coverage = m.unavailableFor + m.notCollectedFor > 0 ? ` (reported for ${m.availableFor} of ${m.availableFor + m.unavailableFor + m.notCollectedFor} posts)` : '';
  return `${m.value}${coverage}`;
}

/** Builds the compact factual data pack shared by the AI answer and the no-AI fallback. */
async function buildDataPack(workspaceId, question) {
  const range = resolveRange(question);
  const summary = await analyticsService.getSummary(workspaceId, { from: range.from, to: range.to });
  const accounts = await accountService.listAccounts(workspaceId);
  const contentCounts = await all('SELECT status, COUNT(*) AS c FROM content_items WHERE workspace_id = ? GROUP BY status', [workspaceId]);
  const campaigns = await all("SELECT id, name, objective, generation_status FROM campaigns WHERE workspace_id = ? AND source = 'social_hub' ORDER BY id DESC LIMIT 10", [workspaceId]);

  const lines = [];
  lines.push(`Period: ${range.label} (${summary.range.from.slice(0, 10)} to ${summary.range.to.slice(0, 10)}).`);
  lines.push(`Connected accounts: ${accounts.length ? accounts.map(a => `${a.displayName} (${a.accountTypeLabel}, ${a.status})`).join('; ') : 'none'}.`);
  lines.push(`Posts published through TradeSage in the period (provider-confirmed): ${summary.publishedCount}.`);
  lines.push(`Content library by status: ${contentCounts.map(r => `${r.status}=${r.c}`).join(', ') || 'empty'}.`);
  lines.push(`Totals: ${Object.entries(summary.totals).map(([k, v]) => `${k}=${metricText(v)}`).join(', ')}.`);
  for (const [platform, p] of Object.entries(summary.byPlatform)) {
    lines.push(`Platform ${platform}: ${p.posts} posts; ${Object.entries(p.metrics).map(([k, v]) => `${k}=${metricText(v)}`).join(', ')}.`);
  }
  for (const c of Object.values(summary.byCampaign)) {
    lines.push(`Campaign "${c.name}": ${c.posts} posts; clicks=${metricText(c.metrics.clicks)}, likes=${metricText(c.metrics.likes)}, comments=${metricText(c.metrics.comments)}, shares=${metricText(c.metrics.shares)}.`);
  }
  summary.topPosts.slice(0, 5).forEach((p, i) => {
    lines.push(`Top post #${i + 1}: "${p.title || 'Untitled'}" on ${p.platformKey} (${p.accountName}), engagements=${p.engagements}${p.engagementsPartial ? ' (partial metrics)' : ''}, published ${String(p.publishedAt).slice(0, 10)}.`);
  });
  for (const f of summary.followers) {
    lines.push(`Followers ${f.accountName}: ${f.latest === null ? `unavailable (${f.reason})` : `${f.latest}${f.change === null ? '' : `, change in period ${f.change >= 0 ? '+' : ''}${f.change}`}`}.`);
  }
  if (campaigns.length) lines.push(`Recent campaigns: ${campaigns.map(c => `"${c.name}" (${c.generation_status})`).join('; ')}.`);
  return { range, summary, text: lines.join('\n'), hasMetrics: summary.topPosts.length > 0 || Object.values(summary.totals).some(t => t.value !== null) };
}

async function ask(ctx, question) {
  const workspaceId = ctx.auth.workspaceId;
  const q = String(question || '').trim().slice(0, 1000);
  if (!q) {
    const err = new Error('Ask a question.');
    err.status = 400;
    throw err;
  }
  const pack = await buildDataPack(workspaceId, q);
  const profile = await get('SELECT business_name, industry FROM business_profiles WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [workspaceId]);

  try {
    const { text, provider } = await generateText({
      workspaceId,
      prompt: `Business: ${profile?.business_name || 'unknown'} (${profile?.industry || 'industry not set'}).
Question: ${q}

WORKSPACE DATA (the only facts you may use):
${pack.text}

Answer rules:
- Use only the numbers above. Never estimate, extrapolate or invent metrics, benchmarks or results.
- When a metric is "unavailable" or "not collected yet", say so plainly instead of guessing.
- If there is too little data to answer, say what data is missing and how to get it (e.g. connect an account, publish posts, wait for analytics sync).
- Recommendations must be tied to specific observations from the data, and labelled as recommendations.
- Keep it concise: at most ~180 words, short paragraphs or bullets.`,
      system: 'You are Roger, a data-grounded social media marketing strategist.',
      referenceType: 'strategist',
      maxTokens: 700
    });
    return { answer: text, provider, grounded: true, dataUsed: pack.text, hasMetrics: pack.hasMetrics };
  } catch (err) {
    if (!(err instanceof AiUnavailableError) && err.code !== 'QUOTA_EXCEEDED') throw err;
    // Without a model, return the facts rather than an invented analysis.
    return {
      answer: `${err.code === 'QUOTA_EXCEEDED' ? 'The monthly AI limit has been reached' : 'No AI model is configured'}, so here is the data Roger would use:\n\n${pack.text}`,
      provider: null,
      grounded: true,
      dataUsed: pack.text,
      hasMetrics: pack.hasMetrics,
      aiUnavailable: true
    };
  }
}

/** Heuristic used by the legacy Roger chat to route social-performance questions here. */
function isSocialAnalyticsQuestion(message) {
  const m = String(message || '').toLowerCase();
  return /(post|posts|campaign|engagement|reach|impression|follower|likes|clicks|social|instagram|facebook|linkedin|youtube)/.test(m)
    && /(perform|best|worst|compare|top|which|how (did|are|is)|analytics|metrics|results|recommend)/.test(m);
}

module.exports = { ask, buildDataPack, resolveRange, isSocialAnalyticsQuestion };
