const express = require('express');
const { z } = require('zod');
const crypto = require('crypto');
const { all, run, get } = require('../../db/database');
const { requireCapability } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');
const { rateLimit } = require('../../lib/rateLimit');
const websiteExtractor = require('../../services/websiteExtractor');
const { registrySnapshot, PROVIDERS } = require('./capabilities');
const oauthService = require('./oauthService');
const accountService = require('./accountService');
const contentService = require('./contentService');
const campaignService = require('./campaignService');
const publishingService = require('./publishingService');
const analyticsService = require('./analyticsService');
const inboxService = require('./inboxService');
const strategistService = require('./strategistService');
const settingsService = require('./settingsService');
const overviewService = require('./overviewService');
const dashboardService = require('./dashboardService');
const jobsService = require('./jobsService');
const meta = require('./providers/meta');
const providerAppService = require('./providerAppService');

const router = express.Router();

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ws = req => req.auth.workspaceId;
const idParam = (req, name = 'id') => {
  const v = parseInt(req.params[name], 10);
  if (!Number.isInteger(v) || v <= 0) {
    const err = new Error('Invalid id.');
    err.status = 400;
    throw err;
  }
  return v;
};

function body(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body || {});
    if (!result.success) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        error: result.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
      });
    }
    req.valid = result.data;
    next();
  };
}

const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, keyFn: req => `ai:${req.auth?.workspaceId}`, message: 'Too many AI requests; wait a minute.' });

// ---------------- Public: OAuth callbacks & webhooks ----------------

router.get('/oauth/:provider/callback', wrap(async (req, res) => {
  const target = await oauthService.handleCallback(req.params.provider, req.query);
  res.redirect(302, target);
}));

// Meta webhook verification handshake.
router.get('/webhooks/meta', (req, res) => {
  const token = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (token && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === token) {
    return res.status(200).send(String(req.query['hub.challenge'] || ''));
  }
  return res.status(403).send('Forbidden');
});

// Meta webhook events: signature-verified, de-duplicated, then turned into inbox sync jobs.
router.post('/webhooks/meta', wrap(async (req, res) => {
  const valid = meta.verifyWebhookSignature(req.rawBody, req.headers['x-hub-signature-256'], await providerAppService.allMetaSecrets());
  if (!valid) return res.status(401).json({ success: false, error: 'Invalid signature' });
  const eventKey = crypto.createHash('sha256').update(req.rawBody).digest('hex');
  const ins = await run(
    'INSERT IGNORE INTO provider_webhook_events (provider_key, event_key, signature_valid, payload_json, received_at) VALUES (?, ?, 1, ?, UTC_TIMESTAMP())',
    ['meta', eventKey, JSON.stringify(req.body).slice(0, 60000)]
  );
  if (ins.changes === 0) return res.status(200).json({ success: true, duplicate: true });

  const entryIds = [...new Set((req.body?.entry || []).map(e => String(e.id)).filter(Boolean))];
  if (entryIds.length) {
    const accounts = await all(
      `SELECT id, workspace_id FROM social_accounts WHERE provider_key = 'meta' AND status = 'connected' AND external_account_id IN (${entryIds.map(() => '?').join(',')})`,
      entryIds
    );
    const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
    for (const a of accounts) {
      await jobsService.enqueue(a.workspace_id, 'sync_inbox', { accountId: a.id }, { idempotencyKey: `webhook_inbox:${a.id}:${bucket}` });
    }
  }
  await run('UPDATE provider_webhook_events SET processed_at = UTC_TIMESTAMP() WHERE provider_key = ? AND event_key = ?', ['meta', eventKey]);
  res.status(200).json({ success: true });
}));

// ---------------- Authenticated routes ----------------
router.use((req, res, next) => {
  if (!req.auth) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
  next();
});

router.get('/overview', requireCapability('analytics.view'), wrap(async (req, res) => {
  res.json({ success: true, overview: await overviewService.getOverview(ws(req)) });
}));

