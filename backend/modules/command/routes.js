const express = require('express');
const { z } = require('zod');
const { requireCapability } = require('../../middleware/auth');
const svc = require('./commandService');

/**
 * Campaign Command Center API, mounted at /api/v1/command. Workspace comes from the session.
 * View: analytics.view. Plan/build: campaigns.manage. Approve the brief: content.approve.
 * Sending email and publishing posts stay behind the email-sequence and social approvals.
 */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  }
  if (err.details && err.status && err.status < 500) return res.status(err.status).json({ success: false, code: err.code, error: err.message, details: err.details });
  next(err);
});

router.get('/meta', requireCapability('analytics.view'), (req, res) => res.json({ success: true, channels: svc.CHANNELS, kpiMetrics: svc.KPI_METRICS }));

router.get('/programs', requireCapability('analytics.view'), wrap(async (req, res) => res.json({ success: true, programs: await svc.listPrograms(req) })));
router.post('/programs', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, program: await svc.createProgram(req, req.body) })));
router.get('/programs/:id', requireCapability('analytics.view'), wrap(async (req, res) => res.json({ success: true, program: await svc.getProgram(req, req.params.id) })));
router.patch('/programs/:id', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, program: await svc.updateProgram(req, req.params.id, req.body) })));
router.delete('/programs/:id', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, ...(await svc.deleteProgram(req, req.params.id)) })));
router.post('/programs/:id/archive', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, program: await svc.archiveProgram(req, req.params.id) })));

router.post('/programs/:id/brief', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, program: await svc.generateBrief(req, req.params.id) })));
router.put('/programs/:id/brief', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, program: await svc.saveBrief(req, req.params.id, req.body) })));
router.post('/programs/:id/brief/approve', requireCapability('content.approve'), wrap(async (req, res) => res.json({ success: true, program: await svc.approveBrief(req, req.params.id, req.body || {}) })));

router.post('/programs/:id/audience/preview', requireCapability('campaigns.manage'), wrap(async (req, res) => {
  const audience = await svc.previewAudience(req, req.params.id, req.body || {});
  res.json({ success: true, audience, eligible: audience.filter(a => a.eligible).length });
}));
router.put('/programs/:id/audience', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, ...(await svc.saveAudience(req, req.params.id, req.body || {})) })));

router.post('/programs/:id/build', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, ...(await svc.build(req, req.params.id, req.body || {})) })));
router.get('/programs/:id/overview', requireCapability('analytics.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.overview(req, req.params.id)) })));

module.exports = router;
