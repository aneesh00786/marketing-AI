const { all, get } = require('../../db/database');
const { toDbDateTime } = require('../../lib/time');
const analyticsService = require('./analyticsService');
const accountService = require('./accountService');
const settingsService = require('./settingsService');
const contentService = require('./contentService');

/**
 * AI Marketing Command Center data. Everything is derived from stored records:
 * provider metric snapshots (via analyticsService), content/campaign rows and leads.
 * Metrics the providers did not report stay null ("unavailable"), never 0.
 */
const ENGAGEMENT_KEYS = ['likes', 'comments', 'shares', 'saves'];
const SERIES_KEYS = ['reach', 'impressions', 'engagements', 'clicks'];

function resolveRange({ range, from, to }) {
  const end = to ? new Date(to) : new Date();
  let start;
  if (from) start = new Date(from);
  else start = new Date(end.getTime() - (parseInt(range, 10) || 30) * 86400000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    const err = new Error('Invalid date range.');
    err.status = 400;
    throw err;
  }
  if (end.getTime() - start.getTime() > 366 * 86400000) {
    const err = new Error('Date range cannot exceed one year.');
    err.status = 400;
    throw err;
  }
  const length = end.getTime() - start.getTime();
  return { start, end, prevStart: new Date(start.getTime() - length), prevEnd: start };
}

