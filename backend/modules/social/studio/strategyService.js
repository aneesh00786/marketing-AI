const crypto = require('crypto');
const { z } = require('zod');
const { run, get } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const { generateStructured, untrusted } = require('../../../lib/aiStructured');
const { campaignContext, contextPrompt } = require('./campaignContext');

/**
 * AI Campaign Strategy (wizard). From the selected product's real facts and the campaign details the AI
 * writes a structured strategy — overview (theme, message, audience, unique selling points, approach),
 * content mix (how many posts, posters, videos, reels, carousels, stories), platform strategy, publishing
 * strategy (frequency, sequence, times) and marketing messages (headline, supporting and promotional
 * messages, CTAs, hashtags) — and a content plan: one item per planned piece with its description,
 * objective, type, platforms, day and time, image/video prompts, caption, hashtags, CTA and media format.
 * The strategy stays a draft in the campaign (editable: items edited, added, removed, reordered, one
 * regenerated, or the whole strategy regenerated). Approving it creates one draft post per item and
 * platform; no media is generated until "Generate All Content" (or an individual generation).
 */
const ws = ctx => ctx.auth.workspaceId;
const httpError = (status, message, code, details) => Object.assign(new Error(message), { status, code, expose: true, details });
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const FORMATS = ['poster', 'carousel', 'video', 'reel', 'post', 'story'];
const PLATFORMS = ['facebook', 'instagram', 'linkedin', 'youtube'];
const MEDIA_FORMATS = { poster: 'Image 1:1 or 4:5', carousel: 'Carousel 1:1 / 4:5 slides', video: 'Video 16:9 or 9:16', reel: 'Vertical video 9:16', post: 'Text (with an image if any)', story: 'Vertical image 9:16' };

const ideaSchema = z.object({
  id: z.string().max(40).optional(),
  day: z.number().int().min(1).max(366),
  title: z.string().trim().min(1).max(200),
  idea: z.string().trim().max(2000).optional().default(''),            // content description
  objective: z.string().trim().max(300).optional().default(''),
  format: z.enum(FORMATS),
  platforms: z.array(z.enum(PLATFORMS)).min(1).max(4).optional(),
  platform: z.enum(PLATFORMS).optional(),                              // older strategies: one platform
  suggested_time: z.string().regex(/^\d{2}:\d{2}$/).optional().default('10:00'),
  image_prompt: z.string().trim().max(2000).optional().default(''),
  video_prompt: z.string().trim().max(2000).optional().default(''),
  media_prompt: z.string().trim().max(2000).optional().default(''),
  caption: z.string().trim().max(5000).optional().default(''),
  hashtags: z.array(z.string().max(100)).max(30).optional().default([]),
  cta: z.string().trim().max(200).optional().default(''),
  media_format: z.string().trim().max(100).optional().default('')
});
const count = z.number().int().min(0).max(100).optional().default(0);
const StrategySchema = z.object({
  overview: z.object({
    theme: z.string().max(300).optional().default(''), objective: z.string().max(300).optional().default(''),
    main_message: z.string().max(600).optional().default(''), target_audience: z.string().max(600).optional().default(''),
    unique_selling_points: z.array(z.string().max(300)).max(10).optional().default([]), approach: z.string().max(1500).optional().default('')
  }).optional().default({}),
  content_mix: z.object({ posts: count, posters: count, videos: count, reels: count, carousels: count, stories: count }).optional().default({}),
  platform_strategy: z.object({ facebook: z.string().max(800).optional(), instagram: z.string().max(800).optional(), linkedin: z.string().max(800).optional(), youtube: z.string().max(800).optional() }).optional().default({}),
  publishing: z.object({ frequency: z.string().max(400).optional().default(''), best_times: z.string().max(400).optional().default(''), sequence: z.string().max(1000).optional().default(''), notes: z.string().max(1000).optional().default('') }).optional().default({}),
  messages: z.object({
    headline: z.string().max(300).optional().default(''), supporting: z.array(z.string().max(300)).max(10).optional().default([]),
    promotional: z.array(z.string().max(300)).max(10).optional().default([]), ctas: z.array(z.string().max(200)).max(10).optional().default([]),
    hashtags: z.array(z.string().max(100)).max(30).optional().default([])
  }).optional().default({}),
  strategy: z.string().max(4000).optional().default(''),
  ideas: z.array(ideaSchema).min(1).max(90)
});

