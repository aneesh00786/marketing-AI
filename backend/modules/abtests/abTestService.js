const { z } = require('zod');
const { run, get, all, withTransaction } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { generateStructured, untrusted } = require('../../lib/aiStructured');
const { unverified } = require('../../lib/claims');
const { twoProportionTest } = require('../../lib/abStats');

/**
 * A/B tests on top of existing campaigns (no new sending or publishing paths).
 *
 * Email (outreach sequences): one step gets a variant B. The test is defined while the
 * sequence is a draft and locks when the sequence is approved; recipients are then split
 * evenly and each send records the variant actually used. Metrics: reply rate (higher is
 * better) or unsubscribe rate (lower is better), from real recipient outcomes. Recipients
 * count only once `wait_days` have passed since their test email, so slow replies are not
 * missed. Opens/clicks are not tracked and never used.
 *
 * Social (Social Media Marketing): compares the existing variant posts of one variant group
 * by platform-reported metrics (engagements or clicks per impression). It must be defined
 * before any variant is published. Demo snapshots are never counted.
 *
 * A winner can only be declared when both variants reach the minimum sample fixed in
 * advance AND a two-proportion z-test on the real counts gives p < alpha. Otherwise the
 * result is "insufficient data" or "no significant difference".
 */
const EMAIL_METRICS = {
  reply_rate: { direction: 'higher', label: 'Reply rate', event: 'replied' },
  unsubscribe_rate: { direction: 'lower', label: 'Unsubscribe rate', event: 'unsubscribed' }
};
const SOCIAL_METRICS = {
  engagement_rate: { direction: 'higher', label: 'Engagements per impression', events: ['likes', 'comments', 'shares', 'saves'] },
  click_rate: { direction: 'higher', label: 'Clicks per impression', events: ['clicks'] }
};
const ALPHAS = [0.01, 0.05, 0.1];

