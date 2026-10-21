const crypto = require('crypto');
const { z } = require('zod');
const { run, get, all, withTransaction } = require('../../db/database');
const { audit } = require('../../lib/audit');
const automationEvents = require('../../lib/automationEvents');
const { recordUsage } = require('../../lib/usage');
const { generateStructured, untrusted, AiUnavailableError } = require('../../lib/aiStructured');
const leadService = require('../leads/leadService');
const places = require('./googlePlacesProvider');

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
 */
const DEFAULT_RESULTS = 20;
const maxResultsCap = () => Math.min(parseInt(process.env.LEAD_DISCOVERY_MAX_RESULTS || String(places.GOOGLE_MAX_RESULTS), 10) || places.GOOGLE_MAX_RESULTS, places.GOOGLE_MAX_RESULTS);
const dailySearchLimit = () => parseInt(process.env.LEAD_DISCOVERY_DAILY_SEARCHES || '20', 10);
const dailyDetailsLimit = () => parseInt(process.env.LEAD_DISCOVERY_DAILY_DETAILS || '200', 10);
const REPEAT_WINDOW_MIN = 2;
const AI_BATCH = 20;
// A shared domain of a free mailbox provider says nothing about the business.
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com', 'rediffmail.com', 'zoho.com', 'gmx.com', 'mail.com', 'yandex.com']);
const RELIABLE_MATCHES = new Set(['place_id', 'phone', 'website_domain']);

const NOTICE = 'Results come from Google Places and are limited by Google\'s coverage and ranking (at most 60 places per search). '
  + 'They are not every business in the area, and asking for more results does not guarantee more unique businesses. '
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
  maxResults: z.number().int().min(1).optional(),
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
      workspaceId, prompt, schema: fitSchema, referenceType: 'lead_discovery', maxTokens: 2500,
      system: 'You are a careful B2B sales analyst. You never invent facts and you label assumptions.'
    });
    const ids = new Set(batch.map(p => p.placeId));
    for (const r of data.results) if (ids.has(r.placeId)) out.set(r.placeId, { score: r.score, confidence: r.confidence, evidence: r.evidence, inference: r.inference });
  }
  return out;
}

// ---------------------------------------------------------------- config and limits
async function searchesToday(workspaceId) {
  const r = await get('SELECT COUNT(*) AS n FROM lead_discovery_runs WHERE workspace_id = ? AND created_at >= UTC_DATE()', [workspaceId]);
  return Number(r.n);
}

async function config(ctx) {
  return {
    configured: places.isConfigured(),
    maxResults: maxResultsCap(),
    defaultResults: Math.min(DEFAULT_RESULTS, maxResultsCap()),
    dailySearchLimit: dailySearchLimit(),
    searchesToday: await searchesToday(ws(ctx)),
    notice: NOTICE
  };
}

