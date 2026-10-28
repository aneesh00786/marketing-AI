/**
 * Preloaded into local verification runs (node --require): no process may reach a non-local host.
 * DNS lookups of public names and fetch() to non-local URLs fail as unreachable, so providers
 * (ZeptoMail, Zoho, AI, social APIs), SMTP and IMAP can never be contacted. Local addresses (the
 * database and the app under test) keep working. Each refusal is logged to stderr once per host.
 */
const dns = require('dns');
const net = require('net');

const isLocal = host => /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0)$/i.test(String(host || '').replace(/^\[|\]$/g, ''));
const seen = new Set();
const refused = host => {
  if (!seen.has(host)) { seen.add(host); process.stderr.write(`[blockNetwork] refused external host: ${host}\n`); }
  return Object.assign(new Error(`Local verification never contacts external hosts (${host}).`), { code: 'ENOTFOUND' });
};

const lookup = dns.lookup;
dns.lookup = function (host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (isLocal(host) || (net.isIP(String(host)) && isLocal(host))) return lookup.call(dns, host, opts, cb);
  process.nextTick(() => cb(refused(host)));
};
const plookup = dns.promises.lookup;
dns.promises.lookup = async (host, opts) => {
  if (isLocal(host)) return plookup(host, opts);
  throw refused(host);
};

// Direct connections to non-local IP literals are refused as well.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  if (!o.path && o.host && net.isIP(String(o.host)) && !isLocal(o.host)) {
    process.nextTick(() => this.destroy(refused(o.host)));
    return this;
  }
  return connect.apply(this, args);
};

if (typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    let host = '';
    try { host = new URL(url).hostname; } catch { /* relative */ }
    if (!isLocal(host)) throw Object.assign(new TypeError('fetch failed'), { cause: refused(host) });
    return realFetch(input, init);
  };
}
