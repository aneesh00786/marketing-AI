const { safeFetchText } = require('../../lib/safeFetch');

/**
 * Finds a public contact email and a named contact person on a business's own website.
 * Google Places does not provide either, so they come only from pages the business publishes:
 * its home page and at most two contact/about pages on the same site.
 * - Fetched through the SSRF-safe client (no private addresses, capped size, short timeout).
 * - robots.txt is respected: a site that disallows our pages is not read.
 * - Nothing is guessed: no email patterns (info@...) are invented and no names inferred. A value
 *   is returned only when it appears on the site, together with the page it was found on.
 */
const UA = 'Mozilla/5.0 (compatible; MarketechBot/1.0; +lead-discovery)';
const deps = { fetchText: (url, opts) => safeFetchText(url, opts) };
const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 1024 * 1024;
const EXTRA_PAGES = 2;

const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}/g;
const FILE_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf|zip|mp4|woff2?)$/i;
const JUNK_DOMAINS = /(^|\.)(example\.(com|org|net)|domain\.com|email\.com|yourdomain\.com|yoursite\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|wix\.com|godaddy\.com|schema\.org|w3\.org)$/i;
const JUNK_LOCAL = /^(no-?reply|do-?not-?reply|postmaster|mailer-daemon|abuse|webmaster|example|test|user|name|email|your\.?name|john\.?doe)$/i;
const ROLES = 'Contact Person|Contact Name|Proprietor|Owner|Founder|Co-Founder|Managing Director|Director|CEO|Chief Executive Officer|Managing Partner|Partner|General Manager|Sales Manager|Manager|Chairman';
const ROLE_RE = new RegExp(`\\b(${ROLES})\\b`, 'i');
const HONORIFIC = /^(mr|mrs|ms|miss|dr|shri|smt|sri)\.?\s+/i;
// Words that look like capitalised names on web pages but are not people.
const NOT_NAME = /\b(us|our|team|contact|about|home|read|more|call|email|phone|address|office|company|services?|products?|limited|ltd|pvt|private|llp|inc|group|enterprises?|traders?|wholesale|distributors?|solutions|privacy|policy|terms|copyright|rights|reserved|menu|login|search|welcome|message|from|the|and|for|with|today|click|here|form|map|location|hours|monday|sunday)\b/i;

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

const visibleText = html => decodeEntities(String(html)
  .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
  .replace(/<(br|\/p|\/div|\/li|\/h\d|\/td|\/tr)\b[^>]*>/gi, '\n')
  .replace(/<[^>]+>/g, ' '))
  .replace(/[ \t\r\f\v]+/g, ' ');

