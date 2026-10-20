const express = require('express');
const { z } = require('zod');
const { requireCapability } = require('../../middleware/auth');
const svc = require('./automationService');

/**
 * Automation workflows API, mounted at /api/v1/automations. Workspace comes from the session.
 * View: analytics.view. Build/edit/pause: campaigns.manage. Activate (the approval): the
 * capabilities of every action in the workflow, plus confirm: true.
 */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  }
  next(err);
});

router.get('/meta', requireCapability('analytics.view'), (req, res) => {
  res.json({ success: true, triggers: svc.TRIGGERS, conditionFields: svc.CONDITION_FIELDS, actions: svc.ACTIONS, tokens: svc.TOKENS });
});
router.get('/', requireCapability('analytics.view'), wrap(async (req, res) => res.json({ success: true, workflows: await svc.listWorkflows(req) })));
router.post('/', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, workflow: await svc.createWorkflow(req, req.body) })));
router.get('/:id', requireCapability('analytics.view'), wrap(async (req, res) => res.json({ success: true, workflow: await svc.getWorkflow(req, req.params.id) })));
router.put('/:id', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, workflow: await svc.updateWorkflow(req, req.params.id, req.body) })));
router.delete('/:id', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, ...(await svc.deleteWorkflow(req, req.params.id)) })));
router.post('/:id/activate', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, workflow: await svc.activate(req, req.params.id, req.body || {}) })));
router.post('/:id/pause', requireCapability('campaigns.manage'), wrap(async (req, res) => res.json({ success: true, workflow: await svc.pause(req, req.params.id) })));
router.get('/:id/runs', requireCapability('analytics.view'), wrap(async (req, res) => res.json({ success: true, runs: await svc.listRuns(req, req.params.id, req.query) })));

module.exports = router;
