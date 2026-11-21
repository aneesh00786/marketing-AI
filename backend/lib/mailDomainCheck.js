/**
 * Email authentication of a sending domain, read from public DNS (and Amazon SES for DKIM when it is set up):
 * SPF (exactly one record), DKIM, DMARC and MX. Shown in Mail Center → Deliverability, so problems that send
 * mail to spam (e.g. two SPF records) are found with the record to set. Read-only; results are cached briefly.
 */
const dns = require('dns');

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();
let resolverFactory = () => {
  const r = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
  return r;
};
/** Tests replace DNS with a fake resolver ({ resolveTxt, resolveMx }). */
function setResolverForTests(fn) { resolverFactory = fn; cache.clear(); }

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const missing = e => ['ENOTFOUND', 'ENODATA', 'ENOTIMP', 'NXDOMAIN'].includes(e?.code);

async function txt(resolver, name) {
  try { return (await resolver.resolveTxt(name)).map(parts => parts.join('')); } catch (e) { if (missing(e)) return []; throw e; }
}
async function mx(resolver, name) {
  try { return (await resolver.resolveMx(name)).sort((a, b) => a.priority - b.priority).map(r => r.exchange); } catch (e) { if (missing(e)) return []; throw e; }
}

/** The SPF include a known SMTP mailbox host needs, or null. */
function smtpInclude(host) {
  const h = String(host || '').toLowerCase();
  if (/zoho\./.test(h)) return 'include:zohomail.com';
  if (/gmail\.com$|google\.com$/.test(h)) return 'include:_spf.google.com';
  if (/office365\.com$|outlook\.com$/.test(h)) return 'include:spf.protection.outlook.com';
  return null;
}

/** One SPF record from several (their mechanisms combined, one "all" at the end). */
function mergeSpf(records) {
  const parts = [];
  let all = '~all';
  for (const r of records) {
    for (const t of r.trim().split(/\s+/).slice(1)) {
      if (/^[~?+-]?all$/i.test(t)) { if (t.startsWith('-')) all = '-all'; continue; }
      if (!parts.includes(t)) parts.push(t);
    }
  }
  return ['v=spf1', ...parts, all].join(' ');
}

/**
 * Checks one domain. providers: { smtpHost?, zepto?, sesCfg? }. Each check: { status: 'ok'|'warn'|'error'|'unknown',
 * found, message, fix? } (fix: the record to set, when it can be told).
 */
async function checkDomain(domain, providers = {}) {
  const d = String(domain || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(d)) return { domain: d, error: 'Not a valid domain.' };
  const key = `${d}|${providers.smtpHost || ''}|${providers.zepto ? 1 : 0}|${providers.sesCfg ? providers.sesCfg.region : ''}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const resolver = resolverFactory();
  let value;
  try {
    const [rootTxt, dmarcTxt, mxHosts] = await Promise.all([txt(resolver, d), txt(resolver, `_dmarc.${d}`), mx(resolver, d)]);

    // SPF: exactly one record, including the SMTP mailbox's servers when one is used.
    const spfRecords = rootTxt.filter(t => /^v=spf1(\s|$)/i.test(t));
    let spf;
    if (!spfRecords.length) {
      const inc = smtpInclude(providers.smtpHost);
      spf = { status: 'warn', found: [], message: 'No SPF record. Receiving servers cannot check which servers may send for this domain.',
        ...(inc ? { fix: `v=spf1 ${inc} ~all` } : {}) };
    } else if (spfRecords.length > 1) {
      spf = { status: 'error', found: spfRecords, message: `${spfRecords.length} SPF records. A domain may have only one: with more, SPF fails for every email, which sends mail to spam. Replace them with one record.`,
        fix: mergeSpf(spfRecords) };
    } else {
      const inc = smtpInclude(providers.smtpHost);
      const lacks = inc && !spfRecords[0].toLowerCase().includes(inc.toLowerCase());
      spf = lacks
        ? { status: 'warn', found: spfRecords, message: `The SPF record does not include your mail server (${inc}).`, fix: mergeSpf([spfRecords[0], `v=spf1 ${inc}`]) }
        : { status: 'ok', found: spfRecords, message: 'One SPF record.' };
    }

    // DMARC: present; a policy of none is fine to start with.
    const dmarcRecords = dmarcTxt.filter(t => /^v=DMARC1/i.test(t));
    let dmarc;
    if (!dmarcRecords.length) {
      dmarc = { status: 'warn', found: [], message: 'No DMARC record. Gmail and Yahoo expect one from bulk senders.', fix: `_dmarc.${d}  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@${d}"` };
    } else if (dmarcRecords.length > 1) {
      dmarc = { status: 'error', found: dmarcRecords, message: 'More than one DMARC record: receiving servers ignore them all. Keep one.' };
    } else {
      const policy = (/(?:^|;)\s*p=([a-z]+)/i.exec(dmarcRecords[0]) || [])[1] || null;
      const rua = /rua=/i.test(dmarcRecords[0]);
      dmarc = { status: 'ok', found: dmarcRecords, policy,
        message: policy === 'none' ? `DMARC is set (policy: none, reports ${rua ? 'on' : 'off'}).` : `DMARC is set (policy: ${policy || 'not given'}).` };
    }

    // DKIM: Amazon SES knows its own status; other services use a selector only they know.
    let dkim = { status: 'unknown', message: providers.zepto
      ? 'Check DKIM in ZeptoMail (Mail Agents → Domains): it should show Verified. Its record name is only known to ZeptoMail.'
      : 'Check DKIM with your mail service: its record name (selector) is only known to it.' };
    if (providers.sesCfg) {
      try {
        const id = await require('../modules/mail/ses/sesClient').identityDetails(providers.sesCfg, d);
        const st = id?.DkimAttributes?.Status || null;
        dkim = !id
          ? { status: 'warn', message: `${d} is not set up in Amazon SES, so its emails are not DKIM-signed for this domain. Add the domain in SES (Verified identities) and its DKIM records here.` }
          : st === 'SUCCESS'
            ? { status: 'ok', message: 'Amazon SES signs this domain\'s email (DKIM verified).' }
            : { status: st === 'PENDING' ? 'warn' : 'error', message: `Amazon SES DKIM status: ${st || 'not set up'}. Add the DKIM records SES shows for ${d}.` };
      } catch (e) { /* SES unreachable: keep the general hint */ }
    }

    const mxCheck = mxHosts.length
      ? { status: 'ok', found: mxHosts, message: 'Mail to this domain is received (MX).' }
      : { status: 'warn', found: [], message: 'No MX record: replies to this domain cannot be received.' };

    const worst = [spf, dkim, dmarc, mxCheck].some(c => c.status === 'error') ? 'error' : [spf, dkim, dmarc, mxCheck].some(c => c.status === 'warn') ? 'warn' : 'ok';
    value = { domain: d, status: worst, spf, dkim, dmarc, mx: mxCheck, checkedAt: new Date().toISOString() };
  } catch (e) {
    value = { domain: d, status: 'unknown', error: `DNS could not be read (${e.code || e.message}). Try again later.` };
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { checkDomain, mergeSpf, setResolverForTests };