// ---------- Tolerant reading of the model's reply ----------
// Smaller models vary the shape slightly ("Poster", "Instagram", "9:00 AM", "day": "3", "#launch",
// hashtags as one string, a description under "description"). These are tidied before validation,
// and a single unusable content item is dropped instead of failing the whole strategy.
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function str(v, max) {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) v = v.map(x => (isObj(x) ? Object.values(x).join(' ') : x)).join(', ');
  else if (isObj(v)) v = Object.values(v).map(x => (typeof x === 'object' ? JSON.stringify(x) : x)).join(' ');
  return String(v).trim().slice(0, max);
}
function list(v, max, itemMax) {
  if (typeof v === 'string') v = v.split(/[,\n;]+/);
  if (!Array.isArray(v)) return undefined;
  return v.map(x => str(x, itemMax)).filter(Boolean).slice(0, max);
}
const tags = (v, max = 30) => list(typeof v === 'string' ? v.replace(/\s+(?=#)/g, ',') : v, max, 100)?.map(t => t.replace(/^#+/, '').replace(/\s+/g, '')).filter(Boolean);
function int(v, min, max) {
  const n = typeof v === 'number' ? Math.round(v) : parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}
function time(v) {
  const m = String(v ?? '').trim().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i);
  if (!m) return undefined;
  let h = Number(m[1]); const min = Number(m[2] || 0); const ap = (m[3] || '').toLowerCase()[0];
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  return h <= 23 && min <= 59 ? `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` : undefined;
}
function format(v) {
  const f = String(v ?? '').toLowerCase().trim();
  if (FORMATS.includes(f)) return f;
  if (/carousel|slide|album/.test(f)) return 'carousel';
  if (/reel|short|tiktok|vertical video/.test(f)) return 'reel';
  if (/stor(y|ies)/.test(f)) return 'story';
  if (/video|clip|demo|tutorial/.test(f)) return 'video';
  if (/poster|image|graphic|photo|picture|infographic|banner|visual|static/.test(f)) return 'poster';
  if (/post|text|article|link|update|thread|caption/.test(f)) return 'post';
  return undefined;
}
function platformList(v) {
  const raw = typeof v === 'string' ? v.split(/[,/&+]|\band\b/i) : Array.isArray(v) ? v : [];
  const out = raw.map(x => String(x || '').toLowerCase().trim()).map(x =>
    /^(fb|facebook)/.test(x) ? 'facebook' : /^(ig|insta)/.test(x) ? 'instagram' : /^linked/.test(x) ? 'linkedin' : /^(yt|youtube)/.test(x) ? 'youtube' : x
  ).filter(x => PLATFORMS.includes(x));
  return out.length ? [...new Set(out)].slice(0, 4) : undefined;
}
function coerceIdea(i) {
  if (!isObj(i)) return i;
  const out = {
    id: i.id !== undefined ? str(i.id, 40) : undefined,
    day: int(i.day ?? i.day_number, 1, 366),
    title: str(i.title ?? i.name ?? i.headline, 200),
    idea: str(i.idea ?? i.description ?? i.content ?? i.concept, 2000),
    objective: str(i.objective ?? i.goal, 300),
    format: format(i.format ?? i.type ?? i.content_type),
    platforms: platformList(i.platforms ?? i.platform),
    suggested_time: time(i.suggested_time ?? i.time ?? i.post_time),
    image_prompt: str(i.image_prompt, 2000),
    video_prompt: str(i.video_prompt ?? i.script, 2000),
    media_prompt: str(i.media_prompt, 2000),
    caption: str(i.caption ?? i.copy, 5000),
    hashtags: tags(i.hashtags),
    cta: str(i.cta ?? i.call_to_action, 200),
    media_format: str(i.media_format, 100)
  };
  if (!out.title && out.idea) out.title = out.idea.slice(0, 80);
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== ''));
}
function coerceStrategy(raw) {
  let d = isObj(raw) ? raw : {};
  // Some models wrap everything in a "strategy" object.
  if (!Array.isArray(d.ideas) && isObj(d.strategy)) d = { ...d, ...d.strategy, strategy: d.strategy.strategy ?? d.strategy.summary };
  const ideasRaw = d.ideas ?? d.content_plan ?? d.plan ?? d.calendar ?? d.content_calendar ?? d.posts ?? [];
  let ideas = (Array.isArray(ideasRaw) ? ideasRaw : []).map(coerceIdea);
  const valid = ideas.filter(i => ideaSchema.safeParse(i).success);
  if (valid.length) ideas = valid.slice(0, 90);
  const o = isObj(d.overview) ? d.overview : {};
  const mix = isObj(d.content_mix) ? d.content_mix : {};
  const ps = isObj(d.platform_strategy) ? d.platform_strategy : {};
  const pub = isObj(d.publishing) ? d.publishing : {};
  const m = isObj(d.messages) ? d.messages : {};
  const clean = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
  return {
    overview: clean({ theme: str(o.theme, 300), objective: str(o.objective, 300), main_message: str(o.main_message, 600), target_audience: str(o.target_audience, 600),
      unique_selling_points: list(o.unique_selling_points, 10, 300), approach: str(o.approach, 1500) }),
    content_mix: clean(Object.fromEntries(['posts', 'posters', 'videos', 'reels', 'carousels', 'stories'].map(k => [k, int(mix[k], 0, 100)]))),
    platform_strategy: clean(Object.fromEntries(PLATFORMS.map(k => [k, str(ps[k] ?? ps[k[0].toUpperCase() + k.slice(1)], 800)]))),
    publishing: clean({ frequency: str(pub.frequency, 400), best_times: str(pub.best_times, 400), sequence: str(pub.sequence, 1000), notes: str(pub.notes, 1000) }),
    messages: clean({ headline: str(m.headline, 300), supporting: list(m.supporting, 10, 300), promotional: list(m.promotional, 10, 300), ctas: list(m.ctas, 10, 200), hashtags: tags(m.hashtags) }),
    strategy: str(typeof d.strategy === 'string' ? d.strategy : d.summary, 4000),
    ideas
  };
}

