const express = require('express');
const { audit } = require('../../lib/audit');
const { z } = require('zod');
const { requireCapability } = require('../../middleware/auth');
const leadService = require('./leadService');
const productEmails = require('../mail/productEmails/service');
const zohoLists = require('../mail/zoho/zohoLists');

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

// Export: every lead matching the current filters. Recorded in the audit log (personal data leaves the app).
router.get('/export', requireCapability('leads.view'), wrap(async (req, res) => {
  const result = await leadService.exportLeads(ws(req), req.query);
  await audit(req, 'leads.exported', { resourceType: 'lead', metadata: { count: result.leads.length, truncated: result.truncated,
    filters: { productId: req.query.productId || null, status: req.query.status || null, q: req.query.q ? String(req.query.q).slice(0, 100) : null } } });
  res.json({ success: true, ...result });
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

/**
 * Excel / CSV import. Optional, in the same request:
 * - consent: the contacts agreed to marketing email; recorded with its evidence on the imported
 *   leads (and on matching existing leads whose consent is unknown; withdrawn consent is never
 *   overridden).
 * - zohoList: add them to a Zoho Campaigns list ({ key }) or a new one ({ name }). Only leads that
 *   may be emailed go to Zoho; a Zoho failure never undoes the import.
 */
const importConsent = z.object({
  method: z.enum(productEmails.CONSENT_METHODS),
  obtainedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the date consent was given (YYYY-MM-DD).'),
  evidence: z.string().trim().min(3, 'Give the evidence reference (form, document, URL...).').max(500),
  attest: z.literal(true, { errorMap: () => ({ message: 'Confirm that you hold this evidence for these contacts.' }) })
}).strict();
const importZohoList = z.union([
  z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) }).strict(),
  z.object({ name: z.string().trim().min(1).max(100) }).strict()
]);
router.post('/import-bulk', requireCapability('leads.manage'), body(z.object({ leads: z.array(z.record(z.any())).min(1), consent: importConsent.optional(), zohoList: importZohoList.optional() })), wrap(async (req, res) => {
  const { consent, zohoList } = req.valid;
  if (zohoList && !req.auth.capabilities.has('mail.send')) {
    return res.status(403).json({ success: false, code: 'FORBIDDEN', error: 'Only people who can send campaigns can add contacts to Zoho lists. Import without a Zoho list.' });
  }
  const r = await leadService.importLeads(req, req.valid.leads);
  const targets = [...new Set([...r.leadIds, ...r.duplicates.map(d => d.leadId).filter(Boolean)])];

  let consentRecorded = 0;
  if (consent && targets.length) {
    const ph = targets.map(() => '?').join(',');
    const unknown = (await require('../../db/database').all(`SELECT id FROM leads WHERE workspace_id = ? AND id IN (${ph}) AND (marketing_consent IS NULL OR marketing_consent = 'unknown')`, [ws(req), ...targets])).map(x => x.id);
    for (let i = 0; i < unknown.length; i += 500) {
      const part = unknown.slice(i, i + 500);
      await productEmails.recordConsent(req, { status: 'granted', leadIds: part, method: consent.method, obtainedAt: consent.obtainedAt, evidence: consent.evidence, note: 'Excel / CSV import', attest: true });
      consentRecorded += part.length;
    }
  }

  let zoho = null;
  if (zohoList && targets.length) {
    zoho = { list: null, added: 0, skipped: 0, reasons: [], error: null };
    try {
      let key = zohoList.key || null;
      let rest = targets;
      if (!key) {
        const made = await zohoLists.create(req, { name: zohoList.name, leadIds: targets.slice(0, zohoLists.MAX_ADD), emails: [] });
        key = made.list.key; zoho.list = made.list; zoho.added += made.added; zoho.skipped += made.skipped.length; zoho.reasons.push(...made.skipped);
        rest = targets.slice(zohoLists.MAX_ADD);
      }
      for (let i = 0; i < rest.length; i += zohoLists.MAX_ADD) {
        try {
          const a = await zohoLists.addContacts(req, key, { leadIds: rest.slice(i, i + zohoLists.MAX_ADD), emails: [] });
          zoho.list = a.list; zoho.added += a.added; zoho.skipped += a.skipped.length; zoho.reasons.push(...a.skipped);
        } catch (err) {
          if (err.code !== 'NO_CONTACTS') throw err;
          zoho.skipped += Math.min(zohoLists.MAX_ADD, rest.length - i);
        }
      }
    } catch (err) {
      zoho.error = err.code === 'NO_CONTACTS'
        ? 'None of these contacts can be emailed yet (no marketing consent recorded, or unsubscribed or invalid), so nothing was added to Zoho.'
        : err.message;
    }
    if (!zoho.error && !zoho.added) zoho.error = 'None of these contacts can be emailed yet (no marketing consent recorded, or unsubscribed or invalid), so nothing was added to Zoho.';
    zoho.reasons = zoho.reasons.slice(0, 20);
  }

  res.json({
    success: true,
    ...r,
    count: r.imported,
    consentRecorded,
    zoho,
    message: `Imported ${r.imported} lead${r.imported === 1 ? '' : 's'}.` +
      (r.flagged.length ? ` ${r.flagged.length} need a product review.` : '') +
      (r.duplicates.length ? ` ${r.duplicates.length} already in Leads (not duplicated).` : '') +
      (r.skipped.length ? ` ${r.skipped.length} row${r.skipped.length === 1 ? '' : 's'} skipped.` : '') +
      (consentRecorded ? ` Consent recorded for ${consentRecorded}.` : '') +
      (zoho ? (zoho.error ? ` Zoho: ${zoho.error}` : ` ${zoho.added} added to Zoho list “${zoho.list?.name || ''}”${zoho.skipped ? `, ${zoho.skipped} not added` : ''}.`) : '')
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
