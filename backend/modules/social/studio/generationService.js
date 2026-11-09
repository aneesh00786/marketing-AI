const fs = require('fs');
const { z } = require('zod');
const { run, get, all } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const { recordUsage } = require('../../../lib/usage');
const { generateStructured, untrusted } = require('../../../lib/aiStructured');
const aiMedia = require('../../../lib/aiMedia');
const videoTools = require('../../../lib/videoTools');
const brandKits = require('./brandKitService');
const { campaignContext, contextPrompt } = require('./campaignContext');

/**
 * AI Content Studio generations. Each one is a row in social_content_generations, which is at the
 * same time the job (queued -> processing -> completed | failed), the provider request record and
 * the usage / credit log:
 * - the same request_key (one per click in the browser) is the same generation: a repeated click,
 *   a double submit or a retry never starts (or charges) a second one;
 * - credits are charged once, when a generation completes; a failed one costs nothing and can be
 *   retried; the monthly workspace credit limit is checked before starting;
 * - expensive generations (videos, many images) need explicit confirmation of the estimate;
 * - images and videos run as background jobs (job type studio_generation) and are saved to the
 *   workspace's media library as AI-generated assets; nothing is ever published by a generation.
 * Text generations (posts, plans, carousel copy) answer directly but are recorded the same way.
 */
const ws = ctx => ctx.auth.workspaceId;
const httpError = (status, message, code, details) => Object.assign(new Error(message), { status, code, expose: true, details });
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const PLATFORMS = ['facebook', 'instagram', 'linkedin', 'youtube'];
const FORMATS = ['post', 'poster', 'carousel', 'reel', 'video', 'story'];
const STYLES = ['modern', 'minimal', 'bold', 'elegant', 'playful', 'corporate', 'festive', 'photographic', 'illustrated'];
const PURPOSES = ['offer', 'product_ad', 'feature', 'festival', 'event', 'launch', 'seasonal', 'story', 'general'];

const monthlyCreditLimit = () => {
  const v = process.env.SOCIAL_AI_MONTHLY_CREDIT_LIMIT;
  return v === undefined || v === '' ? 2000 : Number(v);
};
const confirmAbove = () => Number(process.env.AI_CONFIRM_CREDITS || 20);

// ------------------------------------------------------------------ usage and credits

async function creditsThisMonth(workspaceId) {
  const r = await get(`SELECT COALESCE(SUM(credits), 0) AS c FROM social_content_generations
    WHERE workspace_id = ? AND status = 'completed' AND completed_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')`, [workspaceId]);
  return Number(r?.c) || 0;
}

/** Usage summary: this month's credits by kind and provider, the limit, recent generations. */
async function usage(ctx) {
  const byKind = await all(`SELECT kind, provider, COUNT(*) AS n, COALESCE(SUM(credits), 0) AS credits, SUM(cost_usd) AS cost
    FROM social_content_generations WHERE workspace_id = ? AND status = 'completed' AND completed_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')
    GROUP BY kind, provider ORDER BY credits DESC`, [ws(ctx)]);
  const failed = await get(`SELECT COUNT(*) AS n FROM social_content_generations WHERE workspace_id = ? AND status = 'failed' AND created_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')`, [ws(ctx)]);
  const used = await creditsThisMonth(ws(ctx));
  const limit = monthlyCreditLimit();
  return {
    month: new Date().toISOString().slice(0, 7), creditsUsed: used, creditLimit: limit || null, creditsLeft: limit ? Math.max(0, limit - used) : null,
    byKind: byKind.map(r => ({ kind: r.kind, provider: r.provider, generations: Number(r.n), credits: Number(r.credits), costUsd: r.cost === null ? null : Number(r.cost) })),
    failedThisMonth: Number(failed?.n) || 0,
    recent: (await all('SELECT * FROM social_content_generations WHERE workspace_id = ? ORDER BY id DESC LIMIT 20', [ws(ctx)])).map(present),
    note: 'Credits are Marketech.ai usage units. A provider\'s actual cost is shown only when its price is configured on the server; failed generations are not charged.'
  };
}

/** The estimate shown before starting (credits always; USD when the provider price is configured). */
function estimateOf(kind, input) {
  const providerKind = kind === 'carousel' ? 'image' : kind;
  const p = ['image', 'video', 'voice'].includes(providerKind) ? aiMedia.providerFor(providerKind) : null;
  const variations = input.variations || 1;
  const est = aiMedia.estimate(kind, { provider: p?.key, variations, durationSeconds: input.durationSeconds || 5, slides: input.withImages ? (input.slideCount || 5) : 0 });
  // A video with no starting image first creates one; a voice-over is a voice generation.
  if (kind === 'video' && !input.imageAssetId) {
    const img = aiMedia.estimate('image', { provider: aiMedia.providerFor('image')?.key });
    est.credits += img.credits;
    est.costUsd = est.costUsd !== null && img.costUsd !== null ? est.costUsd + img.costUsd : est.costUsd;
  }
  if (kind === 'video' && input.voiceOver) est.credits += aiMedia.estimate('voice').credits;
  return { ...est, provider: p?.key || null, needsConfirmation: kind === 'video' || est.credits >= confirmAbove() };
}

/** Credits reserved by generations still queued or running (released if they fail or are canceled). */
async function reservedCredits(workspaceId) {
  const r = await get("SELECT COALESCE(SUM(estimated_credits), 0) AS c FROM social_content_generations WHERE workspace_id = ? AND status IN ('queued', 'processing')", [workspaceId]);
  return Number(r?.c) || 0;
}

/** Credits left this month: the limit minus what was charged and what running work has reserved. */
async function creditBalance(workspaceId) {
  const limit = monthlyCreditLimit();
  const used = await creditsThisMonth(workspaceId);
  const reserved = await reservedCredits(workspaceId);
  return { limit: limit || null, used, reserved, available: limit ? Math.max(0, limit - used - reserved) : null };
}

async function assertBudget(workspaceId, credits) {
  const b = await creditBalance(workspaceId);
  if (b.available === null) return;
  if (credits > b.available) throw httpError(402, `This would use ${credits} AI credits, but only ${b.available} of this month's ${b.limit} are available${b.reserved ? ` (${b.reserved} reserved by generations in progress)` : ''}.`, 'CREDIT_LIMIT');
}

// ------------------------------------------------------------------ generation rows

function present(r) {
  if (!r) return null;
  const out = parse(r.output_json, {});
  const media = require('../mediaStore');
  return {
    id: r.id, kind: r.kind, purpose: r.purpose, status: r.status, provider: r.provider, model: r.model,
    input: parse(r.input_json, {}), output: out,
    assets: (out.assets || []).map(a => ({ ...a, url: a.publicId ? media.publicUrlFor(a.publicId) : null })),
    error: r.error, errorCode: r.error_code, estimatedCredits: r.estimated_credits === null ? null : Number(r.estimated_credits),
    credits: r.credits === null ? null : Number(r.credits), costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    attempts: r.attempts, campaignId: r.campaign_id, contentItemId: r.content_item_id, brandKitId: r.brand_kit_id,
    createdAt: r.created_at, completedAt: r.completed_at
  };
}