// AI Marketing Command Center (workspace-scoped aggregate of stored data).
router.get('/dashboard', requireCapability('analytics.view'), wrap(async (req, res) => {
  const { range, from, to } = req.query;
  res.json({ success: true, dashboard: await dashboardService.getDashboard(ws(req), { range, from, to }) });
}));

router.get('/capabilities', wrap(async (req, res) => {
  res.json({ success: true, registry: registrySnapshot() });
}));

router.get('/providers', wrap(async (req, res) => {
  res.json({ success: true, providers: await Promise.all(Object.keys(PROVIDERS).map(k => oauthService.setupStatus(ws(req), k))) });
}));

// Per-workspace provider app credentials. The secret is write-only: it is never returned.
router.put('/provider-apps/:provider', requireCapability('integrations.manage'), body(z.object({
  clientId: z.string().min(1).max(255),
  clientSecret: z.string().max(500).optional().default('')
})), wrap(async (req, res) => {
  if (!PROVIDERS[req.params.provider]) return res.status(404).json({ success: false, error: 'Unknown provider' });
  const status = await providerAppService.saveApp(req, req.params.provider, req.valid);
  res.json({ success: true, status, provider: await oauthService.setupStatus(ws(req), req.params.provider) });
}));

router.delete('/provider-apps/:provider', requireCapability('integrations.manage'), wrap(async (req, res) => {
  if (!PROVIDERS[req.params.provider]) return res.status(404).json({ success: false, error: 'Unknown provider' });
  res.json({ success: true, ...(await providerAppService.removeApp(req, req.params.provider)) });
}));

router.get('/members', wrap(async (req, res) => {
  const rows = await all(
    "SELECT u.id, u.display_name, u.email, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.status = 'Active' ORDER BY u.display_name",
    [ws(req)]
  );
  const { capabilitiesForRole } = require('../../lib/permissions');
  res.json({ success: true, members: rows.map(r => ({ id: r.id, displayName: r.display_name, email: r.email, role: r.role, canApprove: capabilitiesForRole(r.role).has('content.approve') })) });
}));

// ---- Accounts ----
router.post('/oauth/:provider/start', requireCapability('integrations.manage'), wrap(async (req, res) => {
  res.json({ success: true, ...(await oauthService.startAuthorization(req, req.params.provider)) });
}));

router.get('/accounts', wrap(async (req, res) => {
  res.json({ success: true, accounts: await accountService.listAccounts(ws(req), { includeDisconnected: req.query.includeDisconnected === '1' }) });
}));

router.post('/accounts/:id/check', requireCapability('integrations.manage'), wrap(async (req, res) => {
  res.json({ success: true, ...(await accountService.checkAccountHealth(req, idParam(req))) });
}));

router.delete('/accounts/:id', requireCapability('integrations.manage'), wrap(async (req, res) => {
  res.json({ success: true, ...(await accountService.disconnectAccount(req, idParam(req))) });
}));

// ---- Products / facts for the campaign wizard ----
router.get('/products', wrap(async (req, res) => {
  const rows = await all('SELECT id, name, url, tagline, description, features_json, target_audience FROM digital_products WHERE workspace_id = ? ORDER BY name', [ws(req)]);
  res.json({ success: true, products: rows.map(p => ({ ...p, features: (() => { try { return JSON.parse(p.features_json || '[]'); } catch (e) { return []; } })(), features_json: undefined })) });
}));

router.post('/facts/extract', requireCapability('campaigns.manage'), aiLimiter, body(z.object({ url: z.string().min(4).max(500) })), wrap(async (req, res) => {
  try {
    const { product, fetched } = await websiteExtractor.extractFromUrl(req.valid.url);
    res.json({ success: true, fetched, facts: product, note: fetched ? 'Review these facts before saving them.' : 'The page could not be fetched; facts may be incomplete.' });
  } catch (err) {
    if (err.code === 'UNSAFE_URL') return res.status(400).json({ success: false, error: err.message, code: err.code });
    throw err;
  }
}));