const newId = () => crypto.randomBytes(6).toString('hex');
const campaignDays = c => {
  const s = c.start_date ? new Date(c.start_date) : null; const e = c.end_date ? new Date(c.end_date) : null;
  return s && e && !isNaN(s) && !isNaN(e) ? Math.max(1, Math.min(90, Math.round((e - s) / 86400000) + 1)) : 7;
};
/** One shape for an item (several platforms; prompts and media format filled in). */
function normalize(i, platforms) {
  const p = (i.platforms && i.platforms.length ? i.platforms : [i.platform]).filter(x => platforms.includes(x));
  return {
    ...i, id: i.id || newId(), platforms: [...new Set(p.length ? p : [platforms[0]])], platform: undefined,
    image_prompt: i.image_prompt || (['poster', 'carousel', 'story', 'post'].includes(i.format) ? i.media_prompt || '' : ''),
    video_prompt: i.video_prompt || (['video', 'reel'].includes(i.format) ? i.media_prompt || '' : ''),
    media_format: i.media_format || MEDIA_FORMATS[i.format]
  };
}
function legacy(strategy) {
  // Older strategies kept their summary fields at the top level.
  return strategy ? { ...strategy, overview: strategy.overview || { theme: strategy.theme || '', main_message: strategy.main_message || '' }, messages: strategy.messages || { hashtags: strategy.hashtags || [], ctas: strategy.cta_suggestions || [] } } : strategy;
}

async function requireCampaign(ctx, id) {
  const row = await get('SELECT * FROM campaigns WHERE workspace_id = ? AND id = ?', [ws(ctx), id]);
  if (!row) throw httpError(404, 'Campaign not found.', 'NOT_FOUND');
  return row;
}

