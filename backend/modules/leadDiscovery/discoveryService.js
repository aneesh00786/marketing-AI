const crypto = require('crypto');
const { z } = require('zod');
const { run, get, all, withTransaction } = require('../../db/database');
const { audit } = require('../../lib/audit');
const automationEvents = require('../../lib/automationEvents');
const { recordUsage } = require('../../lib/usage');
const { generateStructured, untrusted, AiUnavailableError } = require('../../lib/aiStructured');
const leadService = require('../leads/leadService');
const places = require('./googlePlacesProvider');
const planner = require('./queryPlanner');
const websiteContacts = require('./websiteContacts');

/**
 * AI Lead Discovery: finds real businesses with Google Places API (New), lets the user review
 * them, and imports the selected ones into the existing Leads CRM.
 *
 * Storage: search results (name, address, phone, website, category) are not written to the database
 * while the user reviews them; only place IDs and our own flags are. When the user imports selected
 * businesses, the details they reviewed are saved on the new leads at the workspace's request.
 * Note: Google Maps Platform terms (3.2.3 "No Scraping" / "No Caching"; Service Terms 14.3) restrict
 * storing Places content other than place IDs; the workspace owner chose to keep these details.
 * The optional AI product-fit assessment is shown during review only.
 * Every search targets one Digital Product of the workspace (required), and every imported lead
 * is linked to that product. Everything is scoped to the session's workspace.
 *
 * Coverage: one Google query returns at most 60 places, so a search runs several DISTINCT queries
 * (related categories, then states/cities seen in Google's results) until it has the requested
 * number of unique businesses or uses its request budget. Identical queries are never repeated.
 */
const DEFAULT_RESULTS = 50;
const DEFAULT_REQUESTS = 10;
const HARD_MAX_RESULTS = 500;
const HARD_MAX_REQUESTS = 50;
const capEnv = (name, def, hard) => Math.min(Math.max(parseInt(process.env[name] || String(def), 10) || def, 1), hard);
const maxResultsCap = () => capEnv('LEAD_DISCOVERY_MAX_RESULTS', 300, HARD_MAX_RESULTS);
const maxRequestsCap = () => capEnv('LEAD_DISCOVERY_MAX_REQUESTS', 20, HARD_MAX_REQUESTS);
const maxCategoriesCap = () => capEnv('LEAD_DISCOVERY_MAX_CATEGORIES', 8, 12);
const maxSubLocations = () => capEnv('LEAD_DISCOVERY_MAX_SUBLOCATIONS', 10, 30);
const aiFitMax = () => capEnv('LEAD_DISCOVERY_AI_FIT_MAX', 60, 200);
const websiteMax = () => capEnv('LEAD_DISCOVERY_WEBSITE_MAX', 300, HARD_MAX_RESULTS);
// Fields a search can collect besides the business name and category (always shown).
// address, phone and website come from Google; email and contactPerson from the business's own website.
const FIELDS = ['address', 'phone', 'website', 'email', 'contactPerson'];
const GOOGLE_CONTACT_FIELDS = ['phone', 'website', 'email', 'contactPerson'];
const dailySearchLimit = () => parseInt(process.env.LEAD_DISCOVERY_DAILY_SEARCHES || '20', 10);
const dailyRequestLimit = () => parseInt(process.env.LEAD_DISCOVERY_DAILY_REQUESTS || '300', 10);
const dailyDetailsLimit = () => parseInt(process.env.LEAD_DISCOVERY_DAILY_DETAILS || '200', 10);
// List prices per 1,000 Text Search requests (Places API (New), first paid tier, before Google's
// free monthly usage). Estimates only; the Google Cloud bill is authoritative.
const pricePer1000 = includeContacts => parseFloat(includeContacts ? (process.env.PLACES_PRICE_PER_1000_ENTERPRISE || '35') : (process.env.PLACES_PRICE_PER_1000_PRO || '32'));
const REPEAT_WINDOW_MIN = 2;
// Stop paging a query when fewer than this share of a page's places are new.
const MOSTLY_REPEATS = 0.2;
const FATAL_CODES = new Set(['QUOTA_EXCEEDED', 'PERMISSION_DENIED', 'SETUP_REQUIRED']);
const AI_BATCH = 20;
// About 900 tokens answer a batch of 20; the margin covers longer evidence. Every token reserved here
// counts against the AI provider's per-minute limit, so it is kept close to need.
const FIT_MAX_TOKENS = 1800;
// A shared domain of a free mailbox provider says nothing about the business.
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'rediffmail.com', 'zoho.com', 'gmx.com', 'mail.com', 'yandex.com']);
const RELIABLE_MATCHES = new Set(['place_id', 'phone', 'website_domain', 'email']);

const NOTICE = 'Results come from Google Places. Each Google query returns at most 60 places (20 per request), so a search runs several distinct queries within its request budget. '
  + 'Results are still limited by Google\'s coverage and ranking: they are not every business in the area, and a higher target does not guarantee more unique businesses. '
  + 'The businesses you import are saved to your leads with the details shown here.';

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const ws = ctx => ctx.auth.workspaceId;
const optText = max => z.string().trim().max(max).optional().nullable().transform(v => (v ? v : null));

const searchSchema = z.object({
  businessType: z.string().trim().min(2, 'Enter a business type or industry.').max(120),
  countryCode: z.string().trim().length(2, 'Choose a country.').transform(v => v.toUpperCase()),
  region: optText(80),
  city: optText(80),
  keywords: optText(200),
  productId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)], { errorMap: () => ({ message: 'Choose the product these leads are for.' }) }),
  scope: z.enum(['city', 'region', 'country']).optional(),
  expandCategories: z.boolean().optional(),
  categories: z.array(z.string().trim().min(2).max(60)).min(1).max(12).optional(),
  maxResults: z.number().int().min(1).optional(),
  maxRequests: z.number().int().min(1).optional(),
  includeContacts: z.boolean().optional(),
  fields: z.array(z.enum(FIELDS)).max(FIELDS.length).optional(),
  // Skip businesses already in the workspace's leads, so the requested number is all new ones (default on).
  newOnly: z.boolean().optional(),
  aiQualify: z.boolean().optional()
}).strict();

