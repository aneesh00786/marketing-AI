const express = require('express');
const { z } = require('zod');
const { requireCapability } = require('../../../middleware/auth');
const { rateLimit } = require('../../../lib/rateLimit');
const aiMedia = require('../../../lib/aiMedia');
const brandKits = require('./brandKitService');
const gen = require('./generationService');

/**
 * AI Content Studio API: /api/v1/social/studio (signed-in members; the workspace always comes from
 * the session, never from the request body).
 *   GET  /capabilities                 what can be generated on this server (no keys)
 *   GET|POST /brand-kits, PUT|DELETE /brand-kits/:id
 *   POST /estimate                     credits (and USD when configured) before starting
 *   POST /ai/post | /ai/post-field | /ai/poster | /ai/carousel | /ai/video | /ai/video-edit
 *   GET  /generations, /generations/:id; POST /generations/:id/retry
 *   POST /media/:id/edited             an edited image (image editor export) as a new asset
 *   POST /music                        background music (MP3) for video editing
 *   GET  /usage                        this month's AI credits
 *   POST /ai/background                AI background replacement (new edited copy)
 *   GET  /campaigns/:id/overview       product campaign wizard: product, strategy, posts with previews, counts
 *   POST|PUT /campaigns/:id/strategy, POST /campaigns/:id/strategy/accept   AI strategy (draft ideas → draft posts)
 *   GET  /campaigns/:id/analytics      content funnel, real platform metrics, AI credits (no leads)
 *   POST /campaigns/:id/strategy/items/:ideaId/regenerate   one content item of the draft strategy again
 *   GET  /campaigns/:id/bulk/estimate, POST|GET /campaigns/:id/bulk, POST /campaigns/:id/bulk/cancel,
 *   POST /campaigns/:id/bulk/items/:itemId/retry            Generate All Content (estimate, start, progress)
 *   POST /generations/:id/cancel, GET /content/:id/generations   cancel a queued generation; a post's history
 * Every AI call takes requestKey (one per click): repeats return the same generation.
 */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  if (err.expose || (err.status && err.status < 500)) return res.status(err.status || 400).json({ success: false, code: err.code, error: err.message, details: err.details || undefined });
  next(err);
});
const id = req => {
  const v = parseInt(req.params.id, 10);
  if (!Number.isInteger(v) || v <= 0) throw Object.assign(new Error('Invalid id.'), { status: 400, expose: true });
  return v;
};
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: Number(process.env.STUDIO_AI_RATE_PER_MIN || 20), keyFn: req => `studio-ai:${req.auth?.workspaceId}`, message: 'Too many AI requests; wait a minute.' });
const key = req => ({ requestKey: req.body?.requestKey });

router.get('/capabilities', wrap(async (req, res) => res.json({ success: true, capabilities: aiMedia.capabilities(), platforms: gen.PLATFORMS, formats: gen.FORMATS, styles: gen.STYLES, purposes: gen.PURPOSES })));

router.get('/brand-kits', wrap(async (req, res) => res.json({ success: true, brandKits: await brandKits.list(req) })));
router.post('/brand-kits', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, brandKit: await brandKits.save(req, null, req.body) })));
router.put('/brand-kits/:id', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, brandKit: await brandKits.save(req, id(req), req.body) })));
router.delete('/brand-kits/:id', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, ...(await brandKits.remove(req, id(req))) })));

router.post('/estimate', requireCapability('content.create'), wrap(async (req, res) => {
  const v = z.object({ kind: z.enum(['text', 'plan', 'image', 'carousel', 'video', 'voice']), input: z.record(z.any()).optional().default({}) }).parse(req.body || {});
  const est = gen.estimateOf(v.kind, v.input);
  const used = await gen.creditsThisMonth(req.auth.workspaceId);
  res.json({ success: true, estimate: est, creditsUsedThisMonth: used });
}));

const ai = (path, fn, cap = 'content.create') => router.post(path, requireCapability(cap), aiLimiter, wrap(async (req, res) => {
  const generation = await fn(req, req.body || {}, key(req));
  res.status(generation.status === 'completed' ? 200 : 202).json({ success: true, generation });
}));
ai('/ai/post', gen.generatePost);
ai('/ai/post-field', gen.regeneratePostField);
ai('/ai/poster', gen.generatePoster);
ai('/ai/carousel', gen.generateCarousel);
ai('/ai/video', gen.generateVideo);
ai('/ai/video-edit', gen.editVideo);
ai('/ai/background', gen.replaceBackground);