function strategyPrompt(info, row, platforms, n, instruction) {
  return `${contextPrompt(info, untrusted)}\n\nCampaign length: ${n} days, from ${row.start_date ? new Date(row.start_date).toISOString().slice(0, 10) : 'tomorrow'}. Platforms: ${platforms.join(', ')}. Objective: ${row.objective || 'not given'}. Tone: ${row.tone || 'not given'}.` +
    `${info.productImageIds.length ? ` The product has ${info.productImageIds.length} image(s) that posters and videos can show.` : ' The product has no images: designs must not depend on a product photo.'}` +
    `${instruction ? `\nExtra direction: ${untrusted('user_direction', instruction, 500)}` : ''}\n` +
    'Write a structured campaign strategy:\n' +
    '- overview: theme, objective, main_message, target_audience, unique_selling_points (only from the facts), approach;\n' +
    '- content_mix: how many posts, posters, videos, reels, carousels and stories (matching the items below);\n' +
    `- platform_strategy: a recommendation for each of ${platforms.join(', ')};\n` +
    '- publishing: frequency, best_times, sequence (the order of the story the campaign tells), notes;\n' +
    '- messages: headline, supporting, promotional (no invented discounts or prices), ctas, hashtags (without #);\n' +
    `- ideas: the content plan, day by day (day 1..${n}), each with title, idea (what it shows and says), objective, format (${FORMATS.join(', ')}), ` +
    `platforms (one or more of ${platforms.join(', ')}), suggested_time (HH:MM local), image_prompt (posters, carousels, stories, posts), video_prompt (videos and reels), caption, hashtags, cta, media_format.\n` +
    'Return JSON {"overview":{...},"content_mix":{...},"platform_strategy":{...},"publishing":{...},"messages":{...},"strategy":"one-paragraph summary","ideas":[...]}.\n' +
    `Format rules: "day" is a whole number; "format" is exactly one of ${FORMATS.join(', ')} (lowercase); "platforms" is an array of lowercase names; ` +
    '"suggested_time" is 24-hour "HH:MM"; hashtags are arrays of words without #; every text value is a plain string. Keep each text short.';
}

/** Generates (or regenerates) the strategy. An approved strategy is not replaced. */
async function generate(ctx, campaignId, { requestKey, instruction = '' } = {}) {
  const row = await requireCampaign(ctx, campaignId);
  const current = parse(row.strategy_json, null);
  if (current?.status === 'accepted') throw httpError(409, 'This strategy was approved and its posts were created. Edit the posts instead.', 'INVALID_STATE');
  if (!row.product_id) throw httpError(400, 'Select a product for this campaign first.', 'VALIDATION_ERROR');
  const platforms = parse(row.platforms_json, []).filter(p => PLATFORMS.includes(p));
  if (!platforms.length) throw httpError(400, 'Choose at least one target platform in the campaign details.', 'VALIDATION_ERROR');
  const info = await campaignContext(ws(ctx), campaignId);
  const gen = require('./generationService');
  const { row: g, created } = await gen.begin(ctx, 'plan', { requestKey, input: { campaignId, instruction }, purpose: 'strategy', campaignId, productId: row.product_id });
  if (!created) return { generation: gen.present(g), strategy: legacy(parse((await requireCampaign(ctx, campaignId)).strategy_json, null)) };
  const n = campaignDays(row);
  try {
    const { data, provider } = await generateStructured({
      workspaceId: ws(ctx), schema: StrategySchema, coerce: coerceStrategy, referenceType: 'social_generation', referenceId: g.id, maxTokens: 9000,
      system: 'You are a senior social media strategist for product marketing. Plan a campaign around the selected product using only its real facts.',
      prompt: strategyPrompt(info, row, platforms, n, instruction)
    });
    const { unverifiedClaims } = require('../campaignService');
    const ideas = data.ideas.filter(i => i.day <= n && [...(i.platforms || []), ...(i.platform ? [i.platform] : [])].some(p => platforms.includes(p)))
      .map(i => normalize(i, platforms)).sort((a, b) => a.day - b.day);
    const flags = unverifiedClaims(JSON.stringify({ ...data, ideas }), info.factsText);
    const strategy = { ...data, ideas, status: 'draft', generatedAt: new Date().toISOString(), provider, generationId: g.id, days: n,
      unverifiedClaims: flags, missingInformation: info.missing, hashtags: data.messages?.hashtags || [] };
    await run('UPDATE campaigns SET strategy_json = ?, wizard_step = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?', [JSON.stringify(strategy), 'strategy', ws(ctx), campaignId]);
    const done = await gen.complete(g, { campaignId, ideas: ideas.length }, { provider, model: provider });
    await audit(ctx, 'social.campaign.strategy_generated', { resourceType: 'campaign', resourceId: campaignId, metadata: { ideas: ideas.length, flags: flags.length } });
    return { generation: gen.present(done), strategy };
  } catch (err) { await gen.fail(g, err); throw err; }
}