router.post('/products', requireCapability('campaigns.manage'), body(z.object({
  name: z.string().min(1).max(255),
  url: z.string().url().max(255),
  tagline: z.string().max(255).optional().nullable(),
  description: z.string().max(5000).optional().nullable(),
  features: z.array(z.string().max(300)).max(30).optional().default([]),
  targetAudience: z.string().max(2000).optional().nullable()
})), wrap(async (req, res) => {
  const v = req.valid;
  const ins = await run(
    "INSERT INTO digital_products (workspace_id, name, url, tagline, description, features_json, target_audience, pricing_tiers_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'Active', UTC_TIMESTAMP())",
    [ws(req), v.name, v.url, v.tagline || null, v.description || null, JSON.stringify(v.features), v.targetAudience || null]
  );
  await audit(req, 'social.product.saved', { resourceType: 'product', resourceId: ins.lastID });
  res.json({ success: true, productId: ins.lastID });
}));

// ---- Campaigns ----
const campaignFields = {
  name: z.string().min(1).max(255),
  objective: z.string().max(255).optional().nullable(),
  productId: z.number().int().positive().optional().nullable(),
  targetAudience: z.string().max(2000).optional().nullable(),
  offer: z.string().max(2000).optional().nullable(),
  keyMessage: z.string().max(2000).optional().nullable(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  platforms: z.array(z.enum(contentService.PLATFORM_KEYS)).max(5).optional(),
  accountIds: z.array(z.number().int().positive()).max(20).optional(),
  tone: z.string().max(100).optional().nullable(),
  language: z.string().min(2).max(20).optional(),
  desiredPostCount: z.number().int().min(1).max(20).optional().nullable(),
  imageRequirements: z.string().max(2000).optional().nullable(),
  videoRequirements: z.string().max(2000).optional().nullable(),
  callToAction: z.string().max(255).optional().nullable(),
  landingUrl: z.string().url().max(500).optional().nullable().or(z.literal(''))
};

router.get('/campaigns', wrap(async (req, res) => {
  res.json({ success: true, campaigns: await campaignService.listCampaigns(ws(req)) });
}));

router.post('/campaigns', requireCapability('campaigns.manage'), body(z.object(campaignFields)), wrap(async (req, res) => {
  res.json({ success: true, campaign: await campaignService.createCampaign(req, req.valid) });
}));

router.get('/campaigns/:id', wrap(async (req, res) => {
  res.json({ success: true, ...(await campaignService.getCampaign(ws(req), idParam(req))) });
}));

router.patch('/campaigns/:id', requireCapability('campaigns.manage'), body(z.object({
  ...Object.fromEntries(Object.entries(campaignFields).map(([k, v]) => [k, v.optional()])),
  status: z.enum(['Draft', 'Active', 'Paused', 'Completed', 'Archived']).optional()
})), wrap(async (req, res) => {
  res.json({ success: true, campaign: await campaignService.updateCampaign(req, idParam(req), req.valid) });
}));

router.post('/campaigns/:id/generate', requireCapability('campaigns.manage'), aiLimiter, wrap(async (req, res) => {
  res.status(202).json({ success: true, ...(await campaignService.requestGeneration(req, idParam(req))) });
}));

router.get('/jobs/:id', wrap(async (req, res) => {
  const job = await jobsService.getJob(ws(req), idParam(req));
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, job });
}));

// ---- Content ----
const contentFields = {
  campaignId: z.number().int().positive().optional().nullable(),
  platformKey: z.enum(contentService.PLATFORM_KEYS).optional().nullable(),
  socialAccountId: z.number().int().positive().optional().nullable(),
  title: z.string().max(255).optional().nullable(),
  caption: z.string().max(10000).optional(),
  hashtags: z.union([z.array(z.string().max(100)).max(60), z.string().max(3000)]).optional(),
  callToAction: z.string().max(255).optional().nullable(),
  linkUrl: z.string().max(500).optional().nullable(),
  mediaAssetIds: z.array(z.number().int().positive()).max(10).optional(),
  imagePrompt: z.string().max(2000).optional().nullable(),
  videoScript: z.string().max(10000).optional().nullable(),
  assignedApproverId: z.number().int().positive().optional().nullable(),
  changeNote: z.string().max(255).optional()
};

