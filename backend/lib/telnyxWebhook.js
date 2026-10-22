const crypto = require('crypto');

/**
 * Telnyx webhook signature verification (Ed25519).
 *
 * Telnyx signs `${telnyx-timestamp}|${raw request body}` with the account's Ed25519 key and sends
 * the base64 signature in `telnyx-signature-ed25519`. The public key (Mission Control → Account
 * Settings → Keys & Credentials → Public Key) goes in TELNYX_PUBLIC_KEY, as the base64 raw 32-byte
 * key or a PEM. Without it the webhooks stay closed (fail closed).
 */
const TOLERANCE_SECONDS = 300;
// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

let cachedKey = { source: null, key: null };

function publicKey() {
  const source = (process.env.TELNYX_PUBLIC_KEY || '').trim();
  if (!source) return null;
  if (cachedKey.source === source) return cachedKey.key;
  let key = null;
  try {
    if (source.includes('BEGIN PUBLIC KEY')) {
      key = crypto.createPublicKey(source);
    } else {
      const raw = Buffer.from(source, 'base64');
      if (raw.length === 32) key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    }
    if (key && key.asymmetricKeyType !== 'ed25519') key = null;
  } catch (e) {
    key = null;
  }
  cachedKey = { source, key };
  return key;
}

// Signatures already accepted (this process only), so a captured request cannot be replayed
// inside the timestamp window.
const seen = new Map();
function rememberSignature(signature, nowSec) {
  for (const [k, exp] of seen) if (exp < nowSec) seen.delete(k);
  const id = crypto.createHash('sha256').update(signature).digest('hex');
  if (seen.has(id)) return false;
  seen.set(id, nowSec + TOLERANCE_SECONDS * 2);
  return true;
}

/** Returns null when valid, otherwise a short reason code (never the signature or body). */
function verify({ rawBody, signature, timestamp, key, nowSec = Math.floor(Date.now() / 1000) }) {
  if (!signature || !timestamp) return 'MISSING_SIGNATURE';
  if (!/^\d{1,12}$/.test(String(timestamp))) return 'MALFORMED_TIMESTAMP';
  if (Math.abs(nowSec - Number(timestamp)) > TOLERANCE_SECONDS) return 'STALE_TIMESTAMP';
  const sig = Buffer.from(String(signature), 'base64');
  if (sig.length !== 64) return 'MALFORMED_SIGNATURE';
  const message = Buffer.concat([Buffer.from(`${timestamp}|`), Buffer.isBuffer(rawBody) ? rawBody : Buffer.alloc(0)]);
  let ok = false;
  try { ok = crypto.verify(null, message, key, sig); } catch (e) { ok = false; }
  if (!ok) return 'INVALID_SIGNATURE';
  if (!rememberSignature(String(signature), nowSec)) return 'REPLAYED';
  return null;
}

/** Express middleware: rejects before any handler work (database, AI, usage). */
function requireTelnyxSignature() {
  return function telnyxSignatureMiddleware(req, res, next) {
    const key = publicKey();
    if (!key) {
      console.warn('[telnyx] webhook rejected: TELNYX_PUBLIC_KEY is missing or not a valid Ed25519 public key');
      return res.status(503).type('text/plain').send('Telnyx webhooks are not configured');
    }
    const reason = verify({
      rawBody: req.rawBody,
      signature: req.get('telnyx-signature-ed25519'),
      timestamp: req.get('telnyx-timestamp'),
      key
    });
    if (reason) {
      console.warn(`[telnyx] webhook rejected: ${reason}`);
      return res.status(401).type('text/plain').send('Invalid signature');
    }
    next();
  };
}

module.exports = { requireTelnyxSignature, verify, TOLERANCE_SECONDS };