/** Regenerates one content item of the draft strategy (the others stay as they are). */
async function regenerateIdea(ctx, campaignId, ideaId, { requestKey, instruction = '' } = {}) {
  const row = await requireCampaign(ctx, campaignId);
  const current = parse(row.strategy_json, null);
  if (!current) throw httpError(404, 'Generate a strategy first.', 'NOT_FOUND');
  if (current.status === 'accepted') throw httpError(409, 'This strategy was approved; edit its posts instead.', 'INVALID_STATE');
  const idx = (current.ideas || []).findIndex(i => i.id === ideaId);
  if (idx < 0) throw httpError(404, 'Content item not found in this strategy.', 'NOT_FOUND');
  const platforms = parse(row.platforms_json, []).filter(p => PLATFORMS.includes(p));
  const info = await campaignContext(ws(ctx), campaignId);
  const gen = require('./generationService');
  const { row: g, created } = await gen.begin(ctx, 'plan', { requestKey, input: { campaignId, ideaId, instruction }, purpose: 'strategy_item', campaignId, productId: row.product_id });
  if (!created) return { generation: gen.present(g), strategy: parse((await requireCampaign(ctx, campaignId)).strategy_json, null) };
  try {
    const old = current.ideas[idx];
    const { data, provider } = await generateStructured({
      workspaceId: ws(ctx), schema: z.object({ idea: ideaSchema }), coerce: r => ({ idea: coerceIdea(isObj(r?.idea) ? r.idea : r) }), referenceType: 'social_generation', referenceId: g.id, maxTokens: 2500,
      system: 'You are a senior social media strategist. Replace one item of a campaign plan, using only the product\'s real facts.',
      prompt: `${contextPrompt(info, untrusted)}\n\n${untrusted('campaign_plan', JSON.stringify(current.ideas.map(i => ({ day: i.day, title: i.title, format: i.format }))), 4000)}\n` +
        `Write a new, different content item for day ${old.day} to replace "${untrusted('old_title', old.title, 200)}"${instruction ? ` (${untrusted('user_direction', instruction, 300)})` : ''}. ` +
        `Same fields as the plan items: title, idea, objective, format, platforms (of ${platforms.join(', ')}), suggested_time, image_prompt, video_prompt, caption, hashtags, cta, media_format. Return JSON {"idea":{...}}.`
    });
    const item = normalize({ ...data.idea, day: old.day, id: old.id }, platforms);
    const ideas = current.ideas.map((i, k) => (k === idx ? item : i));
    const next = { ...current, ideas, editedAt: new Date().toISOString() };
    await run('UPDATE campaigns SET strategy_json = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?', [JSON.stringify(next), ws(ctx), campaignId]);
    const done = await gen.complete(g, { campaignId, ideaId }, { provider, model: provider });
    return { generation: gen.present(done), strategy: next };
  } catch (err) { await gen.fail(g, err); throw err; }
}

const editSchema = z.object({
  strategy: z.string().max(4000).optional(),
  overview: z.record(z.any()).optional(),
  messages: z.record(z.any()).optional(),
  publishing: z.record(z.any()).optional(),
  platform_strategy: z.record(z.any()).optional(),
  content_mix: z.record(z.any()).optional(),
  hashtags: z.array(z.string().max(100)).max(30).optional(),
  // Older clients
  theme: z.string().max(300).optional(), main_message: z.string().max(600).optional(), cta_suggestions: z.array(z.string().max(200)).max(10).optional(),
  ideas: z.array(ideaSchema).max(90).optional()
}).strict();

/** Edits the draft strategy: texts and the content items (edit, add, remove, reorder — the array order). */
async function update(ctx, campaignId, input) {
  const row = await requireCampaign(ctx, campaignId);
  const current = parse(row.strategy_json, null);
  if (!current) throw httpError(404, 'Generate a strategy first.', 'NOT_FOUND');
  if (current.status === 'accepted') throw httpError(409, 'This strategy was approved; edit its posts instead.', 'INVALID_STATE');
  const v = editSchema.parse(input || {});
  const platforms = parse(row.platforms_json, []).filter(p => PLATFORMS.includes(p));
  if (v.ideas && v.ideas.some(i => [...(i.platforms || []), ...(i.platform ? [i.platform] : [])].some(p => !platforms.includes(p)))) {
    throw httpError(400, 'Content items can only use the campaign\'s platforms.', 'VALIDATION_ERROR');
  }
  const next = { ...current, ...v, ideas: (v.ideas || current.ideas).map(i => normalize(i, platforms)), editedAt: new Date().toISOString() };
  if (v.messages?.hashtags) next.hashtags = v.messages.hashtags;
  await run('UPDATE campaigns SET strategy_json = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?', [JSON.stringify(next), ws(ctx), campaignId]);
  return next;
}

