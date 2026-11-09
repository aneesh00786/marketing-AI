const { run, get, all } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const aiMedia = require('../../../lib/aiMedia');

/**
 * Generate All Content: after the strategy is approved, every planned item is generated with the existing
 * generators (posters, stories, videos, reels, carousels, platform posts) in one run.
 * - One unit per planned item (its posts on several platforms share one generation: media made once).
 * - Before starting: the estimate by type and in total against the credits available (the monthly limit
 *   minus charged and reserved credits); the user confirms. Running work reserves its credits; failed or
 *   canceled work is never charged; completed work is charged once (generationService).
 * - The run is a background job (studio_bulk) that keeps the workspace and campaign from the database; its
 *   progress is the generations of the run (batch_key) plus a per-item error list, all in the database, so
 *   leaving the page or refreshing changes nothing. Starting again while a run is active returns that run.
 * - Nothing is approved, scheduled or published by a run.
 */
const ws = ctx => ctx.auth.workspaceId;
const httpError = (status, message, code, details) => Object.assign(new Error(message), { status, code, expose: true, details });
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const TYPES = { poster: 'Posters', story: 'Stories', video: 'Videos', reel: 'Reels', carousel: 'Carousels', post: 'Social posts' };
const KIND = { poster: 'image', story: 'image', video: 'video', reel: 'video', carousel: 'carousel', post: 'text' };

