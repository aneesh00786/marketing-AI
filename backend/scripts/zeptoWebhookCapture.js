#!/usr/bin/env node
/**
 * STAGING DIAGNOSTIC — capture ZeptoMail (Zoho CPaaS) test webhooks to confirm their real format
 * before ZEPTOMAIL_WEBHOOKS_ENABLED is ever set. See docs/EMAIL_TRACKING_STAGING.md.
 *
 * A standalone listener: no database, no app code, no outgoing requests. It prints a REDACTED view
 * of each request (header names, signature shape, body structure with types; addresses, ids and
 * the signature itself are masked) and, when the Authentication Key is supplied through the
 * CAPTURE_KEY environment variable (never printed), which signing input reproduces the signature.
 * It only reports: the application's verifier is not changed by anything this tool finds.
 *
 *   CAPTURE_KEY=<key from ZeptoMail> node scripts/zeptoWebhookCapture.js --staging --port 8787 [--respond 200|500|429]
 *
 * --respond 500/429 answers with that status to observe ZeptoMail's retry schedule (each delivery is
 * logged with its arrival time and a hash of webhook_request_id). Stop with Ctrl+C.
 */
const http = require('http');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
if (!args.includes('--staging') || process.env.NODE_ENV === 'production') {
  console.error('Refusing to run: staging diagnostic only (pass --staging; never with NODE_ENV=production).');
  process.exit(2);
}
const PORT = parseInt(opt('port') || '8787', 10);
const RESPOND = parseInt(opt('respond') || '200', 10);
const PATH = `/capture/${crypto.randomBytes(12).toString('hex')}`;
const KEY = process.env.CAPTURE_KEY || '';
const hash = v => crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 10);

/** Structure of a value with personal data and identifiers masked. */
function shape(v, depth = 0) {
  if (depth > 12) return '…';
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1), ...(v.length > 1 ? [`(+${v.length - 1} more)`] : [])] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  if (typeof v === 'string') {
    if (/@/.test(v)) return `<address ${hash(v)}>`;
    if (/^https?:\/\//i.test(v)) { try { const u = new URL(v); return `<url ${u.host}${u.pathname.slice(0, 40)}${u.search ? ' +query' : ''}>`; } catch { return '<url>'; } }
    if (/^\d{10,13}$/.test(v)) return `<digits len=${v.length}>`;
    if (v.length > 24) return `<string len=${v.length} ${hash(v)}>`;
    return v;
  }
  if (typeof v === 'number') return Number.isInteger(v) && v > 1e9 ? `<number len=${String(v).length}>` : v;
  return v;
}

/** First value of a key anywhere in the body (e.g. inside a form field that holds the JSON). */
function findKey(v, key, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 6) return null;
  if (!Array.isArray(v) && v[key] !== undefined) return v[key];
  for (const x of Object.values(v)) { const f = findKey(x, key, depth + 1); if (f !== null && f !== undefined) return f; }
  return null;
}

function parseSig(h) {
  const out = {};
  for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim(); }
  return out;
}

/** Candidate signing inputs. Reported only; nothing here is accepted by the application. */
function candidates(raw, contentType, ts) {
  const text = raw.toString('utf8');
  const list = [['raw body (documented)', raw]];
  if (/x-www-form-urlencoded/i.test(contentType || '')) {
    const i = text.indexOf('=');
    if (i > 0) { try { list.push(['decoded value of form field (documented sample code)', Buffer.from(decodeURIComponent(text.slice(i + 1).replace(/\+/g, ' ')))]); } catch { /* skip */ } }
  }
  if (ts) {
    list.push(['ts + body', Buffer.from(ts + text)], ['ts + "." + body', Buffer.from(`${ts}.${text}`)], ['body + ts', Buffer.from(text + ts)]);
  }
  return list;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => { chunks.push(c); if (chunks.reduce((n, b) => n + b.length, 0) > 2 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    const now = Date.now();
    if (req.url.split('?')[0] !== PATH || req.method !== 'POST') { res.writeHead(404).end(); return; }
    const raw = Buffer.concat(chunks);
    const ct = req.headers['content-type'] || '';
    const sig = parseSig(req.headers['producer-signature']);
    let body = null;
    try { body = /json/i.test(ct) ? JSON.parse(raw.toString('utf8')) : Object.fromEntries(new URLSearchParams(raw.toString('utf8'))); } catch { body = '<unparseable>'; }
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      for (const [k, v] of Object.entries(body)) if (typeof v === 'string' && /^\s*[{[]/.test(v)) { try { body[k] = JSON.parse(v); } catch { /* keep */ } }
    }
    const tsNum = Number(sig.ts);
    const report = {
      at: new Date(now).toISOString(),
      method: req.method,
      contentType: ct,
      headerNames: Object.keys(req.headers).sort(),
      producerSignature: req.headers['producer-signature'] ? {
        partNames: Object.keys(sig),
        ts: sig.ts ? { digits: String(sig.ts).length, unitGuess: String(sig.ts).length >= 13 ? 'milliseconds' : 'seconds', skewSeconds: Number.isFinite(tsNum) ? Math.round((now - (String(sig.ts).length >= 13 ? tsNum : tsNum * 1000)) / 1000) : null } : null,
        algorithm: sig['s-algorithm'] || null,
        signature: sig.s ? { length: sig.s.length, urlEncoded: /%[0-9a-f]{2}/i.test(sig.s), decodedBytes: (() => { try { return Buffer.from(decodeURIComponent(sig.s), 'base64').length; } catch { return null; } })() } : null
      } : 'missing',
      authorizationHeaderPresent: !!req.headers.authorization,
      bodyBytes: raw.length,
      body: shape(body),
      webhookRequestIdHash: (() => { const w = findKey(body, 'webhook_request_id'); return w ? hash(w) : null; })()
    };
    if (KEY && sig.s) {
      let given = null;
      try { given = Buffer.from(decodeURIComponent(sig.s), 'base64'); } catch { /* malformed */ }
      report.signatureCheck = candidates(raw, ct, sig.ts).map(([name, input]) => {
        const mac = crypto.createHmac('sha256', KEY).update(input).digest();
        return { input: name, matches: !!given && given.length === mac.length && crypto.timingSafeEqual(given, mac) };
      });
    } else report.signatureCheck = KEY ? 'no signature header' : 'CAPTURE_KEY not set: signature input not checked';
    console.log(JSON.stringify(report, null, 2));
    res.writeHead(RESPOND, { 'Content-Type': 'application/json' }).end(JSON.stringify({ received: true }));
  });
});

server.listen(PORT, () => {
  console.log(`Capture listening on port ${PORT}. Webhook path (expose through the staging proxy over https): ${PATH}`);
  console.log(`Answering with HTTP ${RESPOND}. CAPTURE_KEY ${KEY ? 'set' : 'not set'} (never printed).`);
});
