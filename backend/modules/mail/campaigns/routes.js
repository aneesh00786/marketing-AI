const express = require('express');
const { z } = require('zod');
const { requireCapability } = require('../../../middleware/auth');
const svc = require('./campaignService');

/**
 * Email campaigns (Marketech.ai), sent with Amazon SES. Mounted at /api/v1/mail/campaigns.
 * Read: mail.view. Write content: mail.compose. Approve and send: mail.send.
 */
const router = express.Router();

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  }
  const status = err.status || 500;
  if (status < 500 || err.expose) {
    return res.status(status).json({ success: false, error: err.message, code: err.code, providerCode: err.providerCode || undefined, details: err.details || undefined });
  }
  next(err);
});

router.use((req, res, next) => {
  if (!req.auth || !req.auth.userId) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
  next();
});

router.get('/', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, campaigns: await svc.list(req, { thumbs: String(req.query.thumbs || '') === '1' }) })));
router.get('/audiences', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.audiences(req)) })));
// Leads and selected contacts are addresses from Leads CRM: leads.view as well.
router.get('/lead-options', requireCapability('mail.compose', 'leads.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.leadOptions(req, req.query)) })));
router.post('/', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.create(req, req.body) })));

// Contact lists kept in Marketech.ai. Before /:id so "contact-lists" is not an id.
const mailLists = require('../contacts/listService');
const listsLimit = require('../../../lib/rateLimit').rateLimit({ windowMs: 60 * 1000, max: 20, keyFn: req => `contact-lists:${req.auth.workspaceId}`, message: 'Too many list changes. Wait a minute and try again.' });
router.get('/contact-lists', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, ...(await mailLists.lists(req)) })));
router.post('/contact-lists', requireCapability('mail.send', 'leads.view'), listsLimit, wrap(async (req, res) => res.json({ success: true, ...(await mailLists.create(req, req.body)) })));
router.get('/contact-lists/:id/contacts', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, ...(await mailLists.listContacts(req, req.params.id, req.query)) })));
router.post('/contact-lists/:id/contacts', requireCapability('mail.send', 'leads.view'), listsLimit, wrap(async (req, res) => res.json({ success: true, ...(await mailLists.addContacts(req, req.params.id, req.body)) })));
router.post('/contact-lists/:id/remove', requireCapability('mail.send'), listsLimit, wrap(async (req, res) => res.json({ success: true, ...(await mailLists.removeContacts(req, req.params.id, req.body)) })));
router.delete('/contact-lists/:id', requireCapability('mail.send'), listsLimit, wrap(async (req, res) => res.json({ success: true, ...(await mailLists.deleteList(req, req.params.id, req.body)) })));

// Follow up → History: emails and calls with one recipient of this campaign.
router.get('/:id/recipient-history', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, ...(await svc.recipientHistory(req, req.params.id, req.query)) })));
router.get('/:id', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.getOne(req, req.params.id) })));
router.patch('/:id', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.update(req, req.params.id, req.body) })));
router.post('/:id/duplicate', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.duplicate(req, req.params.id)) })));
router.delete('/:id', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.remove(req, req.params.id)) })));
router.get('/:id/contacts', requireCapability('mail.view', 'leads.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.getContacts(req, req.params.id)) })));
router.put('/:id/contacts/leads', requireCapability('mail.compose', 'leads.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.setContactLeads(req, req.params.id, req.body)) })));
router.post('/:id/contacts/remove', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.removeContacts(req, req.params.id, req.body)) })));
router.post('/:id/check-links', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.checkLinks(req, req.params.id)) })));
router.post('/:id/validate', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, validation: await svc.validate(req, req.params.id) })));
router.post('/:id/approve', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.approve(req, req.params.id) })));
router.post('/:id/send', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.send(req, req.params.id, req.body || {}) })));
router.post('/:id/refresh', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.refresh(req, req.params.id) })));
// Per-recipient activity (addresses): Owner, Admin, Marketing Manager and Approver only.
router.get('/:id/recipients', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, ...(await svc.recipientActivity(req, req.params.id, { activity: String(req.query.activity || ''), page: req.query.page })) })));

module.exports = router;