function toHttp(err) {
  const map = {
    SETUP_REQUIRED: [503, 'PLACES_NOT_CONFIGURED'],
    QUOTA_EXCEEDED: [429, 'PLACES_QUOTA'],
    PERMISSION_DENIED: [502, 'PLACES_PERMISSION_DENIED'],
    INVALID_REQUEST: [400, 'PLACES_INVALID_REQUEST'],
    NOT_FOUND: [404, 'PLACE_NOT_FOUND'],
    TIMEOUT: [504, 'PLACES_TIMEOUT'],
    NETWORK: [502, 'PLACES_UNREACHABLE'],
    PROVIDER_ERROR: [502, 'PLACES_PROVIDER_ERROR']
  };
  const [status, code] = map[err.code] || [502, 'PLACES_PROVIDER_ERROR'];
  return httpError(status, err.message, code);
}

// ---------------------------------------------------------------- de-duplication helpers
const digits = v => String(v || '').replace(/\D/g, '');
const phoneKey = v => { const d = digits(v); return d.length >= 8 ? d.slice(-10) : null; };
function domainOf(urlOrEmail) {
  const s = String(urlOrEmail || '').trim().toLowerCase();
  if (!s) return null;
  const host = s.includes('@') && !s.includes('://') ? s.split('@').pop() : (() => { try { return new URL(s).hostname; } catch (e) { return null; } })();
  if (!host) return null;
  const d = host.replace(/^www\./, '');
  return FREE_MAIL.has(d) ? null : d;
}
const SUFFIXES = /\b(private|pvt|limited|ltd|llc|llp|inc|incorporated|co|company|corp|corporation|plc|gmbh|the|and)\b/g;
function nameKey(v) {
  const k = String(v || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').replace(SUFFIXES, ' ').replace(/\s+/g, ' ').trim();
  return k.length >= 3 ? k : null;
}

async function loadMatchIndex(workspaceId) {
  const leads = await all('SELECT id, name, company_name, phone, email FROM leads WHERE workspace_id = ?', [workspaceId]);
  const refs = await all('SELECT place_id, lead_id FROM lead_place_refs WHERE workspace_id = ?', [workspaceId]);
  const idx = { place: new Map(refs.map(r => [r.place_id, r.lead_id])), phone: new Map(), domain: new Map(), name: new Map(), email: new Map() };
  for (const l of leads) {
    const p = phoneKey(l.phone);
    if (p && !idx.phone.has(p)) idx.phone.set(p, l.id);
    const e = String(l.email || '').trim().toLowerCase();
    if (e && !idx.email.has(e)) idx.email.set(e, l.id);
    const d = domainOf(l.email);
    if (d && !idx.domain.has(d)) idx.domain.set(d, l.id);
    for (const n of [nameKey(l.company_name), nameKey(l.name)]) if (n && !idx.name.has(n)) idx.name.set(n, l.id);
  }
  return idx;
}

/** Reliable matches (place ID, phone, website domain) block import; a name-only match is a warning. */
function matchOf(p, idx) {
  if (idx.place.has(p.placeId)) return { leadId: idx.place.get(p.placeId), reason: 'place_id' };
  const ph = phoneKey(p.phone);
  if (ph && idx.phone.has(ph)) return { leadId: idx.phone.get(ph), reason: 'phone' };
  const e = String(p.email || '').toLowerCase();
  if (e && idx.email.has(e)) return { leadId: idx.email.get(e), reason: 'email' };
  const d = domainOf(p.website);
  if (d && idx.domain.has(d)) return { leadId: idx.domain.get(d), reason: 'website_domain' };
  const n = nameKey(p.name);
  if (n && idx.name.has(n)) return { leadId: idx.name.get(n), reason: 'name' };
  return null;
}

// ---------------------------------------------------------------- AI product fit (review only)
const fitSchema = z.object({
  results: z.array(z.object({
    placeId: z.string().max(255),
    score: z.number().int().min(0).max(100),
    confidence: z.enum(['low', 'medium', 'high']),
    evidence: z.string().min(1).max(400),
    inference: z.boolean()
  })).max(AI_BATCH)
});

function productFacts(p) {
  let features = [];
  try { features = JSON.parse(p.features_json || '[]'); } catch (e) { features = []; }
  return { name: p.name, tagline: p.tagline || null, description: p.description || null, target_audience: p.target_audience || null, features: Array.isArray(features) ? features.slice(0, 8) : [] };
}

async function assessFit(workspaceId, product, list) {
  const out = new Map();
  for (let i = 0; i < list.length; i += AI_BATCH) {
    const batch = list.slice(i, i + AI_BATCH);
    const businesses = batch.map(p => ({ placeId: p.placeId, name: p.name, category: p.category, types: p.types, city: p.city, region: p.region, has_website: !!p.website, business_status: p.businessStatus }));
    const prompt = `Assess how well each business below might fit the product. Use ONLY the facts given.
Rules:
- A matching industry alone does not show the business needs the product. If the only evidence is the category, score at most 50 and set confidence "low" and inference true.
- Never invent facts about a business (size, revenue, tools, problems) that are not in the data.
- "evidence" must cite the specific given facts you used, in one or two short sentences.
- Set inference true whenever the score relies on assumptions rather than stated facts.
${untrusted('product', JSON.stringify(productFacts(product)), 3000)}
${untrusted('businesses', JSON.stringify(businesses), 8000)}
Return JSON: {"results":[{"placeId":"...","score":0-100,"confidence":"low|medium|high","evidence":"...","inference":true|false}]}`;
    let data;
    try {
      ({ data } = await generateStructured({
        workspaceId, prompt, schema: fitSchema, referenceType: 'lead_discovery', maxTokens: FIT_MAX_TOKENS, excludeProviders: leadService.LEADS_AI_EXCLUDE,
        system: 'You are a careful B2B sales analyst. You never invent facts and you label assumptions.'
      }));
    } catch (err) {
      // Batches already assessed are kept when a later one fails (for example a busy AI service).
      if (!out.size || (!(err instanceof AiUnavailableError) && err.code !== 'QUOTA_EXCEEDED')) throw err;
      out.incomplete = true;
      break;
    }
    const ids = new Set(batch.map(p => p.placeId));
    for (const r of data.results) if (ids.has(r.placeId)) out.set(r.placeId, { score: r.score, confidence: r.confidence, evidence: r.evidence, inference: r.inference });
  }
  return out;
}

// ---------------------------------------------------------------- config and limits
async function searchesToday(workspaceId) {
  const r = await get('SELECT COUNT(*) AS n, COALESCE(SUM(requests), 0) AS requests FROM lead_discovery_runs WHERE workspace_id = ? AND created_at >= UTC_DATE()', [workspaceId]);
  return { searches: Number(r.n), requests: Number(r.requests) };
}

async function config(ctx) {
  const today = await searchesToday(ws(ctx));
  return {
    configured: places.isConfigured(),
    maxResults: maxResultsCap(),
    defaultResults: Math.min(DEFAULT_RESULTS, maxResultsCap()),
    maxRequests: maxRequestsCap(),
    defaultRequests: Math.min(DEFAULT_REQUESTS, maxRequestsCap()),
    maxCategories: maxCategoriesCap(),
    resultsPerRequest: places.PAGE_SIZE,
    resultsPerQuery: places.GOOGLE_MAX_RESULTS,
    dailySearchLimit: dailySearchLimit(),
    searchesToday: today.searches,
    dailyRequestLimit: dailyRequestLimit(),
    requestsToday: today.requests,
    pricePer1000: { withContacts: pricePer1000(true), withoutContacts: pricePer1000(false) },
    // A separate browser key for the map view (Maps JavaScript API), restricted to this site's
    // address in Google Cloud. The server's Places key is never sent to the browser.
    mapsBrowserKey: process.env.GOOGLE_MAPS_BROWSER_KEY || null,
    notice: NOTICE
  };
}

// ---------------------------------------------------------------- search planning
/** Validates the request and resolves product, scope, location and budgets (no Google calls). */
async function resolve(ctx, input) {
  const workspaceId = ws(ctx);
  const v = searchSchema.parse(input || {});
  const resultsCap = maxResultsCap();
  const requestsCap = maxRequestsCap();
  const maxResults = v.maxResults ?? Math.min(DEFAULT_RESULTS, resultsCap);
  if (maxResults > resultsCap) throw httpError(400, `Ask for at most ${resultsCap} unique results per search.`, 'VALIDATION_ERROR');
  const maxRequests = v.maxRequests ?? Math.min(DEFAULT_REQUESTS, requestsCap);
  if (maxRequests > requestsCap) throw httpError(400, `Use at most ${requestsCap} Google requests per search.`, 'VALIDATION_ERROR');
  if (!places.countryName(v.countryCode)) throw httpError(400, 'Choose a valid country.', 'VALIDATION_ERROR');
  const scope = v.scope || (v.city ? 'city' : v.region ? 'region' : 'country');
  if (scope === 'city' && !v.city) throw httpError(400, 'Enter the city to search in, or choose a wider scope.', 'VALIDATION_ERROR');
  if (scope === 'region' && !v.region) throw httpError(400, 'Enter the state or region to search in, or choose a wider scope.', 'VALIDATION_ERROR');
  const product = await leadService.requireWorkspaceProduct(workspaceId, v.productId);
  const loc = { city: scope === 'city' ? v.city : null, region: scope === 'country' ? null : v.region, countryCode: v.countryCode };
  const categories = v.categories ? planner.cleanCategories(v.categories, maxCategoriesCap()) : null;
  if (v.categories && !categories.length) throw httpError(400, 'Each category must name a kind of business (no locations or numbers).', 'VALIDATION_ERROR');
  // Without a field list, the older includeContacts switch decides (phone and website, or neither).
  const fields = v.fields ? FIELDS.filter(f => v.fields.includes(f)) : (v.includeContacts === false ? ['address'] : ['address', 'phone', 'website']);
  // Email and contact person are read from the business's website, so Google's website field is needed for them too.
  const includeContacts = fields.some(f => GOOGLE_CONTACT_FIELDS.includes(f));
  return { v, product, scope, loc, location: places.locationLabel(loc), maxResults, maxRequests, categories, fields, includeContacts, newOnly: v.newOnly !== false, expand: v.expandCategories === true };
}

function estimate(r, allowedRequests) {
  const maxPlaces = allowedRequests * places.PAGE_SIZE;
  const per = pricePer1000(r.includeContacts);
  return {
    allowedRequests,
    maxPlacesBeforeDuplicates: maxPlaces,
    maxCostUsd: Math.round(allowedRequests * per / 10) / 100,
    pricePer1000: per,
    shortfall: r.maxResults > maxPlaces
      ? `A target of ${r.maxResults} is more than ${allowedRequests} Google request(s) can return: at most ${maxPlaces} places (20 per request) before duplicates. Raise the request budget or lower the target.`
      : null
  };
}

/** Preview: the categories and first queries a search would run, with its budget. Uses AI only. */
async function plan(ctx, input) {
  const r = await resolve(ctx, input);
  const today = await searchesToday(ws(ctx));
  const allowed = Math.max(0, Math.min(r.maxRequests, dailyRequestLimit() - today.requests));
  const s = r.categories ? { categories: r.categories, suggested: [], ai: null }
    : (r.expand ? await planner.suggestCategories(ws(ctx), { businessType: r.v.businessType, keywords: r.v.keywords, product: r.product, maxCategories: maxCategoriesCap() })
      : { categories: [r.v.businessType], suggested: [], ai: null });
  return {
    scope: r.scope,
    location: r.location,
    categories: s.categories,
    suggested: s.suggested,
    ai: s.ai,
    firstQueries: s.categories.map(c => places.buildQuery({ category: c, keywords: r.v.keywords, location: r.location })),
    progressive: r.scope === 'city' ? null : `After these, the search continues in the ${r.scope === 'country' ? 'states' : 'cities'} where Google's results are, while budget remains.`,
    budget: estimate(r, allowed),
    dailyRequestsRemaining: Math.max(0, dailyRequestLimit() - today.requests)
  };
}

/** Checks limits and repeats before a search starts (so errors return before streaming). */
async function prepareSearch(ctx, input) {
  const workspaceId = ws(ctx);
  const r = await resolve(ctx, input);
  if (!places.isConfigured()) throw httpError(503, 'Google Places is not set up: add GOOGLE_PLACES_API_KEY on the server (Places API (New) enabled).', 'PLACES_NOT_CONFIGURED');
  const today = await searchesToday(workspaceId);
  if (today.searches >= dailySearchLimit()) throw httpError(429, `Daily discovery limit reached (${dailySearchLimit()} searches per workspace). Try again tomorrow.`, 'DISCOVERY_DAILY_LIMIT');
  const dailyRemaining = dailyRequestLimit() - today.requests;
  if (dailyRemaining <= 0) throw httpError(429, `Today's Google request budget for this workspace is used up (${dailyRequestLimit()} requests). Try again tomorrow.`, 'DISCOVERY_DAILY_REQUESTS');
  const criteriaHash = crypto.createHash('sha1').update(JSON.stringify([r.v.businessType.toLowerCase(), r.v.keywords, r.scope, r.location.toLowerCase(), r.v.countryCode,
    r.categories || (r.expand ? 'auto' : null), r.maxResults, r.maxRequests, r.includeContacts, r.fields, r.newOnly, r.product.id])).digest('hex');
  const recent = await get(`SELECT id FROM lead_discovery_runs WHERE workspace_id = ? AND criteria_hash = ? AND created_at >= UTC_TIMESTAMP() - INTERVAL ${REPEAT_WINDOW_MIN} MINUTE AND status NOT IN ('failed', 'cancelled') ORDER BY id DESC LIMIT 1`, [workspaceId, criteriaHash]);
  if (recent) throw httpError(409, `The same search ran less than ${REPEAT_WINDOW_MIN} minutes ago. Review those results or change the search to avoid paying for it twice.`, 'DUPLICATE_SEARCH');
  return { ...r, criteriaHash, allowedRequests: Math.min(r.maxRequests, dailyRemaining) };
}

const STOP_TEXT = {
  reached_target: 'Found the requested number of unique businesses.',
  budget_exhausted: 'Stopped after using this search\'s Google request budget. Raise the budget to search further.',
  daily_budget: 'Stopped at the workspace\'s remaining Google request budget for today.',
  no_more_queries: 'All planned queries ran; Google had no further matching places for them.',
  quota: 'Google\'s quota or rate limit was reached; showing the results received so far.',
  provider_rejected: 'Google rejected further requests; showing the results received so far.',
  cancelled: 'The search was cancelled.'
};

const hasContactField = fields => fields.some(f => GOOGLE_CONTACT_FIELDS.includes(f));
const FIELD_KEYS = {
  address: ['address', 'city', 'region', 'postalCode'],
  phone: ['phone'],
  website: ['website'],
  email: ['email', 'emailSource'],
  contactPerson: ['contactPerson', 'contactRole', 'contactSource']
};
/** A result row without the fields the user did not ask for. */
function shownFields(row, fields) {
  const out = { ...row };
  for (const [field, keys] of Object.entries(FIELD_KEYS)) if (!fields.includes(field)) for (const k of keys) delete out[k];
  if (!fields.includes('email') && !fields.includes('contactPerson')) delete out.contactLookup;
  return out;
}

/**
 * Runs the planned queries: each query is followed through its pages (nextPageToken) while it keeps
 * producing new places; results are de-duplicated across all queries. After the first-tier queries,
 * sub-locations seen in Google's results are searched (country -> states, state -> cities).
 * onProgress receives counts only. A failed query is recorded and the search moves on; quota and
 * permission errors stop it but keep everything already received.
 */
async function executeSearch(ctx, prep, { onProgress = () => {}, signal } = {}) {
  const workspaceId = ws(ctx);
  const { v, product } = prep;
  let categories = prep.categories;
  let planAi = null;
  if (!categories) {
    if (prep.expand) {
      onProgress({ phase: 'planning' });
      const s = await planner.suggestCategories(workspaceId, { businessType: v.businessType, keywords: v.keywords, product, maxCategories: maxCategoriesCap() });
      categories = s.categories;
      planAi = s.ai;
    } else {
      categories = [v.businessType];
    }
  }

  const queue = categories.map(category => ({ category, location: prep.location, tier: 'primary' }));
  const seenQueries = new Set();
  const unique = new Map();
  // Every place this search saw, including those skipped as already in the leads (for repeats and sub-locations).
  const seen = new Map();
  const known = prep.newOnly ? await loadMatchIndex(workspaceId) : null;
  let alreadyInLeads = 0;
  const log = [];
  let requests = 0;
  let billed = 0;
  let raw = 0;
  let repeats = 0;
  let stop = null;
  let fatal = null;
  let lastError = null;
  let expanded = false;
  const country = places.countryName(v.countryCode);
  // The queue holds every planned query, including those already run.
  const stateOf = () => ({ phase: 'searching', completedQueries: log.length, plannedQueries: queue.length, requests, maxRequests: prep.allowedRequests, unique: unique.size, raw, repeats, alreadyInLeads, target: prep.maxResults });

  for (let i = 0; i < queue.length && !stop; i++) {
    const q = queue[i];
    const text = places.buildQuery({ category: q.category, keywords: v.keywords, location: q.location });
    if (seenQueries.has(text.toLowerCase())) continue;
    seenQueries.add(text.toLowerCase());
    const entry = { query: text, category: q.category, tier: q.tier, requests: 0, places: 0, newUnique: 0, status: 'ok', note: null };
    let pageToken = null;
    do {
      if (signal?.aborted) { stop = 'cancelled'; break; }
      if (unique.size >= prep.maxResults) { stop = 'reached_target'; break; }
      if (requests >= prep.allowedRequests) { stop = prep.allowedRequests < prep.maxRequests ? 'daily_budget' : 'budget_exhausted'; break; }
      onProgress({ ...stateOf(), current: text });
      requests++;
      entry.requests++;
      let page;
      try {
        page = await places.searchPage({ textQuery: text, countryCode: v.countryCode, includeContacts: prep.includeContacts, pageToken });
        billed++;
      } catch (err) {
        entry.status = 'error';
        entry.note = String(err.message).slice(0, 200);
        lastError = err;
        if (FATAL_CODES.has(err.code)) { fatal = err; stop = err.code === 'QUOTA_EXCEEDED' ? 'quota' : 'provider_rejected'; }
        break;
      }
      entry.places += page.places.length;
      raw += page.places.length;
      let fresh = 0;
      const added = [];
      for (const p of page.places) {
        if (seen.has(p.placeId)) { repeats++; continue; }
        if (unique.size >= prep.maxResults) break;
        seen.set(p.placeId, p);
        fresh++;
        const m = known && matchOf(p, known);
        if (m && RELIABLE_MATCHES.has(m.reason)) { alreadyInLeads++; continue; }
        unique.set(p.placeId, p);
        added.push(p);
      }
      entry.newUnique += fresh;
      // New businesses go to the browser as they are found; checks, email and AI fit follow later.
      if (added.length) onProgress({ ...stateOf(), current: text, rows: added.map(p => shownFields(p, prep.fields)) });
      // A page of businesses already in the leads is still new to this search, so paging continues.
      pageToken = page.nextPageToken;
      if (pageToken && page.places.length && fresh / page.places.length < MOSTLY_REPEATS) {
        entry.note = 'Remaining pages skipped: mostly businesses already found.';
        pageToken = null;
      }
    } while (pageToken && !stop);
    if (entry.requests) log.push(entry);
    // After the first-tier queries, cover the states/cities where Google's results actually are.
    if (!stop && !expanded && i === queue.length - 1 && prep.scope !== 'city') {
      expanded = true;
      for (const sub of planner.subLocations([...seen.values()], { scope: prep.scope, region: prep.loc.region, countryCode: v.countryCode }, maxSubLocations())) {
        const location = prep.scope === 'country' ? `${sub}, ${country}` : `${sub}, ${prep.loc.region}, ${country}`;
        for (const category of categories) queue.push({ category, location, tier: 'local' });
      }
    }
  }
  if (!stop) stop = unique.size >= prep.maxResults ? 'reached_target' : 'no_more_queries';
  onProgress({ ...stateOf(), phase: 'checking' });

  const runCols = {
    business_type: v.businessType, country_code: v.countryCode, region: prep.loc.region, city: prep.loc.city, keywords: v.keywords, product_id: product.id,
    max_results: prep.maxResults, include_contacts: prep.includeContacts ? 1 : 0, text_query: places.buildTextQuery({ businessType: v.businessType, keywords: v.keywords, ...prep.loc }).slice(0, 400),
    criteria_hash: prep.criteriaHash, scope: prep.scope, expand_categories: prep.expand ? 1 : 0, categories_json: JSON.stringify(categories), max_requests: prep.maxRequests,
    requests, queries_run: log.length, raw_results: raw, stop_reason: stop, fields_json: JSON.stringify(prep.fields)
  };
  const insertRun = async extra => {
    const cols = { ...runCols, workspace_id: workspaceId, created_by: ctx.auth.userId || null, status: extra.status, found: extra.found || 0, duplicates: extra.duplicates || 0,
      possible_duplicates: extra.possible || 0, eligible: extra.eligible || 0, missing_contact: extra.missing || 0, pages: requests,
      error_code: extra.errorCode || null, error_message: extra.errorMessage ? String(extra.errorMessage).slice(0, 500) : null };
    const keys = Object.keys(cols);
    return (await run(`INSERT INTO lead_discovery_runs (${keys.join(', ')}, created_at) VALUES (${keys.map(() => '?').join(', ')}, UTC_TIMESTAMP())`, keys.map(k => cols[k]))).lastID;
  };
  if (billed) await recordUsage({ workspaceId, category: 'places_search', providerKey: 'google_places', quantity: billed, unit: 'request', referenceType: 'lead_discovery' });

  if (stop === 'cancelled') {
    await insertRun({ status: 'cancelled', found: unique.size });
    return null;
  }
  if (!unique.size && lastError && (fatal || !billed)) {
    const runId = await insertRun({ status: 'failed', errorCode: lastError.code, errorMessage: lastError.message });
    await audit(ctx, 'leads.discovery_failed', { resourceType: 'lead_discovery_run', resourceId: runId, metadata: { code: lastError.code } });
    throw toHttp(lastError);
  }

  // Email and contact person: read from each eligible business's own website (Google has neither).
  const want = { email: prep.fields.includes('email'), contactPerson: prep.fields.includes('contactPerson') };
  let websiteLookup = null;
  if (want.email || want.contactPerson) {
    const open = [...unique.values()].filter(p => p.businessStatus !== 'CLOSED_PERMANENTLY');
    const targets = open.filter(p => p.website).slice(0, websiteMax());
    onProgress({ ...stateOf(), phase: 'contacts', checked: 0, total: targets.length });
    const found = await websiteContacts.lookupMany(targets, { want, signal, onEach: (checked, total, row, c) => onProgress({ ...stateOf(), phase: 'contacts', checked, total,
      contact: shownFields({ placeId: row.placeId, email: c.email || null, emailSource: c.emailSource || null, contactPerson: c.contactPerson || null, contactRole: c.contactRole || null, contactSource: c.contactSource || null, contactLookup: c.status }, prep.fields) }) });
    if (signal?.aborted) stop = 'cancelled';
    for (const p of unique.values()) {
      const c = found.get(p.placeId);
      Object.assign(p, {
        email: c?.email || null, emailSource: c?.emailSource || null,
        contactPerson: c?.contactPerson || null, contactRole: c?.contactRole || null, contactSource: c?.contactSource || null,
        contactLookup: c ? c.status : (!p.website ? 'no_website' : 'not_checked')
      });
    }
    const vals = [...found.values()];
    websiteLookup = {
      checked: targets.length,
      withoutWebsite: open.length - open.filter(p => p.website).length,
      emails: vals.filter(c => c.email).length,
      contactPeople: vals.filter(c => c.contactPerson).length,
      unreachable: vals.filter(c => c.status === 'unreachable').length,
      blocked: vals.filter(c => c.status === 'blocked').length,
      limited: open.filter(p => p.website).length > targets.length ? `Websites were checked for the first ${targets.length} businesses (limit per search).` : null
    };
  }
  if (stop === 'cancelled') {
    await insertRun({ status: 'cancelled', found: unique.size });
    return null;
  }

  const idx = await loadMatchIndex(workspaceId);
  const rows = [...unique.values()].map(p => {
    const match = matchOf(p, idx);
    const closed = p.businessStatus === 'CLOSED_PERMANENTLY';
    const reliable = !!match && RELIABLE_MATCHES.has(match.reason);
    return {
      ...p,
      duplicate: reliable ? match : null,
      possibleDuplicate: match && !reliable ? match : null,
      // No way to reach the business among the chosen fields (a contact person alone is not a channel).
      missingContact: hasContactField(prep.fields) && !['phone', 'website', 'email'].some(f => prep.fields.includes(f) && p[f]),
      eligible: !reliable && !closed,
      ineligibleReason: reliable ? 'duplicate' : (closed ? 'permanently_closed' : null),
      fit: null
    };
  });

  let ai = null;
  const toAssess = rows.filter(r => r.eligible).slice(0, aiFitMax());
  if (v.aiQualify !== false && toAssess.length) {
    onProgress({ ...stateOf(), phase: 'assessing' });
    try {
      const fit = await assessFit(workspaceId, product, toAssess);
      for (const r of rows) r.fit = fit.get(r.placeId) || null;
      const eligible = rows.filter(r => r.eligible).length;
      const limits = [];
      if (fit.incomplete) limits.push(`AI fit was assessed for ${fit.size} of ${toAssess.length} businesses; the AI service was busy for the rest. Search again later to assess them.`);
      if (eligible > toAssess.length) limits.push(`AI fit was assessed for the first ${toAssess.length} of ${eligible} eligible businesses (limit per search).`);
      ai = { available: true, assessed: fit.size, limited: limits.join(' ') || null };
    } catch (err) {
      if (!(err instanceof AiUnavailableError) && err.code !== 'QUOTA_EXCEEDED') throw err;
      ai = { available: false, reason: err.code === 'QUOTA_EXCEEDED' ? 'Monthly AI limit reached.' : 'AI is unavailable, so no product-fit assessment was made.' };
    }
  }

  // Only the fields the user chose are returned (name, category and the Maps link always are).
  const results = rows.map(r => shownFields(r, prep.fields));

  const summary = {
    found: rows.length,
    raw,
    repeatsAcrossQueries: repeats,
    alreadyInLeads,
    duplicates: rows.filter(r => r.duplicate).length,
    possibleDuplicates: rows.filter(r => r.possibleDuplicate).length,
    eligible: rows.filter(r => r.eligible).length,
    missingContact: rows.filter(r => r.missingContact).length,
    closed: rows.filter(r => r.ineligibleReason === 'permanently_closed').length,
    requests,
    queries: log.length,
    requested: prep.maxResults
  };
  const failedQueries = log.filter(q => q.status === 'error').length;
  const status = fatal || failedQueries ? 'partial' : 'completed';
  const runId = await insertRun({ status, found: summary.found, duplicates: summary.duplicates, possible: summary.possibleDuplicates, eligible: summary.eligible,
    missing: summary.missingContact, errorCode: fatal?.code || (failedQueries ? lastError?.code : null), errorMessage: fatal?.message || (failedQueries ? `${failedQueries} query(ies) failed: ${lastError?.message}` : null) });
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await run(`INSERT INTO lead_discovery_places (run_id, workspace_id, place_id, eligible, duplicate_lead_id, match_reason, email, contact_name, contact_role, contact_source, created_at) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())').join(', ')}`,
      chunk.flatMap(r => [runId, workspaceId, r.placeId, r.eligible ? 1 : 0, (r.duplicate || r.possibleDuplicate)?.leadId || null, (r.duplicate || r.possibleDuplicate)?.reason || null,
      r.email ? r.email.slice(0, 254) : null, r.contactPerson ? r.contactPerson.slice(0, 80) : null, r.contactRole ? String(r.contactRole).slice(0, 60) : null,
      (r.contactSource || r.emailSource) ? String(r.contactSource || r.emailSource).slice(0, 500) : null]));
  }
  await audit(ctx, 'leads.discovery_searched', { resourceType: 'lead_discovery_run', resourceId: runId, metadata: { found: summary.found, eligible: summary.eligible, requests, queries: log.length, stop, productId: product.id } });

  const budget = estimate(prep, prep.allowedRequests);
  const explanation = [budget.shortfall, STOP_TEXT[stop], stop !== 'reached_target' && summary.found < prep.maxResults ? `Found ${summary.found} unique business(es) of the ${prep.maxResults} requested.` : null,
    alreadyInLeads ? `${alreadyInLeads} business(es) already in your leads were skipped.` : null].filter(Boolean).join(' ');
  return {
    run: { id: runId, status, textQuery: runCols.text_query, countryCode: v.countryCode, productId: product.id, productName: product.name, includeContacts: prep.includeContacts, fields: prep.fields, newOnly: prep.newOnly, scope: prep.scope, location: prep.location },
    summary,
    coverage: {
      categories,
      categoriesFrom: prep.categories ? 'you' : (prep.expand ? (planAi?.available ? 'ai' : 'business_type_only') : 'business_type_only'),
      planAi,
      requestedResults: prep.maxResults,
      maxRequests: prep.maxRequests,
      allowedRequests: prep.allowedRequests,
      requestsUsed: requests,
      remainingRequests: Math.max(0, prep.allowedRequests - requests),
      estimatedCostUsd: Math.round(billed * pricePer1000(prep.includeContacts) / 10) / 100,
      stopReason: stop,
      explanation
    },
    queries: log,
    partial: status === 'partial' ? { code: fatal?.code || lastError?.code, message: fatal ? `${STOP_TEXT[stop]} (${fatal.message})` : `${failedQueries} of ${log.length} queries failed (${lastError?.message}); the others completed.` } : null,
    ai,
    websiteLookup,
    results,
    attribution: 'Google Maps',
    notice: NOTICE
  };
}

