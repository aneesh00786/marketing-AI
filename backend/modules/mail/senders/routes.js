const express = require('express');
const { z } = require('zod');
const { requireCapability } = require('../../../middleware/auth');
const svc = require('./senderService');

// "My sender email": each member's own addresses (signed in), and the public confirmation link.
const router = express.Router();
const publicRouter = express.Router();

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => i.message).join('; ') });
  if (err.status && err.status < 500) return res.status(err.status).json({ success: false, code: err.code, error: err.message });
  next(err);
});

router.get('/', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.mine(req)) })));
router.post('/', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.add(req, req.body)) })));
router.post('/:id(\\d+)/resend', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.resend(req, req.params.id)) })));
router.post('/:id(\\d+)/aws', requireCapability('mail.compose'), wrap(async (req, res) => res.json({ success: true, ...(await svc.requestAws(req, req.params.id)) })));
router.delete('/:id(\\d+)', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.remove(req, req.params.id)) })));

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
publicRouter.get('/verify/:token([a-f0-9]{64})', wrap(async (req, res) => {
  const r = await svc.verify(req.params.token);
  const app = (process.env.APP_BASE_URL || '').replace(/\/$/, '') || '/';
  res.status(r.ok ? 200 : 400).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sender address</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f7fb;color:#1f2937;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}main{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:28px;max-width:440px;text-align:center}a{color:#4f46e5}</style></head>
<body><main>${r.ok ? `<h1>✓ Address confirmed</h1><p><b>${esc(r.email)}</b> is now your sender address in Marketech.ai. Your campaigns and emails can be sent from it.</p>` : `<h1>Link not valid</h1><p>${esc(r.reason)}</p>`}
<p><a href="${esc(app)}">Open Marketech.ai</a></p></main></body></html>`);
}));

module.exports = { router, publicRouter };
