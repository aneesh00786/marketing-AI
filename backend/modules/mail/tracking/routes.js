const express = require('express');
const { z } = require('zod');
const crypto = require('crypto');
const { run, get } = require('../../../db/database');
const { requireCapability } = require('../../../middleware/auth');
const { audit } = require('../../../lib/audit');
const { rateLimit } = require('../../../lib/rateLimit');
const secretBox = require('../../../lib/secretBox');
const svc = require('./trackingService');
const links = require('./links');
const zepto = require('./zeptoWebhook');

/**
 * Public (mounted at /api/v1/mail/t, no session; opaque tokens only):
 *   GET  /o/:token.gif                   open pixel (SMTP emails with open tracking on)
 *   GET  /c/:token                       tracked link: records the click, redirects to the stored URL
 *   POST /webhooks/zeptomail/:endpoint   ZeptoMail events (signature-verified; off unless enabled)
 * Authenticated (mounted at /api/v1/mail/tracking):
 *   GET  /settings                       mail.view
 *   PUT  /settings                       mail.configure  (open/click tracking on or off)
 *   PUT  /zeptomail-webhook              mail.configure  (key, enable/disable, rotate URL)
 *   GET  /emails/:id, /drafts/:id        mail.view       (tracking for one email)
 * Nothing here sends, resends or approves anything.
 */
const publicRouter = express.Router();
const router = express.Router();

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  const status = err.status || 500;
  if (status < 500 || err.expose) return res.status(status).json({ success: false, error: err.message, code: err.code });
  next(err);
});
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code, expose: true });
const ws = req => req.auth.workspaceId;

// Pixel and click: a hard ceiling against floods; under it, a softer per-IP budget only decides whether
// the hit is recorded. A recipient's click is always redirected (never a 429 below the ceiling).
const publicCeiling = rateLimit({ windowMs: 60 * 1000, max: 3000, keyFn: req => `mail-t:${req.ip}` });
const webhookLimit = rateLimit({ windowMs: 60 * 1000, max: 600, keyFn: req => `mail-wh:${req.params.endpoint || req.ip}` });
const recordBudget = new Map();
function withinRecordBudget(ip, max = 120, windowMs = 60 * 1000) {
  const now = Date.now();
  let e = recordBudget.get(ip);
  if (!e || e.resetAt <= now) {
    if (recordBudget.size > 50000) recordBudget.clear();
    e = { count: 0, resetAt: now + windowMs };
    recordBudget.set(ip, e);
  }
  e.count += 1;
  return e.count <= max;
}

// ---------------------------------------------------------------- public

publicRouter.get('/o/:token([a-f0-9]{32}).gif', publicCeiling, wrap(async (req, res) => {
  if (withinRecordBudget(req.ip)) {
    const r = await svc.recordOpen(req.params.token, req.get('user-agent')).catch(err => { console.error('[mail-tracking] open:', err.message); return null; });
    console.info(`[mail-tracking] open pixel ${req.params.token.slice(0, 8)}… recorded=${!!r?.recorded} ua=${String(req.get('user-agent') || '').slice(0, 60)}`);
  }
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
  res.send(links.PIXEL_GIF); // always the same pixel, tracked or not, so nothing is revealed
}));

publicRouter.get('/c/:token([a-f0-9]{32})', publicCeiling, wrap(async (req, res) => {
  const target = await svc.recordClick(req.params.token, req.get('user-agent'), { record: withinRecordBudget(req.ip) });
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
  if (!target) return res.status(404).type('text/plain').send('This link is no longer available.');
  res.redirect(302, target);
}));

