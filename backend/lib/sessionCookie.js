/**
 * Sign-in session in an HttpOnly cookie, so page scripts (and anything injected into the page) can
 * never read the token.
 *
 * - Every response that issues a session token (sign-in, sign-up, workspace switch or create,
 *   accepting an invitation, Platform Admin "Open workspace") also sets the cookie. For the browser
 *   app, which marks its requests with BROWSER_HEADER, the token is then removed from the body:
 *   the page only learns a non-secret session marker (id, user, workspace) to tell tabs apart.
 * - Direct API clients (scripts, integrations, tests) do not send that header and keep receiving
 *   the token, which they send as "Authorization: Bearer". They cannot obtain one without a
 *   password or an existing token.
 * - Cross-site request forgery: a request authenticated by the cookie that changes anything must
 *   carry BROWSER_HEADER. Other sites cannot add a custom header to a cross-origin request without
 *   CORS allowing it, and SameSite=Lax keeps the cookie off cross-site form posts.
 */
const authService = require('../services/authService');

const COOKIE = 'mt_session';
const BROWSER_HEADER = 'x-requested-with';
const BROWSER_VALUE = 'marketech';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const fromBrowser = req => String(req.headers[BROWSER_HEADER] || '').toLowerCase() === BROWSER_VALUE;

function readSessionCookie(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) {
      const v = part.slice(i + 1).trim();
      return v ? decodeURIComponent(v) : null;
    }
  }
  return null;
}

/** Secure (HTTPS-only) on an https site, which production must be. */
function isSecure(req) {
  return !!(req.secure || /^https:\/\//i.test(process.env.APP_BASE_URL || '') || process.env.NODE_ENV === 'production');
}

function cookieHeader(req, value, maxAgeSeconds) {
  return [`${COOKIE}=${value ? encodeURIComponent(value) : ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.max(0, maxAgeSeconds)}`, ...(isSecure(req) ? ['Secure'] : [])].join('; ');
}

function setSessionCookie(req, res, token, exp) {
  res.append('Set-Cookie', cookieHeader(req, token, (exp || 0) - Math.floor(Date.now() / 1000)));
}

function clearSessionCookie(req, res) {
  res.append('Set-Cookie', cookieHeader(req, '', 0));
}

/** Turns any session token in a JSON response into the cookie (see the note above). */
function sessionResponses(req, res, next) {
  const json = res.json.bind(res);
  res.json = body => {
    if (body && typeof body === 'object' && typeof body.token === 'string') {
      const payload = authService.verifyToken(body.token);
      // Only tokens this server signed for a user (not, e.g., a calling provider's token).
      if (payload && payload.userId && payload.workspaceId) {
        setSessionCookie(req, res, body.token, payload.exp);
        body = { ...body, session: { id: payload.jti || null, userId: payload.userId, workspaceId: payload.workspaceId } };
        if (fromBrowser(req)) delete body.token;
      }
    }
    return json(body);
  };
  next();
}

module.exports = { COOKIE, BROWSER_HEADER, BROWSER_VALUE, UNSAFE, fromBrowser, readSessionCookie, setSessionCookie, clearSessionCookie, sessionResponses };