router.get('/content', wrap(async (req, res) => {
  res.json({ success: true, ...(await contentService.listContent(ws(req), req.query)) });
}));

router.post('/content', requireCapability('content.create'), body(z.object(contentFields)), wrap(async (req, res) => {
  res.json({ success: true, content: await contentService.createContent(req, req.valid) });
}));

router.get('/content/:id', wrap(async (req, res) => {
  res.json({ success: true, ...(await contentService.getContentDetail(ws(req), idParam(req))) });
}));

router.patch('/content/:id', requireCapability('content.create'), body(z.object(contentFields)), wrap(async (req, res) => {
  res.json({ success: true, content: await contentService.updateContent(req, idParam(req), req.valid) });
}));

router.post('/content/:id/duplicate', requireCapability('content.create'), wrap(async (req, res) => {
  res.json({ success: true, content: await contentService.duplicateContent(req, idParam(req)) });
}));

router.post('/content/:id/regenerate', requireCapability('content.create'), aiLimiter, body(z.object({
  fields: z.array(z.enum(['title', 'caption', 'hashtags', 'call_to_action', 'image_prompt'])).min(1),
  instruction: z.string().max(500).optional()
})), wrap(async (req, res) => {
  res.json({ success: true, content: await campaignService.regenerateContent(req, idParam(req), req.valid) });
}));

router.post('/content/:id/submit', requireCapability('content.create'), body(z.object({ approverId: z.number().int().positive().optional().nullable() })), wrap(async (req, res) => {
  res.json({ success: true, content: await contentService.submitForApproval(req, idParam(req), req.valid) });
}));

router.post('/content/:id/approve', requireCapability('content.approve'), body(z.object({ note: z.string().max(1000).optional() })), wrap(async (req, res) => {
  res.json({ success: true, content: await contentService.approve(req, idParam(req), req.valid.note) });
}));

router.post('/content/:id/reject', requireCapability('content.approve'), body(z.object({ note: z.string().min(1).max(1000) })), wrap(async (req, res) => {
  res.json({ success: true, content: await contentService.reject(req, idParam(req), req.valid.note) });
}));

router.post('/content/:id/schedule', requireCapability('content.publish'), body(z.object({
  accountId: z.number().int().positive().optional(),
  localDateTime: z.string().min(16).max(19),
  timezone: z.string().max(64).optional()
})), wrap(async (req, res) => {
  res.json({ success: true, job: await publishingService.schedule(req, idParam(req), req.valid) });
}));

router.post('/content/:id/publish-now', requireCapability('content.publish'), body(z.object({ accountId: z.number().int().positive().optional() })), wrap(async (req, res) => {
  res.status(202).json({ success: true, job: await publishingService.publishNow(req, idParam(req), req.valid) });
}));

router.post('/content/:id/unschedule', requireCapability('content.publish'), wrap(async (req, res) => {
  res.json({ success: true, content: await publishingService.cancelSchedule(req, idParam(req)) });
}));

router.post('/content/:id/cancel', requireCapability('content.create'), wrap(async (req, res) => {
  res.json({ success: true, content: await contentService.cancelContent(req, idParam(req)) });
}));

router.delete('/content/:id', requireCapability('content.create'), wrap(async (req, res) => {
  res.json({ success: true, ...(await contentService.deleteContent(req, idParam(req))) });
}));

// ---- Assets ----
router.get('/assets', wrap(async (req, res) => {
  res.json({ success: true, assets: await contentService.listAssets(ws(req)) });
}));

router.post('/assets', requireCapability('content.create'), body(z.object({
  url: z.string().url().max(1000),
  assetType: z.enum(['image', 'video']),
  title: z.string().max(255).optional()
})), wrap(async (req, res) => {
  res.json({ success: true, asset: await contentService.registerAssetUrl(req, req.valid) });
}));

