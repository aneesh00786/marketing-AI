const express = require('express');
const { z } = require('zod');
const { requireCapability } = require('../../middleware/auth');
const { aiRouteLimit } = require('../../lib/rateLimit');
const svc = require('./abTestService');

/**
 * A/B tests API, mounted at /api/v1/ab-tests. Workspace comes from the session.
 * View: analytics.view. Email tests: mail.compose (conclude: mail.send).
 * Social tests: campaigns.manage (conclude: content.approve).
 */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  }
  if (err.details && err.status && err.status < 500) return res.status(err.status).json({ success: false, code: err.code, error: err.message, details: err.details });
  next(err);
});

router.get('/meta', requireCapability('analytics.view'), (req, res) => res.json({ success: true, emailMetrics: svc.EMAIL_METRICS, socialMetrics: svc.SOCIAL_METRICS, alphas: svc.ALPHAS }));
router.get('/', requireCapability('analytics.view'), wrap(async (req, res) => res.json({ success: true, tests: await svc.listTests(req, { emailCampaignId: req.query.emailCampaignId, socialCampaignId: req.query.socialCampaignId }) })));
router.get('/social-groups/:campaignId', requireCapability('analytics.view'), wrap(async (req, res) => res.json({ success: true, groups: await svc.variantGroups(req, req.params.campaignId) })));
router.post('/email', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, test: await svc.createEmailTest(req, req.body) })));
router.post('/social', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, test: await svc.createSocialTest(req, req.body) })));
router.get('/:id', requireCapability('analytics.view'), wrap(async (req, res) => res.json({ success: true, test: await svc.getTest(req, req.params.id) })));
router.patch('/:id', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, test: await svc.updateEmailTest(req, req.params.id, req.body) })));
router.post('/:id/generate-variant', requireCapability('mail.compose'), aiRouteLimit('abtests.variant'), wrap(async (req, res) => res.json({ success: true, test: await svc.generateEmailVariant(req, req.params.id) })));
router.post('/:id/conclude', requireCapability('analytics.view'), wrap(async (req, res) => res.json({ success: true, test: await svc.conclude(req, req.params.id, req.body || {}) })));
router.post('/:id/cancel', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, test: await svc.cancel(req, req.params.id) })));

module.exports = router;
