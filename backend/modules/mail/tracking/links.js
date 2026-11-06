/**
 * Link rewriting and the open pixel for SMTP-sent emails (our own first-party tracking).
 *
 * A tracked link points to /api/v1/mail/t/c/<opaque token>; the destination is looked up on the
 * server, so the redirect can only ever go to a URL stored when the email was sent (no open
 * redirect). Links that must not be tracked are left exactly as they are:
 * - anything that is not http(s), relative links, fragments, mailto:, tel:;
 * - URLs with credentials (user:pass@), placeholders ($[...], {{...}}) or over 2048 characters;
 * - unsubscribe, opt-out, password reset, verification, sign-in and OAuth links;
 * - URLs whose query carries secrets or one-time codes (token, key, code, signature, ...);
 * - this app's own mail URLs (assets, unsubscribe, tracking);
 * - links marked data-no-track.
 */
const crypto = require('crypto');

const MAX_URL = 2048;
const SENSITIVE_PARAM = /^(token|access_token|id_token|refresh_token|auth|authorization|key|api_key|apikey|secret|client_secret|password|passwd|pass|pwd|code|otp|sig|signature|session|sessionid|sid|jwt|reset|nonce|hash|ticket|unsubscribe)$/i;
const SENSITIVE_PATH = /\/(reset|reset-password|password|forgot|verify|verification|confirm|activate|activation|login|log-in|signin|sign-in|signup|magic|magic-link|unsubscribe|unsub|optout|opt-out|preferences|oauth|oauth2|auth|sso|invite|invitation)(\/|$)/i;

const newToken = () => crypto.randomBytes(16).toString('hex');
const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Whether a destination may be tracked. Returns the normalized URL, or a reason it is skipped. */
function trackableUrl(raw, { ownOrigin = null } = {}) {
  const value = decodeEntities(String(raw || '').trim());
  if (!value) return { ok: false, reason: 'empty' };
  if (value.length > MAX_URL) return { ok: false, reason: 'too_long' };
  if (/\$\[|\{\{|%7B%7B/i.test(value)) return { ok: false, reason: 'placeholder' };
  let u;
  try { u = new URL(value); } catch { return { ok: false, reason: 'not_absolute' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'scheme' };
  if (u.username || u.password) return { ok: false, reason: 'credentials' };
  if (SENSITIVE_PATH.test(u.pathname)) return { ok: false, reason: 'sensitive_path' };
  for (const k of u.searchParams.keys()) if (SENSITIVE_PARAM.test(k)) return { ok: false, reason: 'sensitive_param' };
  // Personalised links that carry an email address would put another copy of it in our link table.
  for (const v of u.searchParams.values()) if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(v)) return { ok: false, reason: 'personal_data' };
  if (ownOrigin && u.origin === ownOrigin && u.pathname.startsWith('/api/')) return { ok: false, reason: 'own_url' };
  return { ok: true, url: u.toString() };
}

/** A stored destination is redirected to only if it is still a plain http(s) URL without credentials. */
function safeRedirectTarget(stored) {
  try {
    const u = new URL(String(stored || ''));
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.toString().length > MAX_URL) return null;
    return u.toString();
  } catch { return null; }
}

/** Display form of a link: host and path only (query strings may hold personal data). */
function displayUrl(stored) {
  try { const u = new URL(stored); return `${u.host}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 200); } catch { return ''; }
}

const HREF_RE = /(\shref\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * Rewrites trackable <a href> links. clickUrl(token) builds the public click URL.
 * Returns the new HTML and the links to store ({ token, url, position }).
 */
function rewriteLinks(html, { clickUrl, ownOrigin = null, maxLinks = 100 }) {
  const links = [];
  const out = String(html || '').replace(/<a\b[^>]*>/gi, tag => {
    if (links.length >= maxLinks || /\sdata-no-track\b/i.test(tag)) return tag;
    const m = tag.match(HREF_RE);
    if (!m) return tag;
    const raw = m[3] ?? m[4] ?? m[5] ?? '';
    const check = trackableUrl(raw, { ownOrigin });
    if (!check.ok) return tag;
    const token = newToken();
    links.push({ token, url: check.url, position: links.length });
    return tag.replace(HREF_RE, `$1"${clickUrl(token)}"`);
  });
  return { html: out, links };
}

/** Appends a 1x1 open pixel just before </body> (or at the end). */
function addPixel(html, pixelUrl) {
  const img = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0" />`;
  const s = String(html || '');
  // At the top of the body: Gmail clips long email (about 102 KB) and never loads anything after the cut.
  return /<body\b[^>]*>/i.test(s) ? s.replace(/<body\b[^>]*>/i, m => `${m}${img}`) : `${img}${s}`;
}

// 1x1 transparent GIF.
const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Coarse client hint for an open: image proxies fetch on delivery or cache, so opens are estimates. */
function clientHint(userAgent) {
  const ua = String(userAgent || '');
  if (/GoogleImageProxy|ggpht\.com/i.test(ua)) return 'google_proxy';
  if (/YahooMailProxy/i.test(ua)) return 'yahoo_proxy';
  if (/Outlook-iOS|Microsoft Office|ms-office|OneOutlook/i.test(ua)) return 'outlook';
  if (/bot|crawler|spider|scanner|preview|safelinks|proofpoint|mimecast|barracuda/i.test(ua)) return 'scanner';
  return 'unknown';
}

module.exports = { trackableUrl, safeRedirectTarget, displayUrl, rewriteLinks, addPixel, PIXEL_GIF, clientHint, newToken, sha256, decodeEntities };
