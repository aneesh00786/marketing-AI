/**
 * HTTP client for official provider APIs (fixed, trusted hosts).
 * Maps every failure onto ProviderError so the publishing worker can decide
 * between "safe to retry", "do not retry" and "outcome unknown".
 */

class ProviderError extends Error {
  /**
   * @param {object} o
   * @param {string} o.code  AUTH_EXPIRED | PERMISSION_DENIED | RATE_LIMITED | INVALID_REQUEST | NOT_FOUND | PROVIDER_ERROR | NETWORK | TIMEOUT | NOT_SUPPORTED | SETUP_REQUIRED
   * @param {boolean} [o.retryable]
   * @param {boolean} [o.outcomeUnknown] the request may have reached the provider (never auto-retry a publish)
   */
  constructor({ message, code, httpStatus = null, retryable = false, outcomeUnknown = false, retryAfterSec = null, providerCode = null, details = null }) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.outcomeUnknown = outcomeUnknown;
    this.retryAfterSec = retryAfterSec;
    this.providerCode = providerCode;
    this.details = details;
  }
}

const NOT_SENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ERR_INVALID_URL', 'CERT_HAS_EXPIRED', 'UND_ERR_CONNECT_TIMEOUT']);

function defaultClassify(status, body) {
  if (status === 401) return { code: 'AUTH_EXPIRED', retryable: false };
  if (status === 403) return { code: 'PERMISSION_DENIED', retryable: false };
  if (status === 404) return { code: 'NOT_FOUND', retryable: false };
  if (status === 429) return { code: 'RATE_LIMITED', retryable: true };
  if (status >= 500) return { code: 'PROVIDER_ERROR', retryable: true };
  return { code: 'INVALID_REQUEST', retryable: false };
}

/**
 * @param {string} url
 * @param {object} opts  { method, headers, json, form, multipart (FormData), body (Blob/Buffer, with a
 *                        Content-Type header), timeoutMs, classify(status, body), sent }
 *   sent: false when a failed request cannot have created anything visible (an upload step),
 *   so a network failure is not treated as an unknown publishing outcome.
 * @returns {Promise<{ status:number, headers:Headers, body:any }>}
 */
async function providerRequest(url, { method = 'GET', headers = {}, json, form, multipart, body: rawBody, timeoutMs = 20000, classify = defaultClassify, label = 'provider', sent = true } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers } };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers['Content-Type'] = 'application/json';
  } else if (form !== undefined) {
    init.body = new URLSearchParams(form).toString();
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (multipart !== undefined) {
    init.body = multipart;
  } else if (rawBody !== undefined) {
    init.body = rawBody;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await globalThis.fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const causeCode = err?.cause?.code || err?.code;
    const notSent = NOT_SENT_CODES.has(causeCode);
    const isTimeout = err?.name === 'AbortError';
    throw new ProviderError({
      message: `${label} request failed: ${isTimeout ? 'timed out' : (causeCode || err.message)}`,
      code: isTimeout ? 'TIMEOUT' : 'NETWORK',
      retryable: true,
      // A non-GET request that may have reached the provider has an unknown outcome.
      outcomeUnknown: sent && method !== 'GET' && !notSent
    });
  }
  clearTimeout(timer);

  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (e) { body = { raw: text.slice(0, 2000) }; }
  }

  if (!res.ok) {
    const c = classify(res.status, body) || defaultClassify(res.status, body);
    const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
    throw new ProviderError({
      message: c.message || `${label} returned HTTP ${res.status}`,
      code: c.code,
      httpStatus: res.status,
      retryable: !!c.retryable,
      retryAfterSec: Number.isFinite(retryAfter) ? retryAfter : (c.retryAfterSec || null),
      providerCode: c.providerCode || null,
      details: body
    });
  }
  return { status: res.status, headers: res.headers, body };
}

module.exports = { ProviderError, providerRequest };