// ---- Calendar & queue ----
router.get('/calendar', wrap(async (req, res) => {
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 86400000);
  const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 35 * 86400000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return res.status(400).json({ success: false, error: 'Invalid range' });
  const where = ['c.workspace_id = ?', `((c.status IN ('scheduled', 'publishing') AND c.scheduled_at BETWEEN ? AND ?) OR (c.status = 'published' AND c.published_at BETWEEN ? AND ?)
    OR (c.status IN ('draft', 'review', 'approved') AND c.suggested_publish_at BETWEEN ? AND ?) OR (c.status = 'failed' AND COALESCE(c.scheduled_at, c.updated_at) BETWEEN ? AND ?))`];
  const { toDbDateTime } = require('../../lib/time');
  const f = toDbDateTime(from);
  const t = toDbDateTime(to);
  const params = [ws(req), f, t, f, t, f, t, f, t];
  for (const [q, col] of [['platformKey', 'c.platform_key'], ['accountId', 'c.social_account_id'], ['campaignId', 'c.campaign_id'], ['createdBy', 'c.created_by']]) {
    if (req.query[q]) { where.push(`${col} = ?`); params.push(req.query[q]); }
  }
  if (req.query.status) { where.push('c.status = ?'); params.push(req.query.status); }
  const rows = await all(
    `SELECT c.*, a.display_name AS account_name FROM content_items c
     LEFT JOIN social_accounts a ON a.workspace_id = c.workspace_id AND a.id = c.social_account_id
     WHERE ${where.join(' AND ')} ORDER BY COALESCE(c.scheduled_at, c.published_at, c.suggested_publish_at) ASC LIMIT 500`,
    params
  );
  const settings = await settingsService.getSettings(ws(req));
  res.json({
    success: true,
    timezone: settings.timezone,
    items: rows.map(r => ({ ...contentService.present(r), accountName: r.account_name, calendarAt: r.status === 'published' ? r.published_at : (r.scheduled_at || r.suggested_publish_at || r.updated_at), isSuggestion: ['draft', 'review', 'approved'].includes(r.status) }))
  });
}));

router.get('/queue', wrap(async (req, res) => {
  res.json({ success: true, jobs: await publishingService.listQueue(ws(req), req.query) });
}));

router.post('/queue/:id/retry', requireCapability('content.publish'), body(z.object({ confirmNotPublished: z.boolean().optional() })), wrap(async (req, res) => {
  res.json({ success: true, job: await publishingService.retryJob(req, idParam(req), req.valid) });
}));

router.post('/queue/:id/cancel', requireCapability('content.publish'), wrap(async (req, res) => {
  res.json({ success: true, job: await publishingService.cancelJob(req, idParam(req)) });
}));

// ---- Analytics & Roger strategist ----
router.get('/analytics/summary', requireCapability('analytics.view'), wrap(async (req, res) => {
  res.json({ success: true, analytics: await analyticsService.getSummary(ws(req), req.query) });
}));

router.post('/analytics/sync', requireCapability('analytics.view'), wrap(async (req, res) => {
  const accounts = await all("SELECT id FROM social_accounts WHERE workspace_id = ? AND status = 'connected'", [ws(req)]);
  const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
  const jobs = [];
  for (const a of accounts) {
    const { job, created } = await jobsService.enqueue(ws(req), 'sync_analytics', { accountId: a.id }, { idempotencyKey: `manual_analytics:${a.id}:${bucket}`, createdBy: req.auth.userId });
    jobs.push({ jobId: job.id, accountId: a.id, created });
  }
  res.status(202).json({ success: true, jobs, note: accounts.length ? 'Sync queued; the worker must be running.' : 'No connected accounts.' });
}));

router.post('/strategist/ask', requireCapability('agents.use'), aiLimiter, body(z.object({ question: z.string().min(2).max(1000) })), wrap(async (req, res) => {
  res.json({ success: true, ...(await strategistService.ask(req, req.valid.question)) });
}));

// ---- Engagement inbox ----
router.get('/inbox/threads', requireCapability('inbox.view'), wrap(async (req, res) => {
  res.json({ success: true, threads: await inboxService.listThreads(ws(req), req.query) });
}));

router.get('/inbox/threads/:id', requireCapability('inbox.view'), wrap(async (req, res) => {
  res.json({ success: true, ...(await inboxService.getThread(ws(req), idParam(req))) });
}));

