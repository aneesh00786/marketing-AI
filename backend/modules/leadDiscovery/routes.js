const express = require('express');
const { z } = require('zod');
const { requireCapability } = require('../../middleware/auth');
const { aiRouteLimit, rateLimit } = require('../../lib/rateLimit');
const svc = require('./discoveryService');

/**
 * AI Lead Discovery (Google Places API (New)). Mounted at /api/v1/leads/discovery.
 * Searching and importing cost money and create leads: leads.manage. Live details: leads.view.
 * The workspace always comes from the session; the Google API key never leaves the server.
 */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  }
  if (err.status && err.status < 600 && err.code) return res.status(err.status).json({ success: false, code: err.code, error: err.message });
  next(err);
});
const detailsLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  keyFn: req => `leads.placeDetails:${req.auth?.workspaceId || 0}:${req.auth?.userId || req.ip}`,
  message: 'Too many live detail requests. Please wait a few minutes.'
});

router.use((req, res, next) => {
  if (!req.auth) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
  next();
});

router.get('/config', requireCapability('leads.view'), wrap(async (req, res) => res.json({ success: true, config: await svc.config(req) })));
router.post('/search', requireCapability('leads.manage'), aiRouteLimit('leads.discovery'), wrap(async (req, res) => res.json({ success: true, ...(await svc.search(req, req.body)) })));
router.post('/runs/:id/import', requireCapability('leads.manage'), wrap(async (req, res) => res.json({ success: true, ...(await svc.importSelected(req, req.params.id, req.body)) })));
router.get('/leads/:id/place', requireCapability('leads.view'), detailsLimit, wrap(async (req, res) => res.json({ success: true, ...(await svc.liveDetails(req, req.params.id)) })));

module.exports = router;
