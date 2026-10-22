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
router.post('/plan', requireCapability('leads.manage'), aiRouteLimit('leads.discoveryPlan'), wrap(async (req, res) => res.json({ success: true, plan: await svc.plan(req, req.body) })));

/**
 * Search. With "Accept: application/x-ndjson" the response streams one JSON object per line:
 * {"type":"progress",...} while queries run, then {"type":"result",...} or {"type":"error",...}.
 * Validation and limit errors are normal HTTP errors returned before streaming starts. Results pass
 * straight through to the browser and are not kept on the server. If the browser disconnects, no
 * further Google requests are made.
 */
router.post('/search', requireCapability('leads.manage'), aiRouteLimit('leads.discovery'), wrap(async (req, res) => {
  const prep = await svc.prepareSearch(req, req.body);
  if (!String(req.headers.accept || '').includes('application/x-ndjson')) {
    return res.json({ success: true, ...(await svc.executeSearch(req, prep)) });
  }
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  // X-Accel-Buffering: no lets progress through an nginx proxy without buffering.
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  const send = obj => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
  try {
    const result = await svc.executeSearch(req, prep, { onProgress: p => send({ type: 'progress', ...p }), signal: controller.signal });
    if (result) send({ type: 'result', success: true, ...result });
  } catch (err) {
    // Only our own errors (with an HTTP status) carry a user-facing message; others are logged.
    if (!err.status) console.error('Lead discovery search failed:', err);
    send({ type: 'error', success: false, code: err.status ? err.code : 'SERVER_ERROR', error: err.status ? err.message : 'Search failed. Please try again.' });
  }
  res.end();
}));
router.post('/runs/:id/import', requireCapability('leads.manage'), wrap(async (req, res) => res.json({ success: true, ...(await svc.importSelected(req, req.params.id, req.body)) })));
router.get('/leads/:id/place', requireCapability('leads.view'), detailsLimit, wrap(async (req, res) => res.json({ success: true, ...(await svc.liveDetails(req, req.params.id)) })));

module.exports = router;