/** Cloudflare "email protection" hides addresses as hex XOR-ed with the first byte. */
function decodeCfEmail(hex) {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

function cleanEmail(raw) {
  const e = String(raw || '').trim().replace(/^mailto:/i, '').split('?')[0].replace(/[.,;:]+$/, '').toLowerCase();
  let decoded = e;
  try { decoded = decodeURIComponent(e); } catch (err) { /* keep as is */ }
  if (!/^[a-z0-9._%+-]{1,64}@(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}$/.test(decoded) || decoded.length > 254) return null;
  const [local, domain] = decoded.split('@');
  if (FILE_EXT.test(decoded) || JUNK_DOMAINS.test(domain) || JUNK_LOCAL.test(local) || /^[0-9a-f]{16,}$/.test(local)) return null;
  return decoded;
}

/** Emails on a page, links (mailto, Cloudflare) first, then plain text. */
function findEmails(html) {
  const found = [];
  const add = e => { const c = cleanEmail(e); if (c && !found.includes(c)) found.push(c); };
  for (const m of String(html).matchAll(/href\s*=\s*["']mailto:([^"'>\s]+)/gi)) add(decodeEntities(m[1]));
  for (const m of String(html).matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) add(decodeCfEmail(m[1]));
  for (const m of visibleText(html).matchAll(EMAIL_RE)) add(m[0]);
  return found;
}

function plausibleName(raw) {
  const name = String(raw || '').replace(HONORIFIC, '').replace(/\s+/g, ' ').trim().replace(/[,.;:\-–|]+$/, '');
  const words = name.split(' ');
  if (words.length < 2 || words.length > 4 || name.length > 60) return null;
  if (!words.every(w => /^[A-Z][A-Za-z'’.-]{0,24}$/.test(w) || /^[A-Z]\.?$/.test(w))) return null;
  if (NOT_NAME.test(name) || ROLE_RE.test(name)) return null;
  return name;
}

/** People named in schema.org JSON-LD: a Person, or an organisation's founder/employee/contact. */
function namesFromJsonLd(html) {
  const out = [];
  const visit = (node, role) => {
    if (!node || typeof node !== 'object' || out.length > 5) return;
    if (Array.isArray(node)) { node.forEach(n => visit(n, role)); return; }
    const type = [].concat(node['@type'] || []).join(' ');
    if (/\bPerson\b/.test(type) && typeof node.name === 'string') {
      const name = plausibleName(node.name);
      if (name) out.push({ name, role: (typeof node.jobTitle === 'string' && node.jobTitle.slice(0, 60)) || role || null });
    }
    for (const [key, r] of [['founder', 'Founder'], ['founders', 'Founder'], ['employee', null], ['employees', null], ['contactPoint', null], ['member', null], ['@graph', null]]) {
      if (node[key]) visit(node[key], r);
    }
  };
  for (const m of String(html).matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1].trim())); } catch (e) { /* invalid JSON-LD is ignored */ }
  }
  return out;
}

const NAME = "((?:(?:Mr|Mrs|Ms|Miss|Dr|Shri|Smt|Sri)\\.?\\s+)?[A-Z][A-Za-z'’.-]{0,24}(?:\\s+[A-Z][A-Za-z'’.-]{0,24}){1,3})";
const ROLE_THEN_NAME = new RegExp(`\\b(${ROLES})\\s*[:\\-–]\\s*${NAME}`, 'g');
const NAME_THEN_ROLE = new RegExp(`${NAME}\\s*[,\\-–|(]\\s*(${ROLES})\\b`, 'g');

/** "Contact Person: Mr. Ravi Kumar", "Proprietor - Anil Menon", "Priya Nair, Managing Director". */
function namesFromText(html) {
  const out = [];
  for (const line of visibleText(html).split('\n')) {
    const l = line.trim();
    if (!l || l.length > 300 || !ROLE_RE.test(l)) continue;
    for (const m of l.matchAll(ROLE_THEN_NAME)) { const name = plausibleName(m[2]); if (name) out.push({ name, role: m[1] }); }
    for (const m of l.matchAll(NAME_THEN_ROLE)) { const name = plausibleName(m[1]); if (name) out.push({ name, role: m[2] }); }
  }
  return out;
}

/** Same-site links that usually hold contact details. */
function contactLinks(html, pageUrl) {
  const base = new URL(pageUrl);
  const links = [];
  for (const m of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#>]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const label = visibleText(m[2]).trim();
    if (!/contact|about|team|reach|get in touch|enquir|inquir/i.test(`${m[1]} ${label}`)) continue;
    let u;
    try { u = new URL(decodeEntities(m[1]), base); } catch (e) { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    u.hash = '';
    const href = u.toString();
    if (href !== base.toString() && !links.includes(href)) links.push(href);
  }
  // Contact pages before about/team pages.
  return links.sort((a, b) => Number(!/contact/i.test(a)) - Number(!/contact/i.test(b)));
}

/** robots.txt rules for "*" and for our bot; returns a check for paths. Unreadable robots.txt allows. */
async function robotsFor(origin) {
  let text = '';
  try {
    const r = await deps.fetchText(`${origin}/robots.txt`, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: 256 * 1024, headers: { 'User-Agent': UA } });
    if (r.ok) text = r.text;
  } catch (e) { return () => true; }
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'user-agent') {
      if (!lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(m[2].toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (key === 'disallow' || key === 'allow')) current.rules.push({ allow: key === 'allow', path: m[2] });
    }
  }
  const mine = groups.filter(g => g.agents.some(a => a && a !== '*' && 'marketechbot'.includes(a)));
  const rules = (mine.length ? mine : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules).filter(r => r.path);
  return path => {
    let best = null;
    for (const r of rules) {
      const pattern = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
      if (pattern.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
    }
    return !best || best.allow;
  };
}

async function fetchPage(url) {
  const r = await deps.fetchText(url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_BYTES, headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' } });
  if (!r.ok) return null;
  const type = r.headers?.get?.('content-type') || 'text/html';
  return /html|xml|text\/plain/i.test(type) ? { url: r.url || url, html: r.text } : null;
}

const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };
const sameSite = (email, host) => { const d = email.split('@')[1]; return d === host || d.endsWith(`.${host}`) || host.endsWith(`.${d}`); };

/**
 * @returns {Promise<{ email, emailSource, contactPerson, contactRole, contactSource, status }>}
 * status: found | not_found | blocked (robots.txt) | unreachable
 */
async function lookup(website, { want = { email: true, contactPerson: true } } = {}) {
  const result = { email: null, emailSource: null, contactPerson: null, contactRole: null, contactSource: null, status: 'not_found' };
  let start;
  try { start = new URL(website); } catch (e) { result.status = 'unreachable'; return result; }
  if (!/^https?:$/.test(start.protocol)) { result.status = 'unreachable'; return result; }
  const allowed = await robotsFor(start.origin);
  if (!allowed(start.pathname || '/')) { result.status = 'blocked'; return result; }

  const done = () => (!want.email || result.email) && (!want.contactPerson || result.contactPerson);
  const read = page => {
    const host = hostOf(page.url) || hostOf(website);
    if (want.email && !result.email) {
      const emails = findEmails(page.html);
      // An address on the business's own domain is preferred over e.g. a free mailbox.
      const email = emails.find(e => sameSite(e, host)) || emails[0];
      if (email) { result.email = email; result.emailSource = page.url; }
    }
    if (want.contactPerson && !result.contactPerson) {
      const person = namesFromJsonLd(page.html)[0] || namesFromText(page.html)[0];
      if (person) { result.contactPerson = person.name; result.contactRole = person.role || null; result.contactSource = page.url; }
    }
  };

  let home;
  try {
    home = await fetchPage(start.toString());
  } catch (e) {
    result.status = e.code === 'UNSAFE_URL' ? 'blocked' : 'unreachable';
    return result;
  }
  if (!home) { result.status = 'unreachable'; return result; }
  read(home);
  for (const link of done() ? [] : contactLinks(home.html, home.url).slice(0, EXTRA_PAGES)) {
    if (done()) break;
    if (!allowed(new URL(link).pathname)) continue;
    try {
      const page = await fetchPage(link);
      if (page) read(page);
    } catch (e) { /* one unreadable page does not stop the others */ }
  }
  if (result.email || result.contactPerson) result.status = 'found';
  return result;
}

/** Looks up many websites with limited parallelism; onEach(done, total) reports progress. */
async function lookupMany(rows, { want, concurrency = 6, signal, onEach = () => {} } = {}) {
  const out = new Map();
  let next = 0;
  let finished = 0;
  const worker = async () => {
    while (next < rows.length && !signal?.aborted) {
      const row = rows[next++];
      try {
        out.set(row.placeId, await lookup(row.website, { want }));
      } catch (e) {
        out.set(row.placeId, { email: null, contactPerson: null, status: 'unreachable' });
      }
      onEach(++finished, rows.length, row, out.get(row.placeId));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return out;
}

module.exports = { lookup, lookupMany, findEmails, namesFromJsonLd, namesFromText, contactLinks, cleanEmail, deps };