function dayKey(date, timeZone) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(date)).forEach(x => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}`;
}

function sumAvailable(values) {
  const v = values.filter(x => x !== null && x !== undefined);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}

/** Engagements for one post: sum of reported engagement metrics, null if none were reported. */
function postEngagements(post) {
  return sumAvailable(ENGAGEMENT_KEYS.map(k => post.metrics[k]?.value ?? null));
}

/** KPI block for one period, built from the analytics summary and leads. */
async function periodKpis(workspaceId, start, end) {
  const summary = await analyticsService.getSummary(workspaceId, { from: start.toISOString(), to: end.toISOString() });
  const posts = summary.posts;
  const reach = summary.totals.reach;
  const impressions = summary.totals.impressions;
  const clicks = summary.totals.clicks;

  // Engagement rate only over posts that report both engagements and reach.
  const rated = posts.filter(p => postEngagements(p) !== null && p.metrics.reach.value);
  const engagementRate = rated.length
    ? rated.reduce((a, p) => a + postEngagements(p), 0) / rated.reduce((a, p) => a + p.metrics.reach.value, 0)
    : null;

  const leads = await get('SELECT COUNT(*) AS c FROM leads WHERE workspace_id = ? AND created_at >= ? AND created_at < ?', [workspaceId, toDbDateTime(start), toDbDateTime(end)]);
  const socialLeads = await get(
    "SELECT COUNT(*) AS c FROM leads WHERE workspace_id = ? AND created_at >= ? AND created_at < ? AND product_interest LIKE 'Social (%'",
    [workspaceId, toDbDateTime(start), toDbDateTime(end)]
  );
  return {
    summary,
    kpis: {
      publishedPosts: summary.publishedCount,
      reach: { value: reach.value, coverage: { available: reach.availableFor, total: posts.length } },
      impressions: { value: impressions.value, coverage: { available: impressions.availableFor, total: posts.length } },
      clicks: { value: clicks.value, coverage: { available: clicks.availableFor, total: posts.length } },
      engagements: { value: sumAvailable(posts.map(postEngagements)), coverage: { available: posts.filter(p => postEngagements(p) !== null).length, total: posts.length } },
      engagementRate: { value: engagementRate === null ? null : Number((engagementRate * 100).toFixed(2)), basedOnPosts: rated.length },
      leads: { value: Number(leads?.c || 0), fromSocial: Number(socialLeads?.c || 0) }
    }
  };
}

/** Change vs previous period, only when the previous period has real data for that metric. */
function compare(current, previous, hasPreviousData) {
  if (!hasPreviousData || current === null || previous === null || previous === undefined) return null;
  if (previous === 0) return current === 0 ? { delta: 0, pct: 0 } : { delta: current, pct: null };
  return { delta: Number((current - previous).toFixed(2)), pct: Number((((current - previous) / previous) * 100).toFixed(1)) };
}

async function getDashboard(workspaceId, query = {}) {
  const settings = await settingsService.getSettings(workspaceId);
  const tz = settings.timezone || 'UTC';
  const { start, end, prevStart, prevEnd } = resolveRange(query);

  const [current, previous] = await Promise.all([periodKpis(workspaceId, start, end), periodKpis(workspaceId, prevStart, prevEnd)]);
  const posts = current.summary.posts;
  const prevHasPosts = previous.summary.publishedCount > 0;
  const prevLeadsExist = !!(await get('SELECT id FROM leads WHERE workspace_id = ? AND created_at < ? LIMIT 1', [workspaceId, toDbDateTime(prevEnd)]));

  // Campaign counts are not time-bound: they describe the current portfolio.
  const campaignRows = await all(
    `SELECT id, name, objective, status, generation_status, platforms_json, channels, start_date, end_date, source, created_at
     FROM campaigns WHERE workspace_id = ? ORDER BY id DESC LIMIT 200`,
    [workspaceId]
  );
  const activeCampaigns = campaignRows.filter(c => ['Active', 'Running', 'Scheduled'].includes(c.status));

  const c = current.kpis;
  const p = previous.kpis;
  const kpis = {
    totalCampaigns: { value: campaignRows.length, change: null },
    activeCampaigns: { value: activeCampaigns.length, change: null },
    publishedPosts: { value: c.publishedPosts, change: compare(c.publishedPosts, p.publishedPosts, prevHasPosts) },
    reach: { ...c.reach, change: compare(c.reach.value, p.reach.value, prevHasPosts) },
    impressions: { ...c.impressions, change: compare(c.impressions.value, p.impressions.value, prevHasPosts) },
    engagementRate: { ...c.engagementRate, change: compare(c.engagementRate.value, p.engagementRate.value, prevHasPosts) },
    clicks: { ...c.clicks, change: compare(c.clicks.value, p.clicks.value, prevHasPosts) },
    leads: { ...c.leads, change: compare(c.leads.value, p.leads.value, prevLeadsExist) }
  };

  // Daily series: metrics of posts by publish day (latest collected values) + leads created per day.
  const days = [];
  for (let d = new Date(start); d < end; d = new Date(d.getTime() + 86400000)) days.push(dayKey(d, tz));
  const uniqueDays = [...new Set([...days, dayKey(new Date(end.getTime() - 1), tz)])];
  const byDay = Object.fromEntries(uniqueDays.map(k => [k, { date: k, posts: 0, reach: [], impressions: [], engagements: [], clicks: [] }]));
  for (const post of posts) {
    const k = dayKey(post.publishedAt, tz);
    if (!byDay[k]) continue;
    byDay[k].posts += 1;
    byDay[k].reach.push(post.metrics.reach.value);
    byDay[k].impressions.push(post.metrics.impressions.value);
    byDay[k].engagements.push(postEngagements(post));
    byDay[k].clicks.push(post.metrics.clicks.value);
  }
  const leadRows = await all('SELECT created_at FROM leads WHERE workspace_id = ? AND created_at >= ? AND created_at < ?', [workspaceId, toDbDateTime(start), toDbDateTime(end)]);
  const leadsByDay = {};
  for (const r of leadRows) {
    const k = dayKey(r.created_at, tz);
    leadsByDay[k] = (leadsByDay[k] || 0) + 1;
  }
  const series = uniqueDays.map(k => {
    const d = byDay[k];
    const point = { date: k, posts: d.posts, leads: leadsByDay[k] || 0 };
    // No posts that day => no value (gap), not zero.
    for (const m of SERIES_KEYS) point[m] = d.posts ? sumAvailable(d[m]) : null;
    return point;
  });

  // Campaign comparison + table.
  const contentStats = await all(
    `SELECT campaign_id, status, COUNT(*) AS c, MIN(CASE WHEN status = 'scheduled' THEN scheduled_at END) AS next_scheduled
     FROM content_items WHERE workspace_id = ? AND campaign_id IS NOT NULL GROUP BY campaign_id, status`,
    [workspaceId]
  );
  const statsByCampaign = {};
  for (const r of contentStats) {
    const s = (statsByCampaign[r.campaign_id] = statsByCampaign[r.campaign_id] || { counts: {}, nextScheduled: null });
    s.counts[r.status] = Number(r.c);
    if (r.next_scheduled && (!s.nextScheduled || new Date(r.next_scheduled) < new Date(s.nextScheduled))) s.nextScheduled = r.next_scheduled;
  }
  const metricsByCampaign = current.summary.byCampaign;
  const campaigns = campaignRows.map(row => {
    let platforms = [];
    try { platforms = JSON.parse(row.platforms_json || '[]'); } catch (e) { platforms = []; }
    if (!platforms.length && row.channels) platforms = String(row.channels).split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    const m = metricsByCampaign[row.id];
    const campaignPosts = posts.filter(x => x.campaignId === row.id);
    return {
      id: row.id,
      name: row.name,
      objective: row.objective,
      status: row.status,
      generationStatus: row.generation_status,
      source: row.source,
      platforms,
      startDate: row.start_date,
      endDate: row.end_date,
      nextScheduled: statsByCampaign[row.id]?.nextScheduled || null,
      contentCounts: statsByCampaign[row.id]?.counts || {},
      publishedInRange: m?.posts || 0,
      metrics: {
        reach: m ? m.metrics.reach.value : null,
        clicks: m ? m.metrics.clicks.value : null,
        engagements: sumAvailable(campaignPosts.map(postEngagements))
      }
    };
  });

  // Platform performance: only connected accounts' platforms.
  const accounts = await accountService.listAccounts(workspaceId);
  const connectedPlatforms = [...new Set(accounts.filter(a => a.status === 'connected').map(a => a.platformKey).filter(Boolean))];
  const platforms = ['facebook', 'instagram', 'linkedin', 'youtube'].map(key => {
    const connected = connectedPlatforms.includes(key);
    const accts = accounts.filter(a => a.platformKey === key);
    const pp = posts.filter(x => x.platformKey === key);
    const followers = current.summary.followers.filter(f => f.platformKey === key);
    return {
      key,
      connected,
      accounts: accts.map(a => ({ id: a.id, name: a.displayName, status: a.status })),
      posts: pp.length,
      reach: sumAvailable(pp.map(x => x.metrics.reach.value)),
      engagements: sumAvailable(pp.map(postEngagements)),
      clicks: sumAvailable(pp.map(x => x.metrics.clicks.value)),
      followers: sumAvailable(followers.map(f => f.latest))
    };
  });

  // Post status donut (all content in the workspace) + campaign status counts.
  const statusRows = await all('SELECT status, COUNT(*) AS c FROM content_items WHERE workspace_id = ? GROUP BY status', [workspaceId]);
  const postStatus = Object.fromEntries(statusRows.map(r => [r.status, Number(r.c)]));
  const campaignStatus = {};
  for (const row of campaignRows) campaignStatus[row.status || 'Draft'] = (campaignStatus[row.status || 'Draft'] || 0) + 1;

  // Upcoming activities and items needing attention.
  const scheduled = await all(
    `SELECT c.*, a.display_name AS account_name FROM content_items c
     LEFT JOIN social_accounts a ON a.workspace_id = c.workspace_id AND a.id = c.social_account_id
     WHERE c.workspace_id = ? AND c.status = 'scheduled' ORDER BY c.scheduled_at ASC LIMIT 8`,
    [workspaceId]
  );
  const pendingApprovals = await all("SELECT * FROM content_items WHERE workspace_id = ? AND status = 'review' ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 8", [workspaceId]);
  const failedJobs = await all(
    `SELECT j.id, j.status, j.last_error, j.updated_at, j.content_item_id, c.title, c.platform_key, a.display_name AS account_name
     FROM publishing_jobs j
     JOIN content_items c ON c.workspace_id = j.workspace_id AND c.id = j.content_item_id
     JOIN social_accounts a ON a.workspace_id = j.workspace_id AND a.id = j.social_account_id
     WHERE j.workspace_id = ? AND j.status IN ('failed', 'needs_review') ORDER BY j.updated_at DESC LIMIT 8`,
    [workspaceId]
  );
  const attention = [
    ...accounts.filter(a => a.status !== 'connected').map(a => ({ type: 'account', id: a.id, title: `${a.displayName} is ${a.status}`, detail: a.statusDetail || 'Reconnect this account.' })),
    ...campaignRows.filter(r => r.generation_status === 'failed').map(r => ({ type: 'campaign', id: r.id, title: `Generation failed: ${r.name}`, detail: 'Open the campaign to retry.' }))
  ];

  // Demo/test data is flagged so it is never mistaken for real performance.
  const metricSources = new Set();
  for (const post of posts) for (const m of Object.values(post.metrics)) if (m.source) metricSources.add(m.source);
  const demoSources = [...metricSources].filter(s => !/_api$/.test(s));
  const demoAccounts = accounts.filter(a => /\b(demo|test)\b/i.test(a.displayName || ''));

  return {
    range: { from: start.toISOString(), to: end.toISOString(), previousFrom: prevStart.toISOString(), previousTo: prevEnd.toISOString(), timezone: tz },
    kpis,
    series,
    campaigns,
    platforms,
    postStatus,
    campaignStatus,
    activities: {
      scheduled: scheduled.map(r => ({ ...contentService.present(r), accountName: r.account_name })),
      pendingApprovals: pendingApprovals.map(contentService.present),
      failedJobs,
      attention
    },
    followers: current.summary.followers,
    topPosts: current.summary.topPosts.slice(0, 5),
    dataQuality: {
      containsDemoData: demoSources.length > 0 || demoAccounts.length > 0,
      demoSources,
      demoAccounts: demoAccounts.map(a => a.displayName),
      connectedAccounts: accounts.filter(a => a.status === 'connected').length,
      postsWithoutMetrics: posts.filter(x => Object.values(x.metrics).every(m => m.availability === 'not_collected')).length
    },
    insights: buildInsights({ kpis, platforms, campaigns, posts, postStatus, failedJobs, accounts, prevHasPosts })
  };
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

/**
 * Rule-based insights computed from the data above (no AI call, no invented numbers).
 * Each insight names the dashboard section that holds its supporting data.
 */
function buildInsights({ kpis, platforms, campaigns, posts, postStatus, failedJobs, accounts, prevHasPosts }) {
  const out = [];
  if (!accounts.some(a => a.status === 'connected')) {
    out.push({ tone: 'info', title: 'Connect a social account', text: 'No account is connected, so there are no platform metrics yet. Connect Facebook, Instagram, LinkedIn or YouTube to start measuring.', link: { route: 'social', section: 'accounts' } });
  }
  if (failedJobs.length) {
    out.push({ tone: 'danger', title: `${failedJobs.length} publication${failedJobs.length > 1 ? 's need' : ' needs'} attention`, text: 'Some posts failed or have an unknown outcome. Check the platform, then retry from the Publishing Queue.', link: { route: 'social', section: 'queue', status: 'failed' } });
  }
  if (postStatus.review) {
    out.push({ tone: 'warning', title: `${postStatus.review} post${postStatus.review > 1 ? 's' : ''} waiting for approval`, text: 'Approved content can be scheduled; unapproved drafts cannot be published.', link: { route: 'social', section: 'library', status: 'review' } });
  }
  const measured = platforms.filter(p => p.posts > 0 && p.engagements !== null);
  if (measured.length >= 2) {
    const ranked = measured.map(p => ({ ...p, avg: p.engagements / p.posts })).sort((a, b) => b.avg - a.avg);
    out.push({ tone: 'success', title: `${cap(ranked[0].key)} has the highest engagement per post`, text: `${cap(ranked[0].key)} averages ${fmt(ranked[0].avg.toFixed(1))} engagements per post vs ${fmt(ranked[ranked.length - 1].avg.toFixed(1))} on ${cap(ranked[ranked.length - 1].key)} in this period.`, link: { anchor: 'platforms' } });
  }
  const top = posts.filter(p => postEngagements(p) !== null).sort((a, b) => postEngagements(b) - postEngagements(a))[0];
  if (top) {
    out.push({ tone: 'success', title: 'Top performing post', text: `"${top.title || 'Untitled'}" on ${cap(top.platformKey)} has ${fmt(postEngagements(top))} engagements${top.metrics.reach.value !== null ? ` from a reach of ${fmt(top.metrics.reach.value)}` : ''}.`, link: { route: 'social', section: 'analytics' } });
  }
  const unavailable = ['reach', 'impressions', 'clicks'].filter(k => kpis[k].coverage.total > 0 && kpis[k].coverage.available === 0);
  if (unavailable.length) {
    out.push({ tone: 'info', title: `${unavailable.map(cap).join(', ')} not reported`, text: 'The connected platforms did not return these metrics for your posts. This usually means a missing insights permission or a metric the platform no longer provides.', link: { route: 'social', section: 'accounts' } });
  }
  if (kpis.publishedPosts.value === 0 && accounts.some(a => a.status === 'connected')) {
    out.push({ tone: 'info', title: 'Nothing published in this period', text: 'There are no provider-confirmed posts in the selected range. Schedule approved content to start collecting performance data.', link: { route: 'social', section: 'calendar' } });
  }
  if (kpis.reach.change && kpis.reach.change.pct !== null && prevHasPosts) {
    const up = kpis.reach.change.pct >= 0;
    out.push({ tone: up ? 'success' : 'warning', title: `Reach ${up ? 'up' : 'down'} ${Math.abs(kpis.reach.change.pct)}%`, text: 'Compared with the previous period of the same length, based on posts with reported reach.', link: { anchor: 'performance' } });
  }
  const idle = campaigns.filter(c => c.status === 'Active' && !c.nextScheduled && !(c.contentCounts.published > 0));
  if (idle.length) {
    out.push({ tone: 'warning', title: `${idle.length} active campaign${idle.length > 1 ? 's have' : ' has'} nothing scheduled`, text: `${idle.slice(0, 2).map(c => `"${c.name}"`).join(', ')}${idle.length > 2 ? '…' : ''} — schedule approved posts to keep them running.`, link: { anchor: 'campaigns' } });
  }
  return out.slice(0, 6);
}

const PLATFORM_NAMES = { facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', youtube: 'YouTube', x: 'X' };

function cap(s) {
  const key = String(s || '');
  return PLATFORM_NAMES[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

module.exports = { getDashboard, resolveRange, buildInsights, compare };
