const { z } = require('zod');
const { run, get, all } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { generateStructured, untrusted } = require('../../lib/aiStructured');
const { resolveSelectedProduct } = require('../../lib/productContext');
const { unverified } = require('../../lib/claims');
const leadService = require('../leads/leadService');
const outreach = require('../outreach/outreachService');
const socialCampaigns = require('../social/campaignService');
const contentService = require('../social/contentService');
const analyticsService = require('../social/analyticsService');

/**
 * Campaign Command Center. A program is the strategy layer on top of existing modules:
 *  - Strategist: an AI brief grounded only in the selected product's stored facts, the
 *    user's inputs and real CRM numbers. KPIs map to metrics the app actually measures and
 *    carry no invented targets.
 *  - Audience: real CRM leads with the reasons they match (reuses the outreach rules, so
 *    unsubscribed, bounced and suppressed contacts are excluded).
 *  - Builder: after a person approves the brief, creates an email sequence (outreach module)
 *    and a social campaign (Social Media Marketing) and starts their existing AI generation.
 *    Nothing is sent or published here: each module keeps its own approval gates.
 *  - Overview: status, scheduled activity, pending approvals, failures and real metrics.
 */
const SOCIAL = contentService.PLATFORM_KEYS;
const CHANNELS = ['email', ...SOCIAL];
const KPI_METRICS = {
  emails_sent: 'Emails accepted by the mail provider',
  reply_rate: 'Recipients who replied ÷ recipients emailed',
  bounce_rate: 'Recipients who bounced ÷ recipients emailed',
  unsubscribe_rate: 'Recipients who unsubscribed ÷ recipients emailed',
  posts_published: 'Social posts published (provider-confirmed)',
  engagements: 'Reactions, comments and shares reported by the platforms',
  impressions: 'Impressions reported by the platforms',
  leads_won: 'Audience leads moved to Won in the CRM'
};
const EDITABLE = ['draft', 'brief_ready'];