async function requireGeneration(workspaceId, id) {
  const r = await get('SELECT * FROM social_content_generations WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
  if (!r) throw httpError(404, 'Generation not found.', 'NOT_FOUND');
  return r;
}

/** A generation; while it runs, a due background step is also started here (if no worker took it). */
async function getGeneration(ctx, id) {
  const row = await requireGeneration(ws(ctx), id);
  if (row.status === 'queued' || row.status === 'processing') kick(row.workspace_id, row.id);
  return present(row);
}

async function listGenerations(ctx, { kind, status, campaignId, limit = 50 } = {}) {
  const where = ['workspace_id = ?']; const params = [ws(ctx)];
  if (kind) { where.push('kind = ?'); params.push(String(kind)); }
  if (status) { where.push('status = ?'); params.push(String(status)); }
  if (campaignId) { where.push('campaign_id = ?'); params.push(Number(campaignId)); }
  const rows = await all(`SELECT * FROM social_content_generations WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${Math.min(200, Number(limit) || 50)}`, params);
  return rows.map(present);
}

/**
 * Creates (or returns the existing) generation for a request key. A generation in progress or done
 * is returned as is: nothing new is started or charged.
 */
async function begin(ctx, kind, { requestKey, input, purpose = null, campaignId = null, contentItemId = null, brandKitId = null, confirm = false, provider = null, model = null, productId = null, batchKey = null }) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(String(requestKey || ''))) throw httpError(400, 'requestKey is required (8-80 letters, digits, - or _).', 'VALIDATION_ERROR');
  const existing = await get('SELECT * FROM social_content_generations WHERE workspace_id = ? AND request_key = ?', [ws(ctx), requestKey]);
  if (existing) return { row: existing, created: false };
  const est = estimateOf(kind, input);
  if (est.needsConfirmation && confirm !== true) throw httpError(409, `This uses about ${est.credits} AI credits${est.costUsd !== null ? ` (about $${est.costUsd})` : ''}. Confirm to start.`, 'CONFIRMATION_REQUIRED', { estimate: est });
  await assertBudget(ws(ctx), est.credits);
  // Every generation records its product: the campaign's product, read here (never from the browser).
  if (!productId && campaignId) productId = (await get('SELECT product_id FROM campaigns WHERE workspace_id = ? AND id = ?', [ws(ctx), campaignId]))?.product_id || null;
  try {
    const ins = await run(`INSERT INTO social_content_generations (workspace_id, user_id, kind, purpose, provider, model, request_key, status, input_json,
        estimated_credits, estimated_cost_usd, campaign_id, content_item_id, brand_kit_id, product_id, batch_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ws(ctx), ctx.auth.userId || null, kind, purpose, provider || est.provider, model, requestKey, JSON.stringify(input), est.credits, est.costUsd, campaignId, contentItemId, brandKitId, productId, batchKey]);
    await audit(ctx, 'social.ai.generation_started', { resourceType: 'social_generation', resourceId: ins.lastID, metadata: { kind, estimatedCredits: est.credits } });
    return { row: await get('SELECT * FROM social_content_generations WHERE id = ?', [ins.lastID]), created: true };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return { row: await get('SELECT * FROM social_content_generations WHERE workspace_id = ? AND request_key = ?', [ws(ctx), requestKey]), created: false };
    throw err;
  }
}

/** Marks a generation completed and charges its credits, exactly once. */
async function complete(row, output, { credits = null, costUsd = null, provider = null, model = null } = {}) {
  const charged = credits ?? Number(row.estimated_credits) ?? 0;
  const r = await run(`UPDATE social_content_generations SET status = 'completed', output_json = ?, credits = ?, cost_usd = ?, provider = COALESCE(?, provider), model = COALESCE(?, model),
      error = NULL, error_code = NULL, completed_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ? AND status <> 'completed'`,
  [JSON.stringify(output), charged, costUsd ?? row.estimated_cost_usd, provider, model, row.id]);
  if (r.changes && row.kind !== 'text' && row.kind !== 'plan') {
    // Media usage is also kept in the workspace usage ledger (text is metered there by the AI engine).
    await recordUsage({ workspaceId: row.workspace_id, category: `ai_${row.kind}`, providerKey: provider || row.provider, modelKey: model || row.model, quantity: charged, unit: 'credit', referenceType: 'social_generation', referenceId: row.id }).catch(() => null);
  }
  return get('SELECT * FROM social_content_generations WHERE id = ?', [row.id]);
}

async function fail(row, err) {
  await run(`UPDATE social_content_generations SET status = 'failed', error = ?, error_code = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND status <> 'completed'`,
    [String(err.message || 'The generation failed.').slice(0, 2000), String(err.code || 'FAILED').slice(0, 64), row.id]);
  return get('SELECT * FROM social_content_generations WHERE id = ?', [row.id]);
}

// ------------------------------------------------------------------ background jobs

async function enqueue(row) {
  await require('../jobsService').enqueue(row.workspace_id, 'studio_generation', { generationId: row.id, attempt: row.attempts },
    { idempotencyKey: `studio_generation:${row.id}:${row.attempts}:${Date.now()}`, maxAttempts: 1 });
  kick(row.workspace_id, row.id);
}

/** Runs a queued studio job right away in the API process (the worker also picks them up). */
function kick(workspaceId, generationId) {
  if (process.env.STUDIO_INLINE === '0') return;
  setImmediate(async () => {
    const job = await get(`SELECT * FROM background_jobs WHERE workspace_id = ? AND job_type = 'studio_generation' AND status = 'queued' AND run_at <= UTC_TIMESTAMP()
      AND JSON_EXTRACT(payload_json, '$.generationId') = ? ORDER BY id DESC LIMIT 1`, [workspaceId, Number(generationId)]).catch(() => null);
    if (!job) return;
    const claim = await run("UPDATE background_jobs SET status = 'running', locked_by = 'api', locked_at = UTC_TIMESTAMP(), attempt_count = attempt_count + 1 WHERE id = ? AND status = 'queued'", [job.id]).catch(() => ({ changes: 0 }));
    if (!claim.changes) return;
    const jobs = require('../jobsService');
    try { await jobs.complete(job.id, await runJob(job)); } catch (err) { await jobs.fail({ ...job, max_attempts: 0 }, err).catch(() => null); }
  });
}

/** Retry of a failed generation: the same row, a new attempt; it is charged only if it completes. */
async function retry(ctx, id) {
  const row = await requireGeneration(ws(ctx), id);
  if (row.status !== 'failed') throw httpError(409, row.status === 'completed' ? 'This generation is already done.' : 'This generation is still running.', 'INVALID_STATE');
  if (!['image', 'video', 'carousel'].includes(row.kind)) throw httpError(409, 'Generate the text again instead.', 'INVALID_STATE');
  await assertBudget(ws(ctx), Number(row.estimated_credits) || 0);
  await run("UPDATE social_content_generations SET status = 'queued', attempts = attempts + 1, provider_job_id = NULL, error = NULL, error_code = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'failed'", [row.id]);
  const fresh = await requireGeneration(ws(ctx), id);
  await enqueue(fresh);
  await audit(ctx, 'social.ai.generation_retried', { resourceType: 'social_generation', resourceId: row.id });
  return present(fresh);
}

const workerCtx = row => ({ auth: { workspaceId: row.workspace_id, userId: row.user_id, actorType: 'worker' } });

/** Worker entry (job type studio_generation). The workspace comes from the job, never the request. */
async function runJob(job) {
  const { generationId } = JSON.parse(job.payload_json || '{}');
  const row = await get('SELECT * FROM social_content_generations WHERE workspace_id = ? AND id = ?', [job.workspace_id, generationId]);
  if (!row || !['queued', 'processing'].includes(row.status)) return { skipped: true, status: row?.status || null };
  await run("UPDATE social_content_generations SET status = 'processing', updated_at = UTC_TIMESTAMP() WHERE id = ?", [row.id]);
  try {
    if (row.kind === 'image') return { status: (await runImage(row)).status };
    if (row.kind === 'carousel') return { status: (await runCarouselImages(row)).status };
    if (row.kind === 'video') return { status: (await runVideo(row)).status };
    if (row.kind === 'video_edit') return { status: (await runVideoEdit(row)).status };
    throw httpError(400, `Unknown generation kind ${row.kind}.`, 'UNKNOWN_KIND');
  } catch (err) {
    console.error(`[studio] generation ${row.id} (${row.kind}) failed: ${err.code || ''} ${err.message}`);
    await fail(row, err);
    return { status: 'failed', error: err.message };
  }
}

/**
 * Every generation belongs to a campaign with a selected Digital Product: the product's real record
 * (read here, for this workspace only) is the AI's context. There is no free-text product.
 */
async function requireProductCampaign(ctx, campaignId) {
  if (!campaignId) throw httpError(400, 'Choose a campaign first: content is created for a campaign\'s selected product.', 'CAMPAIGN_REQUIRED');
  const info = await campaignContext(ws(ctx), campaignId);
  if (!info.product) throw httpError(400, 'Select a product for this campaign first.', 'PRODUCT_REQUIRED');
  return info;
}

// ------------------------------------------------------------------ text: social posts

const postInput = z.object({
  platforms: z.array(z.enum(PLATFORMS)).min(1).max(4),
  description: z.string().trim().max(3000).optional().default(''),
  objective: z.string().trim().max(300).optional().default(''),
  audience: z.string().trim().max(500).optional().default(''),
  message: z.string().trim().max(1000).optional().default(''),
  tone: z.string().trim().max(100).optional().default(''),
  language: z.string().trim().min(2).max(30).optional().default('English'),
  brandKitId: z.number().int().positive().nullable().optional(),
  campaignId: z.number().int().positive().nullable().optional(),
  // Advanced
  length: z.enum(['short', 'medium', 'long']).optional().default('medium'),
  emoji: z.enum(['none', 'few', 'many']).optional().default('few'),
  hashtagCount: z.number().int().min(0).max(30).optional().nullable(),
  cta: z.string().trim().max(200).optional().default(''),
  link: z.string().trim().max(500).optional().default(''),
  keywords: z.string().trim().max(300).optional().default(''),
  avoid: z.string().trim().max(300).optional().default('')
});
function postStyle(v) {
  return [
    `Length: ${{ short: 'short (1-2 sentences)', medium: 'medium (3-5 sentences)', long: 'long-form (a short story or several paragraphs)' }[v.length]}.`,
    `Emojis: ${{ none: 'none', few: 'one or two', many: 'several, where natural' }[v.emoji]}.`,
    v.hashtagCount != null && `Use exactly ${v.hashtagCount} hashtags per post.`,
    v.cta && `Call to action: ${v.cta}.`, v.link && `Link to include: ${v.link}.`,
    v.keywords && `Work in these keywords: ${v.keywords}.`, v.avoid && `Avoid: ${v.avoid}.`
  ].filter(Boolean).join(' ');
}
const PostSchema = z.object({
  posts: z.array(z.object({
    platform: z.enum(PLATFORMS), title: z.string().max(200), caption: z.string().min(1).max(5000), description: z.string().max(5000).optional().default(''),
    hashtags: z.array(z.string().max(100)).max(30).optional().default([]), call_to_action: z.string().max(200).optional().default(''),
    suggested_time: z.string().max(60).optional().default(''), suggested_format: z.string().max(60).optional().default('')
  })).min(1).max(4)
});
const FIELDS = ['title', 'caption', 'description', 'hashtags', 'call_to_action'];
const GUIDE = { facebook: 'conversational; links allowed; up to ~5 hashtags', instagram: 'visual-first; links not clickable; up to 30 hashtags', linkedin: 'professional and value-focused; 3-5 hashtags', youtube: 'title up to 100 characters; description where the first two lines matter most' };

function brief(v, kit) {
  return [
    untrusted('brand', brandKits.promptText(kit), 3000),
    untrusted('campaign_brief', [
      v.product && `Product or service: ${v.product}`, v.description && `Description: ${v.description}`, v.objective && `Marketing objective: ${v.objective}`,
      v.audience && `Target audience: ${v.audience}`, v.message && `Promotional message: ${v.message}`, v.tone && `Tone: ${v.tone}`, `Language: ${v.language || 'English'}`
    ].filter(Boolean).join('\n'), 5000)
  ].join('\n\n');
}

async function generatePost(ctx, raw, { requestKey, batchKey = null, contentItemId: postItemId = null }) {
  const v = postInput.parse(raw || {});
  const kit = await brandKits.resolve(ws(ctx), v.brandKitId || null);
  const info = await requireProductCampaign(ctx, v.campaignId);
  v.product = info.product.name;
  const { row, created } = await begin(ctx, 'text', { requestKey, input: v, purpose: 'post', campaignId: v.campaignId || null, contentItemId: postItemId, brandKitId: kit?.id || null, batchKey });
  if (!created) return present(row);
  try {
    const { data, provider } = await generateStructured({
      workspaceId: ws(ctx), schema: PostSchema, referenceType: 'social_generation', referenceId: row.id, maxTokens: 3000,
      system: 'You are a senior social media copywriter. Write ready-to-post content per platform. Never invent prices, discounts, statistics or claims that are not in the brief.',
      prompt: `${info ? `${contextPrompt(info, untrusted)}\n` : ''}${brief(v, kit)}\n\nWrite one post for each of these platforms: ${v.platforms.join(', ')}.\nPlatform rules: ${v.platforms.map(p => `${p}: ${GUIDE[p]}`).join('; ')}.\n${untrusted('style_options', postStyle(v), 1500)}\n` +
        'For each: platform, title, caption, description (YouTube: the video description; others: a short summary), hashtags (without #), call_to_action, suggested_time (best day and time to post, e.g. "Tuesday 10:00"), suggested_format (image, carousel, reel, short video, text).\nReturn JSON {"posts":[...]}.'
    });
    const flags = info ? require('../campaignService').unverifiedClaims(JSON.stringify(data.posts), info.factsText) : [];
    return present(await complete(row, { posts: data.posts, unverifiedClaims: flags, missingInformation: info?.missing || [] }, { provider, model: provider }));
  } catch (err) {
    await fail(row, err);
    throw err;
  }
}

/** One field of a generated post again (the others are left as they are). */
async function regeneratePostField(ctx, raw, { requestKey }) {
  const v = z.object({
    field: z.enum(FIELDS), instruction: z.string().max(500).optional().default(''),
    post: z.object({ platform: z.enum(PLATFORMS), title: z.string().max(200).optional().default(''), caption: z.string().max(5000).optional().default(''), description: z.string().max(5000).optional().default(''), hashtags: z.array(z.string()).max(30).optional().default([]), call_to_action: z.string().max(200).optional().default('') }),
    brandKitId: z.number().int().positive().nullable().optional()
  }).parse(raw || {});
  const kit = await brandKits.resolve(ws(ctx), v.brandKitId || null);
  const { row, created } = await begin(ctx, 'text', { requestKey, input: v, purpose: 'post_field', brandKitId: kit?.id || null });
  if (!created) return present(row);
  const schema = v.field === 'hashtags' ? z.object({ value: z.array(z.string().max(100)).min(1).max(30) }) : z.object({ value: z.string().min(1).max(5000) });
  try {
    const { data, provider } = await generateStructured({
      workspaceId: ws(ctx), schema, referenceType: 'social_generation', referenceId: row.id, maxTokens: 1500,
      system: 'You are a senior social media copywriter. Never invent facts that are not in the post.',
      prompt: `${untrusted('brand', brandKits.promptText(kit), 2000)}\n\n${untrusted('current_post', JSON.stringify(v.post), 6000)}\n\nWrite a new ${v.field.replace('_', ' ')} for this ${v.post.platform} post${v.instruction ? ` (${v.instruction})` : ''}. Keep everything else consistent. Return JSON {"value": ...}${v.field === 'hashtags' ? ' (an array of hashtags without #)' : ''}.`
    });
    return present(await complete(row, { field: v.field, value: data.value }, { provider, model: provider }));
  } catch (err) { await fail(row, err); throw err; }
}

// ------------------------------------------------------------------ images: posters and variations

const posterInput = z.object({
  campaignName: z.string().trim().max(200).optional().default(''),
  description: z.string().trim().max(3000).optional().default(''),
  objective: z.string().trim().max(300).optional().default(''),
  audience: z.string().trim().max(500).optional().default(''),
  message: z.string().trim().max(500).optional().default(''),
  purpose: z.enum(PURPOSES).optional().default('general'),
  style: z.enum(STYLES).optional().default('modern'),
  aspect: z.enum(['1:1', '4:5', '9:16', '16:9', '4:3', '3:4']).optional().default('1:1'),
  language: z.string().trim().min(2).max(30).optional().default('English'),
  variations: z.number().int().min(1).max(4).optional().default(2),
  prompt: z.string().trim().max(2000).optional().default(''),
  referenceAssetIds: z.array(z.number().int().positive()).max(4).optional().default([]),
  brandKitId: z.number().int().positive().nullable().optional(),
  campaignId: z.number().int().positive().nullable().optional(),
  contentItemId: z.number().int().positive().nullable().optional(),
  confirm: z.boolean().optional(),
  // Advanced
  cta: z.string().trim().max(80).optional().default(''),
  offer: z.string().trim().max(120).optional().default(''),
  layout: z.enum(['auto', 'centered', 'split', 'product_focus', 'text_heavy', 'minimal_text']).optional().default('auto'),
  mood: z.enum(['auto', 'bright', 'dark', 'warm', 'cool', 'pastel', 'vibrant']).optional().default('auto'),
  background: z.enum(['auto', 'solid', 'gradient', 'photo', 'pattern', 'scene']).optional().default('auto'),
  useBrandColors: z.boolean().optional().default(true),
  logoSpace: z.boolean().optional().default(true),
  avoid: z.string().trim().max(300).optional().default(''),
  useProductImages: z.boolean().optional().default(true)
});

function posterPrompt(v, kit) {
  const kind = { offer: 'promotional offer poster', product_ad: 'product advertisement', feature: 'product feature poster', story: 'vertical social media story design (9:16)', festival: 'festival greeting poster', event: 'event announcement poster', launch: 'product launch poster', seasonal: 'seasonal marketing poster', general: 'social media marketing poster' }[v.purpose];
  return [
    v.prompt || `A professional ${v.style} ${kind} for social media${v.product ? ` promoting ${v.product}` : ''}.`,
    v.description && `About it: ${v.description}.`, v.objective && `Goal: ${v.objective}.`, v.audience && `For: ${v.audience}.`,
    v.message && `Headline text on the design, spelled exactly: "${v.message}".`,
    v.offer && `Offer badge text, spelled exactly: "${v.offer}".`, v.cta && `Button text, spelled exactly: "${v.cta}".`,
    v.layout && v.layout !== 'auto' && `Layout: ${v.layout.replace('_', ' ')}.`, v.mood && v.mood !== 'auto' && `Colour mood: ${v.mood}.`,
    v.background && v.background !== 'auto' && `Background: ${v.background}.`, v.avoid && `Do not include: ${v.avoid}.`,
    kit?.companyName && `Brand name: ${kit.companyName}.`,
    v.useBrandColors !== false && (kit?.primaryColor || kit?.secondaryColor) && `Use the brand colours ${[kit.primaryColor, kit.secondaryColor].filter(Boolean).join(' and ')}.`,
    kit?.tone && `Brand feel: ${kit.tone}.`, kit?.guidelines && `Brand guidelines: ${String(kit.guidelines).slice(0, 400)}.`,
    `Any text in ${v.language}. Clean layout, high contrast, readable text${v.logoSpace !== false ? ', leave space for a logo' : ''}.`
  ].filter(Boolean).join(' ').slice(0, 3800);
}

async function assertWorkspaceAssets(workspaceId, ids, type = null) {
  if (!ids.length) return [];
  const rows = await all(`SELECT id, public_id, asset_type FROM assets WHERE workspace_id = ? AND status = 'ready' AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, [workspaceId, ...ids]);
  if (rows.length !== new Set(ids).size || (type && rows.some(r => r.asset_type !== type))) throw httpError(400, `Choose ${type || 'media'} from this workspace's library.`, 'VALIDATION_ERROR');
  return rows;
}

