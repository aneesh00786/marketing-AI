const express = require('express');
const { rateLimit } = require('../../lib/rateLimit');
const svc = require('./callingService');
const logs = require('./callLogService');
const { z } = require('zod');

/**
 * Browser calling. Mounted at /api/v1/calling. Calls are charged to the company's Telnyx account,
 * so they need "Make calls" (Members → Permissions), CRM manage access or the platform admin;
 * see lib/callingAccess.js.
 */
const router = express.Router();

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: 'Invalid call details.' });
  const status = err.status || 500;
  if (status < 500 || err.expose) return res.status(status).json({ success: false, error: err.message, code: err.code });
  next(err);
});

// The platform admin, "Make calls" (Members → Permissions) or CRM manage access (lib/callingAccess.js).
const canCall = req => require('../../lib/callingAccess').canCall(req.auth.userId);

router.use((req, res, next) => {
  if (!req.auth || !req.auth.userId) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
  next();
});

router.get('/status', wrap(async (req, res) => {
  res.json({ success: true, canCall: await canCall(req), configured: svc.isConfigured() });
}));

const tokenLimit = rateLimit({ windowMs: 60 * 1000, max: 10, keyFn: req => `calling:${req.auth.userId}`, message: 'Too many calls started. Wait a minute and try again.' });

const allowed = wrap(async (req, res, next) => {
  if (!(await canCall(req))) return res.status(403).json({ success: false, error: 'You do not have permission to make calls.', code: 'CALLING_NOT_ALLOWED' });
  next();
});

// A long call is at most about 15 MB per side at the recording bitrate.
const audioBody = express.raw({ type: () => true, limit: '50mb' });

router.post('/logs/:id/end', allowed, wrap(async (req, res) => res.json({ success: true, ...(await logs.endLog(req, req.params.id, req.body)) })));
router.post('/logs/:id/audio/:track', allowed, audioBody, wrap(async (req, res) => {
  res.json({ success: true, ...(await svc.addTrack(req, req.params.id, req.params.track, { buffer: req.body, contentType: req.headers['content-type'] })) });
}));

router.post('/token', allowed, tokenLimit, wrap(async (req, res) => res.json({ success: true, ...(await svc.startSession(req, req.body || {})) })));

module.exports = router;