publicRouter.post('/webhooks/zeptomail/:endpoint([a-f0-9]{32})', webhookLimit, wrap(async (req, res) => {
  // Off unless the server allows it (format confirmed with an authorized test event) and the
  // workspace enabled it with a key. Unknown or disabled endpoints all look the same: 404.
  if (!svc.zeptoWebhooksAllowed()) return res.status(404).json({ success: false });
  const ep = await get("SELECT id, workspace_id, secret_ciphertext, enabled FROM mail_webhook_endpoints WHERE endpoint_token = ? AND provider = 'zeptomail'", [req.params.endpoint]);
  if (!ep || !ep.enabled || !ep.secret_ciphertext) return res.status(404).json({ success: false });
  let key;
  try { key = secretBox.decrypt(ep.secret_ciphertext); } catch { return res.status(503).json({ success: false, error: 'Webhook key unavailable.' }); }
  const check = zepto.verifySignature({ header: req.get('producer-signature'), rawBody: req.rawBody || Buffer.alloc(0), contentType: req.get('content-type'), key });
  if (!check.ok) return res.status(401).json({ success: false, error: 'Invalid signature.' });

  const parsed = zepto.parsePayload(req.body);
  if (!parsed.ok || !parsed.events.length) return res.status(400).json({ success: false, error: 'Unrecognized webhook payload.', unrecognized: parsed.unrecognized || 0 });

  const counts = { received: parsed.events.length, applied: 0, duplicates: 0, ignored: parsed.unrecognized, suppressed: 0 };
  for (const ev of parsed.events) {
    // Only this workspace's ZeptoMail emails: by our own reference first, then by ZeptoMail's request id.
    const t = (ev.clientReference && /^[a-f0-9]{32}$/.test(ev.clientReference)
      ? await get("SELECT id FROM mail_message_tracking WHERE workspace_id = ? AND tracking_token = ? AND provider = 'zeptomail'", [ep.workspace_id, ev.clientReference])
      : null) || (ev.requestId
      ? await get("SELECT id FROM mail_message_tracking WHERE workspace_id = ? AND provider = 'zeptomail' AND provider_message_id = ? ORDER BY id DESC LIMIT 1", [ep.workspace_id, ev.requestId])
      : null);
    if (!t) { counts.ignored++; continue; }
    const url = ev.url ? links.displayUrl(String(ev.url)) : '';
    const basis = [ev.requestId || ev.clientReference, ev.type, ev.occurredAt ? ev.occurredAt.toISOString() : (parsed.webhookRequestId || 'no-time'), url].join('|');
    const detail = [ev.reason, ev.diagnostic].filter(Boolean).join(' - ') || (ev.type === 'clicked' ? url : null);
    const r = await svc.recordEvent(ep.workspace_id, t.id, {
      type: ev.type, source: 'zeptomail', occurredAt: ev.occurredAt || new Date(), basis,
      providerEventId: parsed.webhookRequestId, detailCode: ev.type === 'hard_bounce' || ev.type === 'soft_bounce' ? ev.reason : null, detail
    });
    if (r.duplicate) { counts.duplicates++; continue; }
    counts.applied++;
    if (ev.type === 'hard_bounce' || ev.type === 'complaint') {
      const s = await svc.suppressRecipient(ep.workspace_id, t.id, ev.type === 'hard_bounce' ? 'bounced' : 'complaint');
      if (s.suppressed) counts.suppressed++;
    }
  }
  await run('UPDATE mail_webhook_endpoints SET last_event_at = UTC_TIMESTAMP() WHERE id = ?', [ep.id]);
  res.json({ success: true, ...counts });
}));

// ---------------------------------------------------------------- authenticated

router.use((req, res, next) => {
  if (!req.auth || !req.auth.userId) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
  next();
});

