const express = require('express');
const { z } = require('zod');
const { requireCapability } = require('../../middleware/auth');
const svc = require('./campaignAnalyticsService');

/**
 * AI Campaigns analytics, mounted at /api/v1/campaign-analytics. Workspace comes from the
 * session; viewing needs analytics.view. Recommendations use the workspace AI quota.
 */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => `${i.path.join('.') || 'query'}: ${i.message}`).join('; ') });
  }
  next(err);
});

router.get('/overview', requireCapability('analytics.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.overview(req, req.query)) })));
router.post('/recommendations', requireCapability('analytics.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.recommendations(req, req.body || {})) })));

module.exports = router;
