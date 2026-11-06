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
router.post('/test', requireCapability('mail.configure'), wrap(async (req, res) => res.json({ success: true, ...(await settings.testConnection(req)) })));

/** Public: Amazon SNS posts SES events here (text/plain JSON), verified by SNS signature. */
const webhook = express.Router();
webhook.post('/:token', express.text({ type: '*/*', limit: '256kb' }), (req, res, next) => {
  const raw = typeof req.body === 'string' ? req.body : (req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {}));
  sns.handle(req.params.token, raw).then(r => res.status(r.status).type('text/plain').send(r.body)).catch(next);
});

module.exports = { router, webhook };
