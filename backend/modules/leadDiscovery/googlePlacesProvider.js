const { providerRequest, ProviderError } = require('../social/providers/http');

/**
 * Google Places API (New): Text Search and Place Details.
 * Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
 * - The key (GOOGLE_PLACES_API_KEY) is sent only in the X-Goog-Api-Key header, never in a URL,
 *   a log line or an API response.
 * - Field masks request only what the lead review needs. Phone and website are Enterprise-tier
 *   fields and are requested only when contact details are asked for.
 * - Text Search returns at most 20 places per page and 60 per query across pages (Google's limit,
 *   "subject to change"). Results are bounded by Google's coverage and ranking: a query never
 *   returns every business in a country.
 * - Values Google does not return stay null (unavailable); nothing is inferred or invented.
 */
const BASE = 'https://places.googleapis.com/v1';
const PAGE_SIZE = 20;
const GOOGLE_MAX_RESULTS = 60;

const SEARCH_FIELDS = ['places.id', 'places.displayName', 'places.formattedAddress', 'places.addressComponents', 'places.types',
  'places.primaryType', 'places.primaryTypeDisplayName', 'places.businessStatus', 'places.googleMapsUri', 'nextPageToken'];
const CONTACT_FIELDS = ['places.nationalPhoneNumber', 'places.internationalPhoneNumber', 'places.websiteUri'];
const DETAIL_FIELDS = ['id', 'displayName', 'formattedAddress', 'addressComponents', 'types', 'primaryTypeDisplayName', 'businessStatus',
  'googleMapsUri', 'nationalPhoneNumber', 'internationalPhoneNumber', 'websiteUri'];

const timeoutMs = () => parseInt(process.env.PLACES_TIMEOUT_MS || '10000', 10);
const isConfigured = () => !!process.env.GOOGLE_PLACES_API_KEY;

/** Countries are ISO 3166-1 alpha-2 codes; the English name comes from the runtime's CLDR data. */
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
// CLDR also names retired codes (e.g. DD, SU, YU, UK) and non-country regions (EU, UN, IC, ...).
const NOT_COUNTRIES = new Set(['AC', 'AN', 'BU', 'CP', 'CS', 'DD', 'DG', 'DY', 'EA', 'EU', 'EZ', 'FX', 'HV', 'IC', 'NH', 'QO', 'RH', 'SU', 'TA', 'TP', 'UK', 'UN', 'VD', 'XA', 'XB', 'YD', 'YU', 'ZR', 'ZZ']);
function countryName(code) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || NOT_COUNTRIES.has(c)) return null;
  try {
    const name = regionNames.of(c);
    return name && name !== c && !/unknown/i.test(name) ? name : null;
  } catch (e) {
    return null;
  }
}

/** "IT service companies with cloud hosting in Kochi, Kerala, India" — only the user's own inputs. */
function buildTextQuery({ businessType, keywords, city, region, countryCode }) {
  const what = [businessType, keywords ? `(${keywords})` : null].filter(Boolean).join(' ');
  const where = [city, region, countryName(countryCode)].filter(Boolean).join(', ');
  return `${what} in ${where}`.replace(/\s+/g, ' ').trim();
}

function classifyGoogle(status, body) {
  const g = body?.error || {};
  const reason = g.details?.find(d => d.reason)?.reason || g.status || null;
  const message = g.message ? String(g.message).slice(0, 300) : null;
  if (status === 429 || g.status === 'RESOURCE_EXHAUSTED') {
    return { code: 'QUOTA_EXCEEDED', retryable: false, providerCode: reason, message: 'Google Places quota or rate limit reached. Try again later or raise the quota in Google Cloud.' };
  }
  if (status === 403 || status === 401 || g.status === 'PERMISSION_DENIED') {
    return { code: 'PERMISSION_DENIED', retryable: false, providerCode: reason, message: `Google rejected the request: ${message || 'check that Places API (New) is enabled and the key is allowed to call it.'}` };
  }
  if (status === 400) return { code: 'INVALID_REQUEST', retryable: false, providerCode: reason, message: `Google could not process the search: ${message || 'invalid request.'}` };
  return null;
}