/**
 * Approves the strategy: one draft post per content item and platform (the platforms of one item share a
 * post group), with its day and time, caption, hashtags, CTA, prompts and media format. Once only.
 */
async function accept(ctx, campaignId) {
  const row = await requireCampaign(ctx, campaignId);
  const current = parse(row.strategy_json, null);
  if (!current) throw httpError(404, 'Generate a strategy first.', 'NOT_FOUND');
  if (current.status === 'accepted') return { strategy: current, contentIds: current.contentIds || [], alreadyAccepted: true };
  if (!current.ideas?.length) throw httpError(400, 'Add at least one content item.', 'VALIDATION_ERROR');
  const claimed = { ...current, status: 'accepting' };
  const claim = await run("UPDATE campaigns SET strategy_json = ? WHERE workspace_id = ? AND id = ? AND JSON_UNQUOTE(JSON_EXTRACT(strategy_json, '$.status')) = 'draft'", [JSON.stringify(claimed), ws(ctx), campaignId]);
  if (!claim.changes) throw httpError(409, 'The strategy is being approved already.', 'IN_PROGRESS');
  try {
    const contentService = require('../contentService');
    const settings = await require('../settingsService').getSettings(ws(ctx));
    const { zonedLocalToUtc, toDbDateTime } = require('../../../lib/time');
    const platforms = parse(row.platforms_json, []).filter(p => PLATFORMS.includes(p));
    const start = row.start_date ? new Date(row.start_date).toISOString().slice(0, 10) : new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const hashtags = current.messages?.hashtags || current.hashtags || [];
    const contentIds = [];
    for (const raw of current.ideas) {
      const idea = normalize(raw, platforms);
      const d = new Date(`${start}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + idea.day - 1);
      let suggested = null;
      try { suggested = toDbDateTime(zonedLocalToUtc(`${d.toISOString().slice(0, 10)}T${idea.suggested_time || '10:00'}`, settings.timezone)); } catch { suggested = null; }
      const group = `s${campaignId}-${idea.id}`;
      for (const platform of idea.platforms) {
        const item = await contentService.createContent(ctx, {
          campaignId, platformKey: platform, title: idea.title, caption: idea.caption || idea.idea || idea.title,
          hashtags: idea.hashtags?.length ? idea.hashtags : hashtags, callToAction: idea.cta || row.call_to_action || null, linkUrl: row.landing_url || null,
          imagePrompt: idea.image_prompt || null, videoScript: idea.video_prompt || null, suggestedPublishAt: suggested, source: 'ai_strategy',
          format: idea.format, planDay: idea.day, mediaPrompt: idea.image_prompt || idea.video_prompt || null, postGroupId: group,
          assumptions: (current.unverifiedClaims || []).length ? [`Verify before approval — not found in the product facts: ${current.unverifiedClaims.join(', ')}`] : undefined
        });
        contentIds.push(item.id);
      }
    }
    const done = { ...current, status: 'accepted', acceptedAt: new Date().toISOString(), contentIds };
    await run("UPDATE campaigns SET strategy_json = ?, wizard_step = 'content', status = IF(status = 'Draft', 'Active', status), updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?", [JSON.stringify(done), ws(ctx), campaignId]);
    await audit(ctx, 'social.campaign.strategy_accepted', { resourceType: 'campaign', resourceId: campaignId, metadata: { posts: contentIds.length } });
    return { strategy: done, contentIds };
  } catch (err) {
    await run('UPDATE campaigns SET strategy_json = ? WHERE workspace_id = ? AND id = ?', [JSON.stringify(current), ws(ctx), campaignId]);
    throw err;
  }
}

module.exports = {
  coerceStrategy, generate, regenerateIdea, update, accept, StrategySchema, FORMATS, MEDIA_FORMATS };
