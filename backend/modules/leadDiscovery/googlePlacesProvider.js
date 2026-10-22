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
 *   returns every business in a country. Broader coverage comes from running several distinct
 *   queries (see discoveryService), never from repeating one.
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

/** "Kochi, Kerala, India" */
function locationLabel({ city, region, countryCode }) {
  return [city, region, countryName(countryCode)].filter(Boolean).join(', ');
}

/** "Wholesale distributors (FMCG) in Kochi, Kerala, India" */
function buildQuery({ category, keywords, location }) {
  const what = [category, keywords ? `(${keywords})` : null].filter(Boolean).join(' ');
  return `${what} in ${location}`.replace(/\s+/g, ' ').trim();
}

/** The base query, built only from the user's own inputs. */
function buildTextQuery({ businessType, keywords, city, region, countryCode }) {
  return buildQuery({ category: businessType, keywords, location: locationLabel({ city, region, countryCode }) });
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
 * One Text Search page. Every page of a query repeats exactly the same parameters with the
 * nextPageToken from the previous page (Google requirement), so the page size is always 20.
 */
async function searchPage({ textQuery, countryCode, includeContacts = true, pageToken = null }) {
  const fields = includeContacts ? [...SEARCH_FIELDS, ...CONTACT_FIELDS] : SEARCH_FIELDS;
  const base = { textQuery, pageSize: PAGE_SIZE, regionCode: countryCode.toLowerCase(), languageCode: 'en' };
  const body = await call('/places:searchText', { method: 'POST', json: pageToken ? { ...base, pageToken } : base, fields });
  if (!Array.isArray(body.places ?? [])) throw new ProviderError({ message: 'Google Places returned results in an unexpected format.', code: 'PROVIDER_ERROR' });
  const places = [];
  let malformed = 0;
  for (const raw of body.places || []) {
    const p = mapPlace(raw);
    if (p) places.push(p);
    else malformed++;
  }
  return { places, malformed, nextPageToken: typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : null };
}

/** Place Details (New) for one place ID, fetched live (not stored). */
async function getPlace(placeId) {
  if (!/^[A-Za-z0-9_-]{10,255}$/.test(String(placeId || ''))) throw new ProviderError({ message: 'Invalid place id.', code: 'INVALID_REQUEST' });
  const body = await call(`/places/${encodeURIComponent(placeId)}`, { fields: DETAIL_FIELDS });
  const mapped = mapPlace(body);
  if (!mapped) throw new ProviderError({ message: 'Google Places returned no details for this place.', code: 'NOT_FOUND' });
  return mapped;
}

module.exports = { buildTextQuery, buildQuery, locationLabel, countryName, mapPlace, searchPage, getPlace, isConfigured, GOOGLE_MAX_RESULTS, PAGE_SIZE, SEARCH_FIELDS, CONTACT_FIELDS };