async function generatePoster(ctx, raw, { requestKey, batchKey = null, contentItemId: postItemId = null }) {
  const v = posterInput.parse(raw || {});
  const provider = aiMedia.providerFor('image');
  if (!provider) throw httpError(501, aiMedia.capabilities().image.reason, 'NOT_CONFIGURED');
  if (v.variations > provider.capabilities.maxVariations) throw httpError(400, `${provider.label} makes at most ${provider.capabilities.maxVariations} variations at a time.`, 'CAPABILITY');
  if (!provider.capabilities.aspects.includes(v.aspect)) throw httpError(400, `${provider.label} cannot make ${v.aspect} images. Choose ${provider.capabilities.aspects.join(', ')}.`, 'CAPABILITY');
  await assertWorkspaceAssets(ws(ctx), v.referenceAssetIds, 'image');
  if (v.referenceAssetIds.length && !provider.capabilities.referenceImages) throw httpError(400, `${provider.label} cannot use reference images. Remove them, or describe the look in the prompt.`, 'CAPABILITY');
  if (v.campaignId) await require('../contentService').assertCampaignInWorkspace(ws(ctx), v.campaignId);
  if (v.contentItemId) await require('../contentService').requireRow(ws(ctx), v.contentItemId);
  const kit = await brandKits.resolve(ws(ctx), v.brandKitId || null);
  const info = await requireProductCampaign(ctx, v.campaignId);
  v.product = info.product.name;
  // The product's own images guide the design when the provider can use references (unless others were chosen).
  if (info && !v.referenceAssetIds.length && v.useProductImages && provider.capabilities.referenceImages && info.productImageIds.length) v.referenceAssetIds = info.productImageIds.slice(0, 3);
  const productLine = info?.product ? `The product: ${info.product.name}${info.product.tagline ? ` — ${info.product.tagline}` : ''}. ${String(info.product.description || '').slice(0, 300)} Show this product; do not invent features or prices.` : '';
  const input = { ...v, confirm: undefined, finalPrompt: `${posterPrompt(v, kit)} ${productLine}`.trim().slice(0, 3800) };
  if (v.purpose === 'story' && !['9:16'].includes(v.aspect)) input.aspect = provider.capabilities.aspects.includes('9:16') ? '9:16' : v.aspect;
  const { row, created } = await begin(ctx, 'image', { requestKey, batchKey, input, purpose: v.purpose, campaignId: v.campaignId || null, contentItemId: v.contentItemId || null, brandKitId: kit?.id || null, confirm: v.confirm, provider: provider.key, model: provider.model() });
  if (created) await enqueue(row);
  return present(row);
}