router.post('/inbox/sync', requireCapability('inbox.view'), wrap(async (req, res) => {
  const accounts = await all("SELECT id FROM social_accounts WHERE workspace_id = ? AND status = 'connected'", [ws(req)]);
  const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
  for (const a of accounts) {
    await jobsService.enqueue(ws(req), 'sync_inbox', { accountId: a.id }, { idempotencyKey: `manual_inbox:${a.id}:${bucket}`, createdBy: req.auth.userId });
  }
  res.status(202).json({ success: true, queued: accounts.length });
}));

router.post('/inbox/threads/:id/analyze', requireCapability('inbox.view'), aiLimiter, wrap(async (req, res) => {
  res.json({ success: true, ...(await inboxService.analyzeThread(req, idParam(req))) });
}));

router.post('/inbox/threads/:id/suggest-reply', requireCapability('inbox.reply'), aiLimiter, body(z.object({ guidance: z.string().max(300).optional() })), wrap(async (req, res) => {
  res.json({ success: true, ...(await inboxService.suggestReply(req, idParam(req), req.valid)) });
}));

router.post('/inbox/threads/:id/reply', requireCapability('inbox.reply'), body(z.object({
  text: z.string().min(1).max(1500),
  draftMessageId: z.number().int().positive().optional().nullable()
})), wrap(async (req, res) => {
  res.json({ success: true, ...(await inboxService.sendReply(req, idParam(req), req.valid)) });
}));

router.patch('/inbox/threads/:id', requireCapability('inbox.reply'), body(z.object({
  status: z.enum(['open', 'resolved']).optional(),
  assignedUserId: z.number().int().positive().nullable().optional()
})), wrap(async (req, res) => {
  res.json({ success: true, thread: await inboxService.updateThread(req, idParam(req), req.valid) });
}));

router.post('/inbox/threads/:id/create-lead', requireCapability('inbox.reply'), body(z.object({
  name: z.string().max(255).optional(),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(50).optional(),
  notes: z.string().max(1000).optional()
})), wrap(async (req, res) => {
  res.json({ success: true, ...(await inboxService.createLeadFromThread(req, idParam(req), req.valid)) });
}));

// ---- Settings & audit ----
router.get('/settings', wrap(async (req, res) => {
  res.json({ success: true, settings: await settingsService.getSettings(ws(req)) });
}));

router.put('/settings', requireCapability('settings.manage'), body(z.object({
  timezone: z.string().max(64).optional(),
  requireApproval: z.boolean().optional(),
  defaultHashtags: z.string().max(500).optional(),
  analyticsPollMinutes: z.number().int().optional(),
  inboxPollMinutes: z.number().int().optional()
})), wrap(async (req, res) => {
  res.json({ success: true, settings: await settingsService.updateSettings(req, req.valid) });
}));

router.get('/audit', requireCapability('workspace.manage'), wrap(async (req, res) => {
  const rows = await all(
    "SELECT id, actor_user_id, actor_type, action, resource_type, resource_id, metadata_json, created_at FROM audit_logs WHERE workspace_id = ? AND action LIKE 'social.%' ORDER BY id DESC LIMIT 200",
    [ws(req)]
  );
  res.json({ success: true, events: rows.map(r => ({ ...r, metadata: (() => { try { return JSON.parse(r.metadata_json || 'null'); } catch (e) { return null; } })(), metadata_json: undefined })) });
}));

router.get('/usage', requireCapability('usage.view'), wrap(async (req, res) => {
  const { aiRequestsThisMonth, AI_MONTHLY_REQUEST_LIMIT } = require('../../lib/usage');
  res.json({ success: true, aiRequestsThisMonth: await aiRequestsThisMonth(ws(req)), aiMonthlyLimit: AI_MONTHLY_REQUEST_LIMIT });
}));

// Social module errors use the shared JSON error shape.
router.use((err, req, res, next) => {
  if (err.name === 'ProviderError') {
    return res.status(502).json({ success: false, error: err.message, code: err.code });
  }
  next(err);
});

module.exports = router;
