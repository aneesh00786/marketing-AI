const { run, get, all } = require('../../db/database');
const { toDbDateTime, isValidTimeZone } = require('../../lib/time');
const { getAdapter } = require('./providers');
const { canAccount, ACCOUNT_TYPES } = require('./capabilities');
const accountService = require('./accountService');

/**
 * Analytics come only from provider APIs and are stored as timestamped snapshots
 * with their source. A metric that the provider did not return is "unavailable",
 * never zero; a post we have not collected yet is "not_collected".
 */
const POST_METRICS = ['impressions', 'reach', 'views', 'likes', 'comments', 'shares', 'saves', 'clicks', 'avg_watch_time'];
// Averages are averaged across posts, never summed.
const AVERAGED = new Set(['avg_watch_time']);
const ENGAGEMENT_METRICS = ['likes', 'comments', 'shares', 'saves'];
const POST_LOOKBACK_DAYS = 60;

async function insertSnapshots(account, objectType, externalObjectId, contentItemId, metrics, source) {
  const collectedAt = toDbDateTime(new Date());
  for (const m of metrics) {
    await run(
      `INSERT INTO social_metric_snapshots (workspace_id, social_account_id, content_item_id, external_object_id, object_type,
         metric_key, metric_value, availability, unavailable_reason, period, source, collected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [account.workspace_id, account.id, contentItemId, externalObjectId, objectType, m.metric_key,
        m.value === null || m.value === undefined ? null : m.value, m.availability || (m.value === null ? 'unavailable' : 'available'),
        m.reason ? String(m.reason).slice(0, 500) : null, m.period || 'lifetime', source, collectedAt]
    );
  }
}

/** 'video' when the post carried a video (platforms report video posts with different metrics). */
async function postMediaKind(workspaceId, mediaJson) {
  let ids = [];
  try { ids = JSON.parse(mediaJson || '[]'); } catch (e) { ids = []; }
  if (!ids.length) return null;
  const v = await get(`SELECT id FROM assets WHERE workspace_id = ? AND asset_type = 'video' AND id IN (${ids.map(() => '?').join(',')}) LIMIT 1`, [workspaceId, ...ids]);
  return v ? 'video' : 'image';
}

/** Worker handler: collects account and recent-post metrics for one account. */
async function syncAccountAnalytics(job) {
  const { accountId } = JSON.parse(job.payload_json || '{}');
  const account = await accountService.getAccountRow(job.workspace_id, accountId);
  if (!account || account.status !== 'connected') return { skipped: 'account not connected' };
  if (accountService.isDemoAccount(account)) return { skipped: 'demo account' };
  const adapter = getAdapter(account.provider_key);
  const source = `${account.provider_key}_api`;
  const summary = { accountMetrics: 0, posts: 0, skipped: [] };

  try {
    const secret = await accountService.getUsableSecret(account);
    if (canAccount(account, 'analytics_account')) {
      const metrics = await adapter.fetchAccountMetrics(account, secret);
      await insertSnapshots(account, 'account', account.external_account_id, null, metrics, source);
      summary.accountMetrics = metrics.length;
    } else {
      summary.skipped.push('analytics_account');
    }

    if (canAccount(account, 'analytics_post')) {
      const posts = await all(
        `SELECT id, external_post_id, media_asset_ids_json FROM content_items
         WHERE workspace_id = ? AND social_account_id = ? AND status = 'published' AND external_post_id IS NOT NULL
           AND published_at >= UTC_TIMESTAMP() - INTERVAL ${POST_LOOKBACK_DAYS} DAY
         ORDER BY published_at DESC LIMIT 50`,
        [account.workspace_id, account.id]
      );
      for (const p of posts) {
        const mediaKind = await postMediaKind(account.workspace_id, p.media_asset_ids_json);
        const metrics = await adapter.fetchPostMetrics(account, secret, p.external_post_id, { mediaKind });
        await insertSnapshots(account, 'post', p.external_post_id, p.id, metrics, source);
        summary.posts += 1;
      }
    } else {
      summary.skipped.push('analytics_post');
    }
    await accountService.recordAccountSuccess(account);
    return summary;
  } catch (err) {
    if (['AUTH_EXPIRED', 'PERMISSION_DENIED'].includes(err.code)) {
      await accountService.recordAccountFailure(account, err);
      err.retryable = false;
    }
    throw err;
  }
}

function emptyMetric() {
  return { value: null, availableFor: 0, unavailableFor: 0, notCollectedFor: 0 };
}

/**
 * Dashboard data for a date range. Values are summed only over posts where the
 * provider returned the metric; coverage counts let the UI say "available for 3 of 5 posts".
 */
async function getSummary(workspaceId, { from, to, platformKey, accountId, campaignId, timezone } = {}) {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * 24 * 3600 * 1000);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    const err = new Error('Invalid date range.');
    err.status = 400;
    throw err;
  }
  const where = ["c.workspace_id = ?", "c.status = 'published'", 'c.published_at BETWEEN ? AND ?'];
  const params = [workspaceId, toDbDateTime(fromDate), toDbDateTime(toDate)];
  if (platformKey) { where.push('c.platform_key = ?'); params.push(platformKey); }
  if (accountId) { where.push('c.social_account_id = ?'); params.push(Number(accountId)); }
  if (campaignId) { where.push('c.campaign_id = ?'); params.push(Number(campaignId)); }

  const posts = await all(
    `SELECT c.id, c.title, c.platform_key, c.campaign_id, c.social_account_id, c.published_at, c.external_post_id, c.external_url,
            a.display_name AS account_name, a.account_type, a.scopes_json, a.provider_key, a.status AS account_status, cp.name AS campaign_name
     FROM content_items c
     LEFT JOIN social_accounts a ON a.workspace_id = c.workspace_id AND a.id = c.social_account_id
     LEFT JOIN campaigns cp ON cp.workspace_id = c.workspace_id AND cp.id = c.campaign_id
     WHERE ${where.join(' AND ')}
     ORDER BY c.published_at DESC LIMIT 500`,
    params
  );

  const snapshotsByPost = new Map();
  const ids = posts.map(p => p.external_post_id).filter(Boolean);
  if (ids.length) {
    const rows = await all(
      `SELECT s.external_object_id, s.metric_key, s.metric_value, s.availability, s.unavailable_reason, s.collected_at, s.source, s.period
       FROM social_metric_snapshots s
       JOIN (SELECT external_object_id, metric_key, MAX(id) AS mid FROM social_metric_snapshots
             WHERE workspace_id = ? AND object_type = 'post' AND external_object_id IN (${ids.map(() => '?').join(',')})
             GROUP BY external_object_id, metric_key) latest ON latest.mid = s.id`,
      [workspaceId, ...ids]
    );
    for (const r of rows) {
      if (!snapshotsByPost.has(r.external_object_id)) snapshotsByPost.set(r.external_object_id, {});
      snapshotsByPost.get(r.external_object_id)[r.metric_key] = r;
    }
  }

  const totals = Object.fromEntries(POST_METRICS.map(m => [m, emptyMetric()]));
  const byPlatform = {};
  const byCampaign = {};
  const postRows = posts.map(p => {
    const snaps = snapshotsByPost.get(p.external_post_id) || null;
    const metrics = {};
    for (const m of POST_METRICS) {
      const s = snaps?.[m];
      let entry;
      if (!snaps) entry = { value: null, availability: 'not_collected', reason: 'Metrics not collected yet.' };
      else if (!s) entry = { value: null, availability: 'unavailable', reason: 'This platform does not report this metric.' };
      else entry = { value: s.availability === 'available' && s.metric_value !== null ? Number(s.metric_value) : null, availability: s.availability, reason: s.unavailable_reason, collectedAt: s.collected_at, source: s.source };
      metrics[m] = entry;

      for (const bucket of [totals, (byPlatform[p.platform_key] = byPlatform[p.platform_key] || { posts: 0, metrics: Object.fromEntries(POST_METRICS.map(k => [k, emptyMetric()])) }).metrics,
        (byCampaign[p.campaign_id || 0] = byCampaign[p.campaign_id || 0] || { name: p.campaign_name || 'No campaign', posts: 0, metrics: Object.fromEntries(POST_METRICS.map(k => [k, emptyMetric()])) }).metrics]) {
        const t = bucket[m];
        if (entry.value !== null) { t.value = (t.value || 0) + entry.value; t.availableFor += 1; t.averaged = AVERAGED.has(m) || undefined; }
        else if (entry.availability === 'not_collected') t.notCollectedFor += 1;
        else t.unavailableFor += 1;
      }
    }
    const engagementParts = ENGAGEMENT_METRICS.map(m => metrics[m].value).filter(v => v !== null);
    return {
      contentId: p.id,
      title: p.title,
      platformKey: p.platform_key,
      accountName: p.account_name,
      campaignId: p.campaign_id,
      campaignName: p.campaign_name,
      publishedAt: p.published_at,
      externalUrl: p.external_url,
      metrics,
      engagements: engagementParts.length ? engagementParts.reduce((a, b) => a + b, 0) : null,
      engagementsPartial: engagementParts.length > 0 && engagementParts.length < ENGAGEMENT_METRICS.length
    };
  });
  for (const p of posts) {
    byPlatform[p.platform_key].posts += 1;
    byCampaign[p.campaign_id || 0].posts += 1;
  }

  // Follower counts: latest and earliest snapshot inside the range, per account.
  const accounts = await all(
    `SELECT id, display_name, account_type, scopes_json, provider_key, status FROM social_accounts WHERE workspace_id = ? AND status <> 'disconnected' ${accountId ? 'AND id = ?' : ''}`,
    accountId ? [workspaceId, Number(accountId)] : [workspaceId]
  );
  const followers = [];
  for (const a of accounts) {
    const platform = ACCOUNT_TYPES[a.account_type]?.platformKey;
    if (platformKey && platform !== platformKey) continue;
    const range = await all(
      `SELECT metric_value, availability, unavailable_reason, collected_at FROM social_metric_snapshots
       WHERE workspace_id = ? AND social_account_id = ? AND object_type = 'account' AND metric_key = 'followers' AND collected_at BETWEEN ? AND ?
       ORDER BY collected_at ASC`,
      [workspaceId, a.id, toDbDateTime(fromDate), toDbDateTime(toDate)]
    );
    const available = range.filter(r => r.availability === 'available' && r.metric_value !== null);
    followers.push({
      accountId: a.id,
      accountName: a.display_name,
      platformKey: platform,
      supported: canAccount(a, 'analytics_account'),
      latest: available.length ? Number(available[available.length - 1].metric_value) : null,
      change: available.length >= 2 ? Number(available[available.length - 1].metric_value) - Number(available[0].metric_value) : null,
      collectedAt: available.length ? available[available.length - 1].collected_at : null,
      reason: available.length ? null : (range[range.length - 1]?.unavailable_reason || (canAccount(a, 'analytics_account') ? 'Not collected in this period yet.' : 'Not available for this account.'))
    });
  }

  // Averaged metrics: the bucket holds a sum until here.
  for (const bucket of [totals, ...Object.values(byPlatform).map(b => b.metrics), ...Object.values(byCampaign).map(b => b.metrics)]) {
    for (const m of AVERAGED) {
      const t = bucket[m];
      if (t && t.value !== null && t.availableFor) t.value = Math.round((t.value / t.availableFor) * 100) / 100;
    }
  }

  // Daily trend by publish date in the workspace time zone. Engagement sums only reported values.
  const tz = timezone && isValidTimeZone(timezone) ? timezone : 'UTC';
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const trendMap = new Map();
  for (const p of postRows) {
    const day = dayFmt.format(new Date(p.publishedAt));
    if (!trendMap.has(day)) trendMap.set(day, { date: day, posts: 0, engagements: null, impressions: null, postsWithEngagement: 0, postsWithImpressions: 0 });
    const t = trendMap.get(day);
    t.posts += 1;
    if (p.engagements !== null) { t.engagements = (t.engagements || 0) + p.engagements; t.postsWithEngagement += 1; }
    if (p.metrics.impressions.value !== null) { t.impressions = (t.impressions || 0) + p.metrics.impressions.value; t.postsWithImpressions += 1; }
  }
  const trend = [...trendMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  const ranked = postRows.filter(p => p.engagements !== null).sort((a, b) => b.engagements - a.engagements);
  return {
    range: { from: fromDate.toISOString(), to: toDate.toISOString() },
    timezone: tz,
    publishedCount: posts.length,
    trend,
    totals,
    byPlatform,
    byCampaign,
    followers,
    topPosts: ranked.slice(0, 10),
    posts: postRows
  };
}

/** A spreadsheet cell; values that a spreadsheet would run as formulas are neutralised. */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Per-post report. A metric the platform did not report is left blank and named in the
 * "Unavailable metrics" column, so a blank is never mistaken for zero.
 */
function toCsv(summary) {
  const head = ['Published at (UTC)', 'Platform', 'Account', 'Campaign', 'Title', 'Post URL', ...POST_METRICS.map(m => (m === 'avg_watch_time' ? 'avg_watch_time_seconds' : m)), 'Engagements (reported metrics only)', 'Unavailable metrics', 'Metrics collected at'];
  const lines = [head.map(csvCell).join(',')];
  for (const p of summary.posts) {
    const unavailable = POST_METRICS.filter(m => p.metrics[m].value === null).map(m => `${m} (${p.metrics[m].availability})`);
    const collected = POST_METRICS.map(m => p.metrics[m].collectedAt).filter(Boolean).map(d => new Date(d).getTime());
    lines.push([
      new Date(p.publishedAt).toISOString(), p.platformKey, p.accountName, p.campaignName, p.title, p.externalUrl,
      ...POST_METRICS.map(m => p.metrics[m].value),
      p.engagements, unavailable.join('; '), collected.length ? new Date(Math.max(...collected)).toISOString() : ''
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  POST_METRICS,
  toCsv,
  syncAccountAnalytics,
  getSummary,
  insertSnapshots
};