async function runImage(row) {
  const v = parse(row.input_json, {});
  const provider = aiMedia.providerFor('image');
  if (!provider) throw httpError(501, aiMedia.capabilities().image.reason, 'NOT_CONFIGURED');
  const media = require('../mediaStore');
  // Reference images (product photos, logo, a design to follow): this workspace's files only.
  const references = [];
  for (const id of v.referenceAssetIds || []) {
    const a = await get("SELECT public_id, mime_type FROM assets WHERE workspace_id = ? AND id = ? AND asset_type = 'image' AND status = 'ready'", [row.workspace_id, id]);
    if (!a) throw httpError(400, 'A reference image is no longer in the library.', 'NOT_FOUND');
    references.push({ buffer: await fs.promises.readFile(media.filePath(row.workspace_id, a.public_id)), mime: a.mime_type });
  }
  const res = await provider.generate({ prompt: references.length ? `${v.finalPrompt} Use the attached images as references (product, logo or style to follow).` : v.finalPrompt, aspect: v.aspect, variations: v.variations || 1, references });
  const assets = [];
  for (const [i, buf] of res.images.entries()) {
    const id = await media.storeBuffer(workerCtx(row), buf, { title: (v.title || `${v.campaignName || v.product || 'AI poster'} ${i + 1}`).slice(0, 200), source: v.parentAssetId ? 'edited' : 'ai', parentAssetId: v.parentAssetId || null, generationId: row.id, campaignId: row.campaign_id, extraMeta: { ai: { provider: provider.key, model: res.model, prompt: v.finalPrompt.slice(0, 1000), purpose: row.purpose } } });
    const a = await get('SELECT id, public_id, width, height FROM assets WHERE id = ?', [id]);
    assets.push({ id: a.id, publicId: a.public_id, width: a.width, height: a.height, type: 'image' });
  }
  await attachToContent(row, [assets[0].id]);
  const est = aiMedia.estimate('image', { provider: provider.key, variations: assets.length });
  return complete(row, { assets, requestId: res.requestId }, { credits: est.credits, costUsd: est.costUsd, provider: provider.key, model: res.model });
}

