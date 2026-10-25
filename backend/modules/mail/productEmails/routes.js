const express = require('express');
const { z } = require('zod');
const { requireCapability } = require('../../../middleware/auth');
const svc = require('./service');

/**
 * Product email batches: /api/v1/mail/product-emails (signed-in members).
 * Pick recipients: mail.compose + leads.view. Record consent: leads.manage.
 * Create a batch: mail.compose. View: mail.view. Approve and send: mail.send.
 * Public unsubscribe links: /api/v1/mail/unsubscribe/:token (GET shows a confirmation; POST applies,
 * so mail scanners that open links do not unsubscribe people).
 */
const router = express.Router();
const unsubscribe = express.Router();

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  }
  const status = err.status || 500;
  if (status < 500 || err.expose) return res.status(status).json({ success: false, error: err.message, code: err.code, details: err.details || undefined });
  next(err);
});

const page = (title, text, form = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:60px auto;padding:0 16px;color:#1e293b"><h1 style="font-size:20px">${title}</h1><p>${text}</p>${form}</body></html>`;

unsubscribe.get('/:token', wrap(async (req, res) => {
  const r = await svc.unsubscribeByToken(req.params.token, { apply: false });
  if (!r) return res.status(404).type('html').send(page('Link not valid', 'This unsubscribe link is not valid. Reply "unsubscribe" to the email instead.'));
  if (r.unsubscribed) return res.type('html').send(page('You are unsubscribed', 'You will not receive further marketing emails from this sender.'));
  res.type('html').send(page('Unsubscribe?', 'Confirm to stop receiving marketing emails from this sender.',
    '<form method="post" action=""><button type="submit" style="font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#1e293b;color:#fff;cursor:pointer">Unsubscribe</button></form>'));
}));
unsubscribe.post('/:token', wrap(async (req, res) => {
  const r = await svc.unsubscribeByToken(req.params.token, { apply: true });
  if (!r) return res.status(404).type('html').send(page('Link not valid', 'This unsubscribe link is not valid. Reply "unsubscribe" to the email instead.'));
  res.type('html').send(page('You are unsubscribed', 'You will not receive further marketing emails from this sender.'));
}));

router.use((req, res, next) => {
  if (!req.auth || !req.auth.userId) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
  next();
});

router.get('/recipients', requireCapability('mail.compose', 'leads.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.listRecipients(req, req.query)) })));
router.post('/consent', requireCapability('leads.manage'), wrap(async (req, res) => res.json({ success: true, ...(await svc.recordConsent(req, req.body)) })));
router.get('/batches', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, batches: await svc.listBatches(req) })));
router.post('/batches', requireCapability('mail.compose', 'leads.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.createBatch(req, req.body)) })));
router.get('/batches/:id', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.getBatch(req, req.params.id)) })));
router.post('/batches/:id/approve', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, ...(await svc.approveBatch(req, req.params.id)) })));
router.post('/batches/:id/send', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, ...(await svc.sendBatch(req, req.params.id, req.body || {})) })));

module.exports = { router, unsubscribe };