function httpError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const ws = ctx => ctx.auth.workspaceId;
const parse = (v, fb) => { try { return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
const dateOnly = v => (v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null);

async function requireProgram(ctx, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw httpError('Invalid campaign id.', 400, 'VALIDATION_ERROR');
  const p = await get('SELECT * FROM campaign_programs WHERE id = ? AND workspace_id = ?', [id, ws(ctx)]);
  if (!p) throw httpError('Campaign not found', 404, 'NOT_FOUND');
  return p;
}

function present(p) {
  return {
    id: p.id,
    name: p.name,
    productId: p.product_id,
    goal: p.goal,
    targetAudience: p.target_audience,
    tone: p.tone,
    channels: parse(p.channels_json, []),
    budget: p.budget_amount !== null && p.budget_amount !== undefined ? { amount: Number(p.budget_amount), currency: p.budget_currency, note: p.budget_note } : (p.budget_note ? { amount: null, currency: null, note: p.budget_note } : null),
    startDate: dateOnly(p.start_date),
    endDate: dateOnly(p.end_date),
    status: p.status,
    brief: parse(p.brief_json, null),
    briefFlags: parse(p.brief_flags_json, []),
    briefProvider: p.brief_provider,
    briefGeneratedAt: p.brief_generated_at,
    briefApprovedAt: p.brief_approved_at,
    leadIds: parse(p.lead_ids_json, []),
    audienceFilter: parse(p.audience_filter_json, null),
    emailCampaignId: p.outreach_campaign_id,
    socialCampaignId: p.social_campaign_id,
    lastError: p.last_error,
    createdAt: p.created_at,
    updatedAt: p.updated_at
  };
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------
const programFields = {
  name: z.string().trim().min(1).max(255),
  productId: z.union([z.number(), z.string(), z.null()]).optional(),
  goal: z.string().trim().max(2000).optional().nullable(),
  targetAudience: z.string().trim().max(2000).optional().nullable(),
  tone: z.enum(['Professional', 'Friendly', 'Direct', 'Consultative']).optional(),
  channels: z.array(z.enum(CHANNELS)).min(1).max(CHANNELS.length),
  budgetAmount: z.number().min(0).max(1e9).optional().nullable(),
  budgetCurrency: z.string().regex(/^[A-Z]{3}$/).optional().nullable(),
  budgetNote: z.string().trim().max(500).optional().nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable()
};
const createSchema = z.object(programFields).strict();
const updateSchema = z.object(Object.fromEntries(Object.entries(programFields).map(([k, v]) => [k, v.optional()]))).strict();

function checkDates(v) {
  if (v.startDate && v.endDate && v.endDate < v.startDate) throw httpError('End date must be on or after the start date.', 400, 'VALIDATION_ERROR');
  if (v.budgetAmount !== null && v.budgetAmount !== undefined && !v.budgetCurrency) throw httpError('Choose a currency for the budget.', 400, 'VALIDATION_ERROR');
}

async function listPrograms(ctx) {
  const rows = await all('SELECT * FROM campaign_programs WHERE workspace_id = ? ORDER BY id DESC LIMIT 200', [ws(ctx)]);
  const out = [];
  for (const p of rows) out.push({ ...present(p), summary: await quickSummary(ctx, p) });
  return out;
}

async function getProgram(ctx, id) {
  const p = await requireProgram(ctx, id);
  const product = p.product_id ? await get('SELECT id, name FROM digital_products WHERE workspace_id = ? AND id = ?', [ws(ctx), p.product_id]) : null;
  return { ...present(p), product, productMissing: !!p.product_id && !product };
}

async function createProgram(ctx, input) {
  const v = createSchema.parse(input);
  checkDates(v);
  const product = await resolveSelectedProduct(ws(ctx), v.productId);
  const r = await run(
    `INSERT INTO campaign_programs (workspace_id, name, product_id, goal, target_audience, tone, channels_json, budget_amount, budget_currency, budget_note, start_date, end_date, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ws(ctx), v.name, product ? product.id : null, v.goal || null, v.targetAudience || null, v.tone || 'Professional', JSON.stringify([...new Set(v.channels)]),
      v.budgetAmount ?? null, v.budgetCurrency || null, v.budgetNote || null, v.startDate || null, v.endDate || null, ctx.auth.userId || null]
  );
  await audit(ctx, 'command.program_created', { resourceType: 'campaign_program', resourceId: r.lastID, metadata: { name: v.name } });
  return getProgram(ctx, r.lastID);
}

async function updateProgram(ctx, id, input) {
  const p = await requireProgram(ctx, id);
  if (!EDITABLE.includes(p.status)) throw httpError('An approved or built campaign cannot be edited here; edit its email sequence or social posts instead.', 409, 'NOT_EDITABLE');
  const v = updateSchema.parse(input);
  const merged = {
    name: v.name ?? p.name,
    goal: v.goal !== undefined ? v.goal : p.goal,
    targetAudience: v.targetAudience !== undefined ? v.targetAudience : p.target_audience,
    tone: v.tone ?? p.tone,
    channels: v.channels ?? parse(p.channels_json, []),
    budgetAmount: v.budgetAmount !== undefined ? v.budgetAmount : (p.budget_amount === null ? null : Number(p.budget_amount)),
    budgetCurrency: v.budgetCurrency !== undefined ? v.budgetCurrency : p.budget_currency,
    budgetNote: v.budgetNote !== undefined ? v.budgetNote : p.budget_note,
    startDate: v.startDate !== undefined ? v.startDate : dateOnly(p.start_date),
    endDate: v.endDate !== undefined ? v.endDate : dateOnly(p.end_date)
  };
  checkDates(merged);
  let productId = p.product_id;
  if (v.productId !== undefined) productId = (await resolveSelectedProduct(ws(ctx), v.productId))?.id || null;
  await run(
    `UPDATE campaign_programs SET name = ?, product_id = ?, goal = ?, target_audience = ?, tone = ?, channels_json = ?, budget_amount = ?, budget_currency = ?, budget_note = ?,
       start_date = ?, end_date = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?`,
    [merged.name, productId, merged.goal || null, merged.targetAudience || null, merged.tone, JSON.stringify([...new Set(merged.channels)]),
      merged.budgetAmount ?? null, merged.budgetCurrency || null, merged.budgetNote || null, merged.startDate || null, merged.endDate || null, p.id, ws(ctx)]
  );
  return getProgram(ctx, p.id);
}

async function deleteProgram(ctx, id) {
  const p = await requireProgram(ctx, id);
  if (p.outreach_campaign_id || p.social_campaign_id) throw httpError('This campaign has built email or social campaigns; archive it instead so their history stays linked.', 409, 'HAS_CHILDREN');
  await run('DELETE FROM campaign_programs WHERE id = ? AND workspace_id = ?', [p.id, ws(ctx)]);
  await audit(ctx, 'command.program_deleted', { resourceType: 'campaign_program', resourceId: p.id });
  return { deleted: true };
}

async function archiveProgram(ctx, id) {
  const p = await requireProgram(ctx, id);
  await run("UPDATE campaign_programs SET status = 'archived', updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?", [p.id, ws(ctx)]);
  return getProgram(ctx, p.id);
}

// ---------------------------------------------------------------------------
// Strategist: AI brief
// ---------------------------------------------------------------------------
const briefSchema = z.object({
  objectives: z.array(z.string().min(1).max(500)).min(1).max(6),
  audience: z.object({ summary: z.string().min(1).max(1500), segments: z.array(z.string().max(300)).max(6).optional().default([]) }),
  messaging: z.object({
    value_proposition: z.string().min(1).max(1000),
    key_messages: z.array(z.string().max(500)).min(1).max(6),
    proof_points: z.array(z.string().max(500)).max(6).optional().default([]),
    call_to_action: z.string().max(300).optional().default('')
  }),
  content_plan: z.array(z.object({
    channel: z.string().max(30),
    format: z.string().max(100),
    count: z.number().int().min(1).max(20),
    purpose: z.string().max(500)
  })).min(1).max(12),
  timeline: z.array(z.object({
    phase: z.string().max(100),
    start_day: z.number().int().min(0).max(365),
    end_day: z.number().int().min(0).max(365),
    activities: z.array(z.string().max(300)).max(8).optional().default([])
  })).min(1).max(8),
  kpis: z.array(z.object({
    metric: z.enum(Object.keys(KPI_METRICS)),
    name: z.string().max(150),
    target: z.string().max(100).nullable().optional(),
    why: z.string().max(400).optional().default('')
  })).min(1).max(8),
  gaps: z.array(z.string().max(400)).max(8).optional().default([])
});

async function productFacts(ctx, productId) {
  if (!productId) return null;
  const p = await get('SELECT * FROM digital_products WHERE workspace_id = ? AND id = ?', [ws(ctx), productId]);
  if (!p) return null;
  return { name: p.name, tagline: p.tagline || null, description: p.description || null, features: parse(p.features_json, []), target_audience: p.target_audience || null, url: p.url || null };
}

/** Real CRM numbers for the brief: counts only, no personal data. */
async function crmSnapshot(ctx, productId) {
  const byStatus = await all('SELECT status, COUNT(*) AS n FROM leads WHERE workspace_id = ? GROUP BY status', [ws(ctx)]);
  const withEmail = await get("SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ? AND email IS NOT NULL AND email <> ''", [ws(ctx)]);
  const forProduct = productId ? await get('SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ? AND product_id = ?', [ws(ctx), productId]) : null;
  return {
    total_leads: byStatus.reduce((a, r) => a + Number(r.n), 0),
    leads_with_email: Number(withEmail.n),
    leads_for_selected_product: forProduct ? Number(forProduct.n) : null,
    leads_by_status: Object.fromEntries(byStatus.map(r => [r.status || 'Unknown', Number(r.n)]))
  };
}

function briefText(brief) {
  return JSON.stringify(brief || {});
}

async function generateBrief(ctx, id) {
  const p = await requireProgram(ctx, id);
  if (!EDITABLE.includes(p.status)) throw httpError('The brief is approved; it can no longer be regenerated.', 409, 'NOT_EDITABLE');
  const product = await productFacts(ctx, p.product_id);
  const crm = await crmSnapshot(ctx, p.product_id);
  const channels = parse(p.channels_json, []);
  const inputs = {
    goal: p.goal, target_audience: p.target_audience, tone: p.tone, channels,
    budget: p.budget_amount !== null ? { amount: Number(p.budget_amount), currency: p.budget_currency, note: p.budget_note } : (p.budget_note ? { note: p.budget_note } : null),
    start_date: dateOnly(p.start_date), end_date: dateOnly(p.end_date)
  };
  const facts = { product, crm, inputs };
  const prompt = `Create a structured marketing campaign brief for "${p.name}".
Channels to plan for (only these): ${channels.join(', ')}.
Rules:
- Use ONLY the facts below (stored product facts, the user's inputs and the CRM counts). Never invent prices, discounts, offers, statistics, customer names, case studies, results or features.
- proof_points may only restate product facts; leave the list empty if there are none.
- KPIs: choose metrics from this list only: ${Object.keys(KPI_METRICS).join(', ')}. Set "target" to null unless the user's goal states a target; never make one up.
- The budget is a constraint from the user; do not invent costs, prices or spend splits.
- List missing information that would improve the campaign in "gaps".
${product ? '' : 'No product is selected: do not name or describe any product.\n'}${untrusted('campaign_facts', JSON.stringify(facts), 8000)}

Return JSON:
{"objectives":["..."],"audience":{"summary":"...","segments":["..."]},
 "messaging":{"value_proposition":"...","key_messages":["..."],"proof_points":["..."],"call_to_action":"..."},
 "content_plan":[{"channel":"email|${SOCIAL.join('|')}","format":"e.g. 3-step email sequence","count":3,"purpose":"..."}],
 "timeline":[{"phase":"...","start_day":0,"end_day":7,"activities":["..."]}],
 "kpis":[{"metric":"reply_rate","name":"Reply rate","target":null,"why":"..."}],
 "gaps":["..."]}`;
  const { data, provider } = await generateStructured({
    workspaceId: ws(ctx),
    prompt,
    system: 'You are a careful B2B campaign strategist. You plan only from the facts provided and never invent facts, numbers or offers.',
    schema: briefSchema,
    referenceType: 'campaign_program',
    referenceId: p.id,
    maxTokens: 2600
  });
  // Plans for channels the user did not choose are dropped, not silently added.
  const brief = { ...data, content_plan: data.content_plan.filter(c => channels.includes(String(c.channel).toLowerCase())) };
  const flags = unverified(briefText({ objectives: brief.objectives, messaging: brief.messaging, kpis: brief.kpis }), JSON.stringify(facts));
  await run(
    `UPDATE campaign_programs SET brief_json = ?, brief_flags_json = ?, brief_provider = ?, brief_generated_at = UTC_TIMESTAMP(), status = 'brief_ready',
       brief_approved_at = NULL, brief_approved_by = NULL, last_error = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?`,
    [JSON.stringify(brief), JSON.stringify(flags), provider, p.id, ws(ctx)]
  );
  await audit(ctx, 'command.brief_generated', { resourceType: 'campaign_program', resourceId: p.id, metadata: { provider, flags: flags.length } });
  return getProgram(ctx, p.id);
}

async function saveBrief(ctx, id, input) {
  const p = await requireProgram(ctx, id);
  if (!EDITABLE.includes(p.status)) throw httpError('The brief is approved; it can no longer be edited.', 409, 'NOT_EDITABLE');
  const brief = briefSchema.parse(input?.brief);
  const facts = { product: await productFacts(ctx, p.product_id), crm: await crmSnapshot(ctx, p.product_id), inputs: { goal: p.goal, target_audience: p.target_audience } };
  const flags = unverified(briefText({ objectives: brief.objectives, messaging: brief.messaging, kpis: brief.kpis }), JSON.stringify(facts));
  await run("UPDATE campaign_programs SET brief_json = ?, brief_flags_json = ?, status = 'brief_ready', brief_approved_at = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?",
    [JSON.stringify(brief), JSON.stringify(flags), p.id, ws(ctx)]);
  return getProgram(ctx, p.id);
}

async function approveBrief(ctx, id, input = {}) {
  const p = await requireProgram(ctx, id);
  if (p.status !== 'brief_ready') throw httpError(p.status === 'draft' ? 'Generate the brief first.' : 'The brief is already approved.', 409, 'NOT_READY');
  if (input.confirm !== true) throw httpError('Explicit confirmation (confirm: true) is required to approve the brief.', 400, 'CONFIRMATION_REQUIRED');
  const flags = parse(p.brief_flags_json, []);
  if (flags.length && input.acknowledgeFlags !== true) throw Object.assign(httpError(`Some claims are not in your facts: ${flags.join(', ')}. Edit them or confirm you verified them.`, 409, 'UNVERIFIED_CLAIMS'), { details: { flags } });
  await run("UPDATE campaign_programs SET status = 'approved', brief_approved_by = ?, brief_approved_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?", [ctx.auth.userId || null, p.id, ws(ctx)]);
  await audit(ctx, 'command.brief_approved', { resourceType: 'campaign_program', resourceId: p.id, metadata: { acknowledgedFlags: flags } });
  return getProgram(ctx, p.id);
}

// ---------------------------------------------------------------------------
// Audience: real CRM leads with match reasons
// ---------------------------------------------------------------------------
async function previewAudience(ctx, id, input = {}) {
  const p = await requireProgram(ctx, id);
  const filter = input.filter || {};
  const audience = await outreach.resolveAudience(ctx, { filter: { ...filter, productId: filter.productId === undefined ? (p.product_id || undefined) : filter.productId || undefined } });
  const ids = audience.map(a => a.leadId);
  const rows = ids.length ? await all(`SELECT * FROM leads WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [ws(ctx), ...ids]) : [];
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  const productName = p.product_id ? (await get('SELECT name FROM digital_products WHERE workspace_id = ? AND id = ?', [ws(ctx), p.product_id]))?.name : null;
  const filterProductId = filter.productId === undefined ? p.product_id : filter.productId;
  return audience.map(a => {
    const lead = byId[a.leadId] || {};
    const reasons = [];
    if (filter.statuses && filter.statuses.length) reasons.push(`Status is ${lead.status}`);
    if (filterProductId && Number(lead.product_id) === Number(filterProductId)) reasons.push(`Interested in ${productName || 'the selected product'}`);
    const scoring = leadService.scoreLead(lead);
    const score = lead.ai_score === null || lead.ai_score === undefined ? scoring.score : Number(lead.ai_score);
    if (filter.minScore !== undefined) reasons.push(`Lead score ${score} ≥ ${filter.minScore}`);
    const top = scoring.factors.filter(f => f.label !== 'Base score' && f.points > 0).map(f => `${f.label} (+${f.points})`);
    if (top.length) reasons.push(`Score factors: ${top.join(', ')}`);
    return { ...a, score, category: scoring.category, reasons };
  });
}

async function saveAudience(ctx, id, input = {}) {
  const p = await requireProgram(ctx, id);
  if (['built', 'archived'].includes(p.status)) throw httpError('Add recipients in the email sequence after the campaign is built.', 409, 'NOT_EDITABLE');
  const v = z.object({
    leadIds: z.array(z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)])).max(1000),
    filter: z.any().optional()
  }).strict().parse(input);
  const audience = v.leadIds.length ? await outreach.resolveAudience(ctx, { leadIds: v.leadIds }) : [];
  const eligible = audience.filter(a => a.eligible).map(a => a.leadId);
  const skipped = audience.filter(a => !a.eligible).map(a => ({ leadId: a.leadId, name: a.name, reason: a.reason }));
  await run('UPDATE campaign_programs SET lead_ids_json = ?, audience_filter_json = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?',
    [JSON.stringify(eligible), v.filter ? JSON.stringify(v.filter) : null, p.id, ws(ctx)]);
  return { saved: eligible.length, skipped, program: await getProgram(ctx, p.id) };
}

// ---------------------------------------------------------------------------
// Builder: approved brief -> email sequence + social campaign (existing modules)
// ---------------------------------------------------------------------------
function emailGoal(p, brief) {
  const parts = [p.goal, `Objectives: ${brief.objectives.join('; ')}`, `Value proposition: ${brief.messaging.value_proposition}`,
    `Key messages: ${brief.messaging.key_messages.join('; ')}`, brief.messaging.call_to_action ? `Call to action: ${brief.messaging.call_to_action}` : null];
  return parts.filter(Boolean).join('\n').slice(0, 2000);
}

async function build(ctx, id, input = {}) {
  const p = await requireProgram(ctx, id);
  if (!['approved', 'built'].includes(p.status)) throw httpError('Approve the brief before building the campaign.', 409, 'BRIEF_NOT_APPROVED');
  if (input.confirm !== true) throw httpError('Explicit confirmation (confirm: true) is required to build the campaign.', 400, 'CONFIRMATION_REQUIRED');
  const brief = parse(p.brief_json, null);
  const channels = parse(p.channels_json, []);
  const social = channels.filter(c => SOCIAL.includes(c));
  const caps = ctx.auth.capabilities;
  const result = { email: null, social: null };
  let lastError = null;

  // Email: reuses the outreach engine (sequence generation, suppressions, approval, sending).
  if (channels.includes('email')) {
    if (!caps.has('mail.compose')) throw httpError('Building the email sequence needs the mail.compose permission.', 403, 'FORBIDDEN');
    try {
      let emailId = p.outreach_campaign_id;
      if (!emailId) {
        const plan = brief.content_plan.find(c => String(c.channel).toLowerCase() === 'email');
        const created = await outreach.createCampaign(ctx, { name: `${p.name} – email`, productId: p.product_id || null, goal: emailGoal(p, brief), audienceNote: brief.audience.summary.slice(0, 500), tone: p.tone });
        emailId = created.id;
        await run('UPDATE campaign_programs SET outreach_campaign_id = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?', [emailId, p.id, ws(ctx)]);
        const leadIds = parse(p.lead_ids_json, []);
        if (leadIds.length) await outreach.addRecipients(ctx, emailId, { leadIds });
        result.email = { campaignId: emailId, created: true, plannedSteps: plan ? Math.min(Math.max(plan.count, 1), outreach.MAX_STEPS) : 3 };
      } else {
        result.email = { campaignId: emailId, created: false };
      }
      const current = await outreach.getCampaign(ctx, emailId);
      if (!current.steps.length && current.status === 'draft') {
        const plan = brief.content_plan.find(c => String(c.channel).toLowerCase() === 'email');
        await outreach.generateSequence(ctx, emailId, { steps: plan ? Math.min(Math.max(plan.count, 1), outreach.MAX_STEPS) : 3 });
        result.email.sequence = 'generated';
      } else {
        result.email.sequence = 'exists';
      }
    } catch (err) {
      lastError = `Email: ${err.message}`;
      result.email = { ...(result.email || {}), error: err.message, code: err.code || null };
    }
  }

  // Social: reuses Social Media Marketing (AI generation job, approval, scheduling, publishing).
  if (social.length) {
    if (!caps.has('campaigns.manage')) throw httpError('Building social content needs the campaigns.manage permission.', 403, 'FORBIDDEN');
    try {
      let socialId = p.social_campaign_id;
      if (!socialId) {
        const postCount = brief.content_plan.filter(c => social.includes(String(c.channel).toLowerCase())).reduce((a, c) => a + c.count, 0);
        const created = await socialCampaigns.createCampaign(ctx, {
          name: `${p.name} – social`,
          objective: brief.objectives[0].slice(0, 255),
          productId: p.product_id || null,
          targetAudience: brief.audience.summary.slice(0, 2000),
          keyMessage: [brief.messaging.value_proposition, ...brief.messaging.key_messages].join('\n').slice(0, 2000),
          callToAction: (brief.messaging.call_to_action || '').slice(0, 255) || null,
          platforms: social,
          tone: p.tone,
          startDate: dateOnly(p.start_date),
          endDate: dateOnly(p.end_date),
          desiredPostCount: Math.min(Math.max(postCount || social.length * 2, 1), 20)
        });
        socialId = created.id;
        await run('UPDATE campaign_programs SET social_campaign_id = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?', [socialId, p.id, ws(ctx)]);
        result.social = { campaignId: socialId, created: true };
      } else {
        result.social = { campaignId: socialId, created: false };
      }
      const { campaign } = await socialCampaigns.getCampaign(ws(ctx), socialId);
      if (['not_started', 'failed'].includes(campaign.generationStatus)) {
        const job = await socialCampaigns.requestGeneration(ctx, socialId);
        result.social.generation = { status: 'queued', jobId: job.jobId };
      } else {
        result.social.generation = { status: campaign.generationStatus };
      }
    } catch (err) {
      lastError = [lastError, `Social: ${err.message}`].filter(Boolean).join(' · ');
      result.social = { ...(result.social || {}), error: err.message, code: err.code || null };
    }
  }

  const fresh = await requireProgram(ctx, p.id);
  const done = (!channels.includes('email') || fresh.outreach_campaign_id) && (!social.length || fresh.social_campaign_id);
  await run('UPDATE campaign_programs SET status = ?, last_error = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?',
    [done ? 'built' : 'approved', lastError ? lastError.slice(0, 1000) : null, p.id, ws(ctx)]);
  await audit(ctx, 'command.program_built', { resourceType: 'campaign_program', resourceId: p.id, metadata: { email: result.email?.campaignId || null, social: result.social?.campaignId || null, error: lastError } });
  return { result, program: await getProgram(ctx, p.id) };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
async function quickSummary(ctx, p) {
  const out = { email: null, social: null };
  if (p.outreach_campaign_id) {
    const c = await get('SELECT status FROM outreach_campaigns WHERE id = ? AND workspace_id = ?', [p.outreach_campaign_id, ws(ctx)]);
    out.email = c ? c.status : 'missing';
  }
  if (p.social_campaign_id) {
    const c = await get('SELECT status, generation_status FROM campaigns WHERE id = ? AND workspace_id = ?', [p.social_campaign_id, ws(ctx)]);
    out.social = c ? (c.generation_status && c.generation_status !== 'completed' ? `content ${c.generation_status}` : c.status) : 'missing';
  }
  return out;
}

const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

async function overview(ctx, id) {
  const p = await requireProgram(ctx, id);
  const program = await getProgram(ctx, p.id);
  const brief = program.brief;
  const approvals = [];
  const failures = [];
  const scheduled = [];
  const metrics = {};

  if (!['approved', 'built', 'archived'].includes(p.status)) {
    approvals.push({ kind: 'brief', label: p.status === 'draft' ? 'Generate and approve the campaign brief' : 'Approve the campaign brief', action: 'brief' });
  }

  let email = null;
  if (p.outreach_campaign_id) {
    const c = await outreach.getCampaign(ctx, p.outreach_campaign_id).catch(() => null);
    if (c) {
      const emailed = (await get("SELECT COUNT(*) AS n FROM outreach_recipients WHERE campaign_id = ? AND workspace_id = ? AND first_sent_at IS NOT NULL", [c.id, ws(ctx)])).n;
      const next = await get("SELECT MIN(next_send_at) AS at, COUNT(*) AS n FROM outreach_recipients WHERE campaign_id = ? AND workspace_id = ? AND status = 'active'", [c.id, ws(ctx)]);
      email = { id: c.id, name: c.name, status: c.status, steps: c.steps.length, stats: c.stats, lastError: c.lastError, nextSendAt: next.at, activeRecipients: Number(next.n) };
      if (['draft', 'paused'].includes(c.status)) {
        const ready = await outreach.readiness(ctx, c.id);
        approvals.push({ kind: 'email', label: c.status === 'paused' ? 'Resume the email sequence' : 'Review and approve the email sequence', problems: ready.problems, action: 'email' });
      }
      if (c.status === 'running' && next.at) scheduled.push({ kind: 'email', at: next.at, label: `Next email sends to ${Number(next.n)} recipient(s) in the sending window (${c.timezone})` });
      if (c.stats.failed) failures.push({ kind: 'email', label: `${c.stats.failed} recipient(s) with a failed send (retry in the email sequence)` });
      if (c.stats.needsReview) failures.push({ kind: 'email', label: `${c.stats.needsReview} send(s) with unknown delivery (check before continuing)` });
      if (c.lastError) failures.push({ kind: 'email', label: `Paused automatically: ${c.lastError}` });
      Object.assign(metrics, {
        emails_sent: c.stats.emailsSent,
        reply_rate: rate(c.stats.replied, Number(emailed)),
        bounce_rate: rate(c.stats.bounced, Number(emailed)),
        unsubscribe_rate: rate(c.stats.unsubscribed, Number(emailed))
      });
    } else {
      email = { id: p.outreach_campaign_id, missing: true };
    }
  }

  let social = null;
  if (p.social_campaign_id) {
    const data = await socialCampaigns.getCampaign(ws(ctx), p.social_campaign_id).catch(() => null);
    if (data) {
      const counts = data.campaign.contentCounts || {};
      const contentIds = data.content.map(c => c.id);
      const jobFails = contentIds.length
        ? await all(`SELECT content_item_id, status, last_error FROM publishing_jobs WHERE workspace_id = ? AND content_item_id IN (${contentIds.map(() => '?').join(',')}) AND status IN ('failed', 'needs_review') ORDER BY id DESC LIMIT 20`, [ws(ctx), ...contentIds])
        : [];
      social = { id: data.campaign.id, name: data.campaign.name, status: data.campaign.status, generationStatus: data.campaign.generationStatus, generationError: data.campaign.generationError, platforms: data.campaign.platforms, counts };
      if (data.campaign.generationStatus === 'failed') failures.push({ kind: 'social', label: `Social content generation failed: ${data.campaign.generationError || 'unknown error'}` });
      const review = (counts.review || 0) + (counts.draft || 0);
      if (review) approvals.push({ kind: 'social', label: `${review} social post(s) waiting for review and approval`, action: 'social' });
      if (counts.approved) approvals.push({ kind: 'social', label: `${counts.approved} approved post(s) not scheduled yet`, action: 'social' });
      for (const c of data.content.filter(x => x.status === 'scheduled' && x.scheduledAt).slice(0, 10)) {
        scheduled.push({ kind: 'social', at: c.scheduledAt, label: `${c.platformKey || 'Post'}: ${c.title || (c.caption || '').slice(0, 60)}` });
      }
      for (const j of jobFails) failures.push({ kind: 'social', label: `Publishing ${j.status === 'failed' ? 'failed' : 'needs review'}: ${String(j.last_error || '').slice(0, 160) || 'no details'}`, contentId: j.content_item_id });
      const since = p.created_at ? new Date(p.created_at) : undefined;
      const summary = await analyticsService.getSummary(ws(ctx), { campaignId: data.campaign.id, from: since ? since.toISOString() : undefined }).catch(() => null);
      metrics.posts_published = summary ? summary.publishedCount : (counts.published || 0);
      // Only platform-reported numbers; null when no platform reported the metric.
      const totals = summary?.totals || {};
      const metricValue = m => (m && m.availableFor > 0 && m.value !== null ? Number(m.value) : null);
      const parts = ['likes', 'comments', 'shares'].map(k => metricValue(totals[k])).filter(v => v !== null);
      metrics.engagements = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
      metrics.impressions = metricValue(totals.impressions);
    } else {
      social = { id: p.social_campaign_id, missing: true };
    }
  }

  const leadIds = program.leadIds;
  if (leadIds.length) {
    const won = await get(`SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ? AND status = 'Won' AND id IN (${leadIds.map(() => '?').join(',')})`, [ws(ctx), ...leadIds]);
    metrics.leads_won = Number(won.n);
  }

  const kpis = (brief?.kpis || []).map(k => ({ ...k, definition: KPI_METRICS[k.metric], actual: metrics[k.metric] ?? null, unit: /_rate$/.test(k.metric) ? '%' : '' }));
  scheduled.sort((a, b) => new Date(a.at) - new Date(b.at));
  // A/B tests on this campaign's email sequence and social posts (results computed by the tests module).
  const abTests = [];
  const abTestService = require('../abtests/abTestService');
  if (p.outreach_campaign_id) abTests.push(...await abTestService.listTests(ctx, { emailCampaignId: p.outreach_campaign_id }));
  if (p.social_campaign_id) abTests.push(...await abTestService.listTests(ctx, { socialCampaignId: p.social_campaign_id }));
  return { program, email, social, approvals, scheduled, failures, metrics, kpis, kpiDefinitions: KPI_METRICS, abTests };
}

module.exports = {
  CHANNELS,
  KPI_METRICS,
  listPrograms,
  getProgram,
  createProgram,
  updateProgram,
  deleteProgram,
  archiveProgram,
  generateBrief,
  saveBrief,
  approveBrief,
  previewAudience,
  saveAudience,
  build,
  overview
};
