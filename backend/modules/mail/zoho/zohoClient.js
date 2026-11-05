/**
 * Minimal Zoho Campaigns (API v1.1) client. Zoho is only the delivery backend for campaigns that
 * are written and approved in Marketech.ai. Only these endpoints can be called:
 * - read: mailing lists, topics, recent campaigns, campaign details, campaign reports;
 * - write: createCampaign (the delivery object Zoho needs before sending) and sendcampaign;
 * - contact sync: a new private list for the contacts selected on a campaign, and adding to it.
 * Contacts of existing lists and content of existing Zoho campaigns are never changed.
 *
 * Data centers: Zoho accounts live in regional data centers. The accounts-server comes only from
 * the allowlist below (never from a URL in the request), selected by the "location" Zoho returns.
 * The Campaigns API host follows Zoho's regional domain pattern; only campaigns.zoho.com is shown
 * in the API documentation, so other regions must be confirmed with a test account.
 */
// ma: the Marketing Automation API host (v2.1), used only to hand a campaign to Zoho's content review.
const DATA_CENTERS = {
  us: { accounts: 'https://accounts.zoho.com', campaigns: 'https://campaigns.zoho.com', ma: 'https://ma.zoho.com' },
  eu: { accounts: 'https://accounts.zoho.eu', campaigns: 'https://campaigns.zoho.eu', ma: 'https://ma.zoho.eu' },
  in: { accounts: 'https://accounts.zoho.in', campaigns: 'https://campaigns.zoho.in', ma: 'https://ma.zoho.in' },
  au: { accounts: 'https://accounts.zoho.com.au', campaigns: 'https://campaigns.zoho.com.au', ma: 'https://ma.zoho.com.au' },
  jp: { accounts: 'https://accounts.zoho.jp', campaigns: 'https://campaigns.zoho.jp', ma: 'https://ma.zoho.jp' },
  ca: { accounts: 'https://accounts.zohocloud.ca', campaigns: 'https://campaigns.zohocloud.ca', ma: 'https://ma.zohocloud.ca' },
  sa: { accounts: 'https://accounts.zoho.sa', campaigns: 'https://campaigns.zoho.sa', ma: 'https://ma.zoho.sa' },
  uk: { accounts: 'https://accounts.zoho.uk', campaigns: 'https://campaigns.zoho.uk', ma: 'https://ma.zoho.uk' }
};

// Documented minimum scopes: campaign.CREATE (createCampaign), campaign.UPDATE (sendcampaign),
// campaign.READ (details, reports, recent campaigns), contact.READ (mailing lists, topics).
const DELIVERY_SCOPES = ['ZohoCampaigns.campaign.CREATE', 'ZohoCampaigns.campaign.READ', 'ZohoCampaigns.campaign.UPDATE', 'ZohoCampaigns.contact.READ'];
// Only for campaigns with selected contacts: a connection without it can still send to lists.
const CONTACT_SYNC_SCOPE = 'ZohoCampaigns.contact.CREATE';
// Optional: lets selected leads' names reach Zoho (listsubscribe), so name merge tags are filled.
// Connections without it still send; names then fall back to the merge tag's default.
const CONTACT_UPDATE_SCOPE = 'ZohoCampaigns.contact.UPDATE';
// Deleting a mailing list (Contact lists → Delete → "Delete in Zoho"). Contacts are never deleted.
const CONTACT_DELETE_SCOPE = 'ZohoCampaigns.contact.DELETE';
const SCOPES = [...DELIVERY_SCOPES, CONTACT_SYNC_SCOPE, CONTACT_UPDATE_SCOPE, CONTACT_DELETE_SCOPE];
const READ_ENDPOINTS = new Set(['recentcampaigns', 'getcampaigndetails', 'campaignreports', 'getmailinglists', 'topics', 'getcampaignrecipientsdata', 'getlistsubscribers']);
// Reads Zoho documents as POST (form body). Still reads: a failure is a plain error, never "outcome unknown".
const READ_POST_ENDPOINTS = new Set(['getcampaignrecipientsdata']);
// Write calls whose outcome can be unknown after a timeout; never retried automatically.
const WRITE_ENDPOINTS = new Set(['createCampaign', 'sendcampaign']);
// Contact and list changes (campaign sync and Zoho Campaigns → Contact lists). Safe to repeat, so a
// failure is a plain error. Deleting campaigns or contacts is never allowed.
const SYNC_ENDPOINTS = new Set(['addlistandcontacts', 'addlistsubscribersinbulk', 'json/listsubscribe', 'json/listunsubscribe']);
// Deleting a mailing list (only with deletecontacts=off, enforced in call()). Documented as GET.
const LIST_DELETE_ENDPOINTS = new Set(['deletemailinglist']);
const TIMEOUT_MS = 20000;
const NOT_CONNECTED_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

