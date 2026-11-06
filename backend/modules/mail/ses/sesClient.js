/**
 * Minimal Amazon SES (API v2) client, signed with AWS Signature Version 4 (no SDK dependency).
 * Only these calls are made:
 * - GET  /v2/email/account                 (connection test: sending enabled, sandbox, quota)
 * - GET  /v2/email/identities/{identity}   (is a sender address or its domain verified)
 * - POST /v2/email/outbound-emails         (send one raw MIME email to one recipient)
 * The secret key is only used to sign requests here; it is never logged or returned.
 */
const crypto = require('crypto');

const TIMEOUT_MS = 20000;
const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const NOT_CONNECTED_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

function sesError(message, { status = 502, code = 'SES_ERROR', providerCode = null, outcomeUnknown = false } = {}) {
  return Object.assign(new Error(message), { status, code, providerCode, outcomeUnknown, expose: true });
}

const sha256hex = v => crypto.createHash('sha256').update(v).digest('hex');
const hmac = (key, v) => crypto.createHmac('sha256', key).update(v).digest();
const rfc3986 = s => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** AWS Signature Version 4 headers for one request (service "ses"). */
function sign({ method, host, path, body = '', region, accessKeyId, secretAccessKey, now = new Date(), service = 'ses' }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers = { host, 'x-amz-date': amzDate, ...(body ? { 'content-type': 'application/json' } : {}) };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}\n`).join('');
  // Non-S3 services: each path segment is URI-encoded again for the canonical request.
  const canonicalUri = path.split('/').map(seg => rfc3986(seg)).join('/');
  const canonical = [method, canonicalUri, '', canonicalHeaders, signedHeaders, sha256hex(body)].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return {
    'X-Amz-Date': amzDate,
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}

function assertConfig(cfg) {
  if (!cfg || !REGION_RE.test(String(cfg.region || ''))) throw sesError('Amazon SES region is missing or invalid (for example us-east-1).', { status: 400, code: 'SES_NOT_CONFIGURED' });
  if (!cfg.accessKeyId || !cfg.secretAccessKey) throw sesError('Amazon SES access keys are missing.', { status: 400, code: 'SES_NOT_CONFIGURED' });
}

/**
 * One signed request. writes=true: a timeout, dropped connection or 5xx is "outcome unknown" (the
 * email may or may not have gone), never retried here.
 */
async function request(cfg, method, path, payload, { write = false } = {}) {
  assertConfig(cfg);
  const host = `email.${cfg.region}.amazonaws.com`;
  const body = payload ? JSON.stringify(payload) : '';
  const encodedPath = path.split('/').map(seg => encodeURIComponent(decodeURIComponent(seg))).join('/');
  let res;
  try {
    res = await fetch(`https://${host}${encodedPath}`, {
      method,
      headers: sign({ method, host, path: encodedPath, body, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }),
      body: body || undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    if (!write || NOT_CONNECTED_CODES.has(code)) throw sesError('Amazon SES could not be reached. Try again later.', { code: 'SES_UNREACHABLE' });
    throw sesError('Amazon SES did not confirm the request (timeout or dropped connection). The email may or may not have been sent.', { code: 'SES_OUTCOME_UNKNOWN', outcomeUnknown: true });
  }
  const data = await res.json().catch(() => null);
  if (res.ok) return data || {};
  const type = String(res.headers.get('x-amzn-errortype') || data?.__type || '').split(':')[0].split('#').pop() || `HTTP${res.status}`;
  const message = String(data?.message || data?.Message || `HTTP ${res.status}`).slice(0, 300);
  if (res.status >= 500 && write) throw sesError(`Amazon SES returned HTTP ${res.status}. The email may or may not have been sent.`, { code: 'SES_OUTCOME_UNKNOWN', outcomeUnknown: true, providerCode: type });
  throw sesError(`Amazon SES: ${message}`, { status: res.status === 429 ? 429 : 400, code: 'SES_API_ERROR', providerCode: type });
}

/** Account status: sending enabled, out of the sandbox, 24-hour quota and maximum send rate. */
async function getAccount(cfg) {
  const d = await request(cfg, 'GET', '/v2/email/account');
  const q = d.SendQuota || {};
  return {
    sendingEnabled: d.SendingEnabled !== false,
    productionAccess: !!d.ProductionAccessEnabled,
    enforcementStatus: d.EnforcementStatus || null,
    max24HourSend: q.Max24HourSend != null ? Number(q.Max24HourSend) : null,
    sentLast24Hours: q.SentLast24Hours != null ? Number(q.SentLast24Hours) : null,
    maxSendRate: q.MaxSendRate != null ? Number(q.MaxSendRate) : null
  };
}

/** Whether SES may send from this address: the address or its domain verified. */
async function identityVerified(cfg, email) {
  const domain = String(email).split('@')[1] || '';
  for (const id of [email, domain].filter(Boolean)) {
    try {
      const d = await request(cfg, 'GET', `/v2/email/identities/${encodeURIComponent(id)}`);
      if (d.VerifiedForSendingStatus) return { verified: true, identity: id };
    } catch (err) {
      if (err.providerCode !== 'NotFoundException') throw err;
    }
  }
  return { verified: false, identity: null };
}

/**
 * Sends one raw MIME email to one recipient. tags: SES message tags (letters, digits, _ and -),
 * returned with every SES event, so events can be matched to the campaign and recipient.
 */
async function sendRaw(cfg, { from, to, raw, configurationSet = null, tags = {} }) {
  const d = await request(cfg, 'POST', '/v2/email/outbound-emails', {
    FromEmailAddress: from,
    Destination: { ToAddresses: [to] },
    Content: { Raw: { Data: Buffer.from(raw).toString('base64') } },
    ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
    EmailTags: Object.entries(tags).map(([Name, Value]) => ({ Name, Value: String(Value).replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 256) }))
  }, { write: true });
  if (!d.MessageId) throw sesError('Amazon SES did not return a message id. The email may or may not have been sent.', { code: 'SES_OUTCOME_UNKNOWN', outcomeUnknown: true });
  return { messageId: String(d.MessageId) };
}

module.exports = { sign, getAccount, identityVerified, sendRaw, sesError, REGION_RE };