// ---- Product campaign workflow (wizard) ----
const strategy = require('./strategyService');
const workflow = require('./campaignWorkflowService');
router.get('/campaigns/:id/overview', wrap(async (req, res) => res.json({ success: true, ...(await workflow.overview(req, id(req))) })));
router.post('/campaigns/:id/strategy', requireCapability('campaigns.manage'), aiLimiter, wrap(async (req, res) => res.json({ success: true, ...(await strategy.generate(req, id(req), { requestKey: req.body?.requestKey, instruction: String(req.body?.instruction || '') })) })));
router.put('/campaigns/:id/strategy', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, strategy: await strategy.update(req, id(req), req.body) })));
router.post('/campaigns/:id/strategy/accept', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, ...(await strategy.accept(req, id(req))) })));
const bulk = require('./bulkService');
const itemId = req => { const v = parseInt(req.params.itemId, 10); if (!Number.isInteger(v) || v <= 0) throw Object.assign(new Error('Invalid id.'), { status: 400, expose: true }); return v; };
router.post('/campaigns/:id/strategy/items/:ideaId/regenerate', requireCapability('campaigns.manage'), aiLimiter, wrap(async (req, res) => res.json({ success: true, ...(await strategy.regenerateIdea(req, id(req), String(req.params.ideaId).slice(0, 40), { requestKey: req.body?.requestKey, instruction: String(req.body?.instruction || '') })) })));
// Generate All Content
router.get('/campaigns/:id/bulk/estimate', requireCapability('content.create'), wrap(async (req, res) => res.json({ success: true, estimate: await bulk.estimate(req, id(req)) })));
router.post('/campaigns/:id/bulk', requireCapability('content.create'), wrap(async (req, res) => res.status(202).json({ success: true, ...(await bulk.start(req, id(req), { confirm: req.body?.confirm === true })) })));
router.get('/campaigns/:id/bulk', wrap(async (req, res) => res.json({ success: true, ...(await bulk.status(req, id(req))) })));
router.post('/campaigns/:id/bulk/cancel', requireCapability('content.create'), wrap(async (req, res) => res.json({ success: true, ...(await bulk.cancelRun(req, id(req), { itemId: req.body?.itemId ? Number(req.body.itemId) : null })) })));
router.post('/campaigns/:id/bulk/items/:itemId/retry', requireCapability('content.create'), aiLimiter, wrap(async (req, res) => res.json({ success: true, ...(await bulk.retryItem(req, id(req), itemId(req))) })));
router.post('/generations/:id/cancel', requireCapability('content.create'), wrap(async (req, res) => res.json({ success: true, generation: await gen.cancel(req, id(req)) })));
router.get('/content/:id/generations', wrap(async (req, res) => res.json({ success: true, history: await gen.history(req, id(req)) })));
router.get('/campaigns/:id/analytics', requireCapability('analytics.view'), wrap(async (req, res) => res.json({ success: true, analytics: await workflow.analytics(req, id(req)) })));

router.get('/generations', wrap(async (req, res) => res.json({ success: true, generations: await gen.listGenerations(req, req.query) })));
router.get('/generations/:id', wrap(async (req, res) => res.json({ success: true, generation: await gen.getGeneration(req, id(req)) })));
router.post('/generations/:id/retry', requireCapability('content.create'), aiLimiter, wrap(async (req, res) => res.status(202).json({ success: true, generation: await gen.retry(req, id(req)) })));

/** Image editor export: saved as a new "edited" asset; the original stays unchanged. */
router.post('/media/:id/edited', requireCapability('content.create'), wrap(async (req, res) => {
  const { get } = require('../../../db/database');
  const media = require('../mediaStore');
  const parent = await get("SELECT id, title, campaign_id FROM assets WHERE workspace_id = ? AND id = ? AND status = 'ready'", [req.auth.workspaceId, id(req)]);
  if (!parent) return res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'The original image was not found.' });
  const received = await media.receiveUpload(req, req.auth.workspaceId);
  if (received.probe.kind !== 'image') {
    await require('fs').promises.unlink(received.tmpPath).catch(() => {});
    return res.status(400).json({ success: false, code: 'INVALID_MEDIA', error: 'The edited file must be an image.' });
  }
  const assetId = await media.commitUpload(req, received, { title: String(req.query.title || `${parent.title || 'Image'} (edited)`).slice(0, 200), source: 'edited', parentAssetId: parent.id, campaignId: parent.campaign_id, extraMeta: { editedFrom: parent.id } });
  res.json({ success: true, ...(await require('../mediaLibraryService').detail(req.auth.workspaceId, assetId)) });
}));

/** Background music for videos (MP3 only; music cannot be attached to posts). */
router.post('/music', requireCapability('content.create'), wrap(async (req, res) => {
  const media = require('../mediaStore');
  const received = await media.receiveUpload(req, req.auth.workspaceId, { allowAudio: true });
  if (received.probe.kind !== 'audio') {
    await require('fs').promises.unlink(received.tmpPath).catch(() => {});
    return res.status(400).json({ success: false, code: 'INVALID_MEDIA', error: 'Upload the music as an MP3 file.' });
  }
  const name = String(req.query.filename || 'Music').slice(0, 200);
  const assetId = await media.commitUpload(req, received, { originalName: name, title: name });
  res.json({ success: true, ...(await require('../mediaLibraryService').detail(req.auth.workspaceId, assetId)) });
}));

router.get('/usage', requireCapability('content.create'), wrap(async (req, res) => res.json({ success: true, usage: await gen.usage(req) })));

module.exports = router;
