const { get } = require('../../../db/database');

/**
 * What the AI knows about a campaign: the campaign brief and the selected product's real facts,
 * read on the server from this workspace's records (never from the browser), plus what is missing.
 * Generators use it so content is about the product without inventing features, prices or claims.
 */
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code, expose: true });

async function campaignContext(workspaceId, campaignId) {
  if (!campaignId) return null;
  const campaigns = require('../campaignService');
  const row = await get('SELECT * FROM campaigns WHERE workspace_id = ? AND id = ?', [workspaceId, campaignId]);
  if (!row) throw httpError(404, 'Campaign not found.', 'NOT_FOUND');
  const facts = await campaigns.loadFacts(workspaceId, row);
  const product = row.product_id ? await get('SELECT id, image_asset_ids_json FROM digital_products WHERE workspace_id = ? AND id = ?', [workspaceId, row.product_id]) : null;
  const p = facts.product || null;
  const missing = [];
  if (!p) missing.push('No product is selected for this campaign.');
  else {
    if (!p.description && !p.tagline) missing.push('Product description');
    if (!(p.features || []).length) missing.push('Product features');
    if (!(p.pricing || []).length) missing.push('Pricing (prices and offers will not be mentioned)');
    if (!p.url && !row.landing_url) missing.push('Website or landing page');
  }
  const brief = {
    name: row.name, objective: row.objective, description: row.description, target_audience: row.target_audience, key_message: row.key_message,
    offer: row.offer, call_to_action: row.call_to_action, landing_url: row.landing_url || p?.url || null, tone: row.tone, language: row.language,
    start_date: row.start_date, end_date: row.end_date, platforms: parse(row.platforms_json, [])
  };
  return {
    campaign: row, productId: row.product_id || null, product: p, facts, brief, missing,
    // The product images chosen for this campaign in the wizard (else any on the product record).
    productImageIds: (parse(row.image_asset_ids_json, []).length ? parse(row.image_asset_ids_json, []) : parse(product?.image_asset_ids_json, [])).filter(Number.isInteger),
    /** Everything the AI may state as fact (the claim check compares against it). */
    factsText: JSON.stringify({ brief, facts })
  };
}

/** The product and brief as prompt text (data, not instructions). */
function contextPrompt(ctxInfo, untrusted) {
  if (!ctxInfo) return '';
  return `${untrusted('product_and_business_facts', JSON.stringify(ctxInfo.facts, null, 2), 6000)}\n${untrusted('campaign_brief', JSON.stringify(ctxInfo.brief, null, 2), 3000)}\n` +
    'Use only facts from these records. Do not invent features, benefits that are not supported, prices, discounts, statistics, awards or testimonials. ' +
    'Where a fact is needed but missing, write general wording or a [placeholder] instead.';
}

module.exports = { campaignContext, contextPrompt };