async function requireCampaign(workspaceId, id) {
  const row = await get('SELECT * FROM campaigns WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
  if (!row) throw httpError(404, 'Campaign not found.', 'NOT_FOUND');
  return row;
}

/** The planned items still to generate: one unit per post group (or post), not yet published or scheduled. */
async function units(workspaceId, campaignId) {
  const items = await all(`SELECT id, title, format, platform_key, post_group_id, plan_day, status, media_asset_ids_json, carousel_json, image_prompt, video_script, media_prompt, caption_text, version
    FROM content_items WHERE workspace_id = ? AND campaign_id = ? AND format IS NOT NULL AND status IN ('draft', 'review', 'rejected', 'failed') ORDER BY COALESCE(plan_day, 999), id`, [workspaceId, campaignId]);
  const groups = new Map();
  for (const i of items) {
    const key = i.post_group_id || `item-${i.id}`;
    if (!groups.has(key)) groups.set(key, { key, itemId: i.id, title: i.title, format: i.format, day: i.plan_day, platforms: [], itemIds: [], item: i });
    const g = groups.get(key);
    g.platforms.push(i.platform_key); g.itemIds.push(i.id);
  }
  // Already made (media, carousel slides, or a completed AI text for a post): not generated again.
  const done = new Set((await all(`SELECT DISTINCT content_item_id AS id FROM social_content_generations WHERE workspace_id = ? AND campaign_id = ? AND status = 'completed' AND content_item_id IS NOT NULL`, [workspaceId, campaignId])).map(r => r.id));
  const hasContent = i => JSON.parse(i.media_asset_ids_json || '[]').length > 0 || (i.format === 'carousel' && i.carousel_json) || done.has(i.id);
  return [...groups.values()].filter(g => !g.itemIds.some(id => hasContent(items.find(i => i.id === id))));
}

function videoSetup(u) {
  const p = aiMedia.providerFor('video');
  const aspects = p?.capabilities.aspects || ['9:16'];
  const want = u.format === 'reel' ? '9:16' : (u.platforms.includes('youtube') ? '16:9' : '9:16');
  return { aspect: aspects.includes(want) ? want : aspects[0], durationSeconds: (p?.capabilities.durations || [5])[0] };
}
function imageAspect(u) {
  const p = aiMedia.providerFor('image');
  const aspects = p?.capabilities.aspects || ['1:1'];
  const want = u.format === 'story' ? '9:16' : u.platforms[0] === 'instagram' ? '4:5' : u.platforms[0] === 'youtube' ? '16:9' : '1:1';
  return aspects.includes(want) ? want : '1:1';
}

/** What generating a unit needs, and why it cannot run here (no provider for its type). */
function unitPlan(u, productImages) {
  const gen = require('./generationService');
  const kind = KIND[u.format];
  let reason = null; let est;
  if (kind === 'image' && !aiMedia.providerFor('image')) reason = aiMedia.capabilities().image.reason;
  if (kind === 'video' && !aiMedia.providerFor('video')) reason = aiMedia.capabilities().video.reason;
  if (kind === 'video' && !productImages && !aiMedia.providerFor('image')) reason = reason || 'The video provider needs a starting image: add product images to the campaign or set up an image provider.';
  if (kind === 'image') est = gen.estimateOf('image', { variations: 1 });
  else if (kind === 'video') est = gen.estimateOf('video', { durationSeconds: videoSetup(u).durationSeconds, imageAssetId: productImages ? 1 : null });
  else if (kind === 'carousel') est = gen.estimateOf('carousel', { withImages: !!aiMedia.providerFor('image'), slideCount: 5 });
  else est = gen.estimateOf('text', {});
  return { kind, reason, credits: est.credits, costUsd: est.costUsd, provider: est.provider };
}

/** The estimate shown before starting: by type, per item and in total, against the credits available. */
async function estimate(ctx, campaignId) {
  const row = await requireCampaign(ws(ctx), campaignId);
  const strategy = parse(row.strategy_json, null);
  if (strategy?.status !== 'accepted') throw httpError(409, 'Approve the strategy first: content is generated from the approved plan.', 'STRATEGY_NOT_APPROVED');
  const info = await require('./campaignContext').campaignContext(ws(ctx), campaignId);
  const list = (await units(ws(ctx), campaignId)).map(u => ({ ...u, item: undefined, ...unitPlan(u, info.productImageIds.length > 0) }));
  const runnable = list.filter(u => !u.reason);
  const byType = {};
  for (const u of runnable) { const t = (byType[u.format] = byType[u.format] || { type: u.format, label: TYPES[u.format], count: 0, credits: 0 }); t.count++; t.credits += u.credits; }
  const credits = runnable.reduce((n, u) => n + u.credits, 0);
  const priced = runnable.every(u => u.costUsd !== null && u.costUsd !== undefined);
  const balance = await require('./generationService').creditBalance(ws(ctx));
  return {
    campaign: { id: row.id, name: row.name }, items: list, byType: Object.values(byType), totalItems: runnable.length, skipped: list.filter(u => u.reason),
    credits, costUsd: runnable.length && priced ? Math.round(runnable.reduce((n, u) => n + u.costUsd, 0) * 10000) / 10000 : null,
    balance, enough: balance.available === null || credits <= balance.available, active: await activeRun(ws(ctx), row)
  };
}

/** The run in progress (a generation of it still queued/processing, or its job not finished). */
async function activeRun(workspaceId, row) {
  const bulk = parse(row.strategy_json, {})?.bulk;
  if (!bulk?.batchKey) return null;
  const pending = await get("SELECT COUNT(*) AS n FROM social_content_generations WHERE workspace_id = ? AND campaign_id = ? AND batch_key = ? AND status IN ('queued', 'processing')", [workspaceId, row.id, bulk.batchKey]);
  const job = await get("SELECT status FROM background_jobs WHERE workspace_id = ? AND job_type = 'studio_bulk' AND idempotency_key = ?", [workspaceId, `studio_bulk:${row.id}:${bulk.batchKey}`]);
  return Number(pending?.n) || ['queued', 'running'].includes(job?.status) ? bulk.batchKey : null;
}

async function saveBulk(workspaceId, campaignId, mutate) {
  const row = await requireCampaign(workspaceId, campaignId);
  const s = parse(row.strategy_json, {});
  s.bulk = mutate(s.bulk || {});
  await run('UPDATE campaigns SET strategy_json = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?', [JSON.stringify(s), workspaceId, campaignId]);
  return s.bulk;
}

/** Starts Generate All Content (confirmed estimate); a run already active is returned instead. */
async function start(ctx, campaignId, { confirm = false } = {}) {
  const est = await estimate(ctx, campaignId);
  if (est.active) return { batchKey: est.active, alreadyRunning: true };
  if (!est.totalItems) throw httpError(400, est.skipped.length ? `Nothing can be generated here: ${est.skipped[0].reason}` : 'Every planned item already has its content.', 'NOTHING_TO_GENERATE');
  if (!est.enough) throw httpError(402, `Generating all content needs about ${est.credits} credits, but ${est.balance.available} are available this month.`, 'CREDIT_LIMIT', { estimate: est });
  if (confirm !== true) throw httpError(409, `This uses about ${est.credits} AI credits. Confirm to start.`, 'CONFIRMATION_REQUIRED', { estimate: est });
  const batchKey = `bulk-${campaignId}-${Date.now()}`;
  await saveBulk(ws(ctx), campaignId, () => ({ batchKey, startedAt: new Date().toISOString(), startedBy: ctx.auth.userId || null, units: est.items.filter(u => !u.reason).map(u => ({ itemId: u.itemId, itemIds: u.itemIds, title: u.title, format: u.format, platforms: u.platforms, day: u.day, credits: u.credits })), errors: {}, canceled: false, estimatedCredits: est.credits }));
  const jobs = require('../jobsService');
  await jobs.enqueue(ws(ctx), 'studio_bulk', { campaignId, batchKey }, { idempotencyKey: `studio_bulk:${campaignId}:${batchKey}`, createdBy: ctx.auth.userId || null, maxAttempts: 1 });
  await audit(ctx, 'social.campaign.bulk_started', { resourceType: 'campaign', resourceId: campaignId, metadata: { items: est.totalItems, credits: est.credits } });
  kick(ws(ctx), campaignId, batchKey);
  return { batchKey, alreadyRunning: false };
}

/** Runs the run's job right away in the API process (the worker also picks it up). */
function kick(workspaceId, campaignId, batchKey) {
  if (process.env.STUDIO_INLINE === '0') return;
  setImmediate(async () => {
    const job = await get("SELECT * FROM background_jobs WHERE workspace_id = ? AND job_type = 'studio_bulk' AND idempotency_key = ? AND status = 'queued'", [workspaceId, `studio_bulk:${campaignId}:${batchKey}`]).catch(() => null);
    if (!job) return;
    const claim = await run("UPDATE background_jobs SET status = 'running', locked_by = 'api', locked_at = UTC_TIMESTAMP(), attempt_count = attempt_count + 1 WHERE id = ? AND status = 'queued'", [job.id]).catch(() => ({ changes: 0 }));
    if (!claim.changes) return;
    const jobs = require('../jobsService');
    try { await jobs.complete(job.id, await runJob(job)); } catch (err) { await jobs.fail({ ...job, max_attempts: 0 }, err).catch(() => null); }
  });
}

/** Starts one unit with the existing generator for its type (request key per run and item: never twice). */
async function startUnit(ctx, row, u, batchKey, attempt = '') {
  const gen = require('./generationService');
  const item = await get('SELECT * FROM content_items WHERE workspace_id = ? AND id = ?', [ws(ctx), u.itemId]);
  if (!item) throw httpError(404, 'The planned post was deleted.', 'NOT_FOUND');
  const key = `${batchKey}-${u.itemId}${attempt}`.slice(0, 80);
  const common = { campaignId: row.id, contentItemId: u.itemId, confirm: true, batchKey };
  const prompt = item.media_prompt || item.image_prompt || item.video_script || item.caption_text || item.title;
  if (u.format === 'poster' || u.format === 'story') {
    return gen.generatePoster(ctx, { ...common, campaignName: item.title || '', prompt: item.image_prompt || item.media_prompt || '', description: item.caption_text || '', purpose: u.format === 'story' ? 'story' : 'product_ad', aspect: imageAspect(u), variations: 1, language: row.language || 'English' }, { requestKey: key, batchKey });
  }
  if (u.format === 'video' || u.format === 'reel') {
    const v = videoSetup(u);
    return gen.generateVideo(ctx, { ...common, title: item.title || 'Campaign video', prompt: String(item.video_script || prompt).slice(0, 2000), kind: u.format === 'reel' ? 'reel' : 'promo', aspect: v.aspect, durationSeconds: v.durationSeconds }, { requestKey: key, batchKey });
  }
  if (u.format === 'carousel') {
    return gen.generateCarousel(ctx, { ...common, topic: String(item.media_prompt || item.title).slice(0, 500), platform: ['instagram', 'linkedin', 'facebook'].find(p => u.platforms.includes(p)) || 'instagram', slideCount: 5, withImages: !!aiMedia.providerFor('image') }, { requestKey: key, batchKey });
  }
  // A social post: one call writes it for every platform of the item; each platform's post gets its own text.
  const out = await gen.generatePost(ctx, { campaignId: row.id, platforms: u.platforms.filter(p => ['facebook', 'instagram', 'linkedin', 'youtube'].includes(p)), message: item.caption_text || item.title, objective: row.objective || '', language: row.language || 'English', tone: row.tone || '' }, { requestKey: key, batchKey, contentItemId: u.itemId });
  if (out.status === 'completed') {
    const contentService = require('../contentService');
    const siblings = await all(`SELECT id, platform_key FROM content_items WHERE workspace_id = ? AND id IN (${u.itemIds.map(() => '?').join(',')})`, [ws(ctx), ...u.itemIds]);
    for (const s of siblings) {
      const p = (out.output.posts || []).find(x => x.platform === s.platform_key);
      if (p) await contentService.updateContent(ctx, s.id, { caption: p.platform === 'youtube' && p.description ? p.description : p.caption, hashtags: p.hashtags || [], callToAction: p.call_to_action || null, changeNote: 'AI post written' });
    }
  }
  return out;
}

/** The run's job: starts each unit in turn (images and videos continue as their own background jobs). */
async function runJob(job) {
  const { campaignId, batchKey } = JSON.parse(job.payload_json || '{}');
  const row = await requireCampaign(job.workspace_id, campaignId);
  const bulk = parse(row.strategy_json, {})?.bulk;
  if (!bulk || bulk.batchKey !== batchKey) return { skipped: true };
  const ctx = { auth: { workspaceId: job.workspace_id, userId: bulk.startedBy || job.created_by || null, actorType: 'worker' } };
  let started = 0;
  for (const u of bulk.units || []) {
    const now = parse((await requireCampaign(job.workspace_id, campaignId)).strategy_json, {})?.bulk;
    if (now?.batchKey !== batchKey || now.canceled) break;
    if (now.skippedItems?.includes(u.itemId)) continue;
    const exists = await get('SELECT id FROM social_content_generations WHERE workspace_id = ? AND batch_key = ? AND content_item_id = ?', [job.workspace_id, batchKey, u.itemId]);
    if (exists) continue;
    try { await startUnit(ctx, row, u, batchKey); started++; } catch (err) {
      await saveBulk(job.workspace_id, campaignId, b => ({ ...b, errors: { ...(b.errors || {}), [u.itemId]: { message: String(err.message || 'Failed').slice(0, 300), code: err.code || null } } }));
    }
  }
  return { started };
}

/** Progress of the latest run: one row per unit with its generation status, and the counts. */
async function status(ctx, campaignId) {
  const row = await requireCampaign(ws(ctx), campaignId);
  const bulk = parse(row.strategy_json, {})?.bulk;
  if (!bulk?.batchKey) return { run: null, items: [], counts: { total: 0, completed: 0, processing: 0, queued: 0, failed: 0, canceled: 0 } };
  const gens = await all('SELECT * FROM social_content_generations WHERE workspace_id = ? AND campaign_id = ? AND batch_key = ? ORDER BY id', [ws(ctx), campaignId, bulk.batchKey]);
  const genPresent = require('./generationService').present;
  const byItem = new Map(gens.filter(g => g.content_item_id).map(g => [g.content_item_id, g]));
  const items = (bulk.units || []).map(u => {
    const g = byItem.get(u.itemId);
    const err = bulk.errors?.[u.itemId];
    let st = g ? g.status : err ? 'failed' : (bulk.canceled || bulk.skippedItems?.includes(u.itemId)) ? 'canceled' : 'queued';
    return { ...u, status: st, generationId: g?.id || null, error: g?.error || err?.message || null, credits: g?.credits === null || g?.credits === undefined ? null : Number(g.credits),
      estimatedCredits: u.credits, assets: g ? genPresent(g).assets : [] };
  });
  const counts = { total: items.length };
  for (const k of ['completed', 'processing', 'queued', 'failed', 'canceled']) counts[k] = items.filter(i => i.status === k).length;
  const active = await activeRun(ws(ctx), row);
  return {
    run: { batchKey: bulk.batchKey, startedAt: bulk.startedAt, canceled: !!bulk.canceled, active: !!active, estimatedCredits: bulk.estimatedCredits,
      charged: items.reduce((n, i) => n + (i.status === 'completed' ? (i.credits || 0) : 0), 0) },
    items, counts
  };
}

/** Cancels what has not started: queued generations and units not yet reached (never charged). */
async function cancelRun(ctx, campaignId, { itemId = null } = {}) {
  const row = await requireCampaign(ws(ctx), campaignId);
  const bulk = parse(row.strategy_json, {})?.bulk;
  if (!bulk?.batchKey) throw httpError(404, 'No generation run for this campaign.', 'NOT_FOUND');
  if (itemId) {
    const g = await get("SELECT id FROM social_content_generations WHERE workspace_id = ? AND batch_key = ? AND content_item_id = ? AND status = 'queued'", [ws(ctx), bulk.batchKey, itemId]);
    if (g) await require('./generationService').cancel(ctx, g.id);
    else await saveBulk(ws(ctx), campaignId, b => ({ ...b, skippedItems: [...new Set([...(b.skippedItems || []), itemId])] }));
  } else {
    await run("UPDATE social_content_generations SET status = 'canceled', error = 'Canceled', error_code = 'CANCELED', updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND batch_key = ? AND status = 'queued'", [ws(ctx), bulk.batchKey]);
    await saveBulk(ws(ctx), campaignId, b => ({ ...b, canceled: true }));
  }
  await audit(ctx, 'social.campaign.bulk_canceled', { resourceType: 'campaign', resourceId: campaignId, metadata: { itemId } });
  return status(ctx, campaignId);
}

/** Retries one failed unit of the run (the same generation row when it exists; charged only on success). */
async function retryItem(ctx, campaignId, itemId) {
  const row = await requireCampaign(ws(ctx), campaignId);
  const bulk = parse(row.strategy_json, {})?.bulk;
  const u = bulk?.units?.find(x => x.itemId === itemId);
  if (!u) throw httpError(404, 'This item is not part of the run.', 'NOT_FOUND');
  const g = await get('SELECT * FROM social_content_generations WHERE workspace_id = ? AND batch_key = ? AND content_item_id = ?', [ws(ctx), bulk.batchKey, itemId]);
  if (g) {
    if (g.status === 'failed' && ['image', 'video', 'carousel'].includes(g.kind)) await require('./generationService').retry(ctx, g.id);
    else if (g.status === 'failed' || g.status === 'canceled') {
      await run('UPDATE social_content_generations SET batch_key = NULL WHERE id = ?', [g.id]);   // a text item is written again
      await startUnit(ctx, row, u, bulk.batchKey, `-r${Date.now() % 100000}`);
    } else throw httpError(409, `This item is ${g.status}.`, 'INVALID_STATE');
  } else {
    await saveBulk(ws(ctx), campaignId, b => { const e = { ...(b.errors || {}) }; delete e[itemId]; return { ...b, errors: e, skippedItems: (b.skippedItems || []).filter(x => x !== itemId) }; });
    await startUnit(ctx, row, u, bulk.batchKey);
  }
  return status(ctx, campaignId);
}

module.exports = { estimate, start, status, cancelRun, retryItem, runJob, units, TYPES };
