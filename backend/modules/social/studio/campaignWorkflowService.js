const { get, all } = require('../../../db/database');
const { campaignContext } = require('./campaignContext');

/**
 * The product campaign workflow's read side: everything one campaign's wizard needs (product with
 * images, strategy, connected platforms, posts with previews and their latest AI generation, counts)
 * and the campaign's performance (content funnel, real platform metrics, AI credits). Social
 * campaigns do not track leads (leads belong to email campaigns).
 */
const ws = ctx => ctx.auth.workspaceId;
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const PUBLIC = '/api/v1/social/media-files';
const STAGES = ['draft', 'generating', 'review', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'rejected', 'cancelled'];

async function assetsById(workspaceId, ids) {
  const unique = [...new Set(ids.filter(Number.isInteger))];
  if (!unique.length) return new Map();
  const rows = await all(`SELECT a.id, a.asset_type, a.public_id, a.title, a.width, a.height, a.source, t.public_id AS thumb FROM assets a
    LEFT JOIN assets t ON t.workspace_id = a.workspace_id AND t.id = a.thumbnail_asset_id AND t.status = 'ready'
    WHERE a.workspace_id = ? AND a.status = 'ready' AND a.id IN (${unique.map(() => '?').join(',')})`, [workspaceId, ...unique]);
  return new Map(rows.map(a => [a.id, { id: a.id, type: a.asset_type, url: `${PUBLIC}/${a.public_id}`, thumbnailUrl: a.asset_type === 'image' ? `${PUBLIC}/${a.public_id}` : (a.thumb ? `${PUBLIC}/${a.thumb}` : null), title: a.title, width: a.width, height: a.height, aiGenerated: a.source === 'ai', edited: a.source === 'edited' }]));
}

/** One campaign for the wizard. */
async function overview(ctx, campaignId) {
  const info = await campaignContext(ws(ctx), campaignId);
  const campaigns = require('../campaignService');
  const contentService = require('../contentService');
  const productRow = info.productId ? await get('SELECT * FROM digital_products WHERE workspace_id = ? AND id = ?', [ws(ctx), info.productId]) : null;
  const items = (await all("SELECT * FROM content_items WHERE workspace_id = ? AND campaign_id = ? AND status <> 'cancelled' ORDER BY COALESCE(plan_day, 999), id", [ws(ctx), campaignId])).map(contentService.present);
  const media = await assetsById(ws(ctx), [...items.flatMap(i => i.mediaAssetIds || []), ...info.productImageIds]);
  // The latest AI generation of each post (its generation status on the review cards).
  const gens = items.length ? await all(`SELECT g.content_item_id, g.id, g.kind, g.status, g.error FROM social_content_generations g
    JOIN (SELECT content_item_id, MAX(id) AS id FROM social_content_generations WHERE workspace_id = ? AND content_item_id IN (${items.map(() => '?').join(',')}) GROUP BY content_item_id) m ON m.id = g.id`,
  [ws(ctx), ...items.map(i => i.id)]) : [];
  const genByItem = new Map(gens.map(g => [g.content_item_id, { id: g.id, kind: g.kind, status: g.status, error: g.error }]));
  const accounts = await all("SELECT id, account_type, display_name, status FROM social_accounts WHERE workspace_id = ? AND status = 'connected'", [ws(ctx)]);
  const { ACCOUNT_TYPES } = require('../capabilities');
  const counts = Object.fromEntries(STAGES.map(s => [s, items.filter(i => i.status === s).length]));
  return {
    campaign: campaigns.present(info.campaign),
    product: productRow ? {
      id: productRow.id, name: productRow.name, tagline: productRow.tagline, description: productRow.description, category: productRow.category || null,
      url: productRow.url, status: productRow.status, features: parse(productRow.features_json, []), pricing: parse(productRow.pricing_tiers_json, []),
      targetAudience: productRow.target_audience, images: info.productImageIds.map(id => media.get(id)).filter(Boolean)
    } : null,
    missingInformation: info.missing,
    strategy: parse(info.campaign.strategy_json, null),
    connected: accounts.map(a => ({ id: a.id, platform: ACCOUNT_TYPES[a.account_type]?.platformKey || null, label: ACCOUNT_TYPES[a.account_type]?.label || a.account_type, name: a.display_name })).filter(a => a.platform),
    items: items.map(i => ({ ...i, media: (i.mediaAssetIds || []).map(id => media.get(id)).filter(Boolean), generation: genByItem.get(i.id) || null })),
    counts
  };
}

