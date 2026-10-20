const { z } = require('zod');
const { get, all } = require('../../db/database');
const { toDbDateTime } = require('../../lib/time');
const { twoProportionTest } = require('../../lib/abStats');
const { generateStructured, untrusted } = require('../../lib/aiStructured');
const analyticsService = require('../social/analyticsService');
const { resolveRange } = require('../social/dashboardService');

/**
 * AI Campaigns analytics: email sequences, social campaigns and CRM outcomes, side by side.
 * The period end is inclusive (timestamps are stored to the second and the end is usually "now").
 *
 * Every metric is an object with an explicit status, so the UI never confuses "0" with "—":
 *   available   real count/rate from stored data (0 is a real zero)
 *   partial     real, but only some items reported it (basis says how many)
 *   unavailable not measurable; `reason` explains why
 *   estimate    a derived association (only attribution), with its method
 * Revenue, ROI and spend are never computed: the app records neither deal values nor spend.
 * Opens and clicks on email are not tracked and never shown.
 */
const MIN_SAMPLE = 30;

const avail = (value, extra = {}) => ({ value, status: 'available', ...extra });
const unavailable = reason => ({ value: null, status: 'unavailable', reason });
const partial = (value, basis) => ({ value, status: 'partial', basis });

function rate(num, den, unavailableReason = null) {
  if (unavailableReason) return unavailable(unavailableReason);
  if (!den) return unavailable('Nobody was emailed in this period.');
  return avail(num / den, { numerator: num, denominator: den, smallSample: den < MIN_SAMPLE });
}

const dayOf = d => new Date(d).toISOString().slice(0, 10);

