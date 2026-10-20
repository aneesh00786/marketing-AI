const { all, get } = require('../../db/database');
const accountService = require('./accountService');
const contentService = require('./contentService');
const analyticsService = require('./analyticsService');
const settingsService = require('./settingsService');
const { setupStatus } = require('./oauthService');
const { PROVIDERS } = require('./capabilities');

/** Single call for the hub Overview: everything is read from stored, real records. */
async function getOverview(workspaceId) {
  const [accounts, settings] = await Promise.all([
    accountService.listAccounts(workspaceId),
    settingsService.getSettings(workspaceId)
  ]);
  const activeCampaigns = await all(
    "SELECT id, name, objective, start_date, end_date, generation_status FROM campaigns WHERE workspace_id = ? AND source = 'social_hub' AND status IN ('Active', 'Draft') ORDER BY id DESC LIMIT 10",
    [workspaceId]
  );
  const awaitingApproval = await contentService.listContent(workspaceId, { status: 'review', limit: 10 });
  const scheduled = await all(
    `SELECT c.*, a.display_name AS account_name FROM content_items c
     LEFT JOIN social_accounts a ON a.workspace_id = c.workspace_id AND a.id = c.social_account_id
     WHERE c.workspace_id = ? AND c.status = 'scheduled' ORDER BY c.scheduled_at ASC LIMIT 10`,
    [workspaceId]
  );
  const published = await all(
    `SELECT c.*, a.display_name AS account_name FROM content_items c
     LEFT JOIN social_accounts a ON a.workspace_id = c.workspace_id AND a.id = c.social_account_id
     WHERE c.workspace_id = ? AND c.status = 'published' ORDER BY c.published_at DESC LIMIT 10`,
    [workspaceId]
  );
  const failedJobs = await all(
    `SELECT j.id, j.content_item_id, j.status, j.last_error, j.last_error_code, j.updated_at, c.title, a.display_name AS account_name
     FROM publishing_jobs j
     JOIN content_items c ON c.workspace_id = j.workspace_id AND c.id = j.content_item_id
     JOIN social_accounts a ON a.workspace_id = j.workspace_id AND a.id = j.social_account_id
     WHERE j.workspace_id = ? AND j.status IN ('failed', 'needs_review') ORDER BY j.updated_at DESC LIMIT 10`,
    [workspaceId]
  );
  const counts = await all('SELECT status, COUNT(*) AS c FROM content_items WHERE workspace_id = ? GROUP BY status', [workspaceId]);
  const openThreads = await get("SELECT COUNT(*) AS c FROM engagement_threads WHERE workspace_id = ? AND status = 'open'", [workspaceId]);
  const analytics = await analyticsService.getSummary(workspaceId, {});

  const withAccountName = rows => rows.map(r => ({ ...contentService.present(r), accountName: r.account_name }));
  return {
    settings,
    providers: await Promise.all(Object.keys(PROVIDERS).map(k => setupStatus(workspaceId, k))),
    accounts,
    connectionHealth: {
      connected: accounts.filter(a => a.status === 'connected').length,
      needsAttention: accounts.filter(a => a.status !== 'connected').length
    },
    activeCampaigns,
    awaitingApproval: awaitingApproval.items,
    scheduled: withAccountName(scheduled),
    recentlyPublished: withAccountName(published),
    failedPublications: failedJobs,
    contentCounts: Object.fromEntries(counts.map(r => [r.status, Number(r.c)])),
    openConversations: Number(openThreads?.c || 0),
    metrics: {
      range: analytics.range,
      publishedCount: analytics.publishedCount,
      totals: analytics.totals,
      followers: analytics.followers
    }
  };
}

module.exports = { getOverview };
