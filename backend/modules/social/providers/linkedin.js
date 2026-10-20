/**
 * LinkedIn Pages adapter (Community Management API, versioned REST endpoints).
 * Docs: https://learn.microsoft.com/linkedin/marketing/community-management/
 * Requires an approved LinkedIn app with the Community Management API product.
 */
const { ProviderError, providerRequest } = require('./http');

const API = 'https://api.linkedin.com/rest';
const OAUTH = 'https://www.linkedin.com/oauth/v2';

function apiVersion() {
  return process.env.LINKEDIN_API_VERSION || '202606';
}

function classifyLinkedIn(status, body) {
  const msg = body?.message ? `LinkedIn: ${body.message}` : `LinkedIn returned HTTP ${status}`;
  if (status === 401) return { message: msg, code: 'AUTH_EXPIRED', retryable: false };
  if (status === 403) return { message: msg, code: 'PERMISSION_DENIED', retryable: false };
  if (status === 404) return { message: msg, code: 'NOT_FOUND', retryable: false };
  if (status === 426) return { message: `${msg} (check LINKEDIN_API_VERSION=${apiVersion()})`, code: 'INVALID_REQUEST', retryable: false };
  if (status === 429) return { message: msg, code: 'RATE_LIMITED', retryable: true, retryAfterSec: 3600 };
  if (status >= 500) return { message: msg, code: 'PROVIDER_ERROR', retryable: true };
  return { message: msg, code: 'INVALID_REQUEST', retryable: false };
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'LinkedIn-Version': apiVersion(),
    'X-Restli-Protocol-Version': '2.0.0'
  };
}

function rest(path, token, opts = {}) {
  return providerRequest(`${API}${path}`, { classify: classifyLinkedIn, label: 'LinkedIn', ...opts, headers: { ...headers(token), ...(opts.headers || {}) } });
}

const enc = encodeURIComponent;

function expiresAt(seconds) {
  return seconds ? new Date(Date.now() + Number(seconds) * 1000) : null;
}

const envApp = () => ({ clientId: process.env.LINKEDIN_CLIENT_ID, clientSecret: process.env.LINKEDIN_CLIENT_SECRET });

function orgUrn(account) {
  return `urn:li:organization:${account.external_account_id}`;
}