function dayList(start, end) {
  const days = [];
  for (let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()); t < end.getTime(); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

async function tableExists(name) {
  const r = await get('SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [name]);
  return !!r;
}

/** Replies are measurable only when the workspace mailbox is being synced (IMAP). */
async function replyTracking(workspaceId) {
  const cfg = await get('SELECT imap_host, imap_user, imap_pass, last_synced_at FROM mail_configurations WHERE workspace_id = ?', [workspaceId]);
  if (!cfg || !cfg.imap_host || !cfg.imap_user || !cfg.imap_pass) return { on: false, reason: 'Replies are not measured: inbound mail (IMAP) is not set up in Mail Settings.' };
  if (!cfg.last_synced_at) return { on: false, reason: 'Replies are not measured yet: the mailbox has never synced.' };
  return { on: true, lastSyncedAt: cfg.last_synced_at };
}

// ---------------------------------------------------------------------------
// Email (outreach sequences)
// ---------------------------------------------------------------------------
async function emailAnalytics(workspaceId, start, end, tracking) {
  const s = toDbDateTime(start);
  const e = toDbDateTime(end);
  const campaigns = await all('SELECT id, name, status, product_id FROM outreach_campaigns WHERE workspace_id = ? ORDER BY id DESC', [workspaceId]);
  const rows = [];
  const total = { sent: 0, failed: 0, emailed: 0, replied: 0, bounced: 0, unsubscribed: 0 };
  for (const c of campaigns) {
    const sends = await get(
      `SELECT SUM(status = 'sent' AND sent_at >= ? AND sent_at <= ?) AS sent, SUM(status = 'failed' AND created_at >= ? AND created_at <= ?) AS failed
       FROM outreach_sends WHERE workspace_id = ? AND campaign_id = ?`, [s, e, s, e, workspaceId, c.id]);
    // Cohort: recipients whose first email went out in the period; outcomes are counted for that cohort.
    const cohort = await get(
      `SELECT COUNT(*) AS emailed, SUM(status = 'replied') AS replied, SUM(status = 'bounced') AS bounced, SUM(status = 'unsubscribed') AS unsubscribed
       FROM outreach_recipients WHERE workspace_id = ? AND campaign_id = ? AND first_sent_at >= ? AND first_sent_at <= ?`, [workspaceId, c.id, s, e]);
    const bouncedAtFirst = await get(
      `SELECT COUNT(DISTINCT r.id) AS n FROM outreach_recipients r JOIN outreach_sends x ON x.recipient_id = r.id
       WHERE r.workspace_id = ? AND r.campaign_id = ? AND r.status = 'bounced' AND r.first_sent_at IS NULL AND x.created_at >= ? AND x.created_at <= ?`, [workspaceId, c.id, s, e]);
    const m = {
      sent: Number(sends.sent || 0), failed: Number(sends.failed || 0), emailed: Number(cohort.emailed || 0),
      replied: Number(cohort.replied || 0), bounced: Number(cohort.bounced || 0) + Number(bouncedAtFirst.n || 0), unsubscribed: Number(cohort.unsubscribed || 0)
    };
    const attempted = m.emailed + Number(bouncedAtFirst.n || 0);
    if (!m.sent && !m.failed && !attempted) continue;
    for (const k of Object.keys(total)) total[k] += m[k];
    rows.push({
      id: c.id, name: c.name, status: c.status, productId: c.product_id,
      emailsSent: avail(m.sent), emailsFailed: avail(m.failed), recipientsEmailed: avail(m.emailed),
      replies: tracking.on ? avail(m.replied) : unavailable(tracking.reason),
      replyRate: rate(m.replied, m.emailed, tracking.on ? null : tracking.reason),
      bounceRate: rate(m.bounced, attempted),
      unsubscribeRate: rate(m.unsubscribed, m.emailed),
      raw: { ...m, attempted }
    });
  }
  const attemptedTotal = rows.reduce((a, r) => a + r.raw.attempted, 0);
  return {
    campaigns: rows,
    totals: {
      emailsSent: avail(total.sent), emailsFailed: avail(total.failed), recipientsEmailed: avail(total.emailed),
      replies: tracking.on ? avail(total.replied) : unavailable(tracking.reason),
      replyRate: rate(total.replied, total.emailed, tracking.on ? null : tracking.reason),
      bounceRate: rate(total.bounced, attemptedTotal),
      unsubscribeRate: rate(total.unsubscribed, total.emailed),
      opens: unavailable('Email opens are not tracked.'),
      clicks: unavailable('Email link clicks are not tracked.')
    },
    raw: { ...total, attempted: attemptedTotal }
  };
}

// ---------------------------------------------------------------------------
// Social (reuses the Social Media Marketing analytics summary)
// ---------------------------------------------------------------------------
const ENGAGEMENT = ['likes', 'comments', 'shares', 'saves'];

function socialMetric(posts, key) {
  const withValue = posts.filter(p => p.metrics?.[key]?.value !== null && p.metrics?.[key]?.value !== undefined);
  if (!posts.length) return unavailable('No posts were published in this period.');
  if (!withValue.length) {
    const reasons = [...new Set(posts.map(p => p.metrics?.[key]?.reason).filter(Boolean))];
    return unavailable(reasons[0] || 'The platforms did not report this metric.');
  }
  const value = withValue.reduce((a, p) => a + Number(p.metrics[key].value), 0);
  return withValue.length === posts.length ? avail(value, { basis: `${posts.length} post(s)` }) : partial(value, `reported for ${withValue.length} of ${posts.length} posts`);
}

function engagementOf(posts) {
  const known = posts.filter(p => p.engagements !== null && p.engagements !== undefined);
  if (!posts.length) return unavailable('No posts were published in this period.');
  if (!known.length) return unavailable('The platforms did not report likes, comments, shares or saves.');
  const value = known.reduce((a, p) => a + Number(p.engagements), 0);
  return known.length === posts.length ? avail(value, { basis: `${posts.length} post(s)` }) : partial(value, `reported for ${known.length} of ${posts.length} posts`);
}

function engagementRateOf(posts) {
  const both = posts.filter(p => p.engagements !== null && p.engagements !== undefined && p.metrics?.impressions?.value);
  if (!both.length) return unavailable(posts.length ? 'Needs both engagements and impressions from the platform.' : 'No posts were published in this period.');
  const eng = both.reduce((a, p) => a + Number(p.engagements), 0);
  const imp = both.reduce((a, p) => a + Number(p.metrics.impressions.value), 0);
  const v = { value: eng / imp, numerator: eng, denominator: imp };
  return both.length === posts.length ? avail(v.value, { ...v, basis: `${posts.length} post(s)` }) : partial(v.value, `computed from ${both.length} of ${posts.length} posts`);
}

async function socialAnalytics(workspaceId, start, end) {
  const summary = await analyticsService.getSummary(workspaceId, { from: start.toISOString(), to: end.toISOString() });
  const posts = summary.posts || [];
  const names = Object.fromEntries((await all('SELECT id, name, status FROM campaigns WHERE workspace_id = ?', [workspaceId])).map(c => [c.id, c]));
  const byCampaign = {};
  for (const p of posts) (byCampaign[p.campaignId || 0] = byCampaign[p.campaignId || 0] || []).push(p);
  const campaigns = Object.entries(byCampaign).map(([cid, list]) => ({
    id: Number(cid) || null,
    name: Number(cid) ? (names[cid]?.name || 'Removed campaign') : 'Posts without a campaign',
    status: Number(cid) ? names[cid]?.status || null : null,
    postsPublished: avail(list.length),
    impressions: socialMetric(list, 'impressions'),
    reach: socialMetric(list, 'reach'),
    clicks: socialMetric(list, 'clicks'),
    engagements: engagementOf(list),
    engagementRate: engagementRateOf(list),
    byPlatform: Object.fromEntries([...new Set(list.map(p => p.platformKey))].map(k => [k, list.filter(p => p.platformKey === k).length]))
  }));
  const sources = await all('SELECT DISTINCT source FROM social_metric_snapshots WHERE workspace_id = ? AND collected_at >= ? AND collected_at <= ?', [workspaceId, toDbDateTime(start), toDbDateTime(end)]);
  const demoSources = sources.map(r => r.source).filter(src => !/_api$/.test(String(src)));
  return {
    campaigns,
    totals: {
      postsPublished: avail(posts.length),
      impressions: socialMetric(posts, 'impressions'),
      reach: socialMetric(posts, 'reach'),
      clicks: socialMetric(posts, 'clicks'),
      engagements: engagementOf(posts),
      engagementRate: engagementRateOf(posts)
    },
    posts,
    demoSources
  };
}

// ---------------------------------------------------------------------------
// CRM outcomes and attribution
// ---------------------------------------------------------------------------
async function crmAnalytics(workspaceId, start, end, conversionStatus) {
  const s = toDbDateTime(start);
  const e = toDbDateTime(end);
  const created = await get('SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ? AND created_at >= ? AND created_at <= ?', [workspaceId, s, e]);
  const byStatus = await all('SELECT status, COUNT(*) AS n FROM leads WHERE workspace_id = ? GROUP BY status', [workspaceId]);
  const hasEvents = await tableExists('automation_events');
  let conversions = null;
  let historyFrom = null;
  if (hasEvents) {
    const first = await get("SELECT MIN(created_at) AS t FROM automation_events WHERE workspace_id = ? AND event_type = 'lead.status_changed'", [workspaceId]);
    historyFrom = first?.t || null;
    conversions = await all(
      `SELECT e.subject_id AS lead_id, e.created_at FROM automation_events e
       WHERE e.workspace_id = ? AND e.event_type = 'lead.status_changed' AND JSON_UNQUOTE(JSON_EXTRACT(e.payload_json, '$.to')) = ? AND e.created_at >= ? AND e.created_at <= ?`,
      [workspaceId, conversionStatus, s, e]
    );
  }
  const statusHistoryReason = !hasEvents
    ? 'Lead status history is not recorded yet (run the latest database migration).'
    : (!historyFrom ? 'No lead status changes have been recorded yet; history starts with the automation update.' : null);
  return {
    leadsCreated: avail(Number(created.n)),
    statusSnapshot: Object.fromEntries(byStatus.map(r => [r.status || 'Unknown', Number(r.n)])),
    conversions: statusHistoryReason && !conversions?.length ? unavailable(statusHistoryReason) : avail((conversions || []).length, historyFrom && new Date(historyFrom) > start ? { note: `Status history is only available from ${new Date(historyFrom).toISOString().slice(0, 10)}.` } : {}),
    conversionRows: conversions || [],
    historyFrom
  };
}

/**
 * Last-touch email attribution: a conversion counts for the email sequence that last emailed
 * that lead within `lookbackDays` before the status change. It is an association, not proof.
 * Social posts are not linked to individual leads, so social attribution is unavailable.
 */
async function attribution(workspaceId, conversionRows, lookbackDays, conversionStatus) {
  const method = `Last email sent to the lead within ${lookbackDays} days before it moved to "${conversionStatus}". This shows association, not proof that the email caused the outcome.`;
  const perCampaign = {};
  let unattributed = 0;
  for (const c of conversionRows) {
    const touch = await get(
      `SELECT x.campaign_id, x.sent_at FROM outreach_sends x JOIN outreach_recipients r ON r.id = x.recipient_id
       WHERE r.workspace_id = ? AND r.lead_id = ? AND x.status = 'sent' AND x.sent_at <= ? AND x.sent_at >= DATE_SUB(?, INTERVAL ? DAY)
       ORDER BY x.sent_at DESC LIMIT 1`,
      [workspaceId, c.lead_id, c.created_at, c.created_at, lookbackDays]
    );
    if (touch) perCampaign[touch.campaign_id] = (perCampaign[touch.campaign_id] || 0) + 1;
    else unattributed++;
  }
  return {
    method,
    email: Object.fromEntries(Object.entries(perCampaign).map(([k, v]) => [k, { value: v, status: 'estimate', method }])),
    unattributed: avail(unattributed),
    social: unavailable('Social posts are not linked to individual leads, so conversions cannot be attributed to them.'),
    revenue: unavailable('Revenue is not tracked: leads have no recorded deal value.'),
    roi: unavailable('ROI cannot be calculated: neither revenue nor spend is recorded.')
  };
}

// ---------------------------------------------------------------------------
// Trends (daily)
// ---------------------------------------------------------------------------
async function trends(workspaceId, start, end, tracking, social, crm) {
  const days = dayList(start, end);
  const s = toDbDateTime(start);
  const e = toDbDateTime(end);
  const zero = () => Object.fromEntries(days.map(d => [d, 0]));
  const sent = zero();
  for (const r of await all("SELECT DATE(sent_at) AS d, COUNT(*) AS n FROM outreach_sends WHERE workspace_id = ? AND status = 'sent' AND sent_at >= ? AND sent_at <= ? GROUP BY DATE(sent_at)", [workspaceId, s, e])) {
    const k = dayOf(r.d); if (k in sent) sent[k] = Number(r.n);
  }
  let replies = null;
  if (tracking.on) {
    replies = zero();
    for (const r of await all("SELECT DATE(updated_at) AS d, COUNT(*) AS n FROM outreach_recipients WHERE workspace_id = ? AND status = 'replied' AND updated_at >= ? AND updated_at <= ? GROUP BY DATE(updated_at)", [workspaceId, s, e])) {
      const k = dayOf(r.d); if (k in replies) replies[k] = Number(r.n);
    }
  }
  const leads = zero();
  for (const r of await all('SELECT DATE(created_at) AS d, COUNT(*) AS n FROM leads WHERE workspace_id = ? AND created_at >= ? AND created_at <= ? GROUP BY DATE(created_at)', [workspaceId, s, e])) {
    const k = dayOf(r.d); if (k in leads) leads[k] = Number(r.n);
  }
  const posts = zero();
  const engagements = Object.fromEntries(days.map(d => [d, null]));
  for (const p of social.posts) {
    const k = dayOf(p.publishedAt);
    if (!(k in posts)) continue;
    posts[k] += 1;
    if (p.engagements !== null && p.engagements !== undefined) engagements[k] = (engagements[k] || 0) + Number(p.engagements);
  }
  let conversions = null;
  if (crm.conversions.status !== 'unavailable') {
    conversions = zero();
    for (const c of crm.conversionRows) { const k = dayOf(c.created_at); if (k in conversions) conversions[k] += 1; }
  }
  const series = (map, unavailableReason) => (map ? days.map(d => map[d]) : { unavailable: unavailableReason });
  return {
    days,
    series: {
      emailsSent: series(sent),
      replies: series(replies, tracking.reason),
      postsPublished: series(posts),
      engagements: series(engagements),
      leadsCreated: series(leads),
      conversions: series(conversions, crm.conversions.reason)
    },
    notes: { engagements: 'Engagements are grouped by the day a post was published; empty days have no reported data (not zero).' }
  };
}

// ---------------------------------------------------------------------------
// Programs (Command Center) roll-up
// ---------------------------------------------------------------------------
async function programs(workspaceId, email, social, attr) {
  if (!(await tableExists('campaign_programs'))) return [];
  const rows = await all("SELECT id, name, status, outreach_campaign_id, social_campaign_id, budget_amount, budget_currency FROM campaign_programs WHERE workspace_id = ? AND status <> 'archived' ORDER BY id DESC", [workspaceId]);
  return rows.map(p => {
    const e = email.campaigns.find(c => c.id === p.outreach_campaign_id) || null;
    const s = social.campaigns.find(c => c.id === p.social_campaign_id) || null;
    return {
      id: p.id, name: p.name, status: p.status,
      email: e ? { emailsSent: e.emailsSent, replyRate: e.replyRate } : (p.outreach_campaign_id ? { note: 'No email activity in this period.' } : null),
      social: s ? { postsPublished: s.postsPublished, engagements: s.engagements, engagementRate: s.engagementRate } : (p.social_campaign_id ? { note: 'No posts published in this period.' } : null),
      attributedConversions: p.outreach_campaign_id && attr.email[p.outreach_campaign_id] ? attr.email[p.outreach_campaign_id] : { value: 0, status: 'estimate', method: attr.method },
      plannedBudget: p.budget_amount !== null ? { value: Number(p.budget_amount), currency: p.budget_currency, status: 'available', note: 'Planned budget you entered, not recorded spend.' } : null,
      roi: unavailable('ROI cannot be calculated: neither revenue nor spend is recorded.')
    };
  });
}

// ---------------------------------------------------------------------------
// Evidence-backed insights (deterministic)
// ---------------------------------------------------------------------------
function insights(email, social, crm, tracking, attr) {
  const out = [];
  const add = (id, severity, title, detail, evidence) => out.push({ id, severity, title, detail, evidence });
  if (!tracking.on) add('reply_tracking_off', 'info', 'Replies are not being measured', tracking.reason, [{ metric: 'email.replies', status: 'unavailable' }]);
  for (const c of email.campaigns) {
    if (c.bounceRate.status === 'available' && c.raw.attempted >= 20 && c.bounceRate.value >= 0.05) {
      add(`bounce_high_${c.id}`, 'warning', `High bounce rate in "${c.name}"`, `${c.raw.bounced} of ${c.raw.attempted} addresses bounced (${(c.bounceRate.value * 100).toFixed(1)}%). Check the list quality before sending more.`, [{ metric: 'bounceRate', campaignId: c.id, numerator: c.raw.bounced, denominator: c.raw.attempted }]);
    }
    if (c.unsubscribeRate.status === 'available' && c.raw.emailed >= 50 && c.unsubscribeRate.value >= 0.02) {
      add(`unsub_high_${c.id}`, 'warning', `Unsubscribes above 2% in "${c.name}"`, `${c.raw.unsubscribed} of ${c.raw.emailed} recipients unsubscribed. Review targeting and message fit.`, [{ metric: 'unsubscribeRate', campaignId: c.id, numerator: c.raw.unsubscribed, denominator: c.raw.emailed }]);
    }
    if (c.raw.failed > 0) add(`failed_${c.id}`, 'warning', `Failed sends in "${c.name}"`, `${c.raw.failed} email(s) were not accepted by the mail provider. Check Mail Settings and retry them in the sequence.`, [{ metric: 'emailsFailed', campaignId: c.id, value: c.raw.failed }]);
  }
  // Pairwise reply-rate comparisons only when both have enough recipients and the difference is significant.
  if (tracking.on) {
    const eligible = email.campaigns.filter(c => c.raw.emailed >= MIN_SAMPLE);
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const a = eligible[i];
        const b = eligible[j];
        const t = twoProportionTest(a.raw.replied, a.raw.emailed, b.raw.replied, b.raw.emailed);
        if (t.pValue !== null && t.pValue < 0.05) {
          const [hi, lo] = t.p2 > t.p1 ? [b, a] : [a, b];
          add(`reply_compare_${a.id}_${b.id}`, 'insight', `"${hi.name}" gets significantly more replies than "${lo.name}"`,
            `${hi.raw.replied}/${hi.raw.emailed} vs ${lo.raw.replied}/${lo.raw.emailed} replied (p = ${t.pValue.toFixed(3)}). Consider reusing its approach.`,
            [{ metric: 'replyRate', campaignId: hi.id, numerator: hi.raw.replied, denominator: hi.raw.emailed }, { metric: 'replyRate', campaignId: lo.id, numerator: lo.raw.replied, denominator: lo.raw.emailed }, { metric: 'pValue', value: t.pValue }]);
        }
      }
    }
  }
  const pub = social.totals.postsPublished.value;
  if (pub > 0 && social.totals.impressions.status === 'unavailable') add('social_metrics_missing', 'info', 'Published posts have no platform metrics yet', `${pub} post(s) were published, but no impressions were reported. Analytics sync runs in the background worker.`, [{ metric: 'social.postsPublished', value: pub }]);
  if (social.demoSources.length) add('demo_data', 'warning', 'Some social numbers are demo data', `Metric sources ${social.demoSources.join(', ')} are not live platform APIs; treat them as samples.`, [{ metric: 'social.sources', value: social.demoSources }]);
  if (crm.conversions.status === 'available' && crm.conversions.value > 0 && attr.unattributed.value === crm.conversions.value) {
    add('conversions_no_email', 'info', 'Conversions without a recent email touch', `${crm.conversions.value} lead(s) converted with no campaign email in the lookback window.`, [{ metric: 'conversions', value: crm.conversions.value }, { metric: 'unattributed', value: attr.unattributed.value }]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
const querySchema = z.object({
  range: z.string().regex(/^\d{1,3}$/).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  conversionStatus: z.enum(['Qualified', 'Demo Scheduled', 'Proposal', 'Won']).optional(),
  lookbackDays: z.string().regex(/^\d{1,3}$/).optional()
}).passthrough();

async function overview(ctx, query = {}) {
  const q = querySchema.parse(query);
  const workspaceId = ctx.auth.workspaceId;
  const { start, end } = resolveRange(q);
  const conversionStatus = q.conversionStatus || 'Won';
  const lookbackDays = Math.min(Math.max(parseInt(q.lookbackDays || '30', 10), 1), 180);
  const tracking = await replyTracking(workspaceId);
  const [email, social, crm] = [await emailAnalytics(workspaceId, start, end, tracking), await socialAnalytics(workspaceId, start, end), await crmAnalytics(workspaceId, start, end, conversionStatus)];
  const attr = await attribution(workspaceId, crm.conversionRows, lookbackDays, conversionStatus);
  for (const c of email.campaigns) c.attributedConversions = attr.email[c.id] || { value: 0, status: 'estimate', method: attr.method };
  const progs = await programs(workspaceId, email, social, attr);
  const trend = await trends(workspaceId, start, end, tracking, social, crm);
  const strip = c => { const { raw, ...rest } = c; return rest; };
  return {
    range: { from: start.toISOString(), to: end.toISOString() },
    settings: { conversionStatus, lookbackDays, minSample: MIN_SAMPLE },
    dataQuality: { replyTracking: tracking, demoSources: social.demoSources, statusHistoryFrom: crm.historyFrom },
    channels: {
      email: email.totals,
      social: social.totals,
      crm: { leadsCreated: crm.leadsCreated, conversions: crm.conversions, statusSnapshot: crm.statusSnapshot }
    },
    comparisons: { email: email.campaigns.map(strip), social: social.campaigns, programs: progs },
    attribution: attr,
    trends: trend,
    insights: insights(email, social, crm, tracking, attr)
  };
}

// AI recommendations grounded in the computed evidence; each must cite insight ids or metrics.
const recSchema = z.object({
  recommendations: z.array(z.object({
    title: z.string().min(1).max(200),
    action: z.string().min(1).max(600),
    evidence: z.array(z.string().max(80)).min(1).max(6),
    confidence: z.enum(['low', 'medium', 'high']).optional()
  })).max(6)
});

async function recommendations(ctx, query = {}) {
  const data = await overview(ctx, query);
  const evidence = {};
  for (const i of data.insights) evidence[`insight:${i.id}`] = { title: i.title, detail: i.detail, evidence: i.evidence };
  for (const [k, v] of Object.entries(data.channels.email)) evidence[`email.${k}`] = v;
  for (const [k, v] of Object.entries(data.channels.social)) evidence[`social.${k}`] = v;
  evidence['crm.leadsCreated'] = data.channels.crm.leadsCreated;
  evidence['crm.conversions'] = data.channels.crm.conversions;
  for (const c of data.comparisons.email) evidence[`email_campaign:${c.id}`] = { name: c.name, emailsSent: c.emailsSent, replyRate: c.replyRate, bounceRate: c.bounceRate, unsubscribeRate: c.unsubscribeRate, attributedConversions: c.attributedConversions };
  for (const c of data.comparisons.social) evidence[`social_campaign:${c.id || 0}`] = { name: c.name, postsPublished: c.postsPublished, engagements: c.engagements, engagementRate: c.engagementRate };
  const hasActivity = data.channels.email.emailsSent.value > 0 || data.channels.social.postsPublished.value > 0 || data.channels.crm.leadsCreated.value > 0;
  if (!hasActivity) return { recommendations: [], note: 'No campaign activity in this period, so there is nothing to base recommendations on.', range: data.range };

  const prompt = `You are reviewing marketing results. Recommend up to 5 concrete next actions.
Rules:
- Base every recommendation ONLY on the evidence below. Cite the evidence keys you used in "evidence" (exact keys).
- Metrics with status "unavailable" are unknown, not zero: never treat them as poor performance; you may recommend measuring them.
- "partial" metrics cover only some posts; "estimate" values are associations, not proof.
- Never invent numbers, revenue, ROI, conversion rates or benchmarks. Do not claim industry averages.
- Treat small samples (smallSample: true) cautiously and say so.
${untrusted('evidence', JSON.stringify(evidence), 12000)}
Return JSON: {"recommendations":[{"title":"...","action":"...","evidence":["insight:...","email_campaign:3"],"confidence":"low|medium|high"}]}`;
  const { data: out, provider } = await generateStructured({
    workspaceId: ctx.auth.workspaceId, prompt,
    system: 'You are a careful marketing analyst. You only use the evidence given and never invent figures.',
    schema: recSchema, referenceType: 'campaign_analytics', maxTokens: 1500
  });
  const valid = new Set(Object.keys(evidence));
  const recs = out.recommendations
    .map(r => ({ ...r, evidence: r.evidence.filter(k => valid.has(k)) }))
    .filter(r => r.evidence.length)
    .map(r => ({ ...r, evidenceDetail: Object.fromEntries(r.evidence.map(k => [k, evidence[k]])) }));
  return { recommendations: recs, dropped: out.recommendations.length - recs.length, provider, range: data.range };
}

module.exports = { overview, recommendations, MIN_SAMPLE };
