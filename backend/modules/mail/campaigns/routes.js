const express = require('express');
const { z } = require('zod');
const { requireCapability } = require('../../../middleware/auth');
const svc = require('./campaignService');

/**
 * Email campaigns (Marketech.ai), delivered through Zoho Campaigns. Mounted at /api/v1/mail/campaigns.
 * Read: mail.view. Write content: mail.compose. Approve, send and resolve: mail.send.
 * GET /content/:token is public: Zoho imports the approved HTML from it (token-bound, expiring).
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

router.get('/content/:token', wrap(async (req, res) => {
  const html = await svc.contentByToken(req.params.token);
  if (!html) return res.status(404).type('text/plain').send('Not found');
  // User-written HTML must never run with this site's privileges.
  res.set({
    'Content-Security-Policy': "sandbox; default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store'
  });
  res.type('html').send(html);
}));

router.use((req, res, next) => {
  if (!req.auth || !req.auth.userId) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
  next();
});

router.get('/', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, campaigns: await svc.list(req, { thumbs: String(req.query.thumbs || '') === '1' }) })));
router.get('/audiences', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.zohoAudiences(req)) })));
// Leads and selected contacts are addresses from Leads CRM: leads.view as well.
router.get('/lead-options', requireCapability('mail.compose', 'leads.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.leadOptions(req, req.query)) })));
router.post('/', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.create(req, req.body) })));
// Zoho Campaigns → Contact lists (like Zoho's Manage Lists). Before /:id so "zoho-lists" is not an id.
const lists = require('../zoho/zohoLists');
const listsLimit = require('../../../lib/rateLimit').rateLimit({ windowMs: 60 * 1000, max: 20, keyFn: req => `zoho-lists:${req.auth.workspaceId}`, message: 'Too many list changes. Wait a minute and try again.' });
// Zoho's lists (counts only): the plan usage on Contact lists.
router.get('/zoho-lists', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, ...(await lists.lists(req)) })));
// The Zoho plan's contact limit (Zoho's API does not report it): set by those who configure mail.
// Contact lists kept in Marketech.ai (Zoho gets a list only when a campaign is sent to it).
const mailLists = require('../contacts/listService');
router.get('/contact-lists', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, ...(await mailLists.lists(req)) })));
router.post('/contact-lists', requireCapability('mail.send', 'leads.view'), listsLimit, wrap(async (req, res) => res.json({ success: true, ...(await mailLists.create(req, req.body)) })));
router.get('/contact-lists/:id/contacts', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, ...(await mailLists.listContacts(req, req.params.id, req.query)) })));
router.post('/contact-lists/:id/contacts', requireCapability('mail.send', 'leads.view'), listsLimit, wrap(async (req, res) => res.json({ success: true, ...(await mailLists.addContacts(req, req.params.id, req.body)) })));
router.post('/contact-lists/:id/remove', requireCapability('mail.send'), listsLimit, wrap(async (req, res) => res.json({ success: true, ...(await mailLists.removeContacts(req, req.params.id, req.body)) })));
router.delete('/contact-lists/:id', requireCapability('mail.send'), listsLimit, wrap(async (req, res) => res.json({ success: true, ...(await mailLists.deleteList(req, req.params.id, req.body)) })));
// The one-time copy of Zoho lists and contacts made when Zoho was connected.
router.get('/contact-sync', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, ...(await require('../contacts/zohoImport').importStatus(req.auth.workspaceId)) })));
router.put('/zoho-plan', requireCapability('mail.configure'), wrap(async (req, res) => res.json({ success: true, ...(await lists.setPlan(req, req.body)) })));

router.get('/:id', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.getOne(req, req.params.id) })));
router.patch('/:id', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.update(req, req.params.id, req.body) })));
router.post('/:id/duplicate', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.duplicate(req, req.params.id)) })));
router.delete('/:id', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.remove(req, req.params.id)) })));
router.get('/:id/contacts', requireCapability('mail.view', 'leads.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.getContacts(req, req.params.id)) })));
router.put('/:id/contacts/leads', requireCapability('mail.compose', 'leads.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.setContactLeads(req, req.params.id, req.body)) })));
router.post('/:id/contacts/remove', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.removeContacts(req, req.params.id, req.body)) })));
router.post('/:id/validate', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, validation: await svc.validate(req, req.params.id) })));
router.post('/:id/approve', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.approve(req, req.params.id) })));
router.post('/:id/send', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.send(req, req.params.id, req.body || {}) })));
router.post('/:id/refresh', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.refresh(req, req.params.id) })));
// Per-recipient activity from Zoho (addresses): Owner, Admin, Marketing Manager and Approver only.
// Limited per workspace: Zoho allows 500 calls per 5 minutes and then locks the account for 30 minutes.
const recipientsLimit = require('../../../lib/rateLimit').rateLimit({ windowMs: 60 * 1000, max: 30, keyFn: req => `zoho-recipients:${req.auth.workspaceId}`, message: 'Too many recipient lookups. Wait a minute and try again.' });
// Contacts of one Zoho mailing list, read-only (addresses, so the same roles and limit as above).
router.get('/audiences/:listKey/contacts', requireCapability('mail.send'), recipientsLimit, wrap(async (req, res) => res.json({ success: true, ...(await svc.listContacts(req, req.params.listKey, { status: String(req.query.status || 'subscribed'), page: req.query.page })) })));
// Selecting from a Zoho list reads the same addresses, so it needs the same role and limit.
router.post('/:id/contacts/zoho', requireCapability('mail.compose', 'mail.send'), recipientsLimit, wrap(async (req, res) => res.json({ success: true, ...(await svc.addContactsFromZoho(req, req.params.id, req.body)) })));
router.get('/:id/recipients', requireCapability('mail.send'), recipientsLimit, wrap(async (req, res) => res.json({ success: true, ...(await svc.recipientActivity(req, req.params.id, { activity: String(req.query.activity || ''), page: req.query.page })) })));
router.post('/:id/resolve', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.resolve(req, req.params.id, req.body || {}) })));

module.exports = router;