const linkedin = {
  key: 'linkedin',

  buildAuthorizeUrl({ state, redirectUri, scopes, app = envApp() }) {
    return `${OAUTH}/authorization?${new URLSearchParams({
      response_type: 'code',
      client_id: app.clientId,
      redirect_uri: redirectUri,
      state,
      scope: scopes.join(' ')
    })}`;
  },

  async _token(form, app = envApp()) {
    const res = await providerRequest(`${OAUTH}/accessToken`, {
      method: 'POST',
      form: { ...form, client_id: app.clientId, client_secret: app.clientSecret },
      classify: classifyLinkedIn,
      label: 'LinkedIn OAuth'
    });
    return res.body;
  },

  async exchangeCode({ code, redirectUri, app = envApp() }) {
    const tok = await linkedin._token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, app);
    const scopes = String(tok.scope || '').split(/[\s,]+/).filter(Boolean);
    const secret = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || null,
      access_expires_at: expiresAt(tok.expires_in)?.toISOString() || null,
      refresh_expires_at: expiresAt(tok.refresh_token_expires_in)?.toISOString() || null
    };

    const acls = await rest('/organizationAcls?q=roleAssignee&state=APPROVED&count=100', tok.access_token);
    const roleByOrg = new Map();
    for (const el of acls.body?.elements || []) {
      const id = String(el.organization || el.organizationTarget || '').split(':').pop();
      if (id) roleByOrg.set(id, [...(roleByOrg.get(id) || []), el.role]);
    }

    const accounts = [];
    for (const [orgId, roles] of roleByOrg) {
      let org = {};
      try {
        org = (await rest(`/organizations/${orgId}`, tok.access_token)).body || {};
      } catch (e) {
        if (e.code === 'AUTH_EXPIRED') throw e;
      }
      accounts.push({
        account_type: 'linkedin_organization',
        external_account_id: orgId,
        display_name: org.localizedName || `LinkedIn organization ${orgId}`,
        username: org.vanityName || null,
        avatar_url: null,
        profile_url: org.vanityName ? `https://www.linkedin.com/company/${org.vanityName}/` : null,
        scopes,
        secret,
        token_expires_at: secret.access_expires_at ? new Date(secret.access_expires_at) : null,
        metadata: { roles }
      });
    }
    return { accounts };
  },

  async refresh(secret, app = envApp()) {
    if (!secret.refresh_token) {
      throw new ProviderError({ message: 'This LinkedIn app is not enabled for refresh tokens; reconnect the account before the token expires.', code: 'NOT_SUPPORTED' });
    }
    const tok = await linkedin._token({ grant_type: 'refresh_token', refresh_token: secret.refresh_token }, app);
    return {
      ...secret,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || secret.refresh_token,
      access_expires_at: expiresAt(tok.expires_in)?.toISOString() || null,
      refresh_expires_at: expiresAt(tok.refresh_token_expires_in)?.toISOString() || secret.refresh_expires_at
    };
  },

  async checkHealth(account, secret) {
    await rest(`/organizations/${account.external_account_id}`, secret.access_token);
    return { ok: true, detail: 'Token valid' };
  },

  async revoke(account, secret, app = envApp()) {
    await providerRequest(`${OAUTH}/revoke`, {
      method: 'POST',
      form: { client_id: app.clientId, client_secret: app.clientSecret, token: secret.access_token },
      classify: classifyLinkedIn,
      label: 'LinkedIn OAuth'
    });
  },

  async publish(account, secret, { text, linkUrl, title }) {
    const body = {
      author: orgUrn(account),
      commentary: text || '',
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false
    };
    if (linkUrl) body.content = { article: { source: linkUrl, title: (title || linkUrl).slice(0, 200) } };
    const res = await rest('/posts', secret.access_token, { method: 'POST', json: body });
    const urn = res.headers.get('x-restli-id') || res.body?.id;
    if (!urn) {
      throw new ProviderError({ message: 'LinkedIn accepted the request but returned no post id.', code: 'PROVIDER_ERROR', outcomeUnknown: true });
    }
    return { externalId: urn, url: `https://www.linkedin.com/feed/update/${urn}/`, raw: { id: urn } };
  },

  async fetchPostMetrics(account, secret, externalId) {
    const param = externalId.startsWith('urn:li:ugcPost:') ? 'ugcPosts' : 'shares';
    const res = await rest(
      `/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${enc(orgUrn(account))}&${param}=List(${enc(externalId)})`,
      secret.access_token
    );
    const stats = res.body?.elements?.[0]?.totalShareStatistics;
    const map = { impressions: 'impressionCount', reach: 'uniqueImpressionsCount', clicks: 'clickCount', likes: 'likeCount', comments: 'commentCount', shares: 'shareCount' };
    return Object.entries(map).map(([key, field]) => (
      stats && typeof stats[field] === 'number'
        ? { metric_key: key, value: stats[field], availability: 'available', period: 'lifetime' }
        : { metric_key: key, value: null, availability: 'unavailable', reason: 'LinkedIn did not return this statistic.' }
    ));
  },

  async fetchAccountMetrics(account, secret) {
    const res = await rest(`/networkSizes/${enc(orgUrn(account))}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`, secret.access_token);
    const v = res.body?.firstDegreeSize;
    return [{ metric_key: 'followers', value: typeof v === 'number' ? v : null, availability: typeof v === 'number' ? 'available' : 'unavailable', reason: typeof v === 'number' ? null : 'Follower count not returned.' }];
  },

  async listComments(account, secret, { externalObjectIds = [] }) {
    const threads = [];
    for (const postUrn of externalObjectIds.slice(0, 25)) {
      const res = await rest(`/socialActions/${enc(postUrn)}/comments?count=50`, secret.access_token);
      for (const c of res.body?.elements || []) {
        const commentUrn = c.$URN || c.commentUrn || (c.id ? `urn:li:comment:(${postUrn},${c.id})` : null);
        if (!commentUrn || c.parentComment) continue;
        threads.push({
          externalThreadId: commentUrn,
          externalObjectId: postUrn,
          authorName: c.actor === orgUrn(account) ? account.display_name : 'LinkedIn member',
          authorId: c.actor || null,
          text: c.message?.text || '',
          createdAt: c.created?.time ? new Date(c.created.time).toISOString() : null,
          replies: []
        });
      }
    }
    return threads;
  },

  async replyToComment(account, secret, externalThreadId, text, { externalObjectId } = {}) {
    const res = await rest(`/socialActions/${enc(externalThreadId)}/comments`, secret.access_token, {
      method: 'POST',
      json: { actor: orgUrn(account), object: externalObjectId, parentComment: externalThreadId, message: { text } }
    });
    return { externalId: res.headers.get('x-restli-id') || res.body?.$URN || res.body?.id || null };
  }
};

module.exports = linkedin;
