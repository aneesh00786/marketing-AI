const express = require('express');
const { z } = require('zod');
const access = require('./crmAccess');
const svc = require('./crmService');
const support = require('./supportService');
const calls = require('../calling/callLogService');

/**
 * Global CRM and support. Mounted at /api/v1/global-crm, not /api/v1/crm: that prefix belongs to
 * existing workspace routes (the Leads alias, Appointments). Signed-in users only (the /api gate),
 * then an explicit CRM grant; see crmAccess.js.
 */
const router = express.Router();
const { requireCrm } = access;

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => i.message).join(' ') });
  }
  const status = err.status || 500;
  if (status < 500 || err.expose) return res.status(status).json({ success: false, error: err.message, code: err.code, details: err.details || undefined });
  next(err);
});
const send = fn => wrap(async (req, res) => res.json({ success: true, ...(await fn(req)) }));

router.use((req, res, next) => {
  if (!req.auth || !req.auth.userId) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
  next();
});

// Lets the app decide whether to show the CRM. Reveals only the caller's own access.
router.get('/me', send(async req => ({ access: await access.accessFor(req.auth.userId) })));

router.use(access.requireCrmAccess());

const view = requireCrm('crm.view');
const manage = requireCrm('crm.manage');
const deals = requireCrm('crm.deals');
const tickets = requireCrm('crm.support');

router.get('/overview', view, send(() => svc.overview()));
router.get('/team', view, send(async () => ({ team: await access.team() })));

router.get('/contacts', view, send(req => svc.listContacts(req.query)));
router.post('/contacts', manage, send(req => svc.createContact(req, req.body)));
router.get('/contacts/:id', view, send(req => svc.getContact(req.params.id)));
router.patch('/contacts/:id', manage, send(req => svc.updateContact(req, req.params.id, req.body)));

router.get('/companies', view, send(req => svc.listCompanies(req.query)));
router.post('/companies', manage, send(req => svc.createCompany(req, req.body)));
router.get('/companies/:id', view, send(req => svc.getCompany(req.params.id)));
router.patch('/companies/:id', manage, send(req => svc.updateCompany(req, req.params.id, req.body)));

router.get('/deals', view, send(req => svc.listDeals(req.query)));
router.post('/deals', deals, send(req => svc.createDeal(req, req.body)));
router.get('/deals/:id', view, send(req => svc.getDeal(req.params.id)));
router.patch('/deals/:id', deals, send(req => svc.updateDeal(req, req.params.id, req.body)));
router.delete('/deals/:id', deals, send(req => svc.removeDeal(req, req.params.id)));

router.get('/tickets', view, send(req => support.listTickets(req.query)));
router.post('/tickets', tickets, send(req => support.createTicket(req, req.body)));
router.get('/tickets/:id', view, send(req => support.getTicket(req.params.id)));
router.patch('/tickets/:id', tickets, send(req => support.updateTicket(req, req.params.id, req.body)));

router.get('/calls', view, send(req => calls.listCalls(req.query)));
router.get('/calls/:id', view, send(req => calls.getCall(req, req.params.id)));
router.delete('/calls/:id/transcript', manage, send(req => calls.removeTranscript(req, req.params.id)));

// Adding to a record needs that record's permission (checked in the service).
for (const parent of Object.keys(svc.PARENTS)) {
  router.get(`/${parent}/:id/activities`, view, send(req => svc.listActivities(parent, req.params.id)));
  router.post(`/${parent}/:id/activities`, view, send(req => svc.addActivity(req, parent, req.params.id, req.body)));
}
router.patch('/activities/:id', view, send(req => svc.setTaskDone(req, req.params.id, req.body)));

module.exports = router;
