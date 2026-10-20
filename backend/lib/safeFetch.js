const dns = require('dns');
const net = require('net');
const { Agent, fetch: undiciFetch } = require('undici');

/**
 * SSRF-safe fetch for user-supplied URLs (website ingestion, media URLs).
 * - Only http/https on default ports (80/443) unless explicitly allowed.
 * - Every resolved address is checked at connect time (defeats DNS rebinding).
 * - Redirects are followed manually and each hop is re-validated.
 * - Response bodies are capped.
 */

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function isBlockedIPv4(ip) {
  const n = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

function isBlockedIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  // IPv4-mapped/compatible in hex form, e.g. ::ffff:7f00:1 (how URL() normalises ::ffff:127.0.0.1).
  const mappedHex = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isBlockedIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;   // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;    // fe80::/10 link local
  if (/^ff[0-9a-f]{2}:/.test(lower)) return true;       // multicast
  if (lower.startsWith('64:ff9b:')) return true;        // NAT64
  if (lower.startsWith('2001:db8:')) return true;       // documentation
  return false;
}

function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true;
}

class UnsafeUrlError extends Error {
  constructor(message) {
    super(message);
    this.code = 'UNSAFE_URL';
    this.status = 400;
  }
}

function assertSafeUrl(rawUrl, { allowedPorts = [80, 443] } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (e) {
    throw new UnsafeUrlError('Invalid URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new UnsafeUrlError('Only http and https URLs are allowed.');
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('URLs with embedded credentials are not allowed.');
  }
  const port = url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
  if (!allowedPorts.includes(port)) {
    throw new UnsafeUrlError(`Port ${port} is not allowed.`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new UnsafeUrlError('Private or internal hosts are not allowed.');
  }
  if (net.isIP(host) && isBlockedAddress(host)) {
    throw new UnsafeUrlError('Private, loopback, link-local and metadata addresses are not allowed.');
  }
  return url;
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    const bad = list.find(a => isBlockedAddress(a.address));
    if (bad) {
      return callback(new UnsafeUrlError(`Host ${hostname} resolves to a blocked address.`));
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

const safeAgent = new Agent({ connect: { lookup: safeLookup } });

/**
 * @returns {Promise<{ status:number, ok:boolean, url:string, headers:Headers, text:string }>}
 */
async function safeFetchText(rawUrl, { timeoutMs = 8000, maxBytes = 2 * 1024 * 1024, maxRedirects = 5, headers = {} } = {}) {
  let current = assertSafeUrl(rawUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const res = await undiciFetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        dispatcher: safeAgent,
        headers
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) throw new UnsafeUrlError('Redirect without a location.');
        current = assertSafeUrl(new URL(location, current).toString()).toString();
        continue;
      }
      const reader = res.body ? res.body.getReader() : null;
      const chunks = [];
      let received = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > maxBytes) {
            controller.abort();
            break;
          }
          chunks.push(value);
        }
      }
      const text = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
      return { status: res.status, ok: res.ok, url: current, headers: res.headers, text };
    }
    throw new UnsafeUrlError('Too many redirects.');
  } catch (err) {
    // undici wraps connect-time lookup failures; surface our block reason instead of "fetch failed".
    let cause = err;
    while (cause && cause.code !== 'UNSAFE_URL' && cause.cause) cause = cause.cause;
    if (cause && cause.code === 'UNSAFE_URL') throw cause;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  assertSafeUrl,
  safeFetchText,
  isBlockedAddress,
  UnsafeUrlError
};
