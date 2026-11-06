/**
 * Deliverability of campaigns sent with Amazon SES:
 *
 * - contentReport: offline checks of a campaign email (subject and HTML) for what mailbox providers
 *   treat as spam signals: image-heavy email, link shorteners, misleading link text, plain-http links,
 *   spam phrases, shouting subjects, clipped size, no postal address. Shown at approval as warnings.
 * - checkLinks: asks each link in the email whether it works (SSRF-safe fetch; only on request).
 * - warm-up: a new sender domain sends a little more each day (50, 100, 200, …) so mailbox providers
 *   can build its reputation. A campaign over today's allowance pauses and continues by itself.
 * - health: bounce and complaint rates of the last 14 days. At the levels where SES itself reviews
 *   or pauses an account, sending is paused before SES does it.
 * - dashboard: the workspace's figures. "Delivered" means the receiving mail server accepted the
 *   email (inbox or spam folder); it is never proof of inbox placement. Acceptance by SES is "sent".
 */
const { run, get, all } = require('../../../db/database');

const num = v => Number(v) || 0;
const rate = (n, d) => (d ? Math.round((n / d) * 10000) / 100 : null);   // percent, 2 decimals
const domainOf = email => String(email || '').trim().toLowerCase().split('@')[1] || '';

// ------------------------------------------------------------------ content

const SHORTENERS = /^(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|tiny\.cc|rb\.gy|t\.ly|s\.id)$/i;
const SPAM_PHRASES = ['100% free', 'act now', 'apply now', 'best price', 'buy now', 'call now', 'cash bonus', 'click here', 'congratulations',
  'dear friend', 'double your', 'earn money', 'extra income', 'free gift', 'free money', 'guaranteed', 'increase sales', 'limited time',
  'lowest price', 'make money', 'no cost', 'no obligation', 'once in a lifetime', 'order now', 'risk-free', 'risk free', 'special promotion',
  'this is not spam', 'urgent', 'winner', 'you have been selected', '$$$', 'cheap', 'miracle', 'unsecured credit'];
const GMAIL_CLIP_BYTES = 102 * 1024;

const decode = s => String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const textOf = html => decode(String(html || '').replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\$\[[^\]]*\]\$/g, ' ').replace(/\s+/g, ' ').trim();

/** The links of an email: href, the visible text, and whether it is a merge tag (filled in per person). */
function linksOf(html) {
  const out = [];
  const re = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) out.push({ href: decode(m[2]).trim(), text: textOf(m[3]) });
  return out;
}

/**
 * Offline checks of one campaign email. issues: [{ code, message }] (warnings: the email can still be
 * approved); stats: words, images, links, size.
 */