/** Non-streaming search (JSON API): prepare + execute. */
async function search(ctx, input) {
  return executeSearch(ctx, await prepareSearch(ctx, input));
}

// ---------------------------------------------------------------- helpers for the search form
/** "Who should I target?": business types for a product of this workspace, suggested by AI. */
async function suggestTargets(ctx, input) {
  const { productId } = z.object({ productId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)]) }).strict().parse(input || {});
  const product = await leadService.requireWorkspaceProduct(ws(ctx), productId);
  return planner.suggestTargets(ws(ctx), product, 5);
}

/** The workspace's last searches: only the user's own settings, never Google content. */
async function recentSearches(ctx) {
  const rows = await all(`SELECT r.id, r.business_type, r.country_code, r.region, r.city, r.keywords, r.product_id, r.scope, r.expand_categories, r.max_results, r.max_requests,
      r.include_contacts, r.fields_json, r.status, r.found, r.imported, r.created_at, p.name AS product_name
    FROM lead_discovery_runs r LEFT JOIN digital_products p ON p.id = r.product_id AND p.workspace_id = r.workspace_id
    WHERE r.workspace_id = ? AND r.status IN ('completed', 'partial') ORDER BY r.id DESC LIMIT 30`, [ws(ctx)]);
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    let fields = null;
    try { fields = r.fields_json ? JSON.parse(r.fields_json) : null; } catch (e) { fields = null; }
    if (!Array.isArray(fields)) fields = r.include_contacts ? ['address', 'phone', 'website'] : ['address'];
    const search = {
      businessType: r.business_type, countryCode: r.country_code, scope: r.scope || (r.city ? 'city' : r.region ? 'region' : 'country'), region: r.region || '', city: r.city || '',
      keywords: r.keywords || '', productId: r.product_id, expandCategories: !!r.expand_categories, maxResults: r.max_results, maxRequests: r.max_requests, fields: fields.filter(f => FIELDS.includes(f))
    };
    // One entry per search as the list shows it (business type, place, product, number), newest first;
    // "Whole sale" and "whole sale" are the same search.
    const key = JSON.stringify([search.businessType.trim().toLowerCase().replace(/\s+/g, ' '), search.countryCode, search.scope, search.region.toLowerCase(), search.city.toLowerCase(), search.productId, search.maxResults]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ runId: r.id, search, productName: r.product_name || null, location: [r.city, r.region, places.countryName(r.country_code)].filter(Boolean).join(', '),
      found: r.found, imported: r.imported, createdAt: r.created_at });
    if (out.length >= 10) break;
  }
  return out;
}