function httpError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const ws = ctx => ctx.auth.workspaceId;
const parse = (v, fb) => { try { return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
const TOKENS = ['first_name', 'company'];
const unknownTokens = text => [...String(text).matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map(m => m[1].toLowerCase()).filter(t => !TOKENS.includes(t));

async function requireTest(ctx, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw httpError('Invalid test id.', 400, 'VALIDATION_ERROR');
  const t = await get('SELECT * FROM ab_tests WHERE id = ? AND workspace_id = ?', [id, ws(ctx)]);
  if (!t) throw httpError('A/B test not found', 404, 'NOT_FOUND');
  return t;
}

async function requireOutreach(ctx, rawId) {
  const c = await get('SELECT * FROM outreach_campaigns WHERE id = ? AND workspace_id = ?', [Number(rawId), ws(ctx)]);
  if (!c) throw httpError('Email sequence not found', 404, 'NOT_FOUND');
  return c;
}

async function requireSocialCampaign(ctx, rawId) {
  const c = await get('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [Number(rawId), ws(ctx)]);
  if (!c) throw httpError('Social campaign not found', 404, 'NOT_FOUND');
  return c;
}

function presentTest(t) {
  const metrics = t.kind === 'email' ? EMAIL_METRICS : SOCIAL_METRICS;
  return {
    id: t.id, kind: t.kind, name: t.name, hypothesis: t.hypothesis,
    emailCampaignId: t.outreach_campaign_id, stepOrder: t.step_order,
    socialCampaignId: t.social_campaign_id, variantGroup: t.variant_group,
    metric: t.metric, metricLabel: metrics[t.metric]?.label || t.metric, direction: t.direction,
    minSamplePerVariant: t.min_sample_per_variant, waitDays: t.wait_days, alpha: Number(t.alpha),
    status: t.status, lockedAt: t.locked_at, winner: t.winner_label, decision: t.decision, decisionNote: t.decision_note,
    concludedAt: t.concluded_at, frozenResult: parse(t.result_json, null), createdAt: t.created_at
  };
}

// ---------------------------------------------------------------------------
// Evaluation (real counts only)
// ---------------------------------------------------------------------------
function decide(t, a, b) {
  const minN = t.min_sample_per_variant;
  const alpha = Number(t.alpha);
  const reasons = [];
  if (a.n < minN || b.n < minN) reasons.push(`Each variant needs at least ${minN} ${t.kind === 'email' ? 'recipients counted' : 'impressions'}; A has ${a.n}, B has ${b.n}.`);
  if (a.unavailable || b.unavailable) reasons.push(a.unavailable || b.unavailable);
  const stats = twoProportionTest(a.events, a.n, b.events, b.n);
  let recommendation = 'insufficient_data';
  let leader = null;
  if (stats.p1 !== null && stats.p2 !== null && stats.p1 !== stats.p2) {
    const bBetter = t.direction === 'higher' ? stats.p2 > stats.p1 : stats.p2 < stats.p1;
    leader = bBetter ? 'B' : 'A';
  }
  if (!reasons.length) {
    if (stats.pValue === null) {
      recommendation = 'no_difference';
      reasons.push('Both variants have the same outcome in every case, so no difference can be measured.');
    } else if (stats.pValue < alpha && leader) {
      recommendation = 'winner';
    } else {
      recommendation = 'no_difference';
      reasons.push(`The difference is not statistically significant (p = ${stats.pValue.toFixed(3)}, needs < ${alpha}).`);
    }
  }
  return {
    recommendation,
    leader: recommendation === 'winner' ? leader : null,
    observedLeader: leader,
    pValue: stats.pValue,
    z: stats.z,
    alpha,
    reasons
  };
}

async function evaluateEmail(t) {
  const out = {};
  for (const label of ['A', 'B']) {
    const emailed = await get(
      `SELECT COUNT(*) AS n FROM outreach_sends WHERE campaign_id = ? AND workspace_id = ? AND step_order = ? AND variant_label = ? AND status = 'sent'`,
      [t.outreach_campaign_id, t.workspace_id, t.step_order, label]
    );
    // Only recipients whose test email is at least wait_days old are counted (matured).
    const matured = await get(
      `SELECT COUNT(*) AS n, SUM(r.status = ?) AS events FROM outreach_sends s JOIN outreach_recipients r ON r.id = s.recipient_id
       WHERE s.campaign_id = ? AND s.workspace_id = ? AND s.step_order = ? AND s.variant_label = ? AND s.status = 'sent'
         AND s.sent_at <= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)`,
      [EMAIL_METRICS[t.metric].event, t.outreach_campaign_id, t.workspace_id, t.step_order, label, t.wait_days]
    );
    const assigned = await get('SELECT COUNT(*) AS n FROM outreach_recipients WHERE campaign_id = ? AND workspace_id = ? AND variant_label = ?', [t.outreach_campaign_id, t.workspace_id, label]);
    const n = Number(matured.n);
    const events = Number(matured.events || 0);
    out[label] = { label, assigned: Number(assigned.n), emailed: Number(emailed.n), n, events, rate: n ? events / n : null };
  }
  return out;
}

async function latestMetric(workspaceId, contentId, key) {
  return get(
    `SELECT metric_value, availability FROM social_metric_snapshots
     WHERE workspace_id = ? AND content_item_id = ? AND metric_key = ? AND source NOT LIKE 'demo%' ORDER BY collected_at DESC, id DESC LIMIT 1`,
    [workspaceId, contentId, key]
  );
}

async function evaluateSocial(t) {
  const items = await all('SELECT id, variant_label, status, platform_key, published_at, title FROM content_items WHERE workspace_id = ? AND campaign_id = ? AND variant_group = ? ORDER BY variant_label, id',
    [t.workspace_id, t.social_campaign_id, t.variant_group]);
  const out = {};
  for (const label of ['A', 'B']) {
    const item = items.find(i => String(i.variant_label).toUpperCase() === label);
    const entry = { label, contentId: item ? item.id : null, title: item ? item.title : null, status: item ? item.status : 'missing', n: 0, events: 0, rate: null, unavailable: null };
    if (!item) { entry.unavailable = `Variant ${label} no longer exists.`; out[label] = entry; continue; }
    if (item.status !== 'published') { entry.unavailable = `Variant ${label} is not published yet.`; out[label] = entry; continue; }
    const imp = await latestMetric(t.workspace_id, item.id, 'impressions');
    if (!imp || imp.availability !== 'available' || imp.metric_value === null) { entry.unavailable = `The platform has not reported impressions for variant ${label}.`; out[label] = entry; continue; }
    let events = 0;
    let anyEvent = false;
    for (const key of SOCIAL_METRICS[t.metric].events) {
      const m = await latestMetric(t.workspace_id, item.id, key);
      if (m && m.availability === 'available' && m.metric_value !== null) { events += Number(m.metric_value); anyEvent = true; }
    }
    if (!anyEvent) { entry.unavailable = `The platform has not reported ${t.metric === 'click_rate' ? 'clicks' : 'engagements'} for variant ${label}.`; out[label] = entry; continue; }
    entry.n = Math.round(Number(imp.metric_value));
    // A proportion needs events <= trials; platforms can count several actions per view.
    entry.capped = events > entry.n;
    entry.events = Math.min(Math.round(events), entry.n);
    entry.rate = entry.n ? entry.events / entry.n : null;
    out[label] = entry;
  }
  return out;
}

async function evaluate(t) {
  if (t.status === 'draft') return { variants: null, decision: { recommendation: 'not_started', reasons: ['The test starts when the email sequence is approved.'] } };
  const variants = t.kind === 'email' ? await evaluateEmail(t) : await evaluateSocial(t);
  return { variants, decision: decide(t, variants.A, variants.B) };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
async function listTests(ctx, { emailCampaignId, socialCampaignId } = {}) {
  const where = ['workspace_id = ?'];
  const params = [ws(ctx)];
  if (emailCampaignId) { where.push('outreach_campaign_id = ?'); params.push(Number(emailCampaignId)); }
  if (socialCampaignId) { where.push('social_campaign_id = ?'); params.push(Number(socialCampaignId)); }
  const rows = await all(`SELECT * FROM ab_tests WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 200`, params);
  const out = [];
  for (const t of rows) {
    const live = ['running'].includes(t.status) ? await evaluate(t) : null;
    out.push({ ...presentTest(t), recommendation: live ? live.decision.recommendation : (t.status === 'concluded' ? t.decision : 'not_started') });
  }
  return out;
}

async function getTest(ctx, id) {
  const t = await requireTest(ctx, id);
  const result = t.status === 'concluded' || t.status === 'cancelled' ? parse(t.result_json, null) : await evaluate(t);
  let variants = null;
  if (t.kind === 'email') {
    const step = await get('SELECT subject, body_text FROM outreach_steps WHERE campaign_id = ? AND workspace_id = ? AND step_order = ?', [t.outreach_campaign_id, ws(ctx), t.step_order]);
    const b = await get("SELECT subject, body_text, needs_verification_json FROM outreach_step_variants WHERE campaign_id = ? AND workspace_id = ? AND step_order = ? AND label = 'B'", [t.outreach_campaign_id, ws(ctx), t.step_order]);
    variants = {
      A: step ? { subject: step.subject, body: step.body_text } : null,
      B: b ? { subject: b.subject, body: b.body_text, needsVerification: parse(b.needs_verification_json, []) } : null
    };
  } else {
    const items = await all('SELECT id, variant_label, status, title, caption_text AS caption FROM content_items WHERE workspace_id = ? AND campaign_id = ? AND variant_group = ? ORDER BY variant_label', [ws(ctx), t.social_campaign_id, t.variant_group]);
    variants = Object.fromEntries(items.map(i => [String(i.variant_label).toUpperCase(), { contentId: i.id, status: i.status, title: i.title, caption: i.caption }]));
  }
  return { ...presentTest(t), content: variants, result };
}

// ---------------------------------------------------------------------------
// Email tests
// ---------------------------------------------------------------------------
const commonFields = {
  name: z.string().trim().min(1).max(255),
  hypothesis: z.string().trim().max(1000).optional().nullable(),
  alpha: z.number().refine(v => ALPHAS.includes(v), `alpha must be one of ${ALPHAS.join(', ')}`).optional()
};
const emailSchema = z.object({
  ...commonFields,
  emailCampaignId: z.number().int().positive(),
  stepOrder: z.number().int().min(1).max(5),
  metric: z.enum(Object.keys(EMAIL_METRICS)),
  minSamplePerVariant: z.number().int().min(30).max(10000).optional(),
  waitDays: z.number().int().min(0).max(30).optional(),
  variant: z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(5000) }).optional()
}).strict();

async function factsFor(ctx, campaign) {
  const p = campaign.product_id ? await get('SELECT name, tagline, description, features_json, target_audience, url FROM digital_products WHERE workspace_id = ? AND id = ?', [ws(ctx), campaign.product_id]) : null;
  return JSON.stringify({ product: p ? { ...p, features: parse(p.features_json, []) } : null, goal: campaign.goal, audience: campaign.audience_note });
}

/** Validates variant B and returns its claims needing verification (throws 400 on bad placeholders). */
async function checkEmailVariant(ctx, campaign, subject, body) {
  const bad = unknownTokens(`${subject} ${body}`);
  if (bad.length) throw httpError(`Unknown placeholder(s): ${bad.map(x => `{{${x}}}`).join(', ')}. Use {{first_name}} or {{company}}.`, 400, 'VALIDATION_ERROR');
  return unverified(`${subject} ${body}`, await factsFor(ctx, campaign));
}

async function saveEmailVariant(ctx, t, campaign, subject, body, flags = null, db = { run }) {
  if (!flags) flags = await checkEmailVariant(ctx, campaign, subject, body);
  await db.run(
    `INSERT INTO outreach_step_variants (workspace_id, campaign_id, step_order, label, subject, body_text, needs_verification_json, created_at, updated_at)
     VALUES (?, ?, ?, 'B', ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE subject = VALUES(subject), body_text = VALUES(body_text), needs_verification_json = VALUES(needs_verification_json), updated_at = UTC_TIMESTAMP()`,
    [ws(ctx), campaign.id, t.step_order, subject, body, JSON.stringify(flags)]
  );
}

async function createEmailTest(ctx, input) {
  const v = emailSchema.parse(input);
  const campaign = await requireOutreach(ctx, v.emailCampaignId);
  if (campaign.status !== 'draft') throw httpError('A/B tests are set up while the email sequence is a draft, before anything is sent.', 409, 'NOT_DRAFT');
  const sent = await get('SELECT COUNT(*) AS n FROM outreach_sends WHERE campaign_id = ? AND workspace_id = ?', [campaign.id, ws(ctx)]);
  if (Number(sent.n) > 0) throw httpError('This sequence has already sent emails; start a test on a new sequence.', 409, 'HAS_HISTORY');
  const step = await get('SELECT id FROM outreach_steps WHERE campaign_id = ? AND workspace_id = ? AND step_order = ?', [campaign.id, ws(ctx), v.stepOrder]);
  if (!step) throw httpError(`Email ${v.stepOrder} does not exist in this sequence.`, 400, 'VALIDATION_ERROR');
  const open = await get("SELECT id FROM ab_tests WHERE workspace_id = ? AND outreach_campaign_id = ? AND status IN ('draft', 'running')", [ws(ctx), campaign.id]);
  if (open) throw httpError('This sequence already has an A/B test. Cancel it to start another.', 409, 'TEST_EXISTS');
  const m = EMAIL_METRICS[v.metric];
  // Validate everything first, then write the test and its variant together (all or nothing).
  const flags = v.variant ? await checkEmailVariant(ctx, campaign, v.variant.subject, v.variant.body) : null;
  const testId = await withTransaction(async tx => {
    const r = await tx.run(
      `INSERT INTO ab_tests (workspace_id, kind, name, hypothesis, outreach_campaign_id, step_order, metric, direction, min_sample_per_variant, wait_days, alpha, status, created_by, created_at, updated_at)
       VALUES (?, 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [ws(ctx), v.name, v.hypothesis || null, campaign.id, v.stepOrder, v.metric, m.direction, v.minSamplePerVariant ?? 100,
        v.waitDays ?? (v.metric === 'reply_rate' ? 3 : 1), v.alpha ?? 0.05, ctx.auth.userId || null]
    );
    if (v.variant) await saveEmailVariant(ctx, { step_order: v.stepOrder }, campaign, v.variant.subject, v.variant.body, flags, tx);
    return r.lastID;
  });
  const t = await requireTest(ctx, testId);
  await audit(ctx, 'abtest.created', { resourceType: 'ab_test', resourceId: t.id, metadata: { kind: 'email', metric: v.metric, minSample: t.min_sample_per_variant } });
  return getTest(ctx, t.id);
}

async function updateEmailTest(ctx, id, input) {
  const t = await requireTest(ctx, id);
  if (t.kind !== 'email') throw httpError('Not an email test.', 400, 'VALIDATION_ERROR');
  if (t.status !== 'draft') throw httpError('The test definition is locked once the sequence is approved.', 409, 'LOCKED');
  const v = z.object({
    name: commonFields.name.optional(),
    hypothesis: commonFields.hypothesis,
    alpha: commonFields.alpha,
    metric: z.enum(Object.keys(EMAIL_METRICS)).optional(),
    minSamplePerVariant: z.number().int().min(30).max(10000).optional(),
    waitDays: z.number().int().min(0).max(30).optional(),
    variant: z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(5000) }).optional()
  }).strict().parse(input);
  const campaign = await requireOutreach(ctx, t.outreach_campaign_id);
  const metric = v.metric ?? t.metric;
  await run(
    'UPDATE ab_tests SET name = ?, hypothesis = ?, alpha = ?, metric = ?, direction = ?, min_sample_per_variant = ?, wait_days = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?',
    [v.name ?? t.name, v.hypothesis !== undefined ? v.hypothesis : t.hypothesis, v.alpha ?? Number(t.alpha), metric, EMAIL_METRICS[metric].direction,
      v.minSamplePerVariant ?? t.min_sample_per_variant, v.waitDays ?? t.wait_days, t.id, ws(ctx)]
  );
  if (v.variant) await saveEmailVariant(ctx, t, campaign, v.variant.subject, v.variant.body);
  return getTest(ctx, t.id);
}

async function generateEmailVariant(ctx, id) {
  const t = await requireTest(ctx, id);
  if (t.kind !== 'email' || t.status !== 'draft') throw httpError('Variant B can only be written while the email test is a draft.', 409, 'LOCKED');
  const campaign = await requireOutreach(ctx, t.outreach_campaign_id);
  const step = await get('SELECT subject, body_text FROM outreach_steps WHERE campaign_id = ? AND workspace_id = ? AND step_order = ?', [campaign.id, ws(ctx), t.step_order]);
  if (!step) throw httpError(`Email ${t.step_order} does not exist in this sequence.`, 400, 'VALIDATION_ERROR');
  const prompt = `Write variant B of the email below for an A/B test${t.hypothesis ? ` (hypothesis: ${t.hypothesis})` : ''}.
Change the subject line and the opening/angle; keep the same call to action, length and facts.
Use ONLY the facts below. Never invent statistics, prices, discounts, free trials, guarantees, customer names, results or features. Keep {{first_name}}/{{company}} placeholders if used.
${untrusted('variant_a', JSON.stringify({ subject: step.subject, body: step.body_text }), 6000)}
${untrusted('facts', await factsFor(ctx, campaign), 6000)}
Return JSON: {"subject":"...","body":"..."}`;
  const { data } = await generateStructured({
    workspaceId: ws(ctx), prompt,
    system: 'You are a careful B2B email copywriter writing A/B variants. You never invent facts, numbers or offers.',
    schema: z.object({ subject: z.string().min(1).max(200), body: z.string().min(1).max(5000) }),
    referenceType: 'ab_test', referenceId: t.id, maxTokens: 900
  });
  await saveEmailVariant(ctx, t, campaign, data.subject.trim(), data.body.trim());
  return getTest(ctx, t.id);
}

// ---------------------------------------------------------------------------
// Social tests
// ---------------------------------------------------------------------------
const socialSchema = z.object({
  ...commonFields,
  socialCampaignId: z.number().int().positive(),
  variantGroup: z.string().trim().min(1).max(64),
  metric: z.enum(Object.keys(SOCIAL_METRICS)),
  minSamplePerVariant: z.number().int().min(100).max(10000000).optional()
}).strict();

async function variantGroups(ctx, socialCampaignId) {
  await requireSocialCampaign(ctx, socialCampaignId);
  const rows = await all(
    `SELECT variant_group, GROUP_CONCAT(DISTINCT UPPER(variant_label) ORDER BY variant_label) AS labels, SUM(status = 'published') AS published, MIN(title) AS title, MIN(platform_key) AS platform
     FROM content_items WHERE workspace_id = ? AND campaign_id = ? AND variant_group IS NOT NULL AND status NOT IN ('superseded', 'cancelled')
     GROUP BY variant_group HAVING COUNT(DISTINCT variant_label) >= 2`,
    [ws(ctx), Number(socialCampaignId)]
  );
  return rows.map(r => ({ variantGroup: r.variant_group, labels: String(r.labels || '').split(','), published: Number(r.published), title: r.title, platform: r.platform, testable: Number(r.published) === 0 }));
}

async function createSocialTest(ctx, input) {
  const v = socialSchema.parse(input);
  await requireSocialCampaign(ctx, v.socialCampaignId);
  const groups = await variantGroups(ctx, v.socialCampaignId);
  const g = groups.find(x => x.variantGroup === v.variantGroup);
  if (!g || !g.labels.includes('A') || !g.labels.includes('B')) throw httpError('That post slot has no A and B variants in this campaign.', 400, 'VALIDATION_ERROR');
  if (!g.testable) throw httpError('A variant of this post is already published; define tests before publishing so the metric is not chosen after seeing results.', 409, 'ALREADY_PUBLISHED');
  const open = await get("SELECT id FROM ab_tests WHERE workspace_id = ? AND social_campaign_id = ? AND variant_group = ? AND status = 'running'", [ws(ctx), v.socialCampaignId, v.variantGroup]);
  if (open) throw httpError('This post slot already has a running test.', 409, 'TEST_EXISTS');
  const r = await run(
    `INSERT INTO ab_tests (workspace_id, kind, name, hypothesis, social_campaign_id, variant_group, metric, direction, min_sample_per_variant, wait_days, alpha, status, locked_at, created_by, created_at, updated_at)
     VALUES (?, 'social', ?, ?, ?, ?, ?, 'higher', ?, 0, ?, 'running', UTC_TIMESTAMP(), ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ws(ctx), v.name, v.hypothesis || null, v.socialCampaignId, v.variantGroup, v.metric, v.minSamplePerVariant ?? 500, v.alpha ?? 0.05, ctx.auth.userId || null]
  );
  await audit(ctx, 'abtest.created', { resourceType: 'ab_test', resourceId: r.lastID, metadata: { kind: 'social', metric: v.metric } });
  return getTest(ctx, r.lastID);
}

// ---------------------------------------------------------------------------
// Conclude / cancel
// ---------------------------------------------------------------------------
async function conclude(ctx, id, input = {}) {
  const t = await requireTest(ctx, id);
  if (t.status !== 'running') throw httpError('Only a running test can be concluded.', 409, 'NOT_RUNNING');
  const need = t.kind === 'email' ? 'mail.send' : 'content.approve';
  if (!ctx.auth.capabilities.has(need)) throw httpError(`Missing permission: ${need}`, 403, 'FORBIDDEN');
  const v = z.object({
    decision: z.enum(['winner', 'no_winner']),
    winner: z.enum(['A', 'B']).optional(),
    note: z.string().trim().max(1000).optional(),
    confirm: z.literal(true, { errorMap: () => ({ message: 'explicit confirmation (confirm: true) is required' }) })
  }).strict().parse(input);
  const result = await evaluate(t);
  if (v.decision === 'winner') {
    if (result.decision.recommendation !== 'winner') {
      throw Object.assign(httpError(`A winner cannot be declared yet: ${result.decision.reasons.join(' ') || 'the result is not significant.'}`, 409, 'INSUFFICIENT_EVIDENCE'), { details: result });
    }
    if (v.winner !== result.decision.leader) throw httpError(`The data supports variant ${result.decision.leader}, not ${v.winner}.`, 409, 'WRONG_WINNER');
  }
  const winner = v.decision === 'winner' ? v.winner : null;
  await run(
    "UPDATE ab_tests SET status = 'concluded', winner_label = ?, decision = ?, decision_note = ?, result_json = ?, concluded_by = ?, concluded_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?",
    [winner, v.decision === 'winner' ? 'winner' : 'no_winner', v.note || null, JSON.stringify(result), ctx.auth.userId || null, t.id, ws(ctx)]
  );
  await audit(ctx, 'abtest.concluded', { resourceType: 'ab_test', resourceId: t.id, metadata: { winner, pValue: result.decision.pValue } });
  return getTest(ctx, t.id);
}

async function cancel(ctx, id) {
  const t = await requireTest(ctx, id);
  if (!['draft', 'running'].includes(t.status)) throw httpError('This test has already ended.', 409, 'NOT_RUNNING');
  const result = t.status === 'running' ? await evaluate(t) : null;
  await run("UPDATE ab_tests SET status = 'cancelled', result_json = ?, concluded_by = ?, concluded_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?",
    [result ? JSON.stringify(result) : null, ctx.auth.userId || null, t.id, ws(ctx)]);
  await audit(ctx, 'abtest.cancelled', { resourceType: 'ab_test', resourceId: t.id });
  return getTest(ctx, t.id);
}

module.exports = {
  EMAIL_METRICS,
  SOCIAL_METRICS,
  ALPHAS,
  listTests,
  getTest,
  createEmailTest,
  updateEmailTest,
  generateEmailVariant,
  variantGroups,
  createSocialTest,
  conclude,
  cancel,
  evaluate
};
