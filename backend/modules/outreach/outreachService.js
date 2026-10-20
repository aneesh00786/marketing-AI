const crypto = require('crypto');
const { z } = require('zod');
const { run, get, all, withTransaction } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { generateStructured, untrusted } = require('../../lib/aiStructured');
const { resolveSelectedProduct } = require('../../lib/productContext');
const { unverified } = require('../../lib/claims');
const { isValidTimeZone } = require('../../lib/time');
const emailService = require('../../services/emailService');
const { LEGACY_WORKSPACE_ID } = require('../../middleware/auth');

/**
 * Email outreach campaigns: an AI-written, human-approved email sequence sent to selected
 * leads from the workspace mailbox. This module owns campaign state; sending is done by
 * outreachSender (run by the worker). Every query is scoped to the caller's workspace.
 */
const MAX_STEPS = 5;
const MAX_RECIPIENTS = 1000;
const TOKENS = ['first_name', 'company'];
const EDITABLE = ['draft', 'paused'];

function httpError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const ws = ctx => ctx.auth.workspaceId;
const parse = (v, fb) => { try { return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };

function unknownTokens(text) {
  return [...String(text).matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map(m => m[1].toLowerCase()).filter(t => !TOKENS.includes(t));
}

async function requireCampaign(ctx, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw httpError('Invalid campaign id.', 400, 'VALIDATION_ERROR');
  const c = await get('SELECT * FROM outreach_campaigns WHERE id = ? AND workspace_id = ?', [id, ws(ctx)]);
  if (!c) throw httpError('Campaign not found', 404, 'NOT_FOUND');
  return c;
}

async function steps(campaign) {
  return all('SELECT * FROM outreach_steps WHERE campaign_id = ? AND workspace_id = ? ORDER BY step_order', [campaign.id, campaign.workspace_id]);
}

/** Honest numbers only: recipient states and provider-accepted sends. No opens or clicks. */
async function stats(campaign) {
  const byStatus = await all('SELECT status, COUNT(*) AS n FROM outreach_recipients WHERE campaign_id = ? AND workspace_id = ? GROUP BY status', [campaign.id, campaign.workspace_id]);
  const sends = await all('SELECT status, COUNT(*) AS n FROM outreach_sends WHERE campaign_id = ? AND workspace_id = ? GROUP BY status', [campaign.id, campaign.workspace_id]);
  const r = Object.fromEntries(byStatus.map(x => [x.status, Number(x.n)]));
  const s = Object.fromEntries(sends.map(x => [x.status, Number(x.n)]));
  const recipients = Object.values(r).reduce((a, b) => a + b, 0);
  return {
    recipients,
    pending: r.pending || 0,
    active: r.active || 0,
    completed: r.completed || 0,
    replied: r.replied || 0,
    unsubscribed: r.unsubscribed || 0,
    bounced: r.bounced || 0,
    failed: r.failed || 0,
    needsReview: (r.needs_review || 0),
    suppressed: r.suppressed || 0,
    stopped: r.stopped || 0,
    emailsSent: s.sent || 0,
    emailsFailed: s.failed || 0,
    emailsUnknown: s.needs_review || 0
  };
}

function presentCampaign(c) {
  return {
    id: c.id,
    name: c.name,
    productId: c.product_id,
    goal: c.goal,
    audienceNote: c.audience_note,
    tone: c.tone,
    status: c.status,
    timezone: c.timezone,
    sendDays: String(c.send_days || '').split(',').filter(Boolean).map(Number),
    sendStartHour: c.send_start_hour,
    sendEndHour: c.send_end_hour,
    dailyLimit: c.daily_limit,
    aiProvider: c.ai_provider,
    generatedAt: c.generated_at,
    approvedAt: c.approved_at,
    completedAt: c.completed_at,
    lastError: c.last_error,
    createdAt: c.created_at,
    updatedAt: c.updated_at
  };
}

function presentStep(s) {
  return { id: s.id, order: s.step_order, delayDays: s.delay_days, subject: s.subject, body: s.body_text, needsVerification: parse(s.needs_verification_json, []) };
}

async function productFacts(ctx, productId) {
  if (!productId) return null;
  const p = await get('SELECT * FROM digital_products WHERE workspace_id = ? AND id = ?', [ws(ctx), productId]);
  if (!p) return null;
  return { name: p.name, tagline: p.tagline || null, description: p.description || null, features: parse(p.features_json, []), target_audience: p.target_audience || null, url: p.url || null };
}

// ---------------------------------------------------------------------------
// Campaign CRUD
// ---------------------------------------------------------------------------
const settingsSchema = {
  name: z.string().trim().min(1).max(255),
  productId: z.union([z.number(), z.string(), z.null()]).optional(),
  goal: z.string().trim().max(2000).optional().nullable(),
  audienceNote: z.string().trim().max(500).optional().nullable(),
  tone: z.enum(['Professional', 'Friendly', 'Direct', 'Consultative']).optional(),
  timezone: z.string().max(64).refine(isValidTimeZone, 'must be a valid IANA time zone').optional(),
  sendDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  sendStartHour: z.number().int().min(0).max(23).optional(),
  sendEndHour: z.number().int().min(1).max(24).optional(),
  dailyLimit: z.number().int().min(1).max(500).optional()
};
const createSchema = z.object(settingsSchema).strict();
const updateSchema = z.object(Object.fromEntries(Object.entries(settingsSchema).map(([k, v]) => [k, v.optional()]))).strict();

async function listCampaigns(ctx) {
  const rows = await all('SELECT * FROM outreach_campaigns WHERE workspace_id = ? ORDER BY id DESC', [ws(ctx)]);
  const out = [];
  for (const c of rows) out.push({ ...presentCampaign(c), stats: await stats(c) });
  return out;
}

async function getCampaign(ctx, id) {
  const c = await requireCampaign(ctx, id);
  const product = c.product_id ? await get('SELECT id, name FROM digital_products WHERE workspace_id = ? AND id = ?', [ws(ctx), c.product_id]) : null;
  return { ...presentCampaign(c), product, productMissing: !!c.product_id && !product, steps: (await steps(c)).map(presentStep), stats: await stats(c) };
}

async function createCampaign(ctx, input) {
  const v = createSchema.parse(input);
  const product = await resolveSelectedProduct(ws(ctx), v.productId);
  if (v.sendStartHour !== undefined && v.sendEndHour !== undefined && v.sendEndHour <= v.sendStartHour) throw httpError('The sending window must end after it starts.', 400, 'VALIDATION_ERROR');
  const wsRow = await get('SELECT timezone FROM workspaces WHERE id = ?', [ws(ctx)]);
  const r = await run(
    `INSERT INTO outreach_campaigns (workspace_id, name, product_id, goal, audience_note, tone, status, timezone, send_days, send_start_hour, send_end_hour, daily_limit, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ws(ctx), v.name, product ? product.id : null, v.goal || null, v.audienceNote || null, v.tone || 'Professional',
      v.timezone || (wsRow && isValidTimeZone(wsRow.timezone) ? wsRow.timezone : 'UTC'), (v.sendDays || [1, 2, 3, 4, 5]).join(','),
      v.sendStartHour ?? 9, v.sendEndHour ?? 17, v.dailyLimit ?? 50, ctx.auth.userId || null]
  );
  await audit(ctx, 'outreach.campaign_created', { resourceType: 'outreach_campaign', resourceId: r.lastID, metadata: { name: v.name } });
  return getCampaign(ctx, r.lastID);
}

async function updateCampaign(ctx, id, input) {
  const c = await requireCampaign(ctx, id);
  if (!EDITABLE.includes(c.status)) throw httpError(`A ${c.status} campaign cannot be edited.`, 409, 'NOT_EDITABLE');
  const v = updateSchema.parse(input);
  const start = v.sendStartHour ?? c.send_start_hour;
  const end = v.sendEndHour ?? c.send_end_hour;
  if (end <= start) throw httpError('The sending window must end after it starts.', 400, 'VALIDATION_ERROR');
  let productId = c.product_id;
  if (v.productId !== undefined) productId = (await resolveSelectedProduct(ws(ctx), v.productId))?.id || null;
  // Any edit of a paused campaign needs a new approval before sending resumes.
  await run(
    `UPDATE outreach_campaigns SET name = ?, product_id = ?, goal = ?, audience_note = ?, tone = ?, timezone = ?, send_days = ?, send_start_hour = ?, send_end_hour = ?, daily_limit = ?,
       status = 'draft', approved_at = NULL, approved_by = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?`,
    [v.name ?? c.name, productId, v.goal !== undefined ? v.goal : c.goal, v.audienceNote !== undefined ? v.audienceNote : c.audience_note, v.tone ?? c.tone, v.timezone ?? c.timezone,
      v.sendDays ? v.sendDays.join(',') : c.send_days, start, end, v.dailyLimit ?? c.daily_limit, c.id, ws(ctx)]
  );
  return getCampaign(ctx, c.id);
}

async function deleteCampaign(ctx, id) {
  const c = await requireCampaign(ctx, id);
  const sent = await get("SELECT COUNT(*) AS n FROM outreach_sends WHERE campaign_id = ? AND workspace_id = ?", [c.id, ws(ctx)]);
  if (Number(sent.n) > 0) throw httpError('This campaign has sent emails; stop it instead of deleting so its history is kept.', 409, 'HAS_HISTORY');
  await run('DELETE FROM outreach_campaigns WHERE id = ? AND workspace_id = ?', [c.id, ws(ctx)]);
  await audit(ctx, 'outreach.campaign_deleted', { resourceType: 'outreach_campaign', resourceId: c.id });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Sequence: AI generation and manual edits
// ---------------------------------------------------------------------------
const stepInput = z.object({
  delayDays: z.number().int().min(0).max(60),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000)
});

async function factsText(ctx, c) {
  return JSON.stringify({ product: await productFacts(ctx, c.product_id), goal: c.goal, audience: c.audience_note });
}

async function saveSteps(ctx, c, list) {
  const facts = await factsText(ctx, c);
  for (const s of list) {
    const bad = unknownTokens(`${s.subject} ${s.body}`);
    if (bad.length) throw httpError(`Unknown placeholder(s): ${bad.map(t => `{{${t}}}`).join(', ')}. Use {{first_name}} or {{company}}.`, 400, 'VALIDATION_ERROR');
  }
  await withTransaction(async tx => {
    await tx.run('DELETE FROM outreach_steps WHERE campaign_id = ? AND workspace_id = ?', [c.id, ws(ctx)]);
    let order = 1;
    for (const s of list) {
      await tx.run(
        'INSERT INTO outreach_steps (workspace_id, campaign_id, step_order, delay_days, subject, body_text, needs_verification_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
        [ws(ctx), c.id, order, order === 1 ? 0 : s.delayDays, s.subject, s.body, JSON.stringify(unverified(`${s.subject} ${s.body}`, facts)), ]
      );
      order++;
    }
    await tx.run("UPDATE outreach_campaigns SET status = 'draft', approved_at = NULL, approved_by = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?", [c.id, ws(ctx)]);
  });
}

async function replaceSteps(ctx, id, input) {
  const c = await requireCampaign(ctx, id);
  if (!EDITABLE.includes(c.status)) throw httpError(`A ${c.status} campaign cannot be edited.`, 409, 'NOT_EDITABLE');
  const runningTest = await get("SELECT name FROM ab_tests WHERE workspace_id = ? AND outreach_campaign_id = ? AND status = 'running'", [ws(ctx), c.id]);
  if (runningTest) throw httpError(`A/B test "${runningTest.name}" is running; conclude or cancel it before editing the emails.`, 409, 'TEST_RUNNING');
  const list = z.array(stepInput).min(1).max(MAX_STEPS).parse(input?.steps);
  await saveSteps(ctx, c, list);
  return getCampaign(ctx, c.id);
}

const aiSchema = z.object({
  steps: z.array(z.object({
    delay_days: z.number().int().min(0).max(60),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(5000)
  })).min(1).max(MAX_STEPS)
});

async function generateSequence(ctx, id, input = {}) {
  const c = await requireCampaign(ctx, id);
  if (c.status !== 'draft') throw httpError('Only a draft campaign can be (re)generated.', 409, 'NOT_EDITABLE');
  const count = Math.min(Math.max(Number(input.steps) || 3, 1), MAX_STEPS);
  const product = await productFacts(ctx, c.product_id);
  const prompt = `Write a ${count}-step B2B email outreach sequence (first email plus ${count - 1} follow-up${count === 2 ? '' : 's'}).
Tone: ${c.tone}. Each email: short (60-140 words), one clear call to action, plain text, no signature (one is added).
Start each body with "Hi {{first_name}},". You may use {{company}} for the recipient's company. No other placeholders.
Follow-ups reference the earlier email briefly and must make sense if the earlier one was not read.
Use ONLY the facts below. Never invent statistics, percentages, prices, discounts, free trials or pilots, grants, guarantees, customer names, results or features.
If a needed fact is missing, write a placeholder in square brackets, e.g. [customer example].
${product ? '' : 'No product is selected: write about the goal only and do not name or describe any product.\n'}${untrusted('campaign_facts', JSON.stringify({ product, goal: c.goal, audience: c.audience_note }), 6000)}

Return JSON: {"steps":[{"delay_days": 0, "subject": "...", "body": "..."}, {"delay_days": 3, ...}]} where delay_days is days after the previous email (0 for the first).`;
  const { data, provider } = await generateStructured({
    workspaceId: ws(ctx),
    prompt,
    system: 'You are a careful B2B email copywriter. You never invent facts, numbers or offers.',
    schema: aiSchema,
    referenceType: 'outreach_campaign',
    referenceId: c.id,
    maxTokens: 2200
  });
  const list = data.steps.slice(0, count).map((s, i) => ({ delayDays: i === 0 ? 0 : Math.max(1, s.delay_days), subject: s.subject.trim(), body: s.body.trim() }));
  await saveSteps(ctx, c, list);
  await run('UPDATE outreach_campaigns SET ai_provider = ?, generated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?', [provider, c.id, ws(ctx)]);
  return getCampaign(ctx, c.id);
}

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------
const audienceSchema = z.object({
  leadIds: z.array(z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)])).max(MAX_RECIPIENTS).optional(),
  filter: z.object({
    statuses: z.array(z.string().max(50)).max(20).optional(),
    productId: z.union([z.number(), z.string(), z.null()]).optional(),
    minScore: z.number().int().min(0).max(100).optional()
  }).strict().optional()
}).strict();

async function suppressedSet(workspaceId) {
  return new Set((await all('SELECT LOWER(email) AS e FROM email_suppressions WHERE workspace_id = ?', [workspaceId])).map(r => r.e));
}

/** Leads matching a filter or explicit ids, each marked eligible or not (with the reason). */
async function resolveAudience(ctx, input) {
  const v = audienceSchema.parse(input || {});
  let leads;
  if (v.leadIds && v.leadIds.length) {
    const ids = [...new Set(v.leadIds)];
    leads = await all(`SELECT id, name, email, company_name, status, ai_score, product_id FROM leads WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [ws(ctx), ...ids]);
    if (leads.length !== ids.length) throw httpError('One or more selected leads were not found in this workspace.', 404, 'NOT_FOUND');
  } else if (v.filter) {
    const where = ['workspace_id = ?'];
    const params = [ws(ctx)];
    if (v.filter.statuses && v.filter.statuses.length) { where.push(`status IN (${v.filter.statuses.map(() => '?').join(',')})`); params.push(...v.filter.statuses); }
    if (v.filter.productId) { const p = await resolveSelectedProduct(ws(ctx), v.filter.productId); where.push('product_id = ?'); params.push(p.id); }
    if (v.filter.minScore !== undefined) { where.push('ai_score >= ?'); params.push(v.filter.minScore); }
    leads = await all(`SELECT id, name, email, company_name, status, ai_score, product_id FROM leads WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${MAX_RECIPIENTS}`, params);
  } else {
    throw httpError('Choose leads or a filter.', 400, 'VALIDATION_ERROR');
  }
  const suppressed = await suppressedSet(ws(ctx));
  return leads.map(l => {
    const email = String(l.email || '').trim();
    let reason = null;
    if (!email) reason = 'no email address';
    else if (!emailService.isValidRecipient(email)) reason = 'invalid or placeholder email address';
    else if (suppressed.has(email.toLowerCase())) reason = 'unsubscribed or bounced earlier';
    return { leadId: l.id, name: l.name, email, company: l.company_name, status: l.status, score: l.ai_score, eligible: !reason, reason };
  });
}

async function addRecipients(ctx, id, input) {
  const c = await requireCampaign(ctx, id);
  if (!EDITABLE.includes(c.status)) throw httpError(`Recipients cannot be added to a ${c.status} campaign.`, 409, 'NOT_EDITABLE');
  const audience = await resolveAudience(ctx, input);
  const existing = new Set((await all('SELECT LOWER(email) AS e FROM outreach_recipients WHERE campaign_id = ? AND workspace_id = ?', [c.id, ws(ctx)])).map(r => r.e));
  const count = await get('SELECT COUNT(*) AS n FROM outreach_recipients WHERE campaign_id = ? AND workspace_id = ?', [c.id, ws(ctx)]);
  let room = MAX_RECIPIENTS - Number(count.n);
  const added = [];
  const skipped = [];
  for (const a of audience) {
    if (!a.eligible) { skipped.push({ leadId: a.leadId, name: a.name, reason: a.reason }); continue; }
    if (existing.has(a.email.toLowerCase())) { skipped.push({ leadId: a.leadId, name: a.name, reason: 'already in this campaign' }); continue; }
    if (room <= 0) { skipped.push({ leadId: a.leadId, name: a.name, reason: `campaign limit of ${MAX_RECIPIENTS} recipients reached` }); continue; }
    await run(
      `INSERT INTO outreach_recipients (workspace_id, campaign_id, lead_id, email, name, company, status, next_step_order, unsubscribe_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [ws(ctx), c.id, a.leadId, a.email, a.name || null, a.company || null, crypto.randomBytes(20).toString('hex')]
    );
    existing.add(a.email.toLowerCase());
    added.push(a.leadId);
    room--;
  }
  return { added: added.length, skipped, campaign: await getCampaign(ctx, c.id) };
}

async function listRecipients(ctx, id) {
  const c = await requireCampaign(ctx, id);
  const rows = await all('SELECT * FROM outreach_recipients WHERE campaign_id = ? AND workspace_id = ? ORDER BY id', [c.id, ws(ctx)]);
  const sends = await all('SELECT recipient_id, step_order, status, error, sent_at, created_at FROM outreach_sends WHERE campaign_id = ? AND workspace_id = ? ORDER BY id', [c.id, ws(ctx)]);
  const byRecipient = {};
  for (const s of sends) (byRecipient[s.recipient_id] = byRecipient[s.recipient_id] || []).push({ step: s.step_order, status: s.status, error: s.error, at: s.sent_at || s.created_at });
  return rows.map(r => ({
    id: r.id, leadId: r.lead_id, email: r.email, name: r.name, company: r.company, status: r.status,
    nextStep: r.next_step_order, nextSendAt: r.next_send_at, firstSentAt: r.first_sent_at, lastSentAt: r.last_sent_at, lastError: r.last_error,
    timeline: byRecipient[r.id] || []
  }));
}

async function removeRecipient(ctx, id, recipientId) {
  const c = await requireCampaign(ctx, id);
  const r = await get('SELECT * FROM outreach_recipients WHERE id = ? AND campaign_id = ? AND workspace_id = ?', [Number(recipientId), c.id, ws(ctx)]);
  if (!r) throw httpError('Recipient not found', 404, 'NOT_FOUND');
  if (r.status !== 'pending') throw httpError('Only recipients who have not been emailed yet can be removed; stop the campaign instead.', 409, 'HAS_HISTORY');
  await run('DELETE FROM outreach_recipients WHERE id = ? AND workspace_id = ?', [r.id, ws(ctx)]);
  return { removed: true };
}

// ---------------------------------------------------------------------------
// Lifecycle: approve (one explicit confirmation), pause, resume, stop
// ---------------------------------------------------------------------------
async function readiness(ctx, c) {
  const list = await steps(c);
  const s = await stats(c);
  const cfg = await emailService.getRawMailConfig(ws(ctx));
  const sender = cfg.sender_email || (emailService.isValidRecipient(cfg.smtp_user) ? cfg.smtp_user : null);
  const hasTransport = cfg.provider === 'zeptomail' ? !!(cfg.smtp_pass || (Number(ws(ctx)) === LEGACY_WORKSPACE_ID && process.env.ZEPTOMAIL_TOKEN)) : !!(cfg.smtp_user && cfg.smtp_pass && cfg.smtp_host);
  const problems = [];
  if (!list.length) problems.push('The campaign has no emails. Generate or write the sequence first.');
  if (!(s.pending + s.active)) problems.push('The campaign has no recipients waiting to be emailed.');
  if (!sender || !hasTransport) problems.push('Mail is not configured for this workspace. Add SMTP or ZeptoMail settings in Mail Settings.');
  const flags = [...new Set(list.flatMap(x => parse(x.needs_verification_json, [])))];
  const placeholders = list.filter(x => /\[[^\]{}]{2,60}\]/.test(`${x.subject} ${x.body_text}`)).map(x => x.step_order);
  if (placeholders.length) problems.push(`Fill in the [bracketed] placeholders in email ${placeholders.join(', ')} before sending.`);
  // An A/B test needs its variant B, which is held to the same checks as the main emails.
  const test = await get("SELECT * FROM ab_tests WHERE workspace_id = ? AND outreach_campaign_id = ? AND kind = 'email' AND status IN ('draft', 'running')", [ws(ctx), c.id]);
  let abTest = null;
  if (test) {
    const variant = await get("SELECT * FROM outreach_step_variants WHERE campaign_id = ? AND workspace_id = ? AND step_order = ? AND label = 'B'", [c.id, ws(ctx), test.step_order]);
    abTest = { id: test.id, name: test.name, stepOrder: test.step_order, metric: test.metric, minSamplePerVariant: test.min_sample_per_variant, status: test.status };
    if (!list.some(x => x.step_order === test.step_order)) problems.push(`A/B test "${test.name}" tests email ${test.step_order}, which no longer exists. Cancel or change the test.`);
    if (!variant) problems.push(`A/B test "${test.name}" has no variant B yet.`);
    else {
      flags.push(...parse(variant.needs_verification_json, []).filter(f => !flags.includes(f)));
      if (/\[[^\]{}]{2,60}\]/.test(`${variant.subject} ${variant.body_text}`)) problems.push(`Fill in the [bracketed] placeholders in variant B of email ${test.step_order}.`);
    }
  }
  return { ready: problems.length === 0, problems, flags, recipients: s.pending + s.active, steps: list.length, sender, abTest };
}

async function approve(ctx, id, input = {}) {
  const c = await requireCampaign(ctx, id);
  if (!['draft', 'paused'].includes(c.status)) throw httpError(`A ${c.status} campaign cannot be approved.`, 409, 'NOT_EDITABLE');
  if (input.confirm !== true) throw httpError('Explicit confirmation (confirm: true) is required to start sending.', 400, 'CONFIRMATION_REQUIRED');
  const r = await readiness(ctx, c);
  if (!r.ready) throw Object.assign(httpError(r.problems.join(' '), 409, 'NOT_READY'), { details: r });
  if (r.flags.length && input.acknowledgeFlags !== true) {
    throw Object.assign(httpError(`Some claims are not in your product facts: ${r.flags.join(', ')}. Edit them, or confirm you have verified them.`, 409, 'UNVERIFIED_CLAIMS'), { details: r });
  }
  await withTransaction(async tx => {
    await tx.run("UPDATE outreach_campaigns SET status = 'running', approved_by = ?, approved_at = UTC_TIMESTAMP(), last_error = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?", [ctx.auth.userId || null, c.id, ws(ctx)]);
    await tx.run("UPDATE outreach_recipients SET status = 'active', next_send_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE campaign_id = ? AND workspace_id = ? AND status = 'pending'", [c.id, ws(ctx)]);
    if (r.abTest) {
      // The test definition locks now, before the first email; recipients are split evenly at random.
      await tx.run("UPDATE ab_tests SET status = 'running', locked_at = COALESCE(locked_at, UTC_TIMESTAMP()), updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ? AND status IN ('draft', 'running')", [r.abTest.id, ws(ctx)]);
      const unassigned = await tx.all(
        `SELECT id FROM outreach_recipients WHERE campaign_id = ? AND workspace_id = ? AND variant_label IS NULL AND status = 'active' AND next_step_order <= ?`,
        [c.id, ws(ctx), r.abTest.stepOrder]
      );
      const counts = await tx.get("SELECT SUM(variant_label = 'A') AS a, SUM(variant_label = 'B') AS b FROM outreach_recipients WHERE campaign_id = ? AND workspace_id = ?", [c.id, ws(ctx)]);
      let a = Number(counts.a || 0);
      let b = Number(counts.b || 0);
      const shuffled = unassigned.map(x => x.id).map(v => ({ v, k: crypto.randomInt(1e9) })).sort((x, y) => x.k - y.k).map(x => x.v);
      for (const rid of shuffled) {
        const label = a <= b ? 'A' : 'B';
        if (label === 'A') a++; else b++;
        await tx.run('UPDATE outreach_recipients SET variant_label = ? WHERE id = ? AND workspace_id = ?', [label, rid, ws(ctx)]);
      }
    }
  });
  await audit(ctx, 'outreach.campaign_approved', { resourceType: 'outreach_campaign', resourceId: c.id, metadata: { recipients: r.recipients, steps: r.steps, acknowledgedFlags: r.flags } });
  return getCampaign(ctx, c.id);
}

async function pause(ctx, id) {
  const c = await requireCampaign(ctx, id);
  if (c.status !== 'running') throw httpError('Only a running campaign can be paused.', 409, 'NOT_RUNNING');
  await run("UPDATE outreach_campaigns SET status = 'paused', updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?", [c.id, ws(ctx)]);
  await audit(ctx, 'outreach.campaign_paused', { resourceType: 'outreach_campaign', resourceId: c.id });
  return getCampaign(ctx, c.id);
}

async function stop(ctx, id) {
  const c = await requireCampaign(ctx, id);
  if (['stopped', 'completed'].includes(c.status)) throw httpError(`This campaign is already ${c.status}.`, 409, 'NOT_RUNNING');
  await withTransaction(async tx => {
    await tx.run("UPDATE outreach_campaigns SET status = 'stopped', completed_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?", [c.id, ws(ctx)]);
    await tx.run("UPDATE outreach_recipients SET status = 'stopped', next_send_at = NULL, updated_at = UTC_TIMESTAMP() WHERE campaign_id = ? AND workspace_id = ? AND status IN ('pending', 'active')", [c.id, ws(ctx)]);
  });
  await audit(ctx, 'outreach.campaign_stopped', { resourceType: 'outreach_campaign', resourceId: c.id });
  return getCampaign(ctx, c.id);
}

/** A failed send can be retried once a person has fixed the cause. Unknown outcomes are not retried. */
async function retryRecipient(ctx, id, recipientId, input = {}) {
  const c = await requireCampaign(ctx, id);
  if (input.confirm !== true) throw httpError('Explicit confirmation (confirm: true) is required to retry sending.', 400, 'CONFIRMATION_REQUIRED');
  const r = await get('SELECT * FROM outreach_recipients WHERE id = ? AND campaign_id = ? AND workspace_id = ?', [Number(recipientId), c.id, ws(ctx)]);
  if (!r) throw httpError('Recipient not found', 404, 'NOT_FOUND');
  if (r.status !== 'failed') throw httpError('Only a failed recipient can be retried.', 409, 'NOT_FAILED');
  if (c.status === 'stopped') throw httpError('This campaign was stopped; it cannot send again.', 409, 'NOT_RUNNING');
  // A campaign that finished only because its last recipients failed reopens for the retry.
  if (c.status === 'completed') await run("UPDATE outreach_campaigns SET status = 'running', completed_at = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?", [c.id, ws(ctx)]);
  await run("UPDATE outreach_sends SET status = 'retry' WHERE recipient_id = ? AND workspace_id = ? AND step_order = ? AND status = 'failed'", [r.id, ws(ctx), r.next_step_order]);
  await run("UPDATE outreach_recipients SET status = 'active', next_send_at = UTC_TIMESTAMP(), last_error = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?", [r.id, ws(ctx)]);
  await audit(ctx, 'outreach.recipient_retry', { resourceType: 'outreach_recipient', resourceId: r.id });
  return { retried: true };
}

// ---------------------------------------------------------------------------
// Automation hooks: enrol one lead, stop a lead's sequences
// ---------------------------------------------------------------------------
/**
 * Adds one lead to a sequence (used by automation workflows). The same audience rules apply
 * (valid, non-placeholder, not suppressed). A running (approved) sequence emails the lead in
 * its window; a draft or paused one keeps the lead pending until a person approves it.
 * Idempotent: a lead already in the sequence is reported, not added twice.
 */
async function enrollLead(ctx, campaignId, leadId) {
  const c = await requireCampaign(ctx, campaignId);
  if (['stopped', 'completed'].includes(c.status)) throw httpError(`The email sequence is ${c.status}; it no longer accepts recipients.`, 409, 'CAMPAIGN_CLOSED');
  const [a] = await resolveAudience(ctx, { leadIds: [Number(leadId)] });
  if (!a.eligible) return { enrolled: false, reason: a.reason };
  const exists = await get('SELECT id, status FROM outreach_recipients WHERE campaign_id = ? AND workspace_id = ? AND LOWER(email) = ?', [c.id, ws(ctx), a.email.toLowerCase()]);
  if (exists) return { enrolled: false, reason: 'already in this sequence', recipientId: exists.id };
  const running = c.status === 'running';
  let variant = null;
  const test = await get("SELECT step_order FROM ab_tests WHERE workspace_id = ? AND outreach_campaign_id = ? AND kind = 'email' AND status = 'running'", [ws(ctx), c.id]);
  if (running && test) {
    const counts = await get("SELECT SUM(variant_label = 'A') AS a, SUM(variant_label = 'B') AS b FROM outreach_recipients WHERE campaign_id = ? AND workspace_id = ?", [c.id, ws(ctx)]);
    variant = Number(counts.a || 0) <= Number(counts.b || 0) ? 'A' : 'B';
  }
  try {
    const r = await run(
      `INSERT INTO outreach_recipients (workspace_id, campaign_id, lead_id, email, name, company, status, next_step_order, next_send_at, variant_label, unsubscribe_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [ws(ctx), c.id, a.leadId, a.email, a.name || null, a.company || null, running ? 'active' : 'pending', running ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null, variant, crypto.randomBytes(20).toString('hex')]
    );
    return { enrolled: true, recipientId: r.lastID, status: running ? 'active' : 'pending' };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return { enrolled: false, reason: 'already in this sequence' };
    throw err;
  }
}

async function stopLeadSequences(ctx, leadId, campaignId = null) {
  const params = [ws(ctx), Number(leadId)];
  let extra = '';
  if (campaignId) { await requireCampaign(ctx, campaignId); extra = ' AND campaign_id = ?'; params.push(Number(campaignId)); }
  const r = await run(`UPDATE outreach_recipients SET status = 'stopped', next_send_at = NULL, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND lead_id = ? AND status IN ('pending', 'active')${extra}`, params);
  return { stopped: r.changes };
}

// ---------------------------------------------------------------------------
// Unsubscribe (public, token-based)
// ---------------------------------------------------------------------------
async function suppress(workspaceId, email, reason, source) {
  await run('INSERT IGNORE INTO email_suppressions (workspace_id, email, reason, source, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())', [workspaceId, String(email).trim().toLowerCase(), reason, source]);
  await run("UPDATE outreach_recipients SET status = ?, next_send_at = NULL, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND LOWER(email) = ? AND status IN ('pending', 'active')",
    [reason === 'bounced' ? 'bounced' : 'unsubscribed', workspaceId, String(email).trim().toLowerCase()]);
}

async function unsubscribeByToken(token) {
  if (!/^[a-f0-9]{40}$/.test(String(token || ''))) return null;
  const r = await get('SELECT id, workspace_id, email FROM outreach_recipients WHERE unsubscribe_token = ?', [token]);
  if (!r) return null;
  await suppress(r.workspace_id, r.email, 'unsubscribed', 'unsubscribe_link');
  const full = await get('SELECT id, lead_id, campaign_id FROM outreach_recipients WHERE id = ?', [r.id]);
  if (full && full.lead_id) await require('../../lib/automationEvents').emit(r.workspace_id, 'email.unsubscribed', { subjectType: 'lead', subjectId: full.lead_id, payload: { emailCampaignId: full.campaign_id, recipientId: full.id }, key: `email.unsubscribed:${full.id}` });
  await run("UPDATE outreach_recipients SET status = 'unsubscribed', next_send_at = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?", [r.id]);
  return { email: r.email };
}

async function engineStatus(ctx) {
  const beat = await get("SELECT worker_id, beat_at FROM worker_heartbeats WHERE worker_kind = 'outreach'");
  const ageMs = beat ? Date.now() - new Date(beat.beat_at).getTime() : null;
  const base = process.env.APP_BASE_URL || '';
  const publicLinks = /^https:\/\//i.test(base) && !/localhost|127\.0\.0\.1|\.local\b/i.test(base);
  const cfg = await emailService.getSafeMailConfig(ws(ctx));
  return {
    engineOnline: ageMs !== null && ageMs < 3 * 60 * 1000,
    lastBeatAt: beat ? beat.beat_at : null,
    mailConfigured: !!cfg.sender_email && (cfg.has_smtp_auth || cfg.provider === 'zeptomail'),
    senderEmail: cfg.sender_email || null,
    unsubscribeLinks: publicLinks ? 'link' : 'reply_only',
    suppressed: Number((await get('SELECT COUNT(*) AS n FROM email_suppressions WHERE workspace_id = ?', [ws(ctx)])).n)
  };
}

module.exports = {
  MAX_STEPS,
  TOKENS,
  httpError,
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  replaceSteps,
  generateSequence,
  resolveAudience,
  addRecipients,
  listRecipients,
  removeRecipient,
  readiness: async (ctx, id) => readiness(ctx, await requireCampaign(ctx, id)),
  approve,
  pause,
  resume: approve,
  stop,
  retryRecipient,
  enrollLead,
  stopLeadSequences,
  suppress,
  unsubscribeByToken,
  engineStatus
};
