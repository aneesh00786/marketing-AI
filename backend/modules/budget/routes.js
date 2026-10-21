const express = require('express');
const { z } = require('zod');
const { requireCapability } = require('../../middleware/auth');
const svc = require('./budgetService');

/**
 * Budget & ROI API, mounted at /api/v1/budgets. Workspace comes from the session.
 * View: analytics.view. Budgets, spend/revenue entries, alerts: campaigns.manage.
 * Linking or syncing a provider ad account also needs integrations.manage.
 * Workspace subscription billing is a separate module and is not touched here.
 */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  }
  next(err);
});
const manage = requireCapability('campaigns.manage');

router.get('/', requireCapability('analytics.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.listBudgets(req)) })));
router.post('/', manage, wrap(async (req, res) => res.json({ success: true, budget: await svc.createBudget(req, req.body) })));
router.get('/:id', requireCapability('analytics.view'), wrap(async (req, res) => res.json({ success: true, budget: await svc.getBudget(req, req.params.id) })));
router.patch('/:id', manage, wrap(async (req, res) => res.json({ success: true, budget: await svc.updateBudget(req, req.params.id, req.body) })));
router.post('/:id/spend', manage, wrap(async (req, res) => res.json({ success: true, budget: await svc.addSpend(req, req.params.id, req.body) })));
router.post('/:id/spend/:entryId/void', manage, wrap(async (req, res) => res.json({ success: true, budget: await svc.voidEntry(req, req.params.id, 'spend', req.params.entryId, req.body) })));
router.post('/:id/revenue', manage, wrap(async (req, res) => res.json({ success: true, budget: await svc.addRevenue(req, req.params.id, req.body) })));
router.post('/:id/revenue/:entryId/void', manage, wrap(async (req, res) => res.json({ success: true, budget: await svc.voidEntry(req, req.params.id, 'revenue', req.params.entryId, req.body) })));
router.post('/:id/sources', manage, requireCapability('integrations.manage'), wrap(async (req, res) => res.json({ success: true, budget: await svc.connectSource(req, req.params.id, req.body) })));
router.post('/:id/sources/:sourceId/sync', manage, requireCapability('integrations.manage'), wrap(async (req, res) => res.json({ success: true, ...(await svc.syncNow(req, req.params.id, req.params.sourceId)) })));
router.post('/:id/alerts/:alertId/acknowledge', manage, wrap(async (req, res) => res.json({ success: true, ...(await svc.acknowledgeAlert(req, req.params.id, req.params.alertId)) })));

module.exports = router;