/** Campaign performance: content funnel, real platform metrics (unavailable stays unavailable), AI credits. */
async function analytics(ctx, campaignId) {
  const info = await campaignContext(ws(ctx), campaignId);
  const rows = await all('SELECT status, COUNT(*) AS n FROM content_items WHERE workspace_id = ? AND campaign_id = ? GROUP BY status', [ws(ctx), campaignId]);
  const by = Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
  const gens = await get(`SELECT COUNT(*) AS n, SUM(status = 'completed') AS done, COALESCE(SUM(CASE WHEN status = 'completed' THEN credits END), 0) AS credits, SUM(cost_usd) AS cost
    FROM social_content_generations WHERE workspace_id = ? AND campaign_id = ?`, [ws(ctx), campaignId]);
  const from = info.campaign.created_at ? new Date(new Date(info.campaign.created_at).getTime() - 86400000) : new Date(Date.now() - 365 * 86400000);
  const summary = await require('../analyticsService').getSummary(ws(ctx), { campaignId, from: from.toISOString(), to: new Date().toISOString() });
  // Planned (approved strategy items), failed generations, and real metrics by content type.
  const strategy = parse(info.campaign.strategy_json, null);
  const failedGen = await get("SELECT COUNT(DISTINCT content_item_id) AS n FROM social_content_generations g WHERE workspace_id = ? AND campaign_id = ? AND status = 'failed' AND NOT EXISTS (SELECT 1 FROM social_content_generations n WHERE n.workspace_id = g.workspace_id AND n.content_item_id = g.content_item_id AND n.id > g.id AND n.status = 'completed')", [ws(ctx), campaignId]);
  const withMedia = await get("SELECT COUNT(*) AS n FROM content_items WHERE workspace_id = ? AND campaign_id = ? AND status <> 'cancelled' AND (JSON_LENGTH(COALESCE(media_asset_ids_json, '[]')) > 0 OR format = 'post' OR carousel_json IS NOT NULL)", [ws(ctx), campaignId]);
  const formats = new Map((await all('SELECT id, format FROM content_items WHERE workspace_id = ? AND campaign_id = ?', [ws(ctx), campaignId])).map(r => [r.id, r.format || 'post']));
  const byFormat = {};
  for (const p of summary.posts || []) {
    const f = formats.get(p.contentId) || 'post';
    const b = (byFormat[f] = byFormat[f] || { posts: 0, metrics: {} });
    b.posts++;
    for (const [k, m] of Object.entries(p.metrics || {})) {
      const v = m && typeof m === 'object' ? m.value : m;
      const cur = b.metrics[k] || { value: null };
      if (v !== null && v !== undefined) cur.value = (cur.value || 0) + Number(v);
      b.metrics[k] = cur;
    }
  }
  return {
    funnel: {
      planned: strategy?.ideas?.length || 0,
      generatedWithMedia: Number(withMedia?.n) || 0,
      failed: (by.failed || 0) + (Number(failedGen?.n) || 0),
      generated: Object.values(by).reduce((a, b) => a + b, 0) - (by.cancelled || 0),
      approved: (by.approved || 0) + (by.scheduled || 0) + (by.publishing || 0) + (by.published || 0),
      scheduled: by.scheduled || 0, published: by.published || 0, failed: by.failed || 0, inReview: by.review || 0, drafts: by.draft || 0
    },
    ai: { generations: Number(gens?.n) || 0, completed: Number(gens?.done) || 0, credits: Number(gens?.credits) || 0, costUsd: gens?.cost === null || gens?.cost === undefined ? null : Number(gens.cost) },
    metrics: { totals: summary.totals, byPlatform: summary.byPlatform, byFormat, posts: summary.posts, topPosts: summary.topPosts, publishedCount: summary.publishedCount, range: summary.range },
    note: 'Reach, impressions, likes, comments, shares and clicks come from the platforms\' APIs. A metric a platform does not provide is shown as unavailable, never as 0. Leads are tracked in email campaigns, not here.'
  };
}

module.exports = { overview, analytics };