// ---------------------------------------------------------------- import
const PLACE_ID = z.string().regex(/^[A-Za-z0-9_-]{10,255}$/);
const detailText = max => z.string().trim().max(max).nullable().optional().transform(v => (v ? v : null));
// The details the user reviewed for each selected business, sent by the browser with the import
// (the server never kept them). They are saved on the lead, so the workspace owns its lead data.
const importSchema = z.object({
  placeIds: z.array(PLACE_ID).min(1).max(HARD_MAX_RESULTS),
  details: z.array(z.object({
    placeId: PLACE_ID,
    name: detailText(255),
    category: detailText(120),
    address: detailText(500),
    // The country of the business's address on Google (ISO code), saved as the lead's country.
    countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/).nullable().optional().catch(null),
    phone: detailText(50),
    website: z.string().trim().max(500).url().refine(u => /^https?:\/\//i.test(u)).nullable().optional(),
    googleMapsUri: z.string().trim().max(500).url().refine(u => /^https:\/\//i.test(u)).nullable().optional(),
    rating: z.number().min(0).max(5).nullable().optional(),
    ratingCount: z.number().int().min(0).nullable().optional()
  }).strip()).max(HARD_MAX_RESULTS).optional()
}).strict();

async function importSelected(ctx, runIdRaw, input) {
  const workspaceId = ws(ctx);
  const runId = Number(runIdRaw);
  if (!Number.isInteger(runId) || runId <= 0) throw httpError(400, 'Invalid discovery run.', 'VALIDATION_ERROR');
  const { placeIds, details = [] } = importSchema.parse(input || {});
  const detailsById = new Map(details.map(d => [d.placeId, d]));
  const r = await get('SELECT * FROM lead_discovery_runs WHERE id = ? AND workspace_id = ?', [runId, workspaceId]);
  if (!r) throw httpError(404, 'Discovery search not found.', 'NOT_FOUND');
  // Leads are always imported for the search's product, which must still belong to this workspace.
  const product = r.product_id ? await get('SELECT id, name FROM digital_products WHERE id = ? AND workspace_id = ?', [r.product_id, workspaceId]) : null;
  if (!product) throw httpError(409, 'The product chosen for this search no longer exists. Search again with a current product.', 'PRODUCT_REMOVED');
  const found = new Map((await all('SELECT * FROM lead_discovery_places WHERE run_id = ? AND workspace_id = ?', [runId, workspaceId])).map(p => [p.place_id, p]));

  const location = [r.city, r.region, places.countryName(r.country_code)].filter(Boolean).join(', ');
  const day = new Date().toISOString().slice(0, 10);
  const notes = `Found by AI Lead Discovery (Google Places) on ${day} for "${r.text_query}".`;
  const googleNote = d => d ? [
    d.category ? `Category: ${d.category}` : null,
    d.address ? `Address: ${d.address}` : null,
    d.website ? `Website: ${d.website}` : null,
    d.rating != null ? `Google rating: ${d.rating} (${d.ratingCount || 0} reviews)` : null,
    d.googleMapsUri ? `Google Maps: ${d.googleMapsUri}` : null
  ].filter(Boolean).join('\n') : '';
  // Email and contact person were read from the business's own website (not Google), so they are kept.
  const websiteNote = p => [
    p.contact_name ? `Contact person ${p.contact_name}${p.contact_role ? ` (${p.contact_role})` : ''}` : null,
    p.email ? `email ${p.email}` : null
  ].filter(Boolean).join(' and ') + (p.contact_source ? ` found on the business's website (${p.contact_source}).` : ' found on the business\'s website.');
  const outcome = { created: [], skipped: [], duplicates: [], failed: [] };
  const unique = [...new Set(placeIds)];

  await withTransaction(async tx => {
    let n = Number((await tx.get('SELECT COUNT(*) AS n FROM lead_place_refs WHERE workspace_id = ? AND run_id = ?', [workspaceId, runId])).n);
    for (const placeId of unique) {
      const p = found.get(placeId);
      if (!p) { outcome.failed.push({ placeId, reason: 'Not part of this search.' }); continue; }
      if (p.imported_lead_id) { outcome.duplicates.push({ placeId, leadId: p.imported_lead_id, reason: 'Already imported.' }); continue; }
      if (p.duplicate_lead_id && RELIABLE_MATCHES.has(p.match_reason)) { outcome.duplicates.push({ placeId, leadId: p.duplicate_lead_id, reason: `Matches an existing lead (${p.match_reason.replace('_', ' ')}).` }); continue; }
      if (!p.eligible) { outcome.skipped.push({ placeId, reason: 'Not eligible (permanently closed).' }); continue; }
      const existing = await tx.get('SELECT lead_id FROM lead_place_refs WHERE workspace_id = ? AND place_id = ?', [workspaceId, placeId]);
      if (existing) { outcome.duplicates.push({ placeId, leadId: existing.lead_id, reason: 'Already in your leads.' }); continue; }
      const d = detailsById.get(placeId) || null;
      const phone = d?.phone || null;
      if (phone && phoneKey(phone)) {
        const samePhone = (await tx.all('SELECT id, phone FROM leads WHERE workspace_id = ? AND phone IS NOT NULL', [workspaceId])).find(l => phoneKey(l.phone) === phoneKey(phone));
        if (samePhone) { outcome.duplicates.push({ placeId, leadId: samePhone.id, reason: 'Matches an existing lead (phone).' }); continue; }
      }
      if (p.email) {
        const sameEmail = await tx.get('SELECT id FROM leads WHERE workspace_id = ? AND LOWER(email) = ? LIMIT 1', [workspaceId, p.email.toLowerCase()]);
        if (sameEmail) { outcome.duplicates.push({ placeId, leadId: sameEmail.id, reason: 'Matches an existing lead (email).' }); continue; }
      }
      n += 1;
      const prospect = `Prospect ${n}: ${r.business_type}${location ? ` (${location})` : ''}`;
      const business = d?.name || null;
      const lead = {
        // The contact person when the website names one, otherwise the business itself.
        name: (p.contact_name || business || prospect).slice(0, 255),
        company_name: business ? business.slice(0, 255) : null,
        phone: phone ? phone.slice(0, 50) : null,
        email: p.email || null,
        notes: [notes, googleNote(d), p.email || p.contact_name ? websiteNote(p) : null].filter(Boolean).join('\n'),
        status: 'Imported',
        product_interest: product.name
      };
      const { score, category } = leadService.scoreLead(lead);
      const ins = await tx.run(
        `INSERT INTO leads (workspace_id, name, email, phone, company_name, country, address, estimated_budget, notes, status, product_id, product_interest, product_review_note, ai_score, ai_category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'Imported', ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [workspaceId, lead.name, lead.email, lead.phone, lead.company_name, places.countryName(d?.countryCode) || places.countryName(r.country_code), d?.address ? String(d.address).slice(0, 500) : null, lead.notes, product.id, lead.product_interest, null, score, category]
      );
      await tx.run('INSERT INTO lead_place_refs (workspace_id, lead_id, place_id, run_id, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())', [workspaceId, ins.lastID, placeId, runId]);
      await tx.run('UPDATE lead_discovery_places SET imported_lead_id = ? WHERE id = ?', [ins.lastID, p.id]);
      outcome.created.push({ placeId, leadId: ins.lastID });
    }
    if (outcome.created.length) await tx.run('UPDATE lead_discovery_runs SET imported = imported + ? WHERE id = ?', [outcome.created.length, runId]);
  });

  for (const c of outcome.created) {
    await automationEvents.emit(workspaceId, 'lead.created', { subjectType: 'lead', subjectId: c.leadId, payload: { source: 'google_places', status: 'Imported', productId: product.id }, key: `lead.created:${c.leadId}` });
  }
  await audit(ctx, 'leads.discovery_imported', { resourceType: 'lead_discovery_run', resourceId: runId, metadata: { created: outcome.created.length, duplicates: outcome.duplicates.length, skipped: outcome.skipped.length, failed: outcome.failed.length } });
  return { runId, productId: product.id, ...outcome };
}

// ---------------------------------------------------------------- live details for an imported lead
async function liveDetails(ctx, leadIdRaw) {
  const workspaceId = ws(ctx);
  const lead = await leadService.requireLead(workspaceId, leadIdRaw);
  const ref = await get('SELECT place_id FROM lead_place_refs WHERE workspace_id = ? AND lead_id = ?', [workspaceId, lead.id]);
  if (!ref) throw httpError(404, 'This lead was not found through Google Places.', 'NO_PLACE_REFERENCE');
  const usedToday = Number((await get("SELECT COUNT(*) AS n FROM usage_ledger WHERE workspace_id = ? AND category = 'places_details' AND created_at >= UTC_DATE()", [workspaceId])).n);
  if (usedToday >= dailyDetailsLimit()) throw httpError(429, `Daily limit for live Google details reached (${dailyDetailsLimit()} per workspace).`, 'DISCOVERY_DETAILS_LIMIT');
  let place;
  try {
    place = await places.getPlace(ref.place_id);
  } catch (err) {
    throw toHttp(err);
  }
  await recordUsage({ workspaceId, category: 'places_details', providerKey: 'google_places', referenceType: 'lead', referenceId: lead.id });
  return { leadId: lead.id, place, attribution: 'Google Maps', stored: false, fetchedAt: new Date().toISOString() };
}

module.exports = { config, plan, suggestTargets, recentSearches, prepareSearch, executeSearch, search, importSelected, liveDetails, matchOf, nameKey, phoneKey, domainOf, NOTICE };
