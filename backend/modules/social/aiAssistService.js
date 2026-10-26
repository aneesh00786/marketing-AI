const { z } = require('zod');
const { get } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { generateStructured, untrusted } = require('../../lib/aiStructured');
const { resolveSelectedProduct } = require('../../lib/productContext');
const { unverifiedClaims } = require('./campaignService');
const { httpError, splitHashtags } = require('./contentService');
const platformRules = require('./platformRules');

/**
 * Composer AI help: captions from product facts, per-platform variations, hashtags, rewrites by
 * tone/length, repurposing for another platform, calls to action and alt text. Results are
 * suggestions returned to the composer; nothing is saved, approved or published here. Every call
 * goes through generateStructured, so the workspace AI quota and usage metering apply.
 */
const PLATFORMS = ['facebook', 'instagram', 'linkedin', 'youtube', 'x'];
const LIMITS = { facebook: 63206, instagram: 2200, linkedin: 3000, youtube: 5000, x: 280 };
const GUIDE = {
  facebook: 'conversational; links allowed',
  instagram: 'visual-first; links are not clickable; up to 30 hashtags',
  linkedin: 'professional and value-focused',
  youtube: 'video description; first two lines matter most',
  x: 'very short; under 280 characters including hashtags'
};

const schemas = {
  caption: z.object({
    variants: z.array(z.object({
      platform: z.enum(PLATFORMS),
      caption: z.string().min(1).max(5000),
      hashtags: z.array(z.string().max(100)).max(30).optional().default([]),
      call_to_action: z.string().max(200).optional().default('')
    })).min(1).max(10),
    assumptions: z.array(z.string()).optional().default([]),
    missing_information: z.array(z.string()).optional().default([])
  }),
  rewrite: z.object({ text: z.string().min(1).max(5000) }),
  repurpose: z.object({ caption: z.string().min(1).max(5000), hashtags: z.array(z.string().max(100)).max(30).optional().default([]) }),
  hashtags: z.object({ hashtags: z.array(z.string().max(100)).min(1).max(30) }),
  cta: z.object({ suggestions: z.array(z.string().min(1).max(200)).min(1).max(8) }),
  alt_text: z.object({ alt_text: z.string().min(1).max(1000) })
};

