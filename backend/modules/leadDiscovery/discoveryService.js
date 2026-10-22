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

/**
 * AI Lead Discovery: finds real businesses with Google Places API (New), lets the user review
 * them, and imports the selected ones into the existing Leads CRM.
 *
 * Google Maps Platform terms (3.2.3 "No Scraping" / "No Caching"; Service Terms 14.3) forbid
 * storing business names, addresses and other Places content; place IDs may be stored. So:
 * - search results (name, address, phone, website, category) are returned for review only and
 *   never written to the database;
 * - an imported lead stores the place ID (lead_place_refs) plus the user's own search criteria,
 *   and its business details are fetched live from Google when viewed;
 * - the optional AI product-fit assessment is shown during review only.
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
// A shared domain of a free mailbox provider says nothing about the business.
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'rediffmail.com', 'zoho.com', 'gmx.com', 'mail.com', 'yandex.com']);
const RELIABLE_MATCHES = new Set(['place_id', 'phone', 'website_domain']);

const NOTICE = 'Results come from Google Places. Each Google query returns at most 60 places (20 per request), so a search runs several distinct queries within its request budget. '
  + 'Results are still limited by Google\'s coverage and ranking: they are not every business in the area, and a higher target does not guarantee more unique businesses. '
  + 'Business details are shown for review only: Google\'s terms do not allow storing them, so imported leads keep a Google place reference and show the details live.';

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
  const idx = { place: new Map(refs.map(r => [r.place_id, r.lead_id])), phone: new Map(), domain: new Map(), name: new Map() };
  for (const l of leads) {
    const p = phoneKey(l.phone);
    if (p && !idx.phone.has(p)) idx.phone.set(p, l.id);
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
    const { data } = await generateStructured({
      workspaceId, prompt, schema: fitSchema, referenceType: 'lead_discovery', maxTokens: 2500, excludeProviders: leadService.LEADS_AI_EXCLUDE,
      system: 'You are a careful B2B sales analyst. You never invent facts and you label assumptions.'
    });
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
  return { v, product, scope, loc, location: places.locationLabel(loc), maxResults, maxRequests, categories, includeContacts: v.includeContacts !== false, expand: v.expandCategories === true };
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
    r.categories || (r.expand ? 'auto' : null), r.maxResults, r.maxRequests, r.includeContacts, r.product.id])).digest('hex');
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
  const stateOf = () => ({ phase: 'searching', completedQueries: log.length, plannedQueries: queue.length, requests, maxRequests: prep.allowedRequests, unique: unique.size, raw, repeats, target: prep.maxResults });

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
      for (const p of page.places) {
        if (unique.has(p.placeId)) { repeats++; continue; }
        if (unique.size >= prep.maxResults) break;
        unique.set(p.placeId, p);
        fresh++;
      }
      entry.newUnique += fresh;
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
      for (const sub of planner.subLocations([...unique.values()], { scope: prep.scope, region: prep.loc.region, countryCode: v.countryCode }, maxSubLocations())) {
        const location = prep.scope === 'country' ? `${sub}, ${country}` : `${sub}, ${prep.loc.region}, ${country}`;
        for (const category of categories) queue.push({ category, location, tier: 'local' });
      }
    }
  }
  if (!stop) stop = 'no_more_queries';
  onProgress({ ...stateOf(), phase: 'checking' });

  const runCols = {
    business_type: v.businessType, country_code: v.countryCode, region: prep.loc.region, city: prep.loc.city, keywords: v.keywords, product_id: product.id,
    max_results: prep.maxResults, include_contacts: prep.includeContacts ? 1 : 0, text_query: places.buildTextQuery({ businessType: v.businessType, keywords: v.keywords, ...prep.loc }).slice(0, 400),
    criteria_hash: prep.criteriaHash, scope: prep.scope, expand_categories: prep.expand ? 1 : 0, categories_json: JSON.stringify(categories), max_requests: prep.maxRequests,
    requests, queries_run: log.length, raw_results: raw, stop_reason: stop
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

  const idx = await loadMatchIndex(workspaceId);
  const rows = [...unique.values()].map(p => {
    const match = matchOf(p, idx);
    const closed = p.businessStatus === 'CLOSED_PERMANENTLY';
    const reliable = !!match && RELIABLE_MATCHES.has(match.reason);
    return {
      ...p,
      duplicate: reliable ? match : null,
      possibleDuplicate: match && !reliable ? match : null,
      missingContact: !p.phone && !p.website,
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
      ai = { available: true, assessed: fit.size, limited: eligible > toAssess.length ? `AI fit was assessed for the first ${toAssess.length} of ${eligible} eligible businesses (limit per search).` : null };
    } catch (err) {
      if (!(err instanceof AiUnavailableError) && err.code !== 'QUOTA_EXCEEDED') throw err;
      ai = { available: false, reason: err.code === 'QUOTA_EXCEEDED' ? 'Monthly AI limit reached.' : 'AI is unavailable, so no product-fit assessment was made.' };
    }
  }

  const summary = {
    found: rows.length,
    raw,
    repeatsAcrossQueries: repeats,
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
    await run(`INSERT INTO lead_discovery_places (run_id, workspace_id, place_id, eligible, duplicate_lead_id, match_reason, created_at) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())').join(', ')}`,
      chunk.flatMap(r => [runId, workspaceId, r.placeId, r.eligible ? 1 : 0, (r.duplicate || r.possibleDuplicate)?.leadId || null, (r.duplicate || r.possibleDuplicate)?.reason || null]));
  }
  await audit(ctx, 'leads.discovery_searched', { resourceType: 'lead_discovery_run', resourceId: runId, metadata: { found: summary.found, eligible: summary.eligible, requests, queries: log.length, stop, productId: product.id } });

  const budget = estimate(prep, prep.allowedRequests);
  const explanation = [budget.shortfall, STOP_TEXT[stop], stop !== 'reached_target' && summary.found < prep.maxResults ? `Found ${summary.found} unique business(es) of the ${prep.maxResults} requested.` : null].filter(Boolean).join(' ');
  return {
    run: { id: runId, status, textQuery: runCols.text_query, countryCode: v.countryCode, productId: product.id, productName: product.name, includeContacts: prep.includeContacts, scope: prep.scope, location: prep.location },
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
    results: rows,
    attribution: 'Google Maps',
    notice: NOTICE
  };
}

/** Non-streaming search (JSON API): prepare + execute. */
async function search(ctx, input) {
  return executeSearch(ctx, await prepareSearch(ctx, input));
}