function zohoError(message, { status = 502, code = 'ZOHO_ERROR', providerCode = null, outcomeUnknown = false, reauth = false } = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.providerCode = providerCode;
  err.outcomeUnknown = outcomeUnknown;
  err.reauth = reauth;
  err.expose = true;
  return err;
}

/** The server-wide OAuth client from .env (used when a workspace has not entered its own in Settings). */
function clientConfig() {
  const clientId = process.env.ZOHO_CAMPAIGNS_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CAMPAIGNS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function appBaseUrl() {
  return (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 8000}`).replace(/\/$/, '');
}

const redirectUri = () => `${appBaseUrl()}/api/v1/mail/zoho/callback`;

/**
 * Picks the data center from Zoho's redirect. accounts-server, when present, must be exactly
 * the allowlisted server for that location; anything else is refused.
 */
function resolveDataCenter(location, accountsServer) {
  const loc = String(location || 'us').toLowerCase();
  const dc = DATA_CENTERS[loc];
  if (!dc) return null;
  if (accountsServer && String(accountsServer).replace(/\/$/, '') !== dc.accounts) return null;
  return { location: loc, ...dc };
}

/** cfg: the OAuth client to use ({ clientId, clientSecret }): the workspace's own or the server's. */
function authorizeUrl(state, cfg = clientConfig()) {
  // Server-based apps start at the US accounts server; Zoho redirects back with the user's location.
  const params = new URLSearchParams({
    scope: SCOPES.join(','),
    client_id: cfg.clientId,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    redirect_uri: redirectUri(),
    state
  });
  return `${DATA_CENTERS.us.accounts}/oauth/v2/auth?${params}`;
}

async function postForm(url, form, { label }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    throw zohoError(`${label}: Zoho could not be reached.`, { code: 'ZOHO_UNREACHABLE' });
  }
  const data = await res.json().catch(() => null);
  if (!data) throw zohoError(`${label}: unexpected response from Zoho (HTTP ${res.status}).`, { code: 'ZOHO_BAD_RESPONSE' });
  return { res, data };
}

/** Exchanges the authorization code at the user's data center. Returns the refresh token. */
async function exchangeCode(dc, code, cfg = clientConfig()) {
  const { data } = await postForm(`${dc.accounts}/oauth/v2/token`, {
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri(),
    code
  }, { label: 'Connecting Zoho' });
  if (data.error) throw zohoError(`Zoho refused the authorization (${String(data.error).slice(0, 60)}).`, { status: 400, code: 'ZOHO_AUTH_FAILED' });
  if (!data.refresh_token) throw zohoError('Zoho did not return a refresh token. Remove Marketech.ai from your Zoho connected apps and connect again.', { status: 400, code: 'ZOHO_NO_REFRESH_TOKEN' });
  return { refreshToken: data.refresh_token, accessToken: data.access_token || null, expiresIn: Number(data.expires_in) || 3600, scope: data.scope || SCOPES.join(',') };
}

/** New access token from a refresh token. invalid grants mean the user must reconnect. */
async function refreshAccessToken(dc, refreshToken, cfg = clientConfig()) {
  if (!cfg) throw zohoError('Zoho Campaigns is not set up: enter the Zoho Client ID and Client Secret in Mail Center → Settings → Zoho Campaigns.', { status: 503, code: 'ZOHO_NOT_CONFIGURED' });
  const { data } = await postForm(`${dc.accounts}/oauth/v2/token`, {
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken
  }, { label: 'Refreshing the Zoho session' });
  if (data.error || !data.access_token) {
    throw zohoError('The Zoho connection is no longer valid. Reconnect Zoho Campaigns in Mail Settings.', { status: 409, code: 'ZOHO_REAUTH_REQUIRED', reauth: true });
  }
  return { accessToken: data.access_token, expiresIn: Number(data.expires_in) || 3600 };
}

/**
 * One console line per Zoho send step (create, send, review): what Zoho answered, for the server log
 * (pm2 logs). Only ids, codes, statuses and Zoho's message: never tokens, addresses or content.
 */
const LOGGED = new Set(['createCampaign', 'sendcampaign', 'reviewandlaunch']);
function logZoho(endpoint, info) {
  if (!LOGGED.has(endpoint) || process.env.ZOHO_LOG === 'off') return;
  const pick = Object.entries(info).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${JSON.stringify(String(v).slice(0, 200))}`);
  console.log(`[zoho] ${new Date().toISOString()} ${endpoint} ${pick.join(' ')}`);
}

