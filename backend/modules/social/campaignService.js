const { z } = require('zod');
const { run, get, all } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { generateStructured, untrusted } = require('../../lib/aiStructured');
const { zonedLocalToUtc, toDbDateTime } = require('../../lib/time');
const contentService = require('./contentService');
const settingsService = require('./settingsService');
const jobsService = require('./jobsService');

const { httpError } = contentService;
const MAX_POSTS = 20;

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

function dateOnly(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function present(row, counts = null) {
  return {
    id: row.id,
    name: row.name,
    objective: row.objective,
    productId: row.product_id,
    targetAudience: row.target_audience,
    offer: row.offer,
    keyMessage: row.key_message,
    startDate: dateOnly(row.start_date),
    endDate: dateOnly(row.end_date),
    platforms: parseJson(row.platforms_json, []),
    accountIds: parseJson(row.account_ids_json, []),
    tone: row.tone,
    language: row.language,
    desiredPostCount: row.desired_post_count,
    imageRequirements: row.image_requirements,
    videoRequirements: row.video_requirements,
    callToAction: row.call_to_action,
    landingUrl: row.landing_url,
    brief: parseJson(row.brief_json, null),
    assumptions: parseJson(row.assumptions_json, []),
    generationStatus: row.generation_status,
    generationError: row.generation_error,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contentCounts: counts || undefined
  };
}

async function contentCounts(workspaceId, campaignIds) {
  if (campaignIds.length === 0) return {};
  const rows = await all(
    `SELECT campaign_id, status, COUNT(*) AS c FROM content_items WHERE workspace_id = ? AND campaign_id IN (${campaignIds.map(() => '?').join(',')}) GROUP BY campaign_id, status`,
    [workspaceId, ...campaignIds]
  );
  const out = {};
  for (const r of rows) {
    out[r.campaign_id] = out[r.campaign_id] || {};
    out[r.campaign_id][r.status] = Number(r.c);
  }
  return out;
}

async function listCampaigns(workspaceId) {
  const rows = await all('SELECT * FROM campaigns WHERE workspace_id = ? ORDER BY id DESC LIMIT 200', [workspaceId]);
  const counts = await contentCounts(workspaceId, rows.map(r => r.id));
  return rows.map(r => present(r, counts[r.id] || {}));
}

async function requireRow(workspaceId, id) {
  const row = await get('SELECT * FROM campaigns WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
  if (!row) throw httpError(404, 'Campaign not found.', 'NOT_FOUND');
  return row;
}

async function getCampaign(workspaceId, id) {
  const row = await requireRow(workspaceId, id);
  const counts = await contentCounts(workspaceId, [row.id]);
  const content = await contentService.listContent(workspaceId, { campaignId: row.id, limit: 200 });
  const job = await get(
    "SELECT id, status, last_error, created_at, completed_at FROM background_jobs WHERE workspace_id = ? AND job_type = 'generate_campaign' AND JSON_VALUE(payload_json, '$.campaignId') = ? ORDER BY id DESC LIMIT 1",
    [workspaceId, String(row.id)]
  ).catch(() => null);
  return { campaign: present(row, counts[row.id] || {}), content: content.items, generationJob: job };
}

async function assertRefs(workspaceId, input) {
  if (input.productId) {
    const p = await get('SELECT id FROM digital_products WHERE workspace_id = ? AND id = ?', [workspaceId, input.productId]);
    if (!p) throw httpError(400, 'Product not found in this workspace.');
  }
  if (input.accountIds && input.accountIds.length) {
    const rows = await all(
      `SELECT id FROM social_accounts WHERE workspace_id = ? AND id IN (${input.accountIds.map(() => '?').join(',')})`,
      [workspaceId, ...input.accountIds]
    );
    if (rows.length !== new Set(input.accountIds).size) throw httpError(400, 'One or more selected accounts do not belong to this workspace.');
  }
  if (input.startDate && input.endDate && input.endDate < input.startDate) throw httpError(400, 'End date must be on or after the start date.');
}

const COLUMN_MAP = {
  name: 'name', objective: 'objective', productId: 'product_id', targetAudience: 'target_audience',
  offer: 'offer', keyMessage: 'key_message', startDate: 'start_date', endDate: 'end_date',
  tone: 'tone', language: 'language', desiredPostCount: 'desired_post_count',
  imageRequirements: 'image_requirements', videoRequirements: 'video_requirements',
  callToAction: 'call_to_action', landingUrl: 'landing_url'
};

function toColumns(input) {
  const cols = {};
  for (const [k, col] of Object.entries(COLUMN_MAP)) if (input[k] !== undefined) cols[col] = input[k] === '' ? null : input[k];
  if (input.platforms !== undefined) {
    cols.platforms_json = JSON.stringify(input.platforms);
    cols.channels = input.platforms.join(', ');
  }
  if (input.accountIds !== undefined) cols.account_ids_json = JSON.stringify(input.accountIds);
  return cols;
}

async function createCampaign(ctx, input) {
  const workspaceId = ctx.auth.workspaceId;
  await assertRefs(workspaceId, input);
  const cols = { ...toColumns(input), workspace_id: workspaceId, status: 'Draft', source: 'social_hub', created_by: ctx.auth.userId, generation_status: 'not_started' };
  const names = Object.keys(cols);
  const ins = await run(
    `INSERT INTO campaigns (${names.join(', ')}, created_at, updated_at) VALUES (${names.map(() => '?').join(', ')}, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    Object.values(cols)
  );
  await audit(ctx, 'social.campaign.created', { resourceType: 'campaign', resourceId: ins.lastID, metadata: { name: input.name } });
  return present(await requireRow(workspaceId, ins.lastID), {});
}

async function updateCampaign(ctx, id, input) {
  const workspaceId = ctx.auth.workspaceId;
  const row = await requireRow(workspaceId, id);
  if (['queued', 'running'].includes(row.generation_status)) throw httpError(409, 'Wait for content generation to finish before editing the campaign.', 'INVALID_STATE');
  await assertRefs(workspaceId, { ...present(row), ...input });
  const cols = toColumns(input);
  if (input.status !== undefined) cols.status = input.status;
  const names = Object.keys(cols);
  if (names.length) {
    await run(
      `UPDATE campaigns SET ${names.map(n => `${n} = ?`).join(', ')}, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?`,
      [...Object.values(cols), workspaceId, id]
    );
    await audit(ctx, 'social.campaign.updated', { resourceType: 'campaign', resourceId: id, metadata: { fields: names } });
  }
  return present(await requireRow(workspaceId, id));
}

/** Saves the request, then queues generation so a crash or timeout cannot lose campaign data. */
async function requestGeneration(ctx, id) {
  const workspaceId = ctx.auth.workspaceId;
  const row = await requireRow(workspaceId, id);
  if (['queued', 'running'].includes(row.generation_status)) throw httpError(409, 'Generation is already in progress.', 'IN_PROGRESS');
  const platforms = parseJson(row.platforms_json, []);
  if (platforms.length === 0) throw httpError(400, 'Select at least one target platform.');
  if (!row.product_id && !row.key_message && !row.offer) {
    throw httpError(400, 'Add a product, key message or offer so content is grounded in real facts.');
  }
  const attempt = Date.now();
  const { job } = await jobsService.enqueue(workspaceId, 'generate_campaign', { campaignId: row.id }, {
    idempotencyKey: `generate_campaign:${row.id}:${attempt}`,
    createdBy: ctx.auth.userId,
    maxAttempts: 2
  });
  await run("UPDATE campaigns SET generation_status = 'queued', generation_error = NULL, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?", [workspaceId, id]);
  await audit(ctx, 'social.campaign.generation_requested', { resourceType: 'campaign', resourceId: id, metadata: { jobId: job.id } });
  return { jobId: job.id, status: 'queued' };
}

// ---------- Generation (worker) ----------

const PLATFORM_ENUM = z.enum(['facebook', 'instagram', 'linkedin', 'youtube', 'x']);
const GenerationSchema = z.object({
  brief: z.object({
    summary: z.string().min(1),
    target_audience: z.string().optional().default(''),
    key_messages: z.array(z.string()).optional().default([]),
    tone_guidance: z.string().optional().default(''),
    success_measures: z.array(z.string()).optional().default([])
  }),
  assumptions: z.array(z.string()).optional().default([]),
  missing_information: z.array(z.string()).optional().default([]),
  posts: z.array(z.object({
    slot: z.number().int().min(1).max(MAX_POSTS),
    variant_label: z.string().max(20).optional().default('A'),
    platform: PLATFORM_ENUM,
    title: z.string().max(200),
    headline: z.string().max(300).optional().default(''),
    caption: z.string().min(1).max(5000),
    hashtags: z.array(z.string()).max(30).optional().default([]),
    call_to_action: z.string().max(200).optional().default(''),
    image_prompt: z.string().max(2000).optional().default(''),
    video_script: z.string().max(5000).optional().default(''),
    suggested_day: z.number().int().min(0).max(365).optional().default(0),
    suggested_time: z.string().regex(/^\d{2}:\d{2}$/).optional().default('10:00')
  })).min(1).max(MAX_POSTS * 2)
});

async function loadFacts(workspaceId, campaign) {
  const facts = {};
  if (campaign.product_id) {
    const p = await get('SELECT name, url, tagline, description, features_json, target_audience FROM digital_products WHERE workspace_id = ? AND id = ?', [workspaceId, campaign.product_id]);
    if (p) {
      facts.product = {
        name: p.name,
        url: p.url,
        tagline: p.tagline,
        description: p.description,
        features: parseJson(p.features_json, []),
        target_audience: p.target_audience
      };
    }
  }
  const profile = await get('SELECT business_name, industry, website_url, description, brand_voice FROM business_profiles WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [workspaceId]);
  if (profile) facts.business = profile;
  return facts;
}

const PRICE_PATTERN = /(?:[$€£₹]|\b(?:usd|aed|inr|eur|gbp|aud)\b)\s?\d[\d,.]*|\d[\d,.]*\s?(?:\/\s?(?:mo|month|yr|year)|per (?:month|user|year))/gi;
const STAT_PATTERN = /\b\d{1,3}(?:\.\d+)?\s?%|\b\d+x\b/gi;

/** Flags prices and statistics that do not appear in the supplied facts so a human verifies them. */
function unverifiedClaims(text, factsText) {
  const flags = [];
  const haystack = factsText.toLowerCase();
  for (const pattern of [PRICE_PATTERN, STAT_PATTERN]) {
    for (const m of String(text).match(pattern) || []) {
      if (!haystack.includes(m.toLowerCase().replace(/\s+/g, ' ').trim())) flags.push(m.trim());
    }
  }
  return [...new Set(flags)];
}

function buildPrompt(campaign, facts) {
  const platforms = parseJson(campaign.platforms_json, []);
  const count = Math.min(Math.max(campaign.desired_post_count || platforms.length * 2, 1), MAX_POSTS);
  const brief = {
    name: campaign.name,
    objective: campaign.objective,
    target_audience: campaign.target_audience,
    offer: campaign.offer,
    key_message: campaign.key_message,
    call_to_action: campaign.call_to_action,
    landing_url: campaign.landing_url,
    start_date: dateOnly(campaign.start_date),
    end_date: dateOnly(campaign.end_date),
    tone: campaign.tone,
    language: campaign.language || 'en',
    image_requirements: campaign.image_requirements,
    video_requirements: campaign.video_requirements
  };
  const factsText = JSON.stringify({ brief, facts });
  const prompt = `Create a social media campaign as JSON.

CAMPAIGN BRIEF (written by the customer):
${JSON.stringify(brief, null, 2)}

BUSINESS AND PRODUCT FACTS (collected from the customer's records and website):
${untrusted('business_facts', JSON.stringify(facts, null, 2), 6000)}

REQUIREMENTS:
- Produce exactly ${count} post slots (slot 1..${count}) spread across these platforms: ${platforms.join(', ')}.
- For each slot write variant "A"; for up to 3 important slots also write an alternative variant "B" with a different hook.
- Platform rules: x captions under 280 characters including hashtags; instagram needs an image_prompt and at most 30 hashtags; linkedin under 3000 characters and professional; youtube posts are video concepts and must include video_script.
- suggested_day is the day offset from the campaign start date; suggested_time is local HH:MM.
- Write in language: ${brief.language}. Tone: ${brief.tone || 'professional'}.

STRICT FACT RULES:
- Use only facts present in the brief or the facts block. Never invent prices, discounts, statistics, percentages, customer names, testimonials, awards, audience demographics or performance results.
- If something useful is missing (e.g. pricing, proof points, offer details), do not make it up: list it in "missing_information".
- List any assumptions you made in "assumptions".

JSON SHAPE:
{"brief":{"summary":"","target_audience":"","key_messages":[""],"tone_guidance":"","success_measures":[""]},
 "assumptions":[""],"missing_information":[""],
 "posts":[{"slot":1,"variant_label":"A","platform":"linkedin","title":"","headline":"","caption":"","hashtags":["#tag"],"call_to_action":"","image_prompt":"","video_script":"","suggested_day":0,"suggested_time":"10:00"}]}`;
  return { prompt, factsText, platforms };
}

async function runGeneration(job) {
  const { campaignId } = JSON.parse(job.payload_json || '{}');
  const workspaceId = job.workspace_id;
  const campaign = await requireRow(workspaceId, campaignId);
  await run("UPDATE campaigns SET generation_status = 'running', updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?", [workspaceId, campaignId]);

  try {
    const facts = await loadFacts(workspaceId, campaign);
    const { prompt, factsText, platforms } = buildPrompt(campaign, facts);
    const { data, provider } = await generateStructured({
      workspaceId,
      prompt,
      system: 'You are a senior B2B social media strategist and copywriter. You never fabricate facts.',
      schema: GenerationSchema,
      referenceType: 'campaign',
      referenceId: campaignId,
      maxTokens: 4000
    });

    const settings = await settingsService.getSettings(workspaceId);
    const accountIds = parseJson(campaign.account_ids_json, []);
    const accounts = accountIds.length
      ? await all(`SELECT id, account_type FROM social_accounts WHERE workspace_id = ? AND id IN (${accountIds.map(() => '?').join(',')})`, [workspaceId, ...accountIds])
      : [];
    const { ACCOUNT_TYPES } = require('./capabilities');
    const accountForPlatform = (pk) => accounts.find(a => ACCOUNT_TYPES[a.account_type]?.platformKey === pk)?.id || null;

    const created = [];
    const startDate = dateOnly(campaign.start_date) || new Date().toISOString().slice(0, 10);
    const ctx = { auth: { workspaceId, userId: job.created_by, actorType: 'worker' } };
    for (const post of data.posts.filter(p => platforms.includes(p.platform))) {
      let suggested = null;
      try {
        const day = new Date(`${startDate}T00:00:00Z`);
        day.setUTCDate(day.getUTCDate() + post.suggested_day);
        suggested = toDbDateTime(zonedLocalToUtc(`${day.toISOString().slice(0, 10)}T${post.suggested_time}`, settings.timezone));
      } catch (e) { suggested = null; }

      const flags = unverifiedClaims(`${post.caption} ${post.headline} ${post.call_to_action}`, factsText);
      const assumptions = flags.length ? [`Verify before approval — not found in your facts: ${flags.join(', ')}`] : [];
      const item = await contentService.createContent(ctx, {
        campaignId,
        platformKey: post.platform,
        socialAccountId: accountForPlatform(post.platform),
        title: post.title || post.headline,
        caption: post.caption,
        hashtags: post.hashtags,
        callToAction: post.call_to_action || campaign.call_to_action,
        linkUrl: campaign.landing_url || null,
        imagePrompt: post.image_prompt || null,
        videoScript: post.video_script || null,
        variantGroup: `c${campaignId}-s${post.slot}`,
        variantLabel: post.variant_label,
        suggestedPublishAt: suggested,
        assumptions,
        source: 'ai_campaign'
      });
      created.push(item.id);
    }

    await run(
      `UPDATE campaigns SET brief_json = ?, assumptions_json = ?, generation_status = 'completed', generation_error = NULL, status = 'Active', updated_at = UTC_TIMESTAMP()
       WHERE workspace_id = ? AND id = ?`,
      [JSON.stringify({ ...data.brief, missing_information: data.missing_information, provider }), JSON.stringify(data.assumptions), workspaceId, campaignId]
    );
    await audit(ctx, 'social.campaign.generated', { resourceType: 'campaign', resourceId: campaignId, metadata: { provider, contentIds: created } });
    return { contentIds: created, provider };
  } catch (err) {
    await run(
      "UPDATE campaigns SET generation_status = 'failed', generation_error = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?",
      [String(err.message).slice(0, 2000), workspaceId, campaignId]
    );
    err.retryable = false;
    throw err;
  }
}

// ---------- Single-item regeneration ----------
const RegenSchema = z.object({
  title: z.string().max(200).optional(),
  caption: z.string().max(5000).optional(),
  hashtags: z.array(z.string()).max(30).optional(),
  call_to_action: z.string().max(200).optional(),
  image_prompt: z.string().max(2000).optional()
});

async function regenerateContent(ctx, contentId, { fields = ['caption'], instruction = '' }) {
  const workspaceId = ctx.auth.workspaceId;
  const row = await contentService.requireRow(workspaceId, contentId);
  const content = contentService.present(row);
  const campaign = row.campaign_id ? await get('SELECT * FROM campaigns WHERE workspace_id = ? AND id = ?', [workspaceId, row.campaign_id]) : null;
  const facts = campaign ? await loadFacts(workspaceId, campaign) : await loadFacts(workspaceId, {});
  const allowed = fields.filter(f => ['title', 'caption', 'hashtags', 'call_to_action', 'image_prompt'].includes(f));
  if (allowed.length === 0) throw httpError(400, 'Choose at least one field to regenerate.');

  const prompt = `Rewrite only these fields of a ${content.platformKey || 'social'} post: ${allowed.join(', ')}.
Current post: ${JSON.stringify({ title: content.title, caption: content.caption, hashtags: content.hashtags, call_to_action: content.callToAction, image_prompt: content.imagePrompt })}
Instruction from the user: ${String(instruction).slice(0, 500) || 'Improve clarity and engagement.'}
Facts you may use:
${untrusted('business_facts', JSON.stringify({ facts, offer: campaign?.offer, key_message: campaign?.key_message }), 4000)}
Never invent prices, statistics, testimonials or claims not in the facts. Return JSON with only the requested fields.`;
  const { data } = await generateStructured({
    workspaceId,
    prompt,
    system: 'You are a careful social media copywriter.',
    schema: RegenSchema,
    referenceType: 'content',
    referenceId: contentId,
    maxTokens: 1200
  });
  const update = { changeNote: `AI regenerated: ${allowed.join(', ')}` };
  if (allowed.includes('title') && data.title) update.title = data.title;
  if (allowed.includes('caption') && data.caption) update.caption = data.caption;
  if (allowed.includes('hashtags') && data.hashtags) update.hashtags = data.hashtags;
  if (allowed.includes('call_to_action') && data.call_to_action) update.callToAction = data.call_to_action;
  if (allowed.includes('image_prompt') && data.image_prompt) update.imagePrompt = data.image_prompt;
  return contentService.updateContent(ctx, contentId, update);
}

module.exports = {
  present,
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  requestGeneration,
  runGeneration,
  regenerateContent,
  unverifiedClaims,
  buildPrompt,
  GenerationSchema
};
