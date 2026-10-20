const express = require('express');
const { z } = require('zod');
const { requireCapability } = require('../../middleware/auth');
const leadService = require('./leadService');

/**
 * Workspace-scoped Leads CRM API. Mounted at /api/v1/leads (plus legacy aliases
 * /api/leads and /api/v1/crm/leads). The workspace always comes from the session.
 */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ws = req => req.auth.workspaceId;

function body(schema) {
  return (req, res, next) => {
    const r = schema.safeParse(req.body || {});
    if (!r.success) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: r.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    }
    req.valid = r.data;
    next();
  };
}

const str = (max) => z.union([z.string().max(max), z.number()]).nullable().optional();
const productId = z.union([z.number().int().positive(), z.string().regex(/^\d+$/), z.literal(''), z.null()]).optional();
const leadFields = {
  name: z.string().max(255).optional(),
  email: z.string().max(255).nullable().optional(),
  phone: str(50),
  companyName: str(255),
  company_name: str(255),
  estimatedBudget: str(100),
  estimated_budget: str(100),
  notes: z.string().max(5000).nullable().optional(),
  status: z.string().max(50).nullable().optional(),
  productId,
  interest: str(255),
  productInterest: str(255)
};

router.use((req, res, next) => {
  if (!req.auth) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
  next();
});

router.get('/products', requireCapability('leads.view'), wrap(async (req, res) => {
  res.json({ success: true, products: await leadService.listProducts(ws(req)) });
}));

router.get('/', requireCapability('leads.view'), wrap(async (req, res) => {
  const result = await leadService.listLeads(ws(req), req.query);
  res.json({ success: true, ...result, statuses: leadService.STATUSES });
}));

router.post('/', requireCapability('leads.manage'), body(z.object(leadFields)), wrap(async (req, res) => {
  const { lead, ai } = await leadService.createLead(req, req.valid);
  const scoreText = lead.score === null ? '' : ` Lead score ${lead.score} (${lead.category}, rule-based).`;
  res.json({
    success: true,
    lead,
    lead_id: lead.id,
    ai,
    message: `Lead for ${lead.name} recorded.${scoreText}${ai && !ai.available ? ' AI advice unavailable.' : ''}`
  });
}));

router.post('/import-bulk', requireCapability('leads.manage'), body(z.object({ leads: z.array(z.record(z.any())).min(1) })), wrap(async (req, res) => {
  const r = await leadService.importLeads(req, req.valid.leads);
  res.json({
    success: true,
    ...r,
    count: r.imported,
    message: `Imported ${r.imported} lead${r.imported === 1 ? '' : 's'}.` +
      (r.flagged.length ? ` ${r.flagged.length} need a product review.` : '') +
      (r.duplicates.length ? ` ${r.duplicates.length} duplicate email${r.duplicates.length === 1 ? '' : 's'} skipped.` : '') +
      (r.skipped.length ? ` ${r.skipped.length} row${r.skipped.length === 1 ? '' : 's'} skipped.` : '')
  });
}));

router.post('/ai-qualify-all', requireCapability('leads.manage'), body(z.object({ productId })), wrap(async (req, res) => {
  const r = await leadService.qualifyAll(req, req.valid);
  res.json({
    success: true,
    ...r,
    message: `Refreshed rule-based scores for ${r.scored} lead${r.scored === 1 ? '' : 's'}.` +
      (r.aiAvailable ? ` AI advice generated for ${r.advised}.` : ' AI unavailable — no advice generated.')
  });
}));

router.get('/:id', requireCapability('leads.view'), wrap(async (req, res) => {
  res.json({ success: true, lead: leadService.present(await leadService.requireLead(ws(req), req.params.id)) });
}));

router.patch('/:id', requireCapability('leads.manage'), body(z.object(leadFields)), wrap(async (req, res) => {
  res.json({ success: true, ...(await leadService.updateLead(req, req.params.id, req.valid)) });
}));

router.delete('/:id', requireCapability('leads.manage'), wrap(async (req, res) => {
  res.json({ success: true, ...(await leadService.deleteLead(req, req.params.id)) });
}));

router.post('/:id/ai-qualify', requireCapability('leads.manage'), wrap(async (req, res) => {
  const ai = await leadService.generateAdvice(req, req.params.id);
  const lead = leadService.present(await leadService.requireLead(ws(req), req.params.id));
  res.json({ success: true, lead, ai, message: ai.available ? 'Score refreshed and AI advice generated.' : `Score refreshed. ${ai.reason}.` });
}));

router.post('/:id/email-draft', requireCapability('leads.view'), wrap(async (req, res) => {
  res.json({ success: true, draft: await leadService.emailDraft(req, req.params.id) });
}));

module.exports = router;
