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

router.get('/', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, campaigns: await svc.list(req) })));
router.get('/audiences', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.zohoAudiences(req)) })));
router.post('/', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.create(req, req.body) })));
router.get('/:id', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.getOne(req, req.params.id) })));
router.patch('/:id', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.update(req, req.params.id, req.body) })));
router.delete('/:id', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.remove(req, req.params.id)) })));
router.post('/:id/validate', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, validation: await svc.validate(req, req.params.id) })));
router.post('/:id/approve', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.approve(req, req.params.id) })));
router.post('/:id/send', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.send(req, req.params.id, req.body || {}) })));
router.post('/:id/refresh', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.refresh(req, req.params.id) })));
router.post('/:id/resolve', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, campaign: await svc.resolve(req, req.params.id, req.body || {}) })));

module.exports = router;
