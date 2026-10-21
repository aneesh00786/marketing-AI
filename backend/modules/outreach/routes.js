const express = require('express');
const { z } = require('zod');
const { requireCapability } = require('../../middleware/auth');
const { aiRouteLimit } = require('../../lib/rateLimit');
const svc = require('./outreachService');

/**
 * Email outreach campaigns API (AI Campaigns page). Mounted at /api/v1/outreach.
 * Viewing: mail.view. Building (settings, AI sequence, audience, pause/stop): mail.compose.
 * Approving / resuming / retrying a send: mail.send, with an explicit confirm: true.
 */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  }
  if (err.details && err.status && err.status < 500) {
    return res.status(err.status).json({ success: false, code: err.code, error: err.message, details: err.details });
  }
  next(err);
});

// Public unsubscribe (the token in the email is the proof). GET only shows a confirmation page,
// because mail security scanners open links automatically; the unsubscribe happens on POST
// (the button on that page, or a one-click POST). Repeating it is harmless.
const page = (title, text, form = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>
<body style="font-family: system-ui, sans-serif; background: #f8fafc; color: #1e293b; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 16px;">
<main style="max-width: 420px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 28px; text-align: center;"><h1 style="font-size: 1.2rem;">${title}</h1><p>${text}</p>${form}</main></body></html>`;
const invalid = res => res.status(404).type('html').send(page('Link not valid', 'This unsubscribe link is not valid. Reply "unsubscribe" to the email instead.'));
router.get('/unsubscribe/:token', wrap(async (req, res) => {
  const r = await svc.findUnsubscribe(req.params.token);
  if (!r) return invalid(res);
  if (r.unsubscribed) return res.type('html').send(page('You are unsubscribed', 'You will not receive further emails from this sender.'));
  res.type('html').send(page('Unsubscribe?', 'Confirm to stop receiving these emails from this sender.',
    '<form method="post" action=""><button type="submit" style="font: inherit; padding: 10px 18px; border-radius: 8px; border: 0; background: #1e293b; color: #fff; cursor: pointer;">Unsubscribe</button></form>'));
}));
router.post('/unsubscribe/:token', wrap(async (req, res) => {
  const done = await svc.unsubscribeByToken(req.params.token);
  if (!done) return invalid(res);
  res.type('html').send(page('You are unsubscribed', 'You will not receive further emails from this sender.'));
}));

router.get('/status', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, status: await svc.engineStatus(req) })));

router.get('/campaigns', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, campaigns: await svc.listCampaigns(req) })));
router.post('/campaigns', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.createCampaign(req, req.body) })));
router.get('/campaigns/:id', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.getCampaign(req, req.params.id) })));
router.patch('/campaigns/:id', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.updateCampaign(req, req.params.id, req.body) })));
router.delete('/campaigns/:id', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.deleteCampaign(req, req.params.id)) })));

router.post('/campaigns/:id/generate', requireCapability('mail.compose'), aiRouteLimit('outreach.generate'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.generateSequence(req, req.params.id, req.body || {}) })));
router.put('/campaigns/:id/steps', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.replaceSteps(req, req.params.id, req.body) })));

router.post('/audience/preview', requireCapability('mail.compose'), wrap(async (req, res) => {
  const audience = await svc.resolveAudience(req, req.body);
  res.json({ success: true, audience, eligible: audience.filter(a => a.eligible).length });
}));
router.get('/campaigns/:id/recipients', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, recipients: await svc.listRecipients(req, req.params.id) })));
router.post('/campaigns/:id/recipients', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.addRecipients(req, req.params.id, req.body)) })));
router.delete('/campaigns/:id/recipients/:rid', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.removeRecipient(req, req.params.id, req.params.rid)) })));
router.post('/campaigns/:id/recipients/:rid/retry', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, ...(await svc.retryRecipient(req, req.params.id, req.params.rid, req.body || {})) })));

router.get('/campaigns/:id/readiness', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, readiness: await svc.readiness(req, req.params.id) })));
router.post('/campaigns/:id/approve', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.approve(req, req.params.id, req.body || {}) })));
router.post('/campaigns/:id/resume', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.resume(req, req.params.id, req.body || {}) })));
router.post('/campaigns/:id/pause', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.pause(req, req.params.id) })));
router.post('/campaigns/:id/stop', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.stop(req, req.params.id) })));

module.exports = router;