// ------------------------------------------------------------------ AI background replacement

const backgroundInput = z.object({
  assetId: z.number().int().positive(),
  background: z.string().trim().min(3).max(500),
  confirm: z.boolean().optional()
});

/**
 * Replaces an image's background with AI (an image edit with the picture as reference); the result is
 * a new "edited" asset linked to the original, which is kept. Uses image credits.
 */
async function replaceBackground(ctx, raw, { requestKey }) {
  const v = backgroundInput.parse(raw || {});
  const provider = aiMedia.providerFor('image');
  if (!provider) throw httpError(501, aiMedia.capabilities().image.reason, 'NOT_CONFIGURED');
  if (!provider.capabilities.referenceImages) throw httpError(400, `${provider.label} cannot edit an existing image. Use OpenAI Images (gpt-image-1) for background replacement.`, 'CAPABILITY');
  const [a] = await assertWorkspaceAssets(ws(ctx), [v.assetId], 'image');
  const full = await get('SELECT width, height, title, campaign_id FROM assets WHERE id = ?', [a.id]);
  const r = full.width && full.height ? full.width / full.height : 1;
  const aspect = r > 1.2 ? '16:9' : r < 0.8 ? (provider.capabilities.aspects.includes('9:16') && r < 0.65 ? '9:16' : '4:5') : '1:1';
  const input = {
    referenceAssetIds: [a.id], parentAssetId: a.id, variations: 1, aspect: provider.capabilities.aspects.includes(aspect) ? aspect : '1:1',
    title: `${full.title || 'Image'} (new background)`.slice(0, 200),
    finalPrompt: `Edit the attached image: keep the main subject, the product, any text and the logo exactly as they are, in the same position and size. Replace only the background with: ${v.background}. Match the lighting so it looks natural.`
  };
  const { row, created } = await begin(ctx, 'image', { requestKey, input, purpose: 'background', campaignId: full.campaign_id || null, confirm: v.confirm, provider: provider.key, model: provider.model() });
  if (created) await enqueue(row);
  return present(row);
}

// ------------------------------------------------------------------ carousels

const carouselInput = z.object({
  topic: z.string().trim().min(2).max(500),
  kind: z.enum(['features', 'steps', 'promotion', 'tips', 'story']).optional().default('features'),
  audience: z.string().trim().max(500).optional().default(''),
  slideCount: z.number().int().min(2).max(10).optional().default(5),
  platform: z.enum(['instagram', 'linkedin', 'facebook']).optional().default('instagram'),
  style: z.enum(STYLES).optional().default('modern'),
  language: z.string().trim().min(2).max(30).optional().default('English'),
  withImages: z.boolean().optional().default(false),
  contentItemId: z.number().int().positive().nullable().optional(),
  cta: z.string().trim().max(120).optional().default(''),
  tone: z.string().trim().max(100).optional().default(''),
  wordsPerSlide: z.number().int().min(5).max(60).optional().default(30),
  brandKitId: z.number().int().positive().nullable().optional(),
  campaignId: z.number().int().positive().nullable().optional(),
  confirm: z.boolean().optional()
});
const CarouselSchema = z.object({
  caption: z.string().min(1).max(3000), hashtags: z.array(z.string().max(100)).max(30).optional().default([]),
  slides: z.array(z.object({ title: z.string().min(1).max(120), body: z.string().max(400).optional().default(''), image_prompt: z.string().max(1000).optional().default('') })).min(2).max(10)
});

/**
 * Slide-by-slide copy (one consistent visual direction for every slide), saved as a draft content
 * item (format carousel). With images, each slide's image is generated in the background with the
 * same style, then attached to its slide.
 */
async function generateCarousel(ctx, raw, { requestKey, batchKey = null, contentItemId: postItemId = null }) {
  const v = carouselInput.parse(raw || {});
  if (v.withImages && !aiMedia.providerFor('image')) throw httpError(501, aiMedia.capabilities().image.reason, 'NOT_CONFIGURED');
  if (v.campaignId) await require('../contentService').assertCampaignInWorkspace(ws(ctx), v.campaignId);
  if (v.contentItemId) await require('../contentService').requireRow(ws(ctx), v.contentItemId);
  const kit = await brandKits.resolve(ws(ctx), v.brandKitId || null);
  const info = await requireProductCampaign(ctx, v.campaignId);
  v.product = info.product.name;
  const { row, created } = await begin(ctx, 'carousel', { requestKey, batchKey, input: { ...v, confirm: undefined }, purpose: v.kind, campaignId: v.campaignId || null, contentItemId: v.contentItemId || null, brandKitId: kit?.id || null, confirm: v.confirm });
  if (!created) return present(row);
  try {
    const { data, provider } = await generateStructured({
      workspaceId: ws(ctx), schema: CarouselSchema, referenceType: 'social_generation', referenceId: row.id, maxTokens: 3000,
      system: 'You are a senior social media designer and copywriter. Carousel slides are short, scannable and consistent. Never invent facts.',
      prompt: `${info ? `${contextPrompt(info, untrusted)}\n` : ''}${brief({ product: v.product, audience: v.audience, language: v.language, tone: v.tone }, kit)}${v.cta ? `\nFinal slide call to action: ${untrusted('cta', v.cta, 200)}` : ''}\nAt most ${v.wordsPerSlide} words of body text per slide.\n\nCreate a ${v.slideCount}-slide ${v.platform} carousel (${v.kind}) about: ${untrusted('topic', v.topic, 600)}.\n` +
        `Slide 1 hooks, the last slide is a call to action. Each slide: title (max 8 words), body (max 30 words), image_prompt (the slide's visual, ${v.style} style, all slides in one consistent design). Also a caption and hashtags (without #). Return JSON {"caption","hashtags","slides":[...]}.`
    });
    const contentService = require('../contentService');
    const slides = data.slides.slice(0, v.slideCount).map(s => ({ title: s.title, body: s.body, imagePrompt: s.image_prompt || null, assetId: null }));
    // For a planned idea, its post becomes the carousel (a new version); otherwise a new draft post.
    const item = v.contentItemId
      ? await contentService.updateContent(ctx, v.contentItemId, { caption: data.caption, hashtags: data.hashtags, format: 'carousel', slides, changeNote: 'AI carousel generated' })
      : await contentService.createContent(ctx, {
        campaignId: v.campaignId || null, platformKey: v.platform, title: slides[0].title, caption: data.caption, hashtags: data.hashtags,
        source: 'ai_studio', format: 'carousel', slides, brandKitId: kit?.id || null
      });
    await run('UPDATE social_content_generations SET content_item_id = ?, output_json = ? WHERE id = ?', [item.id, JSON.stringify({ contentItemId: item.id, slides, caption: data.caption, hashtags: data.hashtags, textProvider: provider }), row.id]);
    if (v.contentItemId) await shareWithGroup({ ...row, content_item_id: item.id });
    const fresh = await get('SELECT * FROM social_content_generations WHERE id = ?', [row.id]);
    if (!v.withImages) {
      const est = aiMedia.estimate('text');
      return present(await complete(fresh, { contentItemId: item.id, slides, caption: data.caption, hashtags: data.hashtags }, { credits: est.credits, provider, model: provider }));
    }
    await enqueue(fresh);
    return present(fresh);
  } catch (err) { await fail(row, err); throw err; }
}

