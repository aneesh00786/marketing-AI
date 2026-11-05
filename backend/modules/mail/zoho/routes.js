const express = require('express');
const { requireCapability } = require('../../../middleware/auth');
const svc = require('./zohoService');

/**
 * Zoho Campaigns connection, mounted at /api/v1/mail/zoho. Campaigns themselves are managed in
 * Marketech.ai (/api/v1/mail/campaigns). The OAuth callback is public (authenticated by the
 * single-use state); everything else needs a signed-in member: status with mail.view,
 * connect/disconnect/test with mail.configure.
 */
const router = express.Router();

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  const status = err.status || 500;
  if (status < 500 || err.expose) {
    return res.status(status).json({ success: false, error: err.message, code: err.code, providerCode: err.providerCode || undefined });
  }
  next(err);
});

router.get('/callback', wrap(async (req, res) => {
  res.redirect(302, await svc.handleCallback(req.query || {}));
}));

router.use((req, res, next) => {
  if (!req.auth || !req.auth.userId) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
  next();
});

router.get('/status', requireCapability('mail.view'), wrap(async (req, res) => res.json({ success: true, ...(await svc.status(req)) })));
// The Zoho org number for "Open in Zoho" links (whoever sends campaigns may set it).
router.put('/web-org', requireCapability('mail.send'), wrap(async (req, res) => res.json({ success: true, ...(await svc.setWebOrg(req, req.body || {})) })));
router.post('/connect', requireCapability('mail.configure'), wrap(async (req, res) => res.json({ success: true, ...(await svc.startConnect(req)) })));
router.post('/disconnect', requireCapability('mail.configure'), wrap(async (req, res) => res.json({ success: true, ...(await svc.disconnect(req)) })));
// The workspace's own Zoho API client (Mail Center → Settings). The secret is accepted, never returned.
router.get('/app', requireCapability('mail.configure'), wrap(async (req, res) => res.json({ success: true, app: await svc.getApp(req) })));
router.put('/app', requireCapability('mail.configure'), wrap(async (req, res) => res.json({ success: true, ...(await svc.saveApp(req, req.body || {})) })));
router.delete('/app', requireCapability('mail.configure'), wrap(async (req, res) => res.json({ success: true, ...(await svc.removeApp(req)) })));
router.post('/test', requireCapability('mail.configure'), wrap(async (req, res) => res.json({ success: true, ...(await svc.testConnection(req)) })));

module.exports = router;