async function loadFacts(workspaceId, productId) {
  const facts = {};
  const product = await resolveSelectedProduct(workspaceId, productId);
  if (product) {
    let features = [];
    try { features = JSON.parse(product.features_json || '[]'); } catch (e) { features = []; }
    facts.product = { name: product.name, url: product.url, tagline: product.tagline, description: product.description, features, target_audience: product.target_audience };
  }
  const profile = await get('SELECT business_name, industry, website_url, description, brand_voice FROM business_profiles WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [workspaceId]);
  if (profile) facts.business = profile;
  return facts;
}

const FACT_RULES = 'Use only facts present in the input or the facts block. Never invent prices, discounts, statistics, percentages, customer names, testimonials, awards or results. If something is missing, leave it out.';

function buildPrompt(mode, input, factsBlock) {
  const userText = untrusted('user_post', input.text || '', 5000);
  const platform = input.platform && PLATFORMS.includes(input.platform) ? input.platform : null;
  switch (mode) {
    case 'caption': {
      const platforms = (input.platforms || []).filter(p => PLATFORMS.includes(p));
      return `Write one social media post per platform for: ${platforms.join(', ')}.
Instruction from the user: ${String(input.instruction || 'Introduce the product to our audience.').slice(0, 800)}
Tone: ${input.tone || 'professional'}. Length: ${input.length || 'medium'}.
Platform guidance: ${platforms.map(p => `${p} (max ${LIMITS[p]} characters, ${GUIDE[p]})`).join('; ')}.
Facts:
${factsBlock}
${FACT_RULES}
Return JSON: {"variants":[{"platform":"linkedin","caption":"","hashtags":["#tag"],"call_to_action":""}],"assumptions":[""],"missing_information":[""]}`;
    }
    case 'rewrite':
      return `Rewrite this social post. Tone: ${input.tone || 'same as original'}. Length: ${input.length || 'same'} (shorter = roughly half, longer = roughly double).${platform ? ` Platform: ${platform} (max ${LIMITS[platform]} characters).` : ''}
Keep every fact, link and claim from the original; do not add new facts.
${userText}
Facts you may rely on:
${factsBlock}
${FACT_RULES}
Return JSON: {"text":""}`;
    case 'repurpose':
      return `Adapt this ${input.sourcePlatform || 'social'} post for ${platform} (max ${LIMITS[platform]} characters, ${GUIDE[platform]}).
Keep the same facts and offer; change format, length and style for the platform.
${userText}
Facts you may rely on:
${factsBlock}
${FACT_RULES}
Return JSON: {"caption":"","hashtags":["#tag"]}`;
    case 'hashtags':
      return `Suggest ${Math.min(Math.max(parseInt(input.count, 10) || 8, 1), 30)} relevant hashtags${platform ? ` for ${platform}` : ''} for this post. Prefer specific, commonly used tags; no spaces inside a tag.
${userText}
Return JSON: {"hashtags":["#tag"]}`;
    case 'cta':
      return `Suggest 5 short calls to action for this post${platform ? ` on ${platform}` : ''}. Each must match what the post or product actually offers; do not promise discounts or results that are not in the facts.
${userText}
Facts:
${factsBlock}
Return JSON: {"suggestions":[""]}`;
    case 'alt_text':
      return `Write alt text (one or two plain sentences, under 250 characters) for an image attached to this post.
You cannot see the image. Base it only on the file details and post text below, describe only what they state, and do not guess colours, people or objects that are not mentioned.
Image details: ${untrusted('image_details', JSON.stringify(input.imageDetails || {}), 600)}
${userText}
Return JSON: {"alt_text":""}`;
    default:
      throw httpError(400, 'Unknown AI assist mode.');
  }
}

async function assist(ctx, input) {
  const workspaceId = ctx.auth.workspaceId;
  const mode = input.mode;
  if (!schemas[mode]) throw httpError(400, 'Unknown AI assist mode.');
  if (['rewrite', 'repurpose', 'hashtags', 'cta'].includes(mode) && !String(input.text || '').trim() && !input.productId) {
    throw httpError(400, 'Write some post text first (or choose a product).');
  }
  if (mode === 'caption' && !(input.platforms || []).some(p => PLATFORMS.includes(p))) throw httpError(400, 'Choose at least one platform.');
  if (mode === 'repurpose' && !PLATFORMS.includes(input.platform)) throw httpError(400, 'Choose the platform to repurpose for.');

  if (mode === 'alt_text') {
    const asset = input.assetId ? await get("SELECT id, asset_type, title, original_name, width, height FROM assets WHERE workspace_id = ? AND id = ? AND status <> 'deleted'", [workspaceId, input.assetId]) : null;
    if (!asset || asset.asset_type !== 'image') throw httpError(404, 'Choose an image from this workspace.', 'NOT_FOUND');
    input = { ...input, imageDetails: { title: asset.title, fileName: asset.original_name, width: asset.width, height: asset.height } };
  }

  const facts = await loadFacts(workspaceId, input.productId);
  const factsText = JSON.stringify(facts);
  const factsBlock = untrusted('business_facts', JSON.stringify(facts, null, 2), 5000);
  const { data, provider } = await generateStructured({
    workspaceId,
    prompt: buildPrompt(mode, input, factsBlock),
    system: 'You are a careful social media copywriter. You never fabricate facts and you follow platform limits.',
    schema: schemas[mode],
    referenceType: 'social_ai_assist',
    referenceId: input.contentId || null,
    maxTokens: mode === 'caption' ? 2500 : 900
  });

  // Claims checked against the facts plus what the user wrote; flagged, never removed.
  const known = `${factsText} ${input.text || ''} ${input.instruction || ''}`;
  const notes = [];
  let suggestions;
  if (mode === 'caption') {
    suggestions = data.variants.map(v => {
      const hashtags = splitHashtags(v.hashtags);
      const text = platformRules.composeText({ caption: v.caption, hashtags, callToAction: v.call_to_action });
      const length = platformRules.chars(text);
      return {
        platform: v.platform,
        caption: v.caption,
        hashtags,
        callToAction: v.call_to_action,
        characters: length,
        overLimit: length > LIMITS[v.platform],
        unverified: unverifiedClaims(`${v.caption} ${v.call_to_action}`, known)
      };
    });
    if (data.assumptions.length) notes.push(...data.assumptions.map(a => `Assumption: ${a}`));
    if (data.missing_information.length) notes.push(`Missing information: ${data.missing_information.join('; ')}`);
  } else if (mode === 'rewrite') {
    suggestions = { text: data.text, characters: platformRules.chars(data.text), unverified: unverifiedClaims(data.text, known) };
  } else if (mode === 'repurpose') {
    const hashtags = splitHashtags(data.hashtags);
    const length = platformRules.chars(platformRules.composeText({ caption: data.caption, hashtags }));
    suggestions = { platform: input.platform, caption: data.caption, hashtags, characters: length, overLimit: length > LIMITS[input.platform], unverified: unverifiedClaims(data.caption, known) };
  } else if (mode === 'hashtags') {
    suggestions = { hashtags: [...new Set(splitHashtags(data.hashtags).map(h => h.replace(/\s+/g, '')))] };
  } else if (mode === 'cta') {
    suggestions = { suggestions: data.suggestions.map(t => ({ text: t, unverified: unverifiedClaims(t, known) })) };
  } else {
    suggestions = { altText: data.alt_text };
    notes.push('The AI did not see the image: this was drafted from the file details and post text. Check it describes the image accurately.');
  }
  await audit(ctx, 'social.ai.assist', { resourceType: 'content', resourceId: input.contentId || null, metadata: { mode, provider, productId: input.productId || null } });
  return { mode, provider, suggestions, notes };
}

module.exports = { assist, LIMITS };