async function runCarouselImages(row) {
  const out = parse(row.output_json, {});
  const v = parse(row.input_json, {});
  const provider = aiMedia.providerFor('image');
  if (!provider) throw httpError(501, aiMedia.capabilities().image.reason, 'NOT_CONFIGURED');
  const kit = await brandKits.resolve(row.workspace_id, row.brand_kit_id || null).catch(() => null);
  const media = require('../mediaStore');
  const slides = out.slides || [];
  const aspect = provider.capabilities.aspects.includes('4:5') ? '4:5' : '1:1';
  const assets = [];
  for (const [i, s] of slides.entries()) {
    if (s.assetId) continue;
    const prompt = [s.imagePrompt || s.title, `Slide ${i + 1} of ${slides.length} of one carousel: identical ${v.style} design, layout and colours on every slide.`,
      s.title && `Title text on the slide, spelled exactly: "${s.title}".`, kit?.primaryColor && `Brand colours ${[kit.primaryColor, kit.secondaryColor].filter(Boolean).join(' and ')}.`].filter(Boolean).join(' ');
    const res = await provider.generate({ prompt, aspect, variations: 1 });
    const id = await media.storeBuffer(workerCtx(row), res.images[0], { title: `${s.title}`.slice(0, 200), source: 'ai', generationId: row.id, campaignId: row.campaign_id, extraMeta: { ai: { provider: provider.key, model: res.model, slide: i + 1 } } });
    s.assetId = id;
    const a = await get('SELECT id, public_id, width, height FROM assets WHERE id = ?', [id]);
    assets.push({ id: a.id, publicId: a.public_id, width: a.width, height: a.height, type: 'image', slide: i + 1 });
    // Saved slide by slide: a retry continues with the slides still missing.
    await run('UPDATE social_content_generations SET output_json = ? WHERE id = ?', [JSON.stringify({ ...out, slides }), row.id]);
  }
  if (out.contentItemId) {
    await run('UPDATE content_items SET carousel_json = ?, media_asset_ids_json = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?',
      [JSON.stringify(slides), JSON.stringify(slides.map(s => s.assetId).filter(Boolean)), row.workspace_id, out.contentItemId]);
  }
  if (out.contentItemId) await shareWithGroup({ ...row, content_item_id: out.contentItemId });
  const est = aiMedia.estimate('carousel', { provider: provider.key, slides: slides.length });
  return complete(row, { ...out, slides, assets }, { credits: est.credits, costUsd: est.costUsd, provider: provider.key, model: provider.model() });
}

// ------------------------------------------------------------------ videos (asynchronous)

const videoInput = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().max(300).optional().default(''),
  prompt: z.string().trim().min(3).max(2000),
  audience: z.string().trim().max(500).optional().default(''),
  kind: z.enum(['promo', 'reel', 'short', 'ad', 'animated_poster', 'product']).optional().default('promo'),
  durationSeconds: z.number().int().min(2).max(60).optional().default(5),
  aspect: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4']).optional().default('9:16'),
  language: z.string().trim().min(2).max(30).optional().default('English'),
  imageAssetId: z.number().int().positive().nullable().optional(),
  voiceOver: z.string().trim().max(2000).optional().default(''),
  subtitles: z.boolean().optional().default(false),
  brandKitId: z.number().int().positive().nullable().optional(),
  campaignId: z.number().int().positive().nullable().optional(),
  contentItemId: z.number().int().positive().nullable().optional(),
  confirm: z.boolean().optional(),
  // Advanced
  camera: z.enum(['auto', 'static', 'slow_zoom', 'pan', 'orbit', 'tracking', 'handheld']).optional().default('auto'),
  mood: z.enum(['auto', 'energetic', 'calm', 'luxury', 'playful', 'cinematic', 'corporate']).optional().default('auto'),
  pace: z.enum(['auto', 'slow', 'medium', 'fast']).optional().default('auto'),
  avoid: z.string().trim().max(300).optional().default(''),
  introAssetId: z.number().int().positive().nullable().optional(),
  outroAssetId: z.number().int().positive().nullable().optional(),
  musicAssetId: z.number().int().positive().nullable().optional(),
  musicVolume: z.number().min(0).max(1).optional().default(0.3),
  useProductImages: z.boolean().optional().default(true)
});
const MAX_POLLS = 80;

async function generateVideo(ctx, raw, { requestKey, batchKey = null, contentItemId: postItemId = null }) {
  const v = videoInput.parse(raw || {});
  const provider = aiMedia.providerFor('video');
  if (!provider) throw httpError(501, aiMedia.capabilities().video.reason, 'NOT_CONFIGURED');
  const caps = provider.capabilities;
  if (!caps.aspects.includes(v.aspect)) throw httpError(400, `${provider.label} cannot make ${v.aspect} videos. Choose ${caps.aspects.join(', ')}.`, 'CAPABILITY');
  if (!caps.durations.includes(v.durationSeconds)) throw httpError(400, `${provider.label} makes videos of ${caps.durations.join(' or ')} seconds.`, 'CAPABILITY');
  if (!v.imageAssetId && !caps.textToVideo && !aiMedia.providerFor('image')) throw httpError(501, `${provider.label} animates a starting image: choose an image, or set up an image provider so one can be generated.`, 'CAPABILITY');
  if (v.imageAssetId) await assertWorkspaceAssets(ws(ctx), [v.imageAssetId], 'image');
  if ((v.voiceOver || v.subtitles || v.introAssetId || v.outroAssetId || v.musicAssetId) && !videoTools.available()) throw httpError(501, aiMedia.capabilities().videoEditing.reason, 'CAPABILITY');
  await assertWorkspaceAssets(ws(ctx), [v.introAssetId, v.outroAssetId].filter(Boolean), 'image');
  if (v.musicAssetId) await assertWorkspaceAssets(ws(ctx), [v.musicAssetId], 'audio');
  if (v.voiceOver && !aiMedia.providerFor('voice')) throw httpError(501, aiMedia.capabilities().voice.reason, 'CAPABILITY');
  if (v.campaignId) await require('../contentService').assertCampaignInWorkspace(ws(ctx), v.campaignId);
  if (v.contentItemId) await require('../contentService').requireRow(ws(ctx), v.contentItemId);
  const kit = await brandKits.resolve(ws(ctx), v.brandKitId || null);
  const info = await requireProductCampaign(ctx, v.campaignId);
  v.product = info.product.name;
  if (info && !v.imageAssetId && v.useProductImages && info.productImageIds.length) v.imageAssetId = info.productImageIds[0];
  v.product = `${info.product.name}${info.product.tagline ? ` (${info.product.tagline})` : ''}`;
  const finalPrompt = [v.prompt, v.product && `Product: ${v.product}.`, v.audience && `For: ${v.audience}.`, kit?.companyName && `Brand: ${kit.companyName}.`,
    (kit?.primaryColor) && `Brand colours ${[kit.primaryColor, kit.secondaryColor].filter(Boolean).join(' and ')}.`,
    v.camera !== 'auto' && `Camera: ${v.camera.replace('_', ' ')}.`, v.mood !== 'auto' && `Mood: ${v.mood}.`, v.pace !== 'auto' && `Pace: ${v.pace}.`, v.avoid && `Avoid: ${v.avoid}.`,
    `A ${v.kind.replace('_', ' ')} video, ${v.camera === 'auto' ? 'smooth camera motion, ' : ''}professional.`].filter(Boolean).join(' ').slice(0, 1000);
  const { row, created } = await begin(ctx, 'video', { requestKey, batchKey, input: { ...v, confirm: undefined, finalPrompt }, purpose: v.kind, campaignId: v.campaignId || null, contentItemId: v.contentItemId || null, brandKitId: kit?.id || null, confirm: v.confirm, provider: provider.key, model: provider.model() });
  if (created) await enqueue(row);
  return present(row);
}