// ---------------------------------------------------------------- import
const importSchema = z.object({ placeIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{10,255}$/)).min(1).max(HARD_MAX_RESULTS) }).strict();

async function importSelected(ctx, runIdRaw, input) {
  const workspaceId = ws(ctx);
  const runId = Number(runIdRaw);
  if (!Number.isInteger(runId) || runId <= 0) throw httpError(400, 'Invalid discovery run.', 'VALIDATION_ERROR');
  const { placeIds } = importSchema.parse(input || {});
  const r = await get('SELECT * FROM lead_discovery_runs WHERE id = ? AND workspace_id = ?', [runId, workspaceId]);
  if (!r) throw httpError(404, 'Discovery search not found.', 'NOT_FOUND');
  // Leads are always imported for the search's product, which must still belong to this workspace.
  const product = r.product_id ? await get('SELECT id, name FROM digital_products WHERE id = ? AND workspace_id = ?', [r.product_id, workspaceId]) : null;
  if (!product) throw httpError(409, 'The product chosen for this search no longer exists. Search again with a current product.', 'PRODUCT_REMOVED');
  const found = new Map((await all('SELECT * FROM lead_discovery_places WHERE run_id = ? AND workspace_id = ?', [runId, workspaceId])).map(p => [p.place_id, p]));

  const location = [r.city, r.region, places.countryName(r.country_code)].filter(Boolean).join(', ');
  const day = new Date().toISOString().slice(0, 10);
  const notes = `Found by AI Lead Discovery (Google Places) on ${day} for "${r.text_query}". `
    + 'The business name, address, phone and website are shown live from Google Maps and are not stored here (Google Maps Platform terms). '
    + 'Verify the business and enter contact details you have confirmed yourself.';
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
      n += 1;
      const lead = { name: `Prospect ${n}: ${r.business_type}${location ? ` (${location})` : ''}`.slice(0, 255), notes, status: 'Imported', product_interest: product.name };
      const { score, category } = leadService.scoreLead(lead);
      const ins = await tx.run(
        `INSERT INTO leads (workspace_id, name, email, phone, company_name, estimated_budget, notes, status, product_id, product_interest, product_review_note, ai_score, ai_category, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, NULL, NULL, ?, 'Imported', ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [workspaceId, lead.name, notes, product.id, lead.product_interest, null, score, category]
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

module.exports = { config, plan, prepareSearch, executeSearch, search, importSelected, liveDetails, matchOf, nameKey, phoneKey, domainOf, NOTICE };
