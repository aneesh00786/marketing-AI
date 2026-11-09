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

// Sign-out support arrives with migration 031. Until it is applied, sessions work as before (no
// revocation) instead of every request failing; the check is repeated every minute.
let revocation = { ready: false, checkedAt: 0 };
async function revocationReady() {
  if (!revocation.ready && Date.now() - revocation.checkedAt > 60000) {
    const row = await get(`SELECT
        (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'session_version') AS col,
        (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'revoked_tokens') AS tbl`);
    revocation = { ready: Number(row?.col) > 0 && Number(row?.tbl) > 0, checkedAt: Date.now() };
  }
  return revocation.ready;
}

/** False when this token was signed out, or the user signed out everywhere / had the password reset since. */
async function sessionStillValid(payload) {
  if (!(await revocationReady())) return true;
  const user = await get('SELECT session_version FROM users WHERE id = ?', [payload.userId]);
  if (!user || (Number(payload.sv) || 0) !== (Number(user.session_version) || 0)) return false;
  if (payload.jti && await get('SELECT 1 AS x FROM revoked_tokens WHERE jti = ? LIMIT 1', [String(payload.jti)])) return false;
  return true;
}

function readBearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/**
 * A session from "Open workspace" in Platform Admin: full Owner rights in that workspace, without
 * being a member of it. Only tokens the server issued for this carry platformAccess, and being the
 * platform admin is checked again on every request, so the access ends the moment that does.
 */
async function resolvePlatformAccess(payload) {
  const { isPlatformAdmin } = require('../lib/platformAdmin');
  if (!(await isPlatformAdmin(payload.userId))) return null;
  const row = await get(
    `SELECT u.id, u.email, u.display_name, w.id AS workspace_id FROM users u JOIN workspaces w ON w.id = ? WHERE u.id = ? AND (w.status IS NULL OR w.status = 'Active') LIMIT 1`,
    [payload.workspaceId, payload.userId]
  );
  if (!row) return null;
  return {
    userId: row.id,
    workspaceId: row.workspace_id,
    role: 'Workspace Owner',
    email: row.email,
    displayName: row.display_name,
    platformAccess: true,
    capabilities: capabilitiesForRole('Workspace Owner')
  };
}

/** Resolves user, workspace membership and capabilities from the token on every request. */
async function resolveAuth(token) {
  const payload = authService.verifyToken(token);
  if (!payload || !payload.userId || !payload.workspaceId) return null;
  if (!(await sessionStillValid(payload))) return null;
  const session = { tokenId: payload.jti || null, tokenExp: payload.exp || null };
  if (payload.platformAccess) {
    const auth = await resolvePlatformAccess(payload);
    return auth ? { ...auth, ...session } : null;
  }

  const member = await get(
    `SELECT m.workspace_id, m.user_id, m.role, m.status, m.module_access_json, u.email, u.display_name, u.status AS user_status
     FROM workspace_members m
     JOIN users u ON u.id = m.user_id
     JOIN workspaces w ON w.id = m.workspace_id AND (w.status IS NULL OR w.status = 'Active')
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
    ...session,
    // Role capabilities plus per-member grants the role currently qualifies for (fails closed).
    capabilities: await require('../lib/capabilityGrants').effectiveCapabilities(member.workspace_id, member.user_id, member.role),
    // Sections this member may open (Owners/Admins: all). Read on every request, so changes apply at once.
    modules: require('../lib/moduleAccess').modulesFor(member.role, member.module_access_json)
  };
}

function requireAuth() {
  return async function requireAuthMiddleware(req, res, next) {
    try {
      // A Bearer header (API clients) or the browser's HttpOnly session cookie.
      const bearer = readBearer(req);
      const sessionCookie = require('../lib/sessionCookie');
      const token = bearer || sessionCookie.readSessionCookie(req);
      // Cookie-authenticated changes must come from the app itself (cross-site request forgery).
      if (!bearer && token && sessionCookie.UNSAFE.has(req.method) && !sessionCookie.fromBrowser(req)) {
        return res.status(403).json({ success: false, error: 'This request was refused (missing app header).', code: 'CSRF_REJECTED' });
      }
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
  revocationReady,
  LEGACY_WORKSPACE_ID,
  resolveAuth,
  requireAuth,
  requireCapability,
  apiGate,
  legacyWorkspaceOnly
};