async function call(path, { method = 'GET', json, fields }) {
  if (!isConfigured()) throw new ProviderError({ message: 'Google Places is not set up (GOOGLE_PLACES_API_KEY is missing on the server).', code: 'SETUP_REQUIRED' });
  const { body } = await providerRequest(`${BASE}${path}`, {
    method,
    json,
    headers: { 'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY, 'X-Goog-FieldMask': fields.join(',') },
    timeoutMs: timeoutMs(),
    classify: classifyGoogle,
    label: 'Google Places'
  });
  if (!body || typeof body !== 'object' || body.raw !== undefined) {
    throw new ProviderError({ message: 'Google Places returned a response that could not be read.', code: 'PROVIDER_ERROR', retryable: true });
  }
  return body;
}

const textOf = v => (v && typeof v === 'object' ? (v.text ? String(v.text) : null) : (v ? String(v) : null));
const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

function component(components, type) {
  const c = (components || []).find(x => Array.isArray(x.types) && x.types.includes(type));
  return c ? (c.longText || c.shortText || null) : null;
}

/** Maps one Places result. Every field is the value Google returned, or null if it did not. */
function mapPlace(p) {
  if (!p || typeof p !== 'object' || !str(p.id)) return null;
  const comps = Array.isArray(p.addressComponents) ? p.addressComponents : [];
  const countryComp = comps.find(x => Array.isArray(x.types) && x.types.includes('country'));
  let website = str(p.websiteUri);
  if (website && !/^https?:\/\//i.test(website)) website = null;
  return {
    placeId: p.id,
    name: textOf(p.displayName),
    category: textOf(p.primaryTypeDisplayName) || (str(p.primaryType) ? p.primaryType.replace(/_/g, ' ') : null),
    types: Array.isArray(p.types) ? p.types.slice(0, 10) : [],
    address: str(p.formattedAddress),
    city: component(comps, 'locality') || component(comps, 'postal_town') || component(comps, 'administrative_area_level_2'),
    region: component(comps, 'administrative_area_level_1'),
    postalCode: component(comps, 'postal_code'),
    country: countryComp ? (countryComp.longText || null) : null,
    countryCode: countryComp ? (countryComp.shortText || null) : null,
    phone: str(p.internationalPhoneNumber) || str(p.nationalPhoneNumber),
    website,
    googleMapsUri: str(p.googleMapsUri),
    businessStatus: str(p.businessStatus)
  };
}

/**
 * Runs one Text Search query, following page tokens until maxResults or Google's 60-result cap.
 * A failure after the first page returns the places already received with `partial` set.
 */
async function searchText({ textQuery, countryCode, maxResults, includeContacts = true }) {
  const limit = Math.min(Math.max(parseInt(maxResults, 10) || PAGE_SIZE, 1), GOOGLE_MAX_RESULTS);
  const pageSize = Math.min(PAGE_SIZE, limit);
  const fields = includeContacts ? [...SEARCH_FIELDS, ...CONTACT_FIELDS] : SEARCH_FIELDS;
  // Every page must repeat the same parameters; only pageToken changes (Google requirement).
  const base = { textQuery, pageSize, regionCode: countryCode.toLowerCase(), languageCode: 'en' };
  const places = [];
  const seen = new Set();
  let pageToken = null;
  let pages = 0;
  let partial = null;
  let malformed = 0;
  do {
    let body;
    try {
      body = await call('/places:searchText', { method: 'POST', json: pageToken ? { ...base, pageToken } : base, fields });
    } catch (err) {
      if (!pages) throw err;
      partial = { code: err.code, message: err.message };
      break;
    }
    if (!Array.isArray(body.places ?? [])) {
      if (!pages) throw new ProviderError({ message: 'Google Places returned results in an unexpected format.', code: 'PROVIDER_ERROR' });
      partial = { code: 'PROVIDER_ERROR', message: 'A later results page had an unexpected format.' };
      break;
    }
    pages++;
    for (const raw of body.places || []) {
      const p = mapPlace(raw);
      if (!p) { malformed++; continue; }
      if (seen.has(p.placeId)) continue;
      seen.add(p.placeId);
      places.push(p);
      if (places.length >= limit) break;
    }
    pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : null;
  } while (pageToken && places.length < limit);
  return { places, pages, partial, malformed, exhausted: !pageToken, requested: limit };
}

/** Place Details (New) for one place ID, fetched live (not stored). */
async function getPlace(placeId) {
  if (!/^[A-Za-z0-9_-]{10,255}$/.test(String(placeId || ''))) throw new ProviderError({ message: 'Invalid place id.', code: 'INVALID_REQUEST' });
  const body = await call(`/places/${encodeURIComponent(placeId)}`, { fields: DETAIL_FIELDS });
  const mapped = mapPlace(body);
  if (!mapped) throw new ProviderError({ message: 'Google Places returned no details for this place.', code: 'NOT_FOUND' });
  return mapped;
}

module.exports = { buildTextQuery, countryName, mapPlace, searchText, getPlace, isConfigured, GOOGLE_MAX_RESULTS, PAGE_SIZE, SEARCH_FIELDS, CONTACT_FIELDS };