async function dataUri(workspaceId, assetId) {
  const a = await get("SELECT public_id, mime_type FROM assets WHERE workspace_id = ? AND id = ? AND asset_type = 'image' AND status = 'ready'", [workspaceId, assetId]);
  if (!a) throw httpError(400, 'The starting image is no longer in the library.', 'NOT_FOUND');
  const media = require('../mediaStore');
  return `data:${a.mime_type};base64,${(await fs.promises.readFile(media.filePath(workspaceId, a.public_id))).toString('base64')}`;
}

async function runVideo(row) {
  const v = parse(row.input_json, {});
  const provider = aiMedia.providerFor('video');
  if (!provider) throw httpError(501, aiMedia.capabilities().video.reason, 'NOT_CONFIGURED');
  const out = parse(row.output_json, {});
  const media = require('../mediaStore');
  if (!row.provider_job_id) {
    // Image-to-video providers animate a still: the chosen image, or a poster generated for it.
    let imageAssetId = v.imageAssetId || out.startImageAssetId || null;
    if (!imageAssetId && !provider.capabilities.textToVideo) {
      const img = aiMedia.providerFor('image');
      if (!img) throw httpError(501, aiMedia.capabilities().image.reason, 'NOT_CONFIGURED');
      const aspect = img.capabilities.aspects.includes(v.aspect) ? v.aspect : '1:1';
      const res = await img.generate({ prompt: `${v.finalPrompt} A single cinematic still frame for the opening shot.`, aspect, variations: 1 });
      imageAssetId = await media.storeBuffer(workerCtx(row), res.images[0], { title: `${v.title} (start frame)`.slice(0, 200), source: 'ai', generationId: row.id, campaignId: row.campaign_id, extraMeta: { ai: { provider: img.key, model: res.model, role: 'video_start_frame' } } });
      out.startImageAssetId = imageAssetId;
    }
    const started = await provider.start({ prompt: v.finalPrompt, imageDataUri: imageAssetId ? await dataUri(row.workspace_id, imageAssetId) : null, aspect: v.aspect, durationSeconds: v.durationSeconds });
    await run("UPDATE social_content_generations SET provider_job_id = ?, model = ?, output_json = ?, status = 'processing', updated_at = UTC_TIMESTAMP() WHERE id = ?",
      [String(started.jobId).slice(0, 255), started.model, JSON.stringify({ ...out, polls: 0 }), row.id]);
    await pollLater(row, 15);
    return { status: 'processing' };
  }
  const polled = await provider.poll(row.provider_job_id);
  if (polled.status === 'processing') {
    const polls = (out.polls || 0) + 1;
    if (polls > MAX_POLLS) throw httpError(504, `${provider.label} did not finish the video in time.`, 'PROVIDER_TIMEOUT');
    await run('UPDATE social_content_generations SET output_json = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [JSON.stringify({ ...out, polls, progress: polled.progress ?? null }), row.id]);
    await pollLater(row, 20);
    return { status: 'processing' };
  }
  if (polled.status === 'failed') throw httpError(502, `${provider.label}: ${polled.error}`, 'PROVIDER_FAILED');
  let videoId = await media.storeBuffer(workerCtx(row), polled.video, { title: v.title, source: 'ai', generationId: row.id, campaignId: row.campaign_id, extraMeta: { ai: { provider: provider.key, model: row.model, prompt: String(v.finalPrompt).slice(0, 1000) } } });
  const assets = [{ id: videoId, type: 'video' }];
  // Voice-over and subtitles (FFmpeg): an edited copy; the generated original stays in the library.
  const cues = v.subtitles ? videoTools.cuesFromScript(v.voiceOver || v.prompt, v.durationSeconds) : [];
  let subtitlesMode = null; let srt = null;
  if ((v.voiceOver || cues.length || v.introAssetId || v.outroAssetId || v.musicAssetId) && videoTools.available()) {
    const r = await editVideoFile(workerCtx(row), videoId, { cues, voiceText: v.voiceOver || null, title: `${v.title} (final)`, generationId: row.id,
      introAssetId: v.introAssetId || null, outroAssetId: v.outroAssetId || null, musicAssetId: v.musicAssetId || null, musicVolume: v.musicVolume ?? 0.3 });
    videoId = r.id; subtitlesMode = r.subtitlesMode; srt = r.srt;
    assets.push({ id: videoId, type: 'video', edited: true });
  }
  for (const a of assets) a.publicId = (await get('SELECT public_id FROM assets WHERE id = ?', [a.id])).public_id;
  await attachToContent(row, [videoId]);
  const est = estimateOf('video', v);
  return complete(row, { ...out, assets, videoAssetId: videoId, subtitles: cues, subtitlesMode, srt }, { credits: est.credits, costUsd: est.costUsd, provider: provider.key, model: row.model });
}

/**
 * Media generated for a planned post is attached to it through the normal edit path (a new
 * version; an approval of the old version no longer counts). Other variations stay in the library.
 */
async function attachToContent(row, assetIds) {
  if (!row.content_item_id || !assetIds.length) return;
  const contentService = require('../contentService');
  const item = await get('SELECT status, media_asset_ids_json FROM content_items WHERE workspace_id = ? AND id = ?', [row.workspace_id, row.content_item_id]);
  if (!item || !['draft', 'review', 'approved', 'rejected', 'failed'].includes(item.status)) return;
  await contentService.updateContent(workerCtx(row), row.content_item_id, { mediaAssetIds: assetIds, changeNote: 'AI media generated' }).catch(err => console.error(`[studio] could not attach media to content ${row.content_item_id}: ${err.message}`));
  await shareWithGroup(row);
}

/**
 * One planned item on several platforms is one post per platform (same post group): media made for one
 * of them is attached to the others too (new versions), so it is generated and charged once.
 */
async function shareWithGroup(row) {
  const item = await get('SELECT id, post_group_id, media_asset_ids_json, carousel_json, format FROM content_items WHERE workspace_id = ? AND id = ?', [row.workspace_id, row.content_item_id]);
  if (!item?.post_group_id) return;
  const siblings = await all("SELECT id FROM content_items WHERE workspace_id = ? AND post_group_id = ? AND id <> ? AND status IN ('draft', 'review', 'approved', 'rejected', 'failed')", [row.workspace_id, item.post_group_id, item.id]);
  const contentService = require('../contentService');
  for (const s of siblings) {
    await contentService.updateContent(workerCtx(row), s.id, { mediaAssetIds: parse(item.media_asset_ids_json, []), ...(item.carousel_json ? { slides: parse(item.carousel_json, null) } : {}), changeNote: 'AI media shared from the same planned item' })
      .catch(err => console.error(`[studio] could not share media with content ${s.id}: ${err.message}`));
  }
}

/** Cancels a queued generation (nothing started yet, never charged; its reservation is released). */
async function cancel(ctx, id) {
  const row = await requireGeneration(ws(ctx), id);
  const r = await run("UPDATE social_content_generations SET status = 'canceled', error = 'Canceled', error_code = 'CANCELED', updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ? AND status = 'queued'", [ws(ctx), id]);
  if (!r.changes) throw httpError(409, row.status === 'processing' ? 'This generation has already started and cannot be canceled.' : `This generation is ${row.status}.`, 'INVALID_STATE');
  await audit(ctx, 'social.ai.generation_canceled', { resourceType: 'social_generation', resourceId: id });
  return present(await requireGeneration(ws(ctx), id));
}

/** Every AI generation of one post (and its group), oldest first: version, provider, model, prompt, cost, files. */
async function history(ctx, contentItemId) {
  const item = await get('SELECT id, post_group_id FROM content_items WHERE workspace_id = ? AND id = ?', [ws(ctx), contentItemId]);
  if (!item) throw httpError(404, 'Post not found.', 'NOT_FOUND');
  const ids = item.post_group_id ? (await all('SELECT id FROM content_items WHERE workspace_id = ? AND post_group_id = ?', [ws(ctx), item.post_group_id])).map(r => r.id) : [item.id];
  const rows = await all(`SELECT * FROM social_content_generations WHERE workspace_id = ? AND content_item_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, [ws(ctx), ...ids]);
  return rows.map((r, i) => {
    const p = present(r);
    return { version: i + 1, ...p, prompt: p.input?.finalPrompt || p.input?.prompt || p.input?.topic || null };
  });
}

async function pollLater(row, seconds) {
  await require('../jobsService').enqueue(row.workspace_id, 'studio_generation', { generationId: row.id, attempt: row.attempts },
    { idempotencyKey: `studio_generation:${row.id}:poll:${Date.now()}`, runAt: new Date(Date.now() + seconds * 1000), maxAttempts: 1 });
}

// ------------------------------------------------------------------ video editing (FFmpeg)

/** A library file of this workspace (path and facts), or a clear error. */
async function libraryFile(workspaceId, id, type, label) {
  const a = await get("SELECT * FROM assets WHERE workspace_id = ? AND id = ? AND asset_type = ? AND status = 'ready'", [workspaceId, id, type]);
  if (!a) throw httpError(400, `The ${label} is not in this workspace's library.`, 'NOT_FOUND');
  return { row: a, path: require('../mediaStore').filePath(workspaceId, a.public_id) };
}

/**
 * Edits a library video into a new "edited" asset (the original is kept): trim, a replaced scene,
 * intro/outro image cards, subtitles, voice-over (mixed or replacing the sound) and background music.
 */
async function editVideoFile(ctx, assetId, { start = null, end = null, cues = [], voiceText = null, voiceMode = 'mix', title, generationId = null,
  introAssetId = null, introSeconds = 2, outroAssetId = null, outroSeconds = 2, musicAssetId = null, musicVolume = 0.3, replace = null }) {
  const media = require('../mediaStore');
  const w = ctx.auth.workspaceId;
  const { row: a, path: mainPath } = await libraryFile(w, assetId, 'video', 'video');
  const intro = introAssetId ? { path: (await libraryFile(w, introAssetId, 'image', 'intro image')).path, seconds: introSeconds } : null;
  const outro = outroAssetId ? { path: (await libraryFile(w, outroAssetId, 'image', 'outro image')).path, seconds: outroSeconds } : null;
  const music = musicAssetId ? { path: (await libraryFile(w, musicAssetId, 'audio', 'music')).path, volume: musicVolume } : null;
  const scene = replace ? { start: replace.start, end: replace.end, path: (await libraryFile(w, replace.assetId, 'video', 'replacement clip')).path } : null;
  let voicePath = null;
  if (voiceText) {
    const voice = aiMedia.providerFor('voice');
    if (!voice) throw httpError(501, aiMedia.capabilities().voice.reason, 'CAPABILITY');
    const r = await voice.generate({ text: voiceText });
    voicePath = await media.tempPath(w, '.mp3');
    await fs.promises.writeFile(voicePath, r.audio, { mode: 0o640 });
  }
  const out = await media.tempPath(w, '.mp4');
  try {
    const meta = parse(a.metadata_json, {});
    const res = await videoTools.compose({
      output: out, main: { path: mainPath, duration: Number(a.duration_seconds) || 0, hasAudio: !!(a.audio_codec || meta.hasAudio), width: a.width, height: a.height },
      start, end, replace: scene, intro, outro, cues, voice: voicePath ? { path: voicePath, mode: voiceMode } : null, music
    });
    const id = await media.storeFile(ctx, out, { title: title || `${a.title || 'Video'} (edited)`, source: 'edited', generationId, parentAssetId: a.id, campaignId: a.campaign_id,
      extraMeta: { edit: { start, end, subtitles: res.subtitlesMode, voiceOver: !!voiceText, intro: !!intro, outro: !!outro, music: !!music, replacedScene: !!scene } } });
    return { id, subtitlesMode: res.subtitlesMode, srt: res.srt };
  } finally {
    if (voicePath) await fs.promises.unlink(voicePath).catch(() => {});
    await fs.promises.unlink(out).catch(() => {});
  }
}

const editInput = z.object({
  assetId: z.number().int().positive(),
  start: z.number().min(0).max(3600).nullable().optional(),
  end: z.number().min(0.5).max(3600).nullable().optional(),
  subtitles: z.array(z.object({ start: z.number().min(0), end: z.number().min(0), text: z.string().max(200) })).max(200).optional().default([]),
  voiceOver: z.string().trim().max(2000).optional().default(''),
  voiceMode: z.enum(['mix', 'replace']).optional().default('mix'),
  introAssetId: z.number().int().positive().nullable().optional(),
  introSeconds: z.number().min(0.5).max(10).optional().default(2),
  outroAssetId: z.number().int().positive().nullable().optional(),
  outroSeconds: z.number().min(0.5).max(10).optional().default(2),
  musicAssetId: z.number().int().positive().nullable().optional(),
  musicVolume: z.number().min(0).max(1).optional().default(0.3),
  replace: z.object({ start: z.number().min(0), end: z.number().min(0.5), assetId: z.number().int().positive() }).nullable().optional(),
  confirm: z.boolean().optional()
});

/** Trim / subtitles / voice-over of a library video, as a background job; the original is kept. */
async function editVideo(ctx, raw, { requestKey }) {
  const v = editInput.parse(raw || {});
  if (!videoTools.available()) throw httpError(501, aiMedia.capabilities().videoEditing.reason, 'CAPABILITY');
  if (v.voiceOver && !aiMedia.providerFor('voice')) throw httpError(501, aiMedia.capabilities().voice.reason, 'CAPABILITY');
  if (v.end != null && v.start != null && v.end <= v.start) throw httpError(400, 'The end must be after the start.', 'VALIDATION_ERROR');
  if (v.replace && v.replace.end <= v.replace.start) throw httpError(400, 'The replaced scene must end after it starts.', 'VALIDATION_ERROR');
  await assertWorkspaceAssets(ws(ctx), [v.assetId], 'video');
  await assertWorkspaceAssets(ws(ctx), [v.introAssetId, v.outroAssetId].filter(Boolean), 'image');
  if (v.musicAssetId) await assertWorkspaceAssets(ws(ctx), [v.musicAssetId], 'audio');
  if (v.replace) await assertWorkspaceAssets(ws(ctx), [v.replace.assetId], 'video');
  if (!(v.start != null || v.end != null || v.subtitles.length || v.voiceOver || v.introAssetId || v.outroAssetId || v.musicAssetId || v.replace)) throw httpError(400, 'Choose at least one change.', 'VALIDATION_ERROR');
  const { row, created } = await begin(ctx, 'video_edit', { requestKey, input: { ...v, confirm: undefined }, confirm: v.confirm || !v.voiceOver });
  if (created) await enqueue(row);
  return present(row);
}

async function runVideoEdit(row) {
  const v = parse(row.input_json, {});
  const r = await editVideoFile(workerCtx(row), v.assetId, { start: v.start ?? null, end: v.end ?? null, cues: v.subtitles || [], voiceText: v.voiceOver || null, voiceMode: v.voiceMode,
    introAssetId: v.introAssetId, introSeconds: v.introSeconds, outroAssetId: v.outroAssetId, outroSeconds: v.outroSeconds, musicAssetId: v.musicAssetId, musicVolume: v.musicVolume,
    replace: v.replace || null, generationId: row.id });
  const a = await get('SELECT id, public_id FROM assets WHERE id = ?', [r.id]);
  return complete(row, { assets: [{ id: a.id, publicId: a.public_id, type: 'video', edited: true }], subtitlesMode: r.subtitlesMode, srt: r.srt }, { credits: v.voiceOver ? aiMedia.estimate('voice').credits : 0 });
}

module.exports = {
  generatePost, regeneratePostField, generatePoster, generateCarousel, generateVideo, editVideo,
  getGeneration, listGenerations, retry, usage, runJob, estimateOf, creditsThisMonth, PLATFORMS, FORMATS, STYLES, PURPOSES,
  begin, complete, fail, present, enqueue, replaceBackground, cancel, history, creditBalance, shareWithGroup, kick
};
