const express = require('express');
const { z } = require('zod');
const authService = require('../../services/authService');
const { LEGACY_WORKSPACE_ID, requireCapability } = require('../../middleware/auth');
const members = require('./memberService');
const { audit } = require('../../lib/audit');
const { rateLimit } = require('../../lib/rateLimit');

/**
 * Workspaces of the signed-in user: list, create, switch. Mounted before the legacy
 * (workspace 1 only) gate so every workspace can use it. A workspace id from the browser is
 * never trusted: switching and creating always check (or create) an active membership on the
 * server and return a new token scoped to that workspace.
 */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  }
  if (err.status && err.status < 500) return res.status(err.status).json({ success: false, code: err.code, error: err.message });
  next(err);
});

// Signed-in members only (tool-secret calls have no user and cannot switch or create).
const member = (req, res, next) => (req.auth && req.auth.userId
  ? next()
  : res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' }));

const createLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyFn: req => `workspaces.create:${req.auth?.userId || req.ip}`,
  message: 'Too many workspaces created. Please try again later.'
});

// Audit entries belong to the workspace acted on (the new one), keeping request id and IP.
const auditCtx = (req, workspaceId) => ({ auth: { ...req.auth, workspaceId }, requestId: req.requestId, ip: req.ip });

/** Workspace-1-only (legacy) modules work only in that workspace; the UI says so elsewhere. */
const describe = w => ({ ...w, legacyModules: w.id === LEGACY_WORKSPACE_ID });

router.get('/api/v1/workspaces', member, wrap(async (req, res) => {
  const workspaces = await authService.listMemberships(req.auth.userId);
  res.json({ success: true, currentWorkspaceId: req.auth.workspaceId, workspaces: workspaces.map(describe) });
}));

router.post('/api/v1/workspaces', member, createLimit, wrap(async (req, res) => {
  const v = z.object({
    name: z.string().trim().min(2, 'Enter a workspace name (at least 2 characters).').max(100),
    industry: z.string().trim().max(100).optional().nullable()
  }).strict().parse(req.body || {});
  const session = await authService.createWorkspaceForUser(req.auth.userId, v);
  await audit(auditCtx(req, session.workspace.id), 'workspace.created', { resourceType: 'workspace', resourceId: session.workspace.id });
  res.json({ success: true, ...session, workspace: describe(session.workspace), workspaces: session.workspaces.map(describe) });
}));

router.post(['/api/v1/auth/switch-workspace', '/api/auth/switch-workspace'], member, wrap(async (req, res) => {
  const v = z.object({ workspaceId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)]) }).strict().parse(req.body || {});
  const session = await authService.switchWorkspace(req.auth.userId, v.workspaceId);
  await audit(auditCtx(req, session.workspace.id), 'auth.workspace_switched', { resourceType: 'workspace', resourceId: session.workspace.id, metadata: { from: req.auth.workspaceId } });
  res.json({ success: true, ...session, workspace: describe(session.workspace), workspaces: session.workspaces.map(describe) });
}));

// ---------------------------------------------------------------- members & invitations
// The workspace is always the session's; target users and invitations are checked against it.
const inviteLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, keyFn: req => `members.invite:${req.auth?.workspaceId}:${req.auth?.userId || req.ip}`, message: 'Too many invitations. Please try again later.' });
const answerLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, keyFn: req => `invitations.answer:${req.auth?.userId || req.ip}`, message: 'Too many attempts. Please wait a few minutes.' });

router.get('/api/v1/workspace/members', member, requireCapability('members.view'), wrap(async (req, res) => res.json({ success: true, ...(await members.listMembers(req)) })));
router.post('/api/v1/workspace/invitations', member, requireCapability('members.manage'), inviteLimit, wrap(async (req, res) => res.json({ success: true, ...(await members.invite(req, req.body)) })));
router.post('/api/v1/workspace/invitations/:id/resend', member, requireCapability('members.manage'), inviteLimit, wrap(async (req, res) => res.json({ success: true, ...(await members.resend(req, req.params.id)) })));
router.post('/api/v1/workspace/invitations/:id/cancel', member, requireCapability('members.manage'), wrap(async (req, res) => res.json({ success: true, ...(await members.cancel(req, req.params.id)) })));
router.patch('/api/v1/workspace/members/:userId', member, requireCapability('members.manage'), wrap(async (req, res) => res.json({ success: true, ...(await members.changeRole(req, req.params.userId, req.body)) })));
router.delete('/api/v1/workspace/members/:userId', member, requireCapability('members.manage'), wrap(async (req, res) => res.json({ success: true, ...(await members.removeMember(req, req.params.userId)) })));

// The invited person (any signed-in account; the invitation's email must match theirs).
router.get('/api/v1/invitations', member, wrap(async (req, res) => res.json({ success: true, invitations: await members.myInvitations(req) })));
router.post('/api/v1/invitations/preview', member, answerLimit, wrap(async (req, res) => res.json({ success: true, ...(await members.preview(req, req.body)) })));
router.post('/api/v1/invitations/accept', member, answerLimit, wrap(async (req, res) => {
  const r = await members.accept(req, req.body);
  res.json({ success: true, ...r, session: { ...r.session, workspace: describe(r.session.workspace), workspaces: r.session.workspaces.map(describe) } });
}));
router.post('/api/v1/invitations/decline', member, answerLimit, wrap(async (req, res) => res.json({ success: true, ...(await members.decline(req, req.body)) })));

module.exports = router;
