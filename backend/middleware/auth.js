const crypto = require('crypto');
const { get } = require('../db/database');
const authService = require('../services/authService');
const { capabilitiesForRole } = require('../lib/permissions');

/**
 * The pre-existing modules (leads, mail, drafts, products, voice, appointments...)
 * still read and write workspace 1 directly. Until each is made tenant-aware, only
 * members of that workspace may use them, so a second tenant can never see its data.
 */
const LEGACY_WORKSPACE_ID = parseInt(process.env.LEGACY_WORKSPACE_ID || '1', 10);

function readBearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/** Resolves user, workspace membership and capabilities from the token on every request. */
async function resolveAuth(token) {
  const payload = authService.verifyToken(token);
  if (!payload || !payload.userId || !payload.workspaceId) return null;

  const member = await get(
    `SELECT m.workspace_id, m.user_id, m.role, m.status, u.email, u.display_name, u.status AS user_status
     FROM workspace_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.user_id = ? AND m.workspace_id = ?
     LIMIT 1`,
    [payload.userId, payload.workspaceId]
  );
  if (!member || member.status !== 'Active') return null;
  if (member.user_status && member.user_status !== 'Active') return null;

  return {
    userId: member.user_id,
    workspaceId: member.workspace_id,
    role: member.role,
    email: member.email,
    displayName: member.display_name,
    capabilities: capabilitiesForRole(member.role)
  };
}

function requireAuth() {
  return async function requireAuthMiddleware(req, res, next) {
    try {
      const token = readBearer(req);
      const auth = token ? await resolveAuth(token) : null;
      if (!auth) {
        return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
      }
      req.auth = auth;
      next();
    } catch (err) {
      next(err);
    }
  };
}

function requireCapability(...caps) {
  return function requireCapabilityMiddleware(req, res, next) {
    if (!req.auth) {
      return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
    }
    const missing = caps.filter(c => !req.auth.capabilities.has(c));
    if (missing.length > 0) {
      return res.status(403).json({ success: false, error: `Missing permission: ${missing.join(', ')}`, code: 'FORBIDDEN' });
    }
    next();
  };
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Global gate for /api: everything requires a signed-in member except explicitly
 * public routes (login, provider webhooks/OAuth callbacks that carry their own proof).
 * Voice-agent tool webhooks may alternatively present X-Tool-Secret.
 */
function apiGate({ publicPaths = [], toolPaths = [] } = {}) {
  const authMw = requireAuth();
  const matches = (list, path) => list.some(p => (p instanceof RegExp ? p.test(path) : p === path));

  return function apiGateMiddleware(req, res, next) {
    const path = req.originalUrl.split('?')[0];
    if (matches(publicPaths, path)) return next();

    const toolSecret = process.env.TOOL_WEBHOOK_SECRET;
    const presented = req.headers['x-tool-secret'];
    if (matches(toolPaths, path) && toolSecret && presented && safeEqual(presented, toolSecret)) {
      req.auth = {
        userId: null,
        workspaceId: LEGACY_WORKSPACE_ID,
        role: 'Voice Agent Tool',
        capabilities: capabilitiesForRole('Member'),
        isToolCall: true
      };
      return next();
    }
    return authMw(req, res, next);
  };
}

/** Restricts single-tenant legacy modules to members of the legacy workspace. */
function legacyWorkspaceOnly() {
  return function legacyWorkspaceOnlyMiddleware(req, res, next) {
    if (!req.auth) return next();
    if (req.auth.workspaceId !== LEGACY_WORKSPACE_ID) {
      return res.status(403).json({
        success: false,
        code: 'MODULE_NOT_TENANT_AWARE',
        error: 'This module is not yet available for your workspace.'
      });
    }
    next();
  };
}

module.exports = {
  LEGACY_WORKSPACE_ID,
  resolveAuth,
  requireAuth,
  requireCapability,
  apiGate,
  legacyWorkspaceOnly
};
