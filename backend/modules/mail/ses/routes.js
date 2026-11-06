const express = require('express');
const { z } = require('zod');
const { requireCapability } = require('../../../middleware/auth');
const settings = require('./sesSettings');
const sns = require('./snsWebhook');

/**
 * The Amazon SES connection that sends campaigns.
 * Read: mail.view (the campaign editor needs to know the service). Change and test: mail.configure.
 */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => i.message).join(' ') });
  next(err);
});

router.get('/settings', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, ...(await settings.getSettings(req)) })));
router.put('/settings', requireCapability('mail.configure'), wrap(async (req, res) => res.json({ success: true, ...(await settings.saveSettings(req, req.body || {})) })));
router.get('/deliverability', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, ...(await require('./deliverability').dashboard(req.auth.workspaceId, { days: req.query.days })) })));
router.post('/test', requireCapability('mail.configure'), wrap(async (req, res) => res.json({ success: true, ...(await settings.testConnection(req)) })));

/** Public: Amazon SNS posts SES events here (text/plain JSON), verified by SNS signature. */
const webhook = express.Router();
webhook.post('/:token', express.text({ type: '*/*', limit: '256kb' }), (req, res, next) => {
  const raw = typeof req.body === 'string' ? req.body : (req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {}));
  sns.handle(req.params.token, raw).then(r => res.status(r.status).type('text/plain').send(r.body)).catch(next);
});

/**
 * Public: a campaign recipient's "View in browser" page (opaque per-recipient token). The email's
 * HTML (sanitized when saved) is served sandboxed: it can never run with this site's privileges.
 */
const view = express.Router();
view.get('/:token', (req, res, next) => {
  require('./sesCampaigns').viewPage(req.params.token).then(page => {
    res.set({
      'Content-Security-Policy': "sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation; default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store'
    });
    if (!page) return res.status(404).type('text/plain').send('This email is no longer available.');
    res.type('html').send(page.html);
  }).catch(next);
});

module.exports = { router, webhook, view };
