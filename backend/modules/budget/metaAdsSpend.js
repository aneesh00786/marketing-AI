const { providerRequest, ProviderError } = require('../social/providers/http');
const accountService = require('../social/accountService');

/**
 * Meta Ads spend through the existing Meta connection (Marketing API Insights).
 * Reads ACTUAL daily spend for one ad account (optionally limited to campaign ids). Requires the
 * connection to have been granted `ads_read`; Marketech.ai's default Meta login does not ask for
 * it, so most connections report "not available" here rather than a number.
 * Docs: https://developers.facebook.com/docs/marketing-api/insights
 */
const GRAPH = () => `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}`;
const REQUIRED_SCOPE = 'ads_read';

function parseScopes(account) {
  try { return JSON.parse(account.scopes_json || '[]'); } catch (e) { return []; }
}

function canReadSpend(account) {
  if (!account || account.provider_key !== 'meta') return { ok: false, reason: 'Spend sync needs a connected Meta account.' };
  if (accountService.isDemoAccount(account)) return { ok: false, reason: 'Demo accounts have no real ad spend.' };
  if (account.status !== 'connected') return { ok: false, reason: 'The Meta account is not connected; reconnect it first.' };
  if (!parseScopes(account).includes(REQUIRED_SCOPE)) return { ok: false, reason: `The Meta connection was not granted "${REQUIRED_SCOPE}", so ad spend cannot be read. Reconnect Meta with ads permission (needs Meta app review).` };
  return { ok: true };
}

const normalizeAdAccount = id => String(id || '').trim().replace(/^act_/, '');

/** Returns [{ date: 'YYYY-MM-DD', amount: Number, currency: 'USD' }] of real reported spend. */
async function fetchDailySpend(account, { adAccountId, campaignIds = [], since, until }) {
  const check = canReadSpend(account);
  if (!check.ok) throw new ProviderError({ message: check.reason, code: 'PERMISSION_DENIED' });
  const secret = await accountService.getUsableSecret(account);
  const token = secret.user_access_token || secret.access_token;
  const act = normalizeAdAccount(adAccountId);
  const params = new URLSearchParams({
    fields: 'spend,account_currency,date_start',
    time_range: JSON.stringify({ since, until }),
    time_increment: '1',
    level: campaignIds.length ? 'campaign' : 'account',
    limit: '500'
  });
  if (campaignIds.length) params.set('filtering', JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campaignIds.map(String) }]));
  let url = `${GRAPH()}/act_${act}/insights?${params}`;
  const byDay = {};
  let currency = null;
  for (let page = 0; url && page < 20; page++) {
    // Token in a header, not the URL, so it never appears in logs.
    const { body } = await providerRequest(url, { label: 'Meta Ads', headers: { Authorization: `Bearer ${token}` } });
    for (const row of body.data || []) {
      if (row.spend === undefined || row.spend === null) continue;
      currency = currency || row.account_currency;
      if (row.account_currency && currency && row.account_currency !== currency) throw new ProviderError({ message: 'Meta returned spend in more than one currency.', code: 'INVALID_REQUEST' });
      byDay[row.date_start] = (byDay[row.date_start] || 0) + Number(row.spend);
    }
    url = body.paging?.next || null;
  }
  return Object.entries(byDay).sort().map(([date, amount]) => ({ date, amount: Math.round(amount * 100) / 100, currency }));
}

module.exports = { canReadSpend, fetchDailySpend, normalizeAdAccount, REQUIRED_SCOPE };
