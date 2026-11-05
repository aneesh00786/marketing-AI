const express = require('express');
const { z } = require('zod');
const { isPlatformAdmin } = require('../../lib/platformAdmin');
const svc = require('./platformService');

/**
 * Platform admin. Mounted at /api/v1/platform. Everything except /me is for the platform admin
 * only; being a Workspace Owner or Admin of any other workspace gives no access. Only signed-in
 * users reach here, and a token from "Open workspace" counts only while its holder is still admin.
 */
const router = express.Router();

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => i.message).join(' ') });
  const status = err.status || 500;
  if (status < 500 || err.expose) return res.status(status).json({ success: false, error: err.message, code: err.code });
  next(err);
});
const send = fn => wrap(async (req, res) => res.json({ success: true, ...(await fn(req)) }));

router.use((req, res, next) => {
  if (!req.auth || !req.auth.userId) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
  next();
});

router.get('/me', send(async req => ({ admin: await isPlatformAdmin(req.auth.userId) })));

router.use(wrap(async (req, res, next) => {
  if (!(await isPlatformAdmin(req.auth.userId))) return res.status(403).json({ success: false, error: 'This area is for the platform admin.', code: 'PLATFORM_ADMIN_REQUIRED' });
  next();
}));

router.get('/workspaces', send(req => svc.listWorkspaces(req.query)));
router.post('/workspaces', send(req => svc.createWorkspace(req, req.body)));
router.get('/workspaces/:id', send(req => svc.getWorkspace(req, req.params.id)));
router.post('/workspaces/:id/open', send(req => svc.openWorkspace(req, req.params.id)));
router.post('/workspaces/:id/members', send(req => svc.assignUser(req, req.params.id, req.body)));
router.delete('/workspaces/:id/members/:userId', send(req => svc.removeUser(req, req.params.id, req.params.userId)));
// Delete (closes it, restorable for 30 days, then erased) and restore.
const deletion = require('./workspaceDeletion');
router.post('/workspaces/:id/delete', send(req => deletion.deleteWorkspace(req, req.params.id, req.body)));
router.post('/workspaces/:id/restore', send(req => deletion.restoreWorkspace(req, req.params.id)));
// Clear data: erase chosen kinds of data at once, keeping the workspace (e.g. test data).
const clearing = require('./workspaceClear');
router.get('/workspaces/:id/clear-options', send(req => clearing.options(req, req.params.id)));
router.post('/workspaces/:id/clear', send(req => clearing.clear(req, req.params.id, req.body)));
router.get('/users', send(req => svc.listUsers(req.query)));
router.get('/activity', send(req => svc.listActivity(req.query)));

module.exports = router;
