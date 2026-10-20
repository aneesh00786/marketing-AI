const { run, get, all } = require('../db/database');
const { z } = require('zod');
const { generateStructured, untrusted } = require('../lib/aiStructured');
const { resolveSelectedProduct } = require('../lib/productContext');

const PLATFORM_KEYS = { linkedin: 'linkedin', twitter: 'x', x: 'x', instagram: 'instagram', facebook: 'facebook' };
const platformKey = (platform) => PLATFORM_KEYS[String(platform || '').toLowerCase()] || null;

async function getCampaigns(workspaceId = 1) {
  return await all('SELECT * FROM campaigns WHERE workspace_id = ? ORDER BY id DESC', [workspaceId]);
}

async function createCampaign(workspaceId, campaignData) {
  const { name, objective, targetAudience, channels, briefText } = campaignData;
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const result = await run(
    `INSERT INTO campaigns (workspace_id, name, objective, target_audience, channels, brief_text, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Active', ?)`,
    [workspaceId, name, objective, targetAudience, channels || 'LinkedIn, Facebook', briefText, now]
  );
  return { id: result.lastID, ...campaignData, status: 'Active', createdAt: now };
}

async function getContentItems(workspaceId = 1, status = null) {
  if (status && status !== 'all') {
    return await all('SELECT * FROM content_items WHERE workspace_id = ? AND status = ? ORDER BY id DESC', [workspaceId, status]);
  }
  return await all('SELECT * FROM content_items WHERE workspace_id = ? ORDER BY id DESC', [workspaceId]);
}

async function updateContentStatus(contentId, newStatus, workspaceId = 1) {
  const LEGACY_MAP = { 'Draft': 'draft', 'Pending Approval': 'review', 'Rejected': 'rejected' };
  const target = LEGACY_MAP[newStatus] || newStatus;
  if (!['draft', 'review', 'rejected', 'cancelled'].includes(target)) {
    const err = new Error('Approving, scheduling and publishing happen in Social Media Marketing so they are permission-checked, audited and confirmed by the platform.');
    err.status = 409;
    throw err;
  }
  await run(
    "UPDATE content_items SET status = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ? AND status NOT IN ('scheduled', 'publishing', 'published')",
    [target, contentId, workspaceId]
  );

  return await get('SELECT * FROM content_items WHERE id = ?', [contentId]);
}

async function generateAiSocialPost(workspaceId = 1, options = {}) {
  const { productId, platform = 'LinkedIn', customTopic = '', tone = 'Professional', campaignId = null } = options;
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  // Only an explicitly selected product from the caller's workspace is used (400/404 otherwise).
  const product = await resolveSelectedProduct(workspaceId, productId);
  const topic = String(customTopic || '').trim().slice(0, 1000);
  if (!product && !topic) {
    const err = new Error('Select a product or describe the topic of the post.');
    err.status = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  let features = [];
  try { features = product?.features_json ? JSON.parse(product.features_json) : []; } catch (e) { features = []; }
  const productBlock = product
    ? `Product (use only these stored details):
- Name: ${product.name}
${product.tagline ? `- Tagline: ${product.tagline}\n` : ''}${product.description ? `- Description: ${String(product.description).slice(0, 1500)}\n` : ''}${Array.isArray(features) && features.length ? `- Features: ${features.slice(0, 10).join('; ')}\n` : ''}${product.target_audience ? `- Target audience: ${product.target_audience}\n` : ''}${product.url ? `- Website: ${product.url}\n` : ''}`
    : 'No product is selected. Write a generic post about the topic only. Do not name, describe or link to any product, company or website.';

  const system = `You are a B2B social media copywriter. Write one post for ${platform}.
Tone: ${tone}
${productBlock}
Never invent prices, discounts, free trials, statistics, customer names, results, links or features that are not listed above.

Output strictly in JSON format with exactly these keys:
{
  "title": "Short internal title for the post (max 8 words)",
  "caption_text": "The full copy for the ${platform} post. ${platform === 'Twitter' ? 'Keep under 270 characters.' : 'Include a hook line, 2-3 value points, and clean line spacing.'}",
  "hashtags": "3 to 6 relevant hashtags with hash symbol",
  "call_to_action": "Short call to action"
}`;
  const prompt = `Write a ${platform} post${product ? ` for ${product.name}` : ''}.${topic ? `\n${untrusted('requested_topic', topic, 1000)}` : ''}`;
  const schema = z.object({
    title: z.string().min(1),
    caption_text: z.string().min(1),
    hashtags: z.string().optional().default(''),
    call_to_action: z.string().optional().default('')
  });
  const { data: parsed } = await generateStructured({ workspaceId, prompt, system, schema, referenceType: 'content_item', maxTokens: 900 });

  const insertRes = await run(
    `INSERT INTO content_items (
      workspace_id, campaign_id, content_type, title, caption_text, hashtags, call_to_action, platform, platform_key, status, version, source, created_at
    ) VALUES (?, ?, 'post', ?, ?, ?, ?, ?, ?, 'draft', 1, 'roger_chat', ?)`,
    [workspaceId, campaignId, parsed.title, parsed.caption_text, parsed.hashtags, parsed.call_to_action, platform, platformKey(platform), now]
  );

  return {
    id: insertRes.lastID,
    workspace_id: workspaceId,
    campaign_id: campaignId,
    content_type: 'post',
    title: parsed.title,
    caption_text: parsed.caption_text,
    hashtags: parsed.hashtags,
    call_to_action: parsed.call_to_action,
    platform: platform,
    status: 'draft',
    created_at: now,
    product_id: product ? product.id : null,
    product_name: product ? product.name : null
  };
}

async function deleteContentItem(contentId, workspaceId = 1) {
  await run(
    "DELETE FROM content_items WHERE id = ? AND workspace_id = ? AND status NOT IN ('scheduled', 'publishing', 'published')",
    [contentId, workspaceId]
  );
  return { success: true, id: contentId };
}

module.exports = {
  getCampaigns,
  createCampaign,
  getContentItems,
  generateAiSocialPost,
  updateContentStatus,
  deleteContentItem
};

