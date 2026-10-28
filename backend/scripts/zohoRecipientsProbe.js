#!/usr/bin/env node
/**
 * STAGING DIAGNOSTIC — read-only check of Zoho Campaigns recipient activity for ONE already-sent
 * test campaign, using the application's own Zoho session and parser. See docs/EMAIL_TRACKING_STAGING.md.
 *
 * Calls only read endpoints (getcampaigndetails, getcampaignrecipientsdata); never creates or sends a
 * campaign and never uploads contacts. At most --max-calls requests (default 20, hard cap 40), one
 * every 1.5 s, far below Zoho's 500 per 5 minutes. Output is redacted: addresses are hashed, record
 * values are reduced to their shape. Nothing is stored.
 *
 *   DEPLOYMENT_ENV=staging node scripts/zohoRecipientsProbe.js --workspace <id> --campaign-key <Zoho campaign key> [--max-calls 20]
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const hash = v => crypto.createHash('sha256').update(String(v).toLowerCase()).digest('hex').slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ACTIONS = ['sentcontacts', 'openedcontacts', 'clickedcontacts', 'senthardbounce', 'sentsoftbounce', 'optoutcontacts', 'spamcontacts', 'unopenedcontacts'];
const REPORT_FIELDS = ['emails_sent_count', 'delivered_count', 'delivered_percent', 'opens_count', 'open_percent', 'unique_clicks_count', 'bounces_count', 'hardbounce_count', 'softbounce_count', 'unsub_count', 'spams_count', 'complaints_count', 'unsent_count'];

function shape(v, depth = 0) {
  if (depth > 8) return '…';
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1), ...(v.length > 1 ? [`(+${v.length - 1} more)`] : [])] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  if (typeof v === 'string') return /@/.test(v) ? `<address ${hash(v)}>` : (v.length > 24 ? `<string len=${v.length}>` : v);
  return v;
}

async function main() {
  const workspaceId = parseInt(opt('workspace'), 10);
  const campaignKey = opt('campaign-key');
  const maxCalls = Math.min(40, parseInt(opt('max-calls') || '20', 10) || 20);
  if (process.env.DEPLOYMENT_ENV !== 'staging') { console.error('Refusing to run: set DEPLOYMENT_ENV=staging (staging only).'); process.exit(2); }
  if (!workspaceId || !campaignKey) { console.error('Usage: --workspace <id> --campaign-key <key> [--max-calls 20]'); process.exit(2); }

  const db = require('../db/database');
  await require('../lib/stagingGuard').enforceStaging('zoho-probe', { query: db.all });
  const zoho = require('../modules/mail/zoho/zohoService');
  const { contactsIn } = require('../modules/mail/campaigns/campaignService');

  let calls = 0;
  const read = async (endpoint, params) => {
    if (calls >= maxCalls) throw Object.assign(new Error('call budget reached'), { code: 'BUDGET' });
    calls++;
    if (calls > 1) await sleep(1500);
    try { return { ok: true, data: await zoho.readCall(workspaceId, endpoint, params) }; } catch (err) {
      return { ok: false, error: { code: err.code, providerCode: err.providerCode || null, status: err.status || null, message: String(err.message || '').replace(/[^\s@]+@[^\s@]+/g, '<address>').slice(0, 200) } };
    }
  };

  const out = { workspaceId, campaignKeyHash: hash(campaignKey), checks: {} };

  const details = await read('getcampaigndetails', { campaignkey: campaignKey, campaigntype: 'normal' });
  const report = details.ok ? (Array.isArray(details.data['campaign-reports']) ? details.data['campaign-reports'][0] : details.data['campaign-reports']) : null;
  out.checks.report = details.ok
    ? { campaignStatus: details.data.campaign_status || null, reportFieldsPresent: REPORT_FIELDS.filter(f => report && report[f] !== undefined), values: report ? Object.fromEntries(REPORT_FIELDS.filter(f => report[f] !== undefined).map(f => [f, report[f]])) : null, otherReportKeys: report ? Object.keys(report).filter(k => !REPORT_FIELDS.includes(k)) : [] }
    : details.error;

  const opened = new Set();
  for (const action of ACTIONS) {
    const r = await read('getcampaignrecipientsdata', { campaignkey: campaignKey, action, fromindex: '1', range: '50' }).catch(e => ({ ok: false, error: { code: e.code } }));
    if (!r.ok) { out.checks[action] = r.error; if (r.error.code === 'BUDGET') break; continue; }
    const records = Array.isArray(r.data.list_of_details) ? r.data.list_of_details : [];
    const parsed = contactsIn(r.data);
    if (action === 'openedcontacts') parsed.forEach(c => opened.add(c.email.toLowerCase()));
    out.checks[action] = {
      topLevelKeys: Object.keys(r.data),
      status: r.data.status ?? null, code: r.data.code ?? null,
      requestdetails: r.data.requestdetails ?? null,
      records: records.length,
      recordFieldNames: [...new Set(records.flatMap(x => Object.keys(x || {})))].sort(),
      firstRecordShape: records[0] ? shape(records[0]) : null,
      appParserFound: parsed.length,
      appParserMatchesRecords: parsed.length === records.length
    };
  }

  // Paging: are fromindex/range honoured? Two adjacent pages of 2 must not overlap.
  const p1 = await read('getcampaignrecipientsdata', { campaignkey: campaignKey, action: 'sentcontacts', fromindex: '1', range: '2' }).catch(() => null);
  const p2 = await read('getcampaignrecipientsdata', { campaignkey: campaignKey, action: 'sentcontacts', fromindex: '3', range: '2' }).catch(() => null);
  if (p1?.ok && p2?.ok) {
    const a = contactsIn(p1.data).map(c => hash(c.email));
    const b = contactsIn(p2.data).map(c => hash(c.email));
    out.checks.paging = { page1: a.length, page2: b.length, overlap: a.filter(x => b.includes(x)).length, rangeHonoured: a.length <= 2 && b.length <= 2 };
  } else out.checks.paging = 'not checked (call failed or budget reached)';

  // Unique vs total opens: compare Zoho's opens_count with the number of distinct opened contacts.
  const opensCount = report && report.opens_count !== undefined ? Number(report.opens_count) : null;
  out.checks.opensCountMeaning = opensCount === null ? 'opens_count not reported'
    : opened.size >= 50 ? `inconclusive: 50+ opened contacts on the first page (opens_count=${opensCount})`
    : opensCount === opened.size ? `opens_count (${opensCount}) equals distinct opened contacts (${opened.size}): consistent with UNIQUE opens`
    : opensCount > opened.size ? `opens_count (${opensCount}) is greater than distinct opened contacts (${opened.size}): suggests TOTAL opens`
    : `opens_count (${opensCount}) is less than distinct opened contacts (${opened.size}): report may be stale; refresh and re-run`;
  out.callsMade = calls;
  console.log(JSON.stringify(out, null, 2));
  await db.closeDatabase?.();
}

main().catch(err => { console.error('Probe failed:', err.code || '', String(err.message || '').slice(0, 200)); process.exit(1); });