// ---------------------------------------------------------------- search
async function search(ctx, input) {
  const workspaceId = ws(ctx);
  const v = searchSchema.parse(input || {});
  const cap = maxResultsCap();
  const maxResults = v.maxResults ?? Math.min(DEFAULT_RESULTS, cap);
  if (maxResults > cap) throw httpError(400, `Ask for at most ${cap} results per search (Google returns at most 60 per query). Narrow the search by state or city for more.`, 'VALIDATION_ERROR');
  if (!places.countryName(v.countryCode)) throw httpError(400, 'Choose a valid country.', 'VALIDATION_ERROR');
  const product = await leadService.requireWorkspaceProduct(workspaceId, v.productId);
  if (!places.isConfigured()) throw httpError(503, 'Google Places is not set up: add GOOGLE_PLACES_API_KEY on the server (Places API (New) enabled).', 'PLACES_NOT_CONFIGURED');

  const used = await searchesToday(workspaceId);
  if (used >= dailySearchLimit()) throw httpError(429, `Daily discovery limit reached (${dailySearchLimit()} searches per workspace). Try again tomorrow.`, 'DISCOVERY_DAILY_LIMIT');

  const includeContacts = v.includeContacts !== false;
  const textQuery = places.buildTextQuery(v);
  const criteriaHash = crypto.createHash('sha1').update(JSON.stringify([textQuery.toLowerCase(), v.countryCode, maxResults, includeContacts, product.id])).digest('hex');
  const recent = await get(`SELECT id FROM lead_discovery_runs WHERE workspace_id = ? AND criteria_hash = ? AND created_at >= UTC_TIMESTAMP() - INTERVAL ${REPEAT_WINDOW_MIN} MINUTE AND status <> 'failed' ORDER BY id DESC LIMIT 1`, [workspaceId, criteriaHash]);
  if (recent) throw httpError(409, `The same search ran less than ${REPEAT_WINDOW_MIN} minutes ago. Review those results or change the search to avoid paying for it twice.`, 'DUPLICATE_SEARCH');

  const runRow = {
    business_type: v.businessType, country_code: v.countryCode, region: v.region, city: v.city, keywords: v.keywords,
    product_id: product.id, max_results: maxResults, include_contacts: includeContacts ? 1 : 0, text_query: textQuery.slice(0, 400), criteria_hash: criteriaHash
  };
  const insertRun = async (extra) => (await run(
    `INSERT INTO lead_discovery_runs (workspace_id, created_by, business_type, country_code, region, city, keywords, product_id, max_results, include_contacts, text_query, criteria_hash,
       status, found, duplicates, possible_duplicates, eligible, missing_contact, pages, error_code, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [workspaceId, ctx.auth.userId || null, runRow.business_type, runRow.country_code, runRow.region, runRow.city, runRow.keywords, runRow.product_id, runRow.max_results,
      runRow.include_contacts, runRow.text_query, runRow.criteria_hash, extra.status, extra.found || 0, extra.duplicates || 0, extra.possible || 0, extra.eligible || 0,
      extra.missing || 0, extra.pages || 0, extra.errorCode || null, extra.errorMessage ? String(extra.errorMessage).slice(0, 500) : null]
  )).lastID;

  let result;
  try {
    result = await places.searchText({ textQuery, countryCode: v.countryCode, maxResults, includeContacts });
  } catch (err) {
    const runId = await insertRun({ status: 'failed', errorCode: err.code, errorMessage: err.message });
    await audit(ctx, 'leads.discovery_failed', { resourceType: 'lead_discovery_run', resourceId: runId, metadata: { code: err.code } });
    throw toHttp(err);
  }
  if (result.pages) await recordUsage({ workspaceId, category: 'places_search', providerKey: 'google_places', quantity: result.pages, unit: 'request', referenceType: 'lead_discovery' });

  const idx = await loadMatchIndex(workspaceId);
  const rows = result.places.map(p => {
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
  if (v.aiQualify !== false && rows.some(r => r.eligible)) {
    try {
      const fit = await assessFit(workspaceId, product, rows.filter(r => r.eligible));
      for (const r of rows) r.fit = fit.get(r.placeId) || null;
      ai = { available: true, assessed: fit.size };
    } catch (err) {
      if (!(err instanceof AiUnavailableError) && err.code !== 'QUOTA_EXCEEDED') throw err;
      ai = { available: false, reason: err.code === 'QUOTA_EXCEEDED' ? 'Monthly AI limit reached.' : 'AI is unavailable, so no product-fit assessment was made.' };
    }
  }

  const summary = {
    found: rows.length,
    duplicates: rows.filter(r => r.duplicate).length,
    possibleDuplicates: rows.filter(r => r.possibleDuplicate).length,
    eligible: rows.filter(r => r.eligible).length,
    missingContact: rows.filter(r => r.missingContact).length,
    closed: rows.filter(r => r.ineligibleReason === 'permanently_closed').length,
    pages: result.pages,
    requested: maxResults
  };
  const status = result.partial ? 'partial' : 'completed';
  const runId = await insertRun({ status, found: summary.found, duplicates: summary.duplicates, possible: summary.possibleDuplicates, eligible: summary.eligible,
    missing: summary.missingContact, pages: summary.pages, errorCode: result.partial?.code, errorMessage: result.partial?.message });
  for (const r of rows) {
    await run('INSERT INTO lead_discovery_places (run_id, workspace_id, place_id, eligible, duplicate_lead_id, match_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
      [runId, workspaceId, r.placeId, r.eligible ? 1 : 0, (r.duplicate || r.possibleDuplicate)?.leadId || null, (r.duplicate || r.possibleDuplicate)?.reason || null]);
  }
  await audit(ctx, 'leads.discovery_searched', { resourceType: 'lead_discovery_run', resourceId: runId, metadata: { found: summary.found, eligible: summary.eligible, pages: summary.pages, productId: product.id } });

  return {
    run: { id: runId, status, textQuery, countryCode: v.countryCode, productId: product.id, productName: product.name, includeContacts },
    summary,
    partial: result.partial ? { code: result.partial.code, message: `Search stopped early: ${result.partial.message} Showing the ${summary.found} result(s) received.` } : null,
    lessThanRequested: summary.found < maxResults ? (result.exhausted ? 'Google returned fewer matching places than requested.' : null) : null,
    ai,
    results: rows,
    attribution: 'Google Maps',
    notice: NOTICE
  };
}

// ---------------------------------------------------------------- import
const importSchema = z.object({ placeIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{10,255}$/)).min(1).max(places.GOOGLE_MAX_RESULTS) }).strict();

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

module.exports = { config, search, importSelected, liveDetails, matchOf, nameKey, phoneKey, domainOf, NOTICE };