const isSuccess = d => d && (String(d.status).toLowerCase() === 'success' || ['0', '200', '3023', '6201'].includes(String(d.code)));

/**
 * Calls an allowed Campaigns endpoint. A structured Zoho error is a known outcome ("not done");
 * a timeout, dropped connection, 5xx or unreadable reply is unknown for sendcampaign.
 */
async function call(dc, accessToken, endpoint, params = {}) {
  const isSend = WRITE_ENDPOINTS.has(endpoint);
  if (!isSend && !READ_ENDPOINTS.has(endpoint) && !SYNC_ENDPOINTS.has(endpoint) && !LIST_DELETE_ENDPOINTS.has(endpoint)) throw new Error(`Zoho endpoint "${endpoint}" is not allowed.`);
  if (LIST_DELETE_ENDPOINTS.has(endpoint) && params.deletecontacts !== 'off') throw new Error('Deleting contacts in Zoho is not allowed.');
  const query = new URLSearchParams({ resfmt: 'JSON', ...params });
  const usePost = isSend || READ_POST_ENDPOINTS.has(endpoint) || SYNC_ENDPOINTS.has(endpoint);
  const url = `${dc.campaigns}/api/v1.1/${endpoint}${usePost ? '' : `?${query}`}`;
  let res;
  try {
    res = await fetch(url, {
      method: usePost ? 'POST' : 'GET',
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, ...(usePost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: usePost ? query.toString() : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    logZoho(endpoint, { result: 'no-reply', error: code || err?.name, campaignkey: params.campaignkey });
    if (!isSend || NOT_CONNECTED_CODES.has(code)) throw zohoError('Zoho Campaigns could not be reached. Try again later.', { code: 'ZOHO_UNREACHABLE' });
    throw zohoError(`Zoho did not confirm the ${endpoint} request (timeout or dropped connection). It may or may not have been carried out.`, { code: 'ZOHO_OUTCOME_UNKNOWN', outcomeUnknown: true });
  }
  const data = await res.json().catch(() => null);
  logZoho(endpoint, {
    http: res.status, ok: isSuccess(data), code: data?.code, message: data?.message || data?.error,
    campaignkey: params.campaignkey || data?.campaignKey, campaignId: data?.campaignId || data?.campaign_id, status: data?.campaign_status
  });
  if (res.status === 401 || ['401', '1007'].includes(String(data?.code))) {
    throw zohoError('Zoho rejected the access token.', { status: 409, code: 'ZOHO_UNAUTHORIZED', providerCode: data?.code || '401', reauth: true });
  }
  if (res.status >= 500 || !data) {
    if (isSend) throw zohoError(`Zoho returned HTTP ${res.status} for the ${endpoint} request. It may or may not have been carried out.`, { code: 'ZOHO_OUTCOME_UNKNOWN', outcomeUnknown: true });
    throw zohoError(`Zoho Campaigns returned an error (HTTP ${res.status}).`, { code: 'ZOHO_BAD_RESPONSE' });
  }
  if (!isSuccess(data)) {
    const message = String(data.message || data.error || 'Zoho returned an error').slice(0, 300);
    throw zohoError(`Zoho: ${message}`, { status: res.status === 429 ? 429 : 400, code: 'ZOHO_API_ERROR', providerCode: data.code != null ? String(data.code) : null });
  }
  return data;
}

/**
 * Accounts moved to Zoho's newer platform review every campaign before it goes out, and the v1.1
 * sendcampaign cannot hand a campaign to that review (it answers 6611 "Content not reviewed").
 * The v2.1 reviewandlaunch does: Zoho reviews it, then sends it by itself. Not in Zoho's public API
 * docs (taken from Zoho support's guidance to another integration), so any failure here only means
 * "not handed over": the campaign keeps waiting and the person is told to press Send in Zoho.
 */
const LAUNCHED_STATUSES = new Set(['contenttobereviewed', 'underreview', 'scheduled', 'sendingshortly', 'sending', 'inprogress', 'sent']);
async function reviewAndLaunch(dc, accessToken, campaignId) {
  if (!/^\d{5,25}$/.test(String(campaignId || ''))) throw zohoError('No Zoho campaign id to hand over for review.', { status: 400, code: 'ZOHO_NO_CAMPAIGN_ID' });
  if (!dc.ma) throw zohoError('Zoho review is not available in this region.', { status: 400, code: 'ZOHO_NO_REVIEW_API' });
  let res;
  try {
    res = await fetch(`${dc.ma}/api/v2.1/campaigns/${campaignId}/reviewandlaunch?send_mode=sendnow&schedule_type=sendnow`, {
      method: 'PUT',
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    logZoho('reviewandlaunch', { result: 'no-reply', error: err?.cause?.code || err?.name, campaignId });
    throw zohoError('Zoho did not confirm handing the campaign over for review.', { code: 'ZOHO_OUTCOME_UNKNOWN', outcomeUnknown: true });
  }
  const data = await res.json().catch(() => null);
  logZoho('reviewandlaunch', { http: res.status, campaignId, status_code: data?.status_code, code: data?.code, message: data?.message || data?.error, status: data?.campaign_details?.status || data?.campaign_status });
  if (res.status === 401) throw zohoError('Zoho rejected the access token.', { status: 409, code: 'ZOHO_UNAUTHORIZED', providerCode: '401' });
  const status = String(data?.campaign_details?.status || data?.campaign_status || '');
  const norm = status.toLowerCase().replace(/[^a-z]/g, '');
  if (res.ok && data && (LAUNCHED_STATUSES.has(norm) || String(data.status_code) === '200')) return { status: status || 'ContentToBeReviewed', data };
  const message = String(data?.message || data?.error || `HTTP ${res.status}`).slice(0, 300);
  throw zohoError(`Zoho: ${message}`, { status: 400, code: 'ZOHO_API_ERROR', providerCode: data?.code != null ? String(data.code) : String(res.status) });
}

module.exports = {
  reviewAndLaunch,
  DATA_CENTERS,
  SCOPES,
  CONTACT_DELETE_SCOPE,
  DELIVERY_SCOPES,
  CONTACT_SYNC_SCOPE,
  CONTACT_UPDATE_SCOPE,
  clientConfig,
  redirectUri,
  resolveDataCenter,
  authorizeUrl,
  exchangeCode,
  refreshAccessToken,
  call,
  zohoError
};
