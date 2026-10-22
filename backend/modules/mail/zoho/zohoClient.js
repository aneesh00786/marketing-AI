/**
 * Minimal Zoho Campaigns (API v1.1) client. Zoho is only the delivery backend for campaigns that
 * are written and approved in Marketech.ai. Only these endpoints can be called:
 * - read: mailing lists, topics, recent campaigns, campaign details, campaign reports;
 * - write: createCampaign (the delivery object Zoho needs before sending) and sendcampaign.
 * Contact uploads, list changes and content updates of existing Zoho campaigns are never called.
 *
 * Data centers: Zoho accounts live in regional data centers. The accounts-server comes only from
 * the allowlist below (never from a URL in the request), selected by the "location" Zoho returns.
 * The Campaigns API host follows Zoho's regional domain pattern; only campaigns.zoho.com is shown
 * in the API documentation, so other regions must be confirmed with a test account.
 */
const DATA_CENTERS = {
  us: { accounts: 'https://accounts.zoho.com', campaigns: 'https://campaigns.zoho.com' },
  eu: { accounts: 'https://accounts.zoho.eu', campaigns: 'https://campaigns.zoho.eu' },
  in: { accounts: 'https://accounts.zoho.in', campaigns: 'https://campaigns.zoho.in' },
  au: { accounts: 'https://accounts.zoho.com.au', campaigns: 'https://campaigns.zoho.com.au' },
  jp: { accounts: 'https://accounts.zoho.jp', campaigns: 'https://campaigns.zoho.jp' },
  ca: { accounts: 'https://accounts.zohocloud.ca', campaigns: 'https://campaigns.zohocloud.ca' },
  sa: { accounts: 'https://accounts.zoho.sa', campaigns: 'https://campaigns.zoho.sa' },
  uk: { accounts: 'https://accounts.zoho.uk', campaigns: 'https://campaigns.zoho.uk' }
};

// Documented minimum scopes: campaign.CREATE (createCampaign), campaign.UPDATE (sendcampaign),
// campaign.READ (details, reports, recent campaigns), contact.READ (mailing lists, topics).
const SCOPES = ['ZohoCampaigns.campaign.CREATE', 'ZohoCampaigns.campaign.READ', 'ZohoCampaigns.campaign.UPDATE', 'ZohoCampaigns.contact.READ'];
const READ_ENDPOINTS = new Set(['recentcampaigns', 'getcampaigndetails', 'campaignreports', 'getmailinglists', 'topics']);
// Write calls whose outcome can be unknown after a timeout; never retried automatically.
const WRITE_ENDPOINTS = new Set(['createCampaign', 'sendcampaign']);
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

function authorizeUrl(state) {
  const cfg = clientConfig();
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
async function exchangeCode(dc, code) {
  const cfg = clientConfig();
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
async function refreshAccessToken(dc, refreshToken) {
  const cfg = clientConfig();
  if (!cfg) throw zohoError('Zoho Campaigns is not set up on the server (ZOHO_CAMPAIGNS_CLIENT_ID / ZOHO_CAMPAIGNS_CLIENT_SECRET).', { status: 503, code: 'ZOHO_NOT_CONFIGURED' });
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

const isSuccess = d => d && (String(d.status).toLowerCase() === 'success' || ['0', '200', '3023', '6201'].includes(String(d.code)));

/**
 * Calls an allowed Campaigns endpoint. A structured Zoho error is a known outcome ("not done");
 * a timeout, dropped connection, 5xx or unreadable reply is unknown for sendcampaign.
 */
async function call(dc, accessToken, endpoint, params = {}) {
  const isSend = WRITE_ENDPOINTS.has(endpoint);
  if (!isSend && !READ_ENDPOINTS.has(endpoint)) throw new Error(`Zoho endpoint "${endpoint}" is not allowed.`);
  const query = new URLSearchParams({ resfmt: 'JSON', ...params });
  const url = `${dc.campaigns}/api/v1.1/${endpoint}${isSend ? '' : `?${query}`}`;
  let res;
  try {
    res = await fetch(url, {
      method: isSend ? 'POST' : 'GET',
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, ...(isSend ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: isSend ? query.toString() : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    if (!isSend || NOT_CONNECTED_CODES.has(code)) throw zohoError('Zoho Campaigns could not be reached. Try again later.', { code: 'ZOHO_UNREACHABLE' });
    throw zohoError(`Zoho did not confirm the ${endpoint} request (timeout or dropped connection). It may or may not have been carried out.`, { code: 'ZOHO_OUTCOME_UNKNOWN', outcomeUnknown: true });
  }
  const data = await res.json().catch(() => null);
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

module.exports = {
  DATA_CENTERS,
  SCOPES,
  clientConfig,
  redirectUri,
  resolveDataCenter,
  authorizeUrl,
  exchangeCode,
  refreshAccessToken,
  call,
  zohoError
};
