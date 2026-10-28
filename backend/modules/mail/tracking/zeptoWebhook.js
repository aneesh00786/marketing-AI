/**
 * ZeptoMail (Zoho CPaaS) webhook: signature verification and payload parsing.
 *
 * Documented (zoho.com/zeptomail/help/webhooks.html):
 * - header "producer-signature: ts=<ms>;s=<URL-encoded base64 HMAC>;s-algorithm=HmacSHA256";
 * - the HMAC-SHA256 is computed over the webhook request body with the Agent's Authentication Key;
 *   the sample code signs the (URL-decoded) value of a form-encoded body;
 * - fields: event_name, event_message[] (request_id, email_info, event_data), mailagent_key,
 *   webhook_request_id.
 * NOT documented: a complete sample payload, and whether ts is part of the signed input. The
 * parser therefore accepts only events it can map to a known type and to one of this workspace's
 * emails, and the whole integration stays off until ZEPTOMAIL_WEBHOOKS_ENABLED=1 is set after an
 * authorized test event has confirmed the format (see the setup notes in the final report).
 */
const crypto = require('crypto');

const TOLERANCE_MS = 5 * 60 * 1000;
const MAX_EVENTS = 100;

function parseSignatureHeader(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return { ts: out.ts, s: out.s, alg: out['s-algorithm'] };
}

/** Inputs the signature may cover: the raw body, and for a form-encoded body the decoded value of its single field. */
function signedCandidates(rawBody, contentType) {
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  const out = [raw];
  if (/application\/x-www-form-urlencoded/i.test(String(contentType || ''))) {
    const text = raw.toString('utf8');
    const i = text.indexOf('=');
    if (i > 0 && !text.includes('&')) {
      try { out.push(Buffer.from(decodeURIComponent(text.slice(i + 1).replace(/\+/g, ' ')), 'utf8')); } catch { /* not decodable */ }
    }
  }
  return out;
}

/** Verifies producer-signature. Returns { ok: true } or { ok: false, reason }. */
function verifySignature({ header, rawBody, contentType, key, now = Date.now() }) {
  if (!key) return { ok: false, reason: 'no_key' };
  const { ts, s, alg } = parseSignatureHeader(header);
  if (!ts || !s || !alg) return { ok: false, reason: 'missing_signature' };
  if (String(alg).toLowerCase() !== 'hmacsha256') return { ok: false, reason: 'algorithm' };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > TOLERANCE_MS) return { ok: false, reason: 'stale' };
  let given;
  try { given = Buffer.from(decodeURIComponent(s), 'base64'); } catch { return { ok: false, reason: 'malformed_signature' }; }
  if (given.length !== 32) return { ok: false, reason: 'malformed_signature' };
  for (const candidate of signedCandidates(rawBody, contentType)) {
    const expected = crypto.createHmac('sha256', key).update(candidate).digest();
    if (crypto.timingSafeEqual(expected, given)) return { ok: true };
  }
  return { ok: false, reason: 'mismatch' };
}

const asArray = v => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

const TYPE_MAP = {
  hardbounce: 'hard_bounce', softbounce: 'soft_bounce',
  delivered: 'delivered', emaildelivered: 'delivered', delivery: 'delivered',
  open: 'opened', opens: 'opened', emailopen: 'opened', opened: 'opened',
  click: 'clicked', clicks: 'clicked', linkclick: 'clicked', linkclicks: 'clicked', emaillinkclick: 'clicked', clicked: 'clicked',
  feedbackloop: 'complaint', spam: 'complaint', complaint: 'complaint', spamcomplaint: 'complaint'
};
const normalizeType = v => TYPE_MAP[String(v || '').toLowerCase().replace(/[^a-z]/g, '')] || null;

function parseTime(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return isNaN(d) ? null : d;
  }
  const d = new Date(String(v));
  return isNaN(d) ? null : d;
}

/** The body as an object: JSON, or a form-encoded body whose single field holds JSON. */
function bodyObject(body) {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    const keys = Object.keys(body);
    if (keys.length === 1 && typeof body[keys[0]] === 'string' && /^\s*[{[]/.test(body[keys[0]])) {
      try { return JSON.parse(body[keys[0]]); } catch { return null; }
    }
    return body;
  }
  return null;
}

/**
 * Extracts events. Each: { type, requestId, clientReference, occurredAt (Date|null), reason, diagnostic, url }.
 * Unknown event names are skipped (counted in `unrecognized`).
 */
function parsePayload(body) {
  const obj = bodyObject(body);
  if (!obj || typeof obj !== 'object') return { ok: false, events: [], unrecognized: 0 };
  const names = asArray(obj.event_name);
  const messages = asArray(obj.event_message);
  const events = [];
  let unrecognized = 0;
  messages.slice(0, MAX_EVENTS).forEach((msg, i) => {
    if (!msg || typeof msg !== 'object') { unrecognized++; return; }
    const info = msg.email_info && typeof msg.email_info === 'object' ? msg.email_info : {};
    const requestId = msg.request_id || info.request_id || null;
    const clientReference = info.client_reference || msg.client_reference || null;
    const data = asArray(msg.event_data);
    const type = normalizeType(names[i] ?? names[0] ?? msg.event_name ?? data[0]?.object);
    if (!type || (!requestId && !clientReference)) { unrecognized++; return; }
    const details = data.flatMap(d => (d && Array.isArray(d.details) && d.details.length ? d.details : [d])).filter(Boolean);
    for (const d of details.length ? details : [{}]) {
      events.push({
        type,
        requestId: requestId ? String(requestId).slice(0, 255) : null,
        clientReference: clientReference ? String(clientReference).slice(0, 64) : null,
        occurredAt: parseTime(d.time ?? d.event_time ?? msg.event_time ?? d.processed_time),
        reason: d.reason ?? d.bounce_reason ?? null,
        diagnostic: d.diagnostic_message ?? null,
        url: d.clicked_link ?? d.link ?? d.url ?? null
      });
    }
  });
  return { ok: true, events: events.slice(0, MAX_EVENTS), unrecognized, webhookRequestId: obj.webhook_request_id ? String(obj.webhook_request_id).slice(0, 128) : null };
}

module.exports = { parseSignatureHeader, verifySignature, parsePayload, normalizeType, TOLERANCE_MS };