function contentReport({ subject, html }) {
  const issues = [];
  const add = (code, message) => issues.push({ code, message });
  const body = String(html || '');
  const text = textOf(body);
  const words = text ? text.split(' ').length : 0;
  const images = (body.match(/<img\b/gi) || []).length;
  const noAlt = (body.match(/<img\b(?![^>]*\balt\s*=\s*["'][^"']+["'])[^>]*>/gi) || []).filter(t => !/width\s*=\s*["']?1["']?/i.test(t)).length;
  const links = linksOf(body).filter(l => !/^\$\[/.test(l.href) && !/^mailto:|^tel:|^#/i.test(l.href));
  const bytes = Buffer.byteLength(body, 'utf8');

  if (images && words < 60) add('IMAGE_HEAVY', `Mostly images (${images} image(s), ${words} words of text). Gmail and Outlook treat image-only email as spam; write the message as text and use images as support.`);
  else if (images && words / images < 40) add('IMAGE_RATIO', `Many images for the amount of text (${images} images, ${words} words). Aim for at least 60% text.`);
  if (noAlt) add('IMAGE_ALT', `${noAlt} image(s) have no alt text: most people see email with images off at first.`);
  if (bytes > GMAIL_CLIP_BYTES) add('CLIPPED', `The email is ${Math.round(bytes / 1024)} KB: Gmail clips email over 102 KB and hides the rest, including the unsubscribe link. Shorten it.`);
  if (links.length > 25) add('MANY_LINKS', `${links.length} links: many links in one email is a spam signal. Keep the important ones.`);

  const hosts = new Set();
  for (const l of links) {
    let u;
    try { u = new URL(l.href); } catch { add('BAD_LINK', `A link is not a web address: "${l.href.slice(0, 80)}".`); continue; }
    hosts.add(u.hostname.toLowerCase());
    if (u.protocol === 'http:') add('HTTP_LINK', `Use https:// for ${u.hostname} (plain http links lower trust).`);
    if (SHORTENERS.test(u.hostname)) add('SHORTENER', `${u.hostname} is a link shortener: spam filters distrust them. Link to the full address.`);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) add('IP_LINK', `A link points to a bare IP address (${u.hostname}): use a domain name.`);
    // Visible text that looks like a different web address than the real target looks like phishing.
    const shown = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.exec(l.text);
    if (shown) {
      const shownHost = new URL(/^https?:/i.test(l.text) ? l.text : `https://${l.text}`).hostname.replace(/^www\./, '').toLowerCase();
      const realHost = u.hostname.replace(/^www\./, '').toLowerCase();
      if (shownHost !== realHost && !realHost.endsWith(`.${shownHost}`) && !shownHost.endsWith(`.${realHost}`)) add('MISLEADING_LINK', `A link shows "${l.text.slice(0, 60)}" but goes to ${u.hostname}: filters flag this as phishing.`);
    }
  }

  const subj = String(subject || '');
  const found = SPAM_PHRASES.filter(p => (`${subj} ${text}`).toLowerCase().includes(p));
  if (found.length) add('SPAM_WORDS', `Words spam filters watch for: ${found.slice(0, 6).map(p => `"${p}"`).join(', ')}. Say it more plainly.`);
  const capsWords = (subj.match(/\b[A-Z]{4,}\b/g) || []).length;
  if (capsWords >= 2 || (subj.length > 8 && subj === subj.toUpperCase() && /[A-Z]/.test(subj))) add('SUBJECT_CAPS', 'The subject shouts (capital letters): write it in normal case.');
  if (/[!?]{2,}/.test(subj) || (subj.match(/!/g) || []).length > 1) add('SUBJECT_PUNCT', 'Several "!" or "?" in the subject: use at most one.');
  if (/^\s*(re|fw|fwd)\s*:/i.test(subj)) add('SUBJECT_FAKE_REPLY', 'The subject starts with "Re:" or "Fwd:" but this is not a reply: filters and people treat it as deceptive.');
  if (subj.length > 80) add('SUBJECT_LONG', `The subject is ${subj.length} characters: under 60 shows in full on phones.`);
  if (/font-size\s*:\s*0|display\s*:\s*none|visibility\s*:\s*hidden/i.test(body.replace(/<img\b[^>]*>/gi, ''))) add('HIDDEN_TEXT', 'The email hides some content (display:none or font-size:0): hidden text is a spam signal.');
  if (!/\$\[HF:ORGADDRESS\]\$/i.test(body)) add('NO_ADDRESS', 'No postal address: add $[HF:ORGADDRESS]$ to the footer (anti-spam laws ask for one, and it builds trust).');
  return { issues, stats: { words, images, links: links.length, linkDomains: [...hosts].slice(0, 20), sizeKb: Math.round(bytes / 102.4) / 10 } };
}

// ------------------------------------------------------------------ links

let linkFetcher = null;
/** Tests replace the network call (tests never reach the internet). */
function setLinkFetcherForTests(fn) { linkFetcher = fn; }

/** Whether each link works: [{ url, ok, status, error }]. Merge-tag links (unsubscribe, view) are skipped. */
async function checkLinks(html, { max = 20 } = {}) {
  const urls = [...new Set(linksOf(html).map(l => l.href).filter(h => /^https?:\/\//i.test(h)))].slice(0, max);
  const fetcher = linkFetcher || (url => require('../../../lib/safeFetch').safeFetchBuffer(url, { timeoutMs: 8000, maxBytes: 64 * 1024, headers: { 'User-Agent': 'Marketech.ai link check' } }));
  return Promise.all(urls.map(async url => {
    try {
      const r = await fetcher(url);
      return { url, ok: r.status < 400, status: r.status, error: r.status >= 400 ? `The page answered HTTP ${r.status}.` : null };
    } catch (err) {
      return { url, ok: false, status: null, error: err.code === 'UNSAFE_URL' ? 'Not a public web address.' : 'The page could not be reached.' };
    }
  }));
}

// ------------------------------------------------------------------ warm-up

/** A DATETIME from MySQL (Date, or "YYYY-MM-DD HH:MM:SS" in UTC) as a Date; null when missing or invalid. */
const toDate = v => {
  const d = v instanceof Date ? v : v ? new Date(`${String(v).replace(' ', 'T')}Z`) : null;
  return d && Number.isFinite(d.getTime()) ? d : null;
};

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);
const WARMUP = () => ({ start: env('SES_WARMUP_START', 50), factor: env('SES_WARMUP_FACTOR', 2), days: env('SES_WARMUP_DAYS', 10) });

/** Today's warm-up allowance for a workspace's sender domain (null: warmed up, no limit). */
function warmupCap(dayIndex) {
  const w = WARMUP();
  if (dayIndex >= w.days) return null;
  return Math.round(w.start * Math.pow(w.factor, Math.max(0, dayIndex)));
}

async function warmupEnabled(workspaceId) {
  const r = await get('SELECT ses_warmup_enabled FROM mail_delivery_settings WHERE workspace_id = ?', [workspaceId]).catch(() => null);
  return !r || r.ses_warmup_enabled === null || r.ses_warmup_enabled === undefined ? true : !!Number(r.ses_warmup_enabled);
}

/** Emails accepted by SES for a workspace's sender domain: first ever, last 24 hours, oldest of those. */
async function domainVolume(workspaceId, domain) {
  const r = await get(`SELECT MIN(r.sent_at) AS first_at,
      SUM(r.sent_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR) AS last24,
      MIN(CASE WHEN r.sent_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR THEN r.sent_at END) AS oldest24
    FROM mail_campaign_recipients r JOIN mail_campaigns c ON c.id = r.campaign_id AND c.workspace_id = r.workspace_id
    WHERE r.workspace_id = ? AND r.status = 'sent' AND r.sent_at IS NOT NULL AND LOWER(SUBSTRING_INDEX(c.from_email, '@', -1)) = ?`, [workspaceId, domain]);
  return { firstAt: toDate(r?.first_at), last24: num(r?.last24), oldest24: toDate(r?.oldest24) };
}

/** The warm-up state of one sender domain: day, today's cap, sent in 24 hours, what is left, when more is allowed. */
async function warmup(workspaceId, domain) {
  const v = await domainVolume(workspaceId, domain);
  const first = toDate(v.firstAt);
  const day = first ? Math.max(0, Math.floor((Date.now() - first.getTime()) / 86400000)) : 0;
  const enabled = await warmupEnabled(workspaceId);
  const cap = enabled ? warmupCap(day) : null;
  const remaining = cap === null ? null : Math.max(0, cap - v.last24);
  const oldest = toDate(v.oldest24);
  const resumeAt = remaining === 0 ? new Date(Math.max(Date.now() + 15 * 60000, (oldest ? oldest.getTime() : Date.now()) + 86400000 + 60000)) : null;
  return { domain, enabled, day: day + 1, cap, sentLast24h: v.last24, remaining, resumeAt, warmedUp: enabled && cap === null, firstSentAt: first };
}

// ------------------------------------------------------------------ health

// SES reviews an account at 5% bounces / 0.1% complaints and may pause it at 10% / 0.5%.
const HEALTH = () => ({ windowDays: env('SES_HEALTH_DAYS', 14), minSent: env('SES_HEALTH_MIN_SENT', 100),
  bounceWarn: 5, bounceStop: env('SES_HEALTH_BOUNCE_STOP', 10), complaintWarn: 0.1, complaintStop: env('SES_HEALTH_COMPLAINT_STOP', 0.5) });

/** Bounce and complaint rates of the workspace's campaigns in the last 14 days, with a level. */
async function health(workspaceId) {
  const h = HEALTH();
  const r = await get(`SELECT COUNT(*) AS sent, SUM(t.delivered_at IS NOT NULL) AS delivered, SUM(t.bounced_at IS NOT NULL) AS hard,
      SUM(t.complained_at IS NOT NULL) AS complaints
    FROM mail_campaign_recipients r LEFT JOIN mail_message_tracking t ON t.id = r.tracking_id
    WHERE r.workspace_id = ? AND r.status = 'sent' AND r.sent_at >= UTC_TIMESTAMP() - INTERVAL ? DAY`, [workspaceId, h.windowDays]);
  const sent = num(r?.sent);
  const bounceRate = rate(num(r?.hard), sent);
  const complaintRate = rate(num(r?.complaints), num(r?.delivered) || sent);
  const enough = sent >= h.minSent;
  let level = 'good';
  const reasons = [];
  if (bounceRate !== null && bounceRate >= h.bounceWarn) { level = 'warning'; reasons.push(`bounce rate ${bounceRate}% (keep it under ${h.bounceWarn}%)`); }
  if (complaintRate !== null && complaintRate >= h.complaintWarn) { level = 'warning'; reasons.push(`complaint rate ${complaintRate}% (keep it under ${h.complaintWarn}%)`); }
  const stopped = enough && ((bounceRate || 0) >= h.bounceStop || (complaintRate || 0) >= h.complaintStop);
  if (stopped) level = 'critical';
  return {
    windowDays: h.windowDays, sent, hardBounces: num(r?.hard), complaints: num(r?.complaints), bounceRate, complaintRate, level, stopped, reasons,
    thresholds: { bounceWarn: h.bounceWarn, bounceStop: h.bounceStop, complaintWarn: h.complaintWarn, complaintStop: h.complaintStop, minSent: h.minSent },
    message: stopped
      ? `Sending is paused: in the last ${h.windowDays} days the ${reasons.join(' and ')} reached the level where Amazon SES pauses accounts. Remove bounced and inactive addresses from your lists (they are already on the stop-list) and send only to people who asked for your email. Sending is allowed again when the rates drop.`
      : level === 'warning' ? `Watch out: ${reasons.join(' and ')} in the last ${h.windowDays} days.` : null
  };
}

/** What a send may do right now: paused for health, or how many more the warm-up allows today. */
async function allowance(row) {
  const hl = await health(row.workspace_id);
  const w = await warmup(row.workspace_id, domainOf(row.from_email));
  return { health: hl, warmup: w, blocked: hl.stopped, remaining: w.remaining };
}

// ------------------------------------------------------------------ dashboard

const RECEIVERS = [
  ['Gmail', ['gmail.com', 'googlemail.com']], ['Outlook / Hotmail', ['outlook.com', 'hotmail.com', 'live.com', 'msn.com']],
  ['Yahoo', ['yahoo.com', 'ymail.com', 'yahoo.co.in', 'yahoo.co.uk']], ['iCloud', ['icloud.com', 'me.com', 'mac.com']]
];
const receiverOf = email => {
  const d = domainOf(email);
  return (RECEIVERS.find(([, ds]) => ds.includes(d)) || ['Business and other'])[0];
};

/** The workspace's deliverability figures for the last N days. */
async function dashboard(workspaceId, { days = 30 } = {}) {
  const d = Math.max(1, Math.min(90, parseInt(days, 10) || 30));
  const totals = await get(`SELECT
      SUM(r.status = 'sent') AS sent, SUM(r.status = 'failed') AS rejected, SUM(r.status = 'unknown') AS unknown,
      SUM(r.status = 'sent' AND t.delivered_at IS NOT NULL) AS delivered, SUM(r.status = 'sent' AND t.bounced_at IS NOT NULL) AS hard,
      SUM(r.status = 'sent' AND t.delivery_status = 'deferred') AS soft, SUM(r.status = 'sent' AND t.complained_at IS NOT NULL) AS complaints,
      SUM(r.status = 'sent' AND t.first_open_at IS NOT NULL) AS opened, SUM(r.status = 'sent' AND t.first_click_at IS NOT NULL) AS clicked
    FROM mail_campaign_recipients r LEFT JOIN mail_message_tracking t ON t.id = r.tracking_id
    WHERE r.workspace_id = ? AND r.status IN ('sent', 'failed', 'unknown') AND r.updated_at >= UTC_TIMESTAMP() - INTERVAL ? DAY`, [workspaceId, d]);
  const unsub = await get(`SELECT COUNT(DISTINCT r.email) AS n FROM mail_campaign_recipients r JOIN email_suppressions s ON s.workspace_id = r.workspace_id AND s.email = r.email
    WHERE r.workspace_id = ? AND r.status = 'sent' AND s.reason = 'unsubscribed' AND s.created_at >= r.sent_at AND r.sent_at >= UTC_TIMESTAMP() - INTERVAL ? DAY`, [workspaceId, d]);
  const sesRejects = await get(`SELECT COUNT(*) AS n FROM mail_events e JOIN mail_message_tracking t ON t.id = e.tracking_id
    WHERE e.workspace_id = ? AND e.source = 'ses' AND e.event_type = 'failed' AND t.campaign_id IS NOT NULL AND e.occurred_at >= UTC_TIMESTAMP() - INTERVAL ? DAY`, [workspaceId, d]);
  const n = k => num(totals?.[k]);
  const sent = n('sent');
  const attempted = sent + n('rejected') + n('unknown');
  const delivered = n('delivered');
  const rejected = n('rejected') + num(sesRejects?.n);

  const daily = await all(`SELECT DATE(r.sent_at) AS day, COUNT(*) AS sent, SUM(t.delivered_at IS NOT NULL) AS delivered, SUM(t.bounced_at IS NOT NULL) AS bounced,
      SUM(t.complained_at IS NOT NULL) AS complaints
    FROM mail_campaign_recipients r LEFT JOIN mail_message_tracking t ON t.id = r.tracking_id
    WHERE r.workspace_id = ? AND r.status = 'sent' AND r.sent_at >= UTC_TIMESTAMP() - INTERVAL ? DAY GROUP BY DATE(r.sent_at) ORDER BY day`, [workspaceId, d]);
  const byDay = new Map(daily.map(x => [String(x.day instanceof Date ? x.day.toISOString().slice(0, 10) : x.day).slice(0, 10), x]));
  const series = [];
  for (let i = d - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const x = byDay.get(key);
    series.push({ day: key, sent: num(x?.sent), delivered: num(x?.delivered), bounced: num(x?.bounced), complaints: num(x?.complaints) });
  }

  const people = await all(`SELECT r.email, t.delivered_at IS NOT NULL AS delivered, t.bounced_at IS NOT NULL AS bounced, t.complained_at IS NOT NULL AS complained,
      t.first_open_at IS NOT NULL AS opened
    FROM mail_campaign_recipients r LEFT JOIN mail_message_tracking t ON t.id = r.tracking_id
    WHERE r.workspace_id = ? AND r.status = 'sent' AND r.sent_at >= UTC_TIMESTAMP() - INTERVAL ? DAY LIMIT 200000`, [workspaceId, d]);
  const recv = new Map();
  for (const p of people) {
    const k = receiverOf(p.email);
    const e = recv.get(k) || { receiver: k, sent: 0, delivered: 0, bounced: 0, complaints: 0, opened: 0 };
    e.sent++; e.delivered += num(p.delivered); e.bounced += num(p.bounced); e.complaints += num(p.complained); e.opened += num(p.opened);
    recv.set(k, e);
  }
  const receivers = [...recv.values()].sort((a, b) => b.sent - a.sent)
    .map(e => ({ ...e, deliveryRate: rate(e.delivered, e.sent), bounceRate: rate(e.bounced, e.sent), complaintRate: rate(e.complaints, e.delivered || e.sent), openRate: rate(e.opened, e.delivered || e.sent) }));

  const domains = await all(`SELECT DISTINCT LOWER(SUBSTRING_INDEX(from_email, '@', -1)) AS domain FROM mail_campaigns
    WHERE workspace_id = ? AND from_email IS NOT NULL AND from_email <> '' AND status IN ('approved', 'submitting', 'submitted', 'failed') ORDER BY domain LIMIT 20`, [workspaceId]);
  const warmups = [];
  for (const x of domains) warmups.push(await warmup(workspaceId, x.domain));

  return {
    days: d,
    totals: {
      attempted, sent, delivered, hardBounces: n('hard'), softBounces: n('soft'), complaints: n('complaints'), unsubscribes: num(unsub?.n),
      rejected, unknown: n('unknown'), opened: n('opened'), clicked: n('clicked')
    },
    rates: {
      delivery: rate(delivered, sent), bounce: rate(n('hard'), sent), complaint: rate(n('complaints'), delivered || sent),
      unsubscribe: rate(num(unsub?.n), delivered || sent), rejection: rate(rejected, attempted), open: rate(n('opened'), delivered || sent)
    },
    daily: series, receivers, warmups, health: await health(workspaceId),
    gmailReputation: { available: false, reason: 'Gmail shares domain reputation only in Google Postmaster Tools (postmaster.google.com) after you verify your sending domain there and send enough Gmail volume; it is not available to Marketech.ai.' },
    note: 'Sent means Amazon SES accepted the email. Delivered means the recipient\'s mail server accepted it: it may still be in the spam folder. No provider reports inbox placement.'
  };
}

module.exports = { contentReport, checkLinks, linksOf, setLinkFetcherForTests, warmup, warmupCap, health, allowance, dashboard, domainOf, receiverOf };
