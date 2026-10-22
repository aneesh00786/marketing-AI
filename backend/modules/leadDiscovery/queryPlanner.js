const { z } = require('zod');
const { generateStructured, untrusted, AiUnavailableError } = require('../../lib/aiStructured');
const { LEADS_AI_EXCLUDE } = require('../leads/leadService');

/**
 * Search planning for AI Lead Discovery.
 * - Categories: a broad business type ("B2B businesses") is not a Google place type, so the AI
 *   engine suggests concrete, searchable kinds of businesses that fit the user's intent and the
 *   product's audience. There is no built-in industry list; without AI the search uses the
 *   user's business type alone. The user's own business type is always the first category.
 * - Places: every location comes from the user (city/state/country) or from addresses in
 *   Google's own results (states for a country-wide search, cities for a state-wide one), so
 *   coverage follows where Google actually has matching businesses.
 */
// Starts with a letter ("B2B" is fine, "24x7 stores" is not); letters, digits and simple punctuation.
const CATEGORY_RE = /^[\p{L}][\p{L}\p{M}\p{N}&/ ,'-]{1,58}[\p{L}\p{N}]$/u;

const normalize = v => String(v || '').trim().replace(/\s+/g, ' ');
const keyOf = v => normalize(v).toLowerCase();

function cleanCategories(list, max) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const c = normalize(raw);
    // A category names a kind of business only: no locations or long phrases.
    if (!CATEGORY_RE.test(c) || /\bin\b|\bnear\b/i.test(c) || c.split(' ').length > 6) continue;
    if (seen.has(keyOf(c))) continue;
    seen.add(keyOf(c));
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

const suggestionSchema = z.object({
  categories: z.array(z.object({ name: z.string().max(80), why: z.string().max(200) })).max(20)
});

function productFacts(p) {
  let features = [];
  try { features = JSON.parse(p.features_json || '[]'); } catch (e) { features = []; }
  return { name: p.name, description: p.description || null, target_audience: p.target_audience || null, features: Array.isArray(features) ? features.slice(0, 6) : [] };
}

/**
 * Returns { categories: [businessType, ...related], suggested: [{ name, why }], ai }.
 * Related categories are potential CUSTOMERS described by the user's business type; companies
 * that sell the same kind of product are excluded unless the user asked for them.
 */
async function suggestCategories(workspaceId, { businessType, keywords, product, maxCategories }) {
  // The user's own business type always comes first, exactly as typed.
  const first = [normalize(businessType)];
  if (maxCategories <= 1) return { categories: first, suggested: [], ai: null };
  const prompt = `A sales team wants to find businesses on Google Maps. They described the businesses they want as:
${untrusted('business_type', JSON.stringify({ business_type: businessType, keywords: keywords || null }), 400)}
They will offer this product to them (context only):
${untrusted('product', JSON.stringify(productFacts(product)), 2000)}
List up to ${maxCategories - 1} specific KINDS OF BUSINESSES that fit the description and could be customers of the product, phrased the way businesses are listed on Google Maps (e.g. "wholesale distributors", "packaging suppliers").
Rules:
- Each must be a kind of business, 1 to 5 words. No locations, company names, brands or adjectives like "best".
- Stay within what the description says. If it is already specific, return close variants or sub-types only.
- Do not list companies that make or sell the same kind of product as the one above, unless the description explicitly asks for them.
- "why" is one short phrase linking it to the description.
Return JSON: {"categories":[{"name":"...","why":"..."}]}`;
  try {
    const { data } = await generateStructured({
      workspaceId, prompt, schema: suggestionSchema, referenceType: 'lead_discovery_plan', maxTokens: 700, excludeProviders: LEADS_AI_EXCLUDE,
      system: 'You plan business directory searches. You list only real, generic kinds of businesses.'
    });
    const names = [first[0], ...cleanCategories(data.categories.map(c => c.name).filter(n => keyOf(n) !== keyOf(first[0])), maxCategories - 1)];
    const why = new Map(data.categories.map(c => [keyOf(c.name), normalize(c.why)]));
    return {
      categories: names,
      suggested: names.slice(1).map(n => ({ name: n, why: why.get(keyOf(n)) || null })),
      ai: { available: true }
    };
  } catch (err) {
    if (!(err instanceof AiUnavailableError) && err.code !== 'QUOTA_EXCEEDED') throw err;
    return {
      categories: first,
      suggested: [],
      ai: { available: false, reason: err.code === 'QUOTA_EXCEEDED' ? 'Monthly AI limit reached, so only your business type is searched.' : 'AI is unavailable, so only your business type is searched (no related categories).' }
    };
  }
}

/**
 * Sub-locations seen in Google's results, most frequent first: states for a country-wide search,
 * cities inside the chosen state for a state-wide search. Nothing is invented or guessed.
 */
function subLocations(places, { scope, region, countryCode }, max) {
  if (scope === 'city') return [];
  const counts = new Map();
  for (const p of places) {
    if (p.countryCode && countryCode && p.countryCode.toUpperCase() !== countryCode.toUpperCase()) continue;
    let name = null;
    if (scope === 'country') name = p.region;
    else if (scope === 'region') {
      if (!p.region || keyOf(p.region) !== keyOf(region)) continue;
      name = p.city;
    }
    if (!name) continue;
    const k = keyOf(name);
    const cur = counts.get(k) || { name: normalize(name), n: 0 };
    cur.n++;
    counts.set(k, cur);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, max).map(x => x.name);
}

module.exports = { suggestCategories, cleanCategories, subLocations };