function webhookUrl(token) {
  const base = (process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
  return base ? `${base}/api/v1/mail/t/webhooks/zeptomail/${token}` : null;
}

async function settingsView(workspaceId) {
  const cfg = await get('SELECT provider, track_opens, track_clicks, tracking_updated_at FROM mail_configurations WHERE workspace_id = ? LIMIT 1', [workspaceId]);
  const ep = await get("SELECT endpoint_token, enabled, secret_ciphertext, last_event_at FROM mail_webhook_endpoints WHERE workspace_id = ? AND provider = 'zeptomail'", [workspaceId]);
  return {
    configured: !!cfg,
    trackOpens: !!cfg?.track_opens,
    trackClicks: !!cfg?.track_clicks,
    updatedAt: cfg?.tracking_updated_at || null,
    publicLinksAvailable: svc.publicBaseOk(),
    retentionDays: svc.RETENTION_DAYS(),
    zeptomail: {
      serverAllowsWebhook: svc.zeptoWebhooksAllowed(),
      endpoint: ep ? { url: webhookUrl(ep.endpoint_token), enabled: !!ep.enabled, hasKey: !!ep.secret_ciphertext, lastEventAt: ep.last_event_at } : null
    }
  };
}

router.get('/settings', requireCapability('mail.view'), wrap(async (req, res) => {
  res.json({ success: true, settings: await settingsView(ws(req)) });
}));

router.put('/settings', requireCapability('mail.configure'), wrap(async (req, res) => {
  const v = z.object({ trackOpens: z.boolean(), trackClicks: z.boolean() }).strict().parse(req.body || {});
  const r = await run('UPDATE mail_configurations SET track_opens = ?, track_clicks = ?, tracking_updated_by = ?, tracking_updated_at = UTC_TIMESTAMP() WHERE workspace_id = ?',
    [v.trackOpens ? 1 : 0, v.trackClicks ? 1 : 0, req.auth.userId, ws(req)]);
  if (!r.changes) throw httpError(409, 'Set up mail for this workspace first (Company Mail settings).', 'MAIL_NOT_CONFIGURED');
  await audit(req, 'mail.tracking_settings_updated', { resourceType: 'mail_configuration', resourceId: ws(req), metadata: v });
  res.json({ success: true, settings: await settingsView(ws(req)) });
}));

router.put('/zeptomail-webhook', requireCapability('mail.configure'), wrap(async (req, res) => {
  const v = z.object({
    authKey: z.string().trim().min(16).max(512).optional(),
    enabled: z.boolean().optional(),
    rotateUrl: z.boolean().optional()
  }).strict().parse(req.body || {});
  const workspaceId = ws(req);
  let ep = await get("SELECT * FROM mail_webhook_endpoints WHERE workspace_id = ? AND provider = 'zeptomail'", [workspaceId]);
  if (!ep) {
    await run("INSERT INTO mail_webhook_endpoints (workspace_id, provider, endpoint_token, enabled, created_by, created_at, updated_at) VALUES (?, 'zeptomail', ?, 0, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
      [workspaceId, crypto.randomBytes(16).toString('hex'), req.auth.userId]);
    ep = await get("SELECT * FROM mail_webhook_endpoints WHERE workspace_id = ? AND provider = 'zeptomail'", [workspaceId]);
  }
  if (v.authKey !== undefined) {
    if (!secretBox.isConfigured()) throw httpError(503, 'Credential encryption is not configured on the server, so the webhook key cannot be stored.', 'ENCRYPTION_NOT_CONFIGURED');
    await run('UPDATE mail_webhook_endpoints SET secret_ciphertext = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [secretBox.encrypt(v.authKey), ep.id]);
  }
  if (v.rotateUrl) await run('UPDATE mail_webhook_endpoints SET endpoint_token = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [crypto.randomBytes(16).toString('hex'), ep.id]);
  if (v.enabled !== undefined) {
    const fresh = await get('SELECT secret_ciphertext FROM mail_webhook_endpoints WHERE id = ?', [ep.id]);
    if (v.enabled && !svc.zeptoWebhooksAllowed()) throw httpError(409, 'ZeptoMail webhooks are not enabled on this server yet (ZEPTOMAIL_WEBHOOKS_ENABLED). They stay off until the event format has been confirmed with a test event.', 'WEBHOOKS_NOT_ALLOWED');
    if (v.enabled && !fresh.secret_ciphertext) throw httpError(409, 'Add the ZeptoMail webhook authentication key first.', 'WEBHOOK_KEY_REQUIRED');
    await run('UPDATE mail_webhook_endpoints SET enabled = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [v.enabled ? 1 : 0, ep.id]);
  }
  // The key itself is never logged or returned.
  await audit(req, 'mail.zeptomail_webhook_updated', { resourceType: 'mail_webhook', resourceId: ep.id, metadata: { keyChanged: v.authKey !== undefined, enabled: v.enabled, rotated: !!v.rotateUrl } });
  res.json({ success: true, settings: await settingsView(workspaceId) });
}));

router.get('/emails/:id(\\d+)', requireCapability('mail.view'), wrap(async (req, res) => {
  const email = await get('SELECT id FROM emails WHERE id = ? AND workspace_id = ?', [req.params.id, ws(req)]);
  if (!email) throw httpError(404, 'Email not found.', 'NOT_FOUND');
  res.json({ success: true, tracking: await svc.forEmail(ws(req), email.id) });
}));

router.get('/drafts/:id(\\d+)', requireCapability('mail.view'), wrap(async (req, res) => {
  const draft = await get('SELECT id, email_id FROM email_drafts WHERE id = ? AND workspace_id = ?', [req.params.id, ws(req)]);
  if (!draft) throw httpError(404, 'Draft not found.', 'NOT_FOUND');
  const byDraft = await svc.forDraft(ws(req), draft.id);
  res.json({ success: true, tracking: byDraft.tracked || !draft.email_id ? byDraft : await svc.forEmail(ws(req), draft.email_id) });
}));

module.exports = { publicRouter, router };
