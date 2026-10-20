/**
 * Meta Graph API adapter: Facebook Pages + Instagram Professional accounts.
 * Docs: https://developers.facebook.com/docs/graph-api , /docs/pages-api , /docs/instagram-platform
 *
 * Connection model: one Facebook Login grant (long-lived user token) yields Page access
 * tokens; Instagram Professional accounts linked to a Page are operated with that Page token.
 */
const crypto = require('crypto');
const { ProviderError, providerRequest } = require('./http');

const GRAPH_VERSION = () => process.env.META_GRAPH_VERSION || 'v23.0';
const GRAPH = () => `https://graph.facebook.com/${GRAPH_VERSION()}`;

function classifyMeta(status, body) {
  const e = body?.error || {};
  const code = Number(e.code);
  const base = { message: e.message ? `Meta: ${e.message}` : `Meta returned HTTP ${status}`, providerCode: e.code ? String(e.code) : null };
  if (code === 190 || code === 102) return { ...base, code: 'AUTH_EXPIRED', retryable: false };
  if (code === 10 || (code >= 200 && code <= 299)) return { ...base, code: 'PERMISSION_DENIED', retryable: false };
  if ([4, 17, 32, 613].includes(code) || (code >= 80001 && code <= 80014)) return { ...base, code: 'RATE_LIMITED', retryable: true, retryAfterSec: 900 };
  if (code === 100 && status === 404) return { ...base, code: 'NOT_FOUND', retryable: false };
  if (e.is_transient || code === 1 || code === 2 || status >= 500) return { ...base, code: 'PROVIDER_ERROR', retryable: true };
  return { ...base, code: 'INVALID_REQUEST', retryable: false };
}

function graph(path, opts = {}) {
  return providerRequest(`${GRAPH()}${path}`, { classify: classifyMeta, label: 'Meta', ...opts }).then(r => r.body);
}

const envApp = () => ({ clientId: process.env.META_APP_ID, clientSecret: process.env.META_APP_SECRET });

function qs(params) {
  return new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();
}

const meta = {
  key: 'meta',

  buildAuthorizeUrl({ state, redirectUri, scopes, app = envApp() }) {
    return `https://www.facebook.com/${GRAPH_VERSION()}/dialog/oauth?${qs({
      client_id: app.clientId,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      scope: scopes.join(',')
    })}`;
  },

  async exchangeCode({ code, redirectUri, app = envApp() }) {
    const shortLived = await graph(`/oauth/access_token?${qs({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: redirectUri,
      code
    })}`);
    const longLived = await graph(`/oauth/access_token?${qs({
      grant_type: 'fb_exchange_token',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      fb_exchange_token: shortLived.access_token
    })}`);
    const userToken = longLived.access_token;

    const me = await graph(`/me?${qs({ fields: 'id,name', access_token: userToken })}`);
    const perms = await graph(`/me/permissions?${qs({ access_token: userToken })}`);
    const scopes = (perms.data || []).filter(p => p.status === 'granted').map(p => p.permission);
    const pages = await graph(`/me/accounts?${qs({
      fields: 'id,name,access_token,link,picture{url},instagram_business_account{id,username,name,profile_picture_url}',
      limit: 100,
      access_token: userToken
    })}`);

    const accounts = [];
    for (const page of pages.data || []) {
      const secret = { access_token: page.access_token, user_access_token: userToken, meta_user_id: me.id };
      accounts.push({
        account_type: 'facebook_page',
        external_account_id: String(page.id),
        display_name: page.name,
        username: null,
        avatar_url: page.picture?.data?.url || null,
        profile_url: page.link || `https://www.facebook.com/${page.id}`,
        scopes,
        secret,
        token_expires_at: null,
        metadata: { meta_user_id: me.id }
      });
      const ig = page.instagram_business_account;
      if (ig?.id) {
        accounts.push({
          account_type: 'instagram_business',
          external_account_id: String(ig.id),
          display_name: ig.name || ig.username,
          username: ig.username || null,
          avatar_url: ig.profile_picture_url || null,
          profile_url: ig.username ? `https://www.instagram.com/${ig.username}/` : null,
          scopes,
          secret,
          token_expires_at: null,
          parentExternalId: String(page.id),
          metadata: { meta_user_id: me.id, facebook_page_id: String(page.id) }
        });
      }
    }
    return { accounts, providerUserId: me.id };
  },

  async refresh() {
    // Page tokens obtained from a long-lived user token do not expire; reconnect if revoked.
    throw new ProviderError({ message: 'Meta Page tokens cannot be refreshed; reconnect the account.', code: 'NOT_SUPPORTED' });
  },

  async checkHealth(account, secret) {
    const fields = account.account_type === 'instagram_business' ? 'id,username' : 'id,name';
    const body = await graph(`/${account.external_account_id}?${qs({ fields, access_token: secret.access_token })}`);
    return { ok: !!body.id, detail: 'Token valid' };
  },

  async revoke(account, secret) {
    if (!secret.user_access_token || !secret.meta_user_id) return;
    await graph(`/${secret.meta_user_id}/permissions?${qs({ access_token: secret.user_access_token })}`, { method: 'DELETE' });
  },

  async publish(account, secret, { text, linkUrl, imageUrls = [] }) {
    const token = secret.access_token;
    if (account.account_type === 'facebook_page') {
      let created;
      if (imageUrls.length > 0) {
        created = await graph(`/${account.external_account_id}/photos`, {
          method: 'POST',
          form: { url: imageUrls[0], caption: text || '', published: 'true', access_token: token }
        });
      } else {
        created = await graph(`/${account.external_account_id}/feed`, {
          method: 'POST',
          form: { message: text || '', ...(linkUrl ? { link: linkUrl } : {}), access_token: token }
        });
      }
      const postId = created.post_id || created.id;
      let url = null;
      try {
        const p = await graph(`/${postId}?${qs({ fields: 'permalink_url', access_token: token })}`);
        url = p.permalink_url || null;
      } catch (e) { /* permalink is optional */ }
      return { externalId: String(postId), url, raw: created };
    }

    if (account.account_type === 'instagram_business') {
      if (imageUrls.length === 0) {
        throw new ProviderError({ message: 'Instagram requires an image.', code: 'INVALID_REQUEST' });
      }
      // Creating a media container does not publish anything, so its failures are safe to retry.
      let container;
      try {
        container = await graph(`/${account.external_account_id}/media`, {
          method: 'POST',
          form: { image_url: imageUrls[0], caption: text || '', access_token: token }
        });
      } catch (err) {
        if (err instanceof ProviderError) err.outcomeUnknown = false;
        throw err;
      }
      for (let i = 0; i < 6; i++) {
        const st = await graph(`/${container.id}?${qs({ fields: 'status_code', access_token: token })}`);
        if (st.status_code === 'FINISHED') break;
        if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') {
          throw new ProviderError({ message: `Instagram could not process the media (${st.status_code}).`, code: 'INVALID_REQUEST' });
        }
        await new Promise(r => setTimeout(r, meta._pollDelayMs));
      }
      const published = await graph(`/${account.external_account_id}/media_publish`, {
        method: 'POST',
        form: { creation_id: container.id, access_token: token }
      });
      let url = null;
      try {
        const m = await graph(`/${published.id}?${qs({ fields: 'permalink', access_token: token })}`);
        url = m.permalink || null;
      } catch (e) { /* optional */ }
      return { externalId: String(published.id), url, raw: { container, published } };
    }
    throw new ProviderError({ message: `Unsupported Meta account type ${account.account_type}`, code: 'NOT_SUPPORTED' });
  },

  _pollDelayMs: 2000,

  /** Requests insight metrics one call at a time so one deprecated metric cannot hide the others. */
  async _insights(objectId, token, metricMap) {
    const results = [];
    for (const [providerMetric, metricKey] of Object.entries(metricMap)) {
      try {
        const body = await graph(`/${objectId}/insights?${qs({ metric: providerMetric, access_token: token })}`);
        const entry = (body.data || [])[0];
        const value = entry?.values?.[0]?.value ?? entry?.total_value?.value;
        if (typeof value === 'number') {
          results.push({ metric_key: metricKey, value, availability: 'available', period: entry.period || 'lifetime' });
        } else {
          results.push({ metric_key: metricKey, value: null, availability: 'unavailable', reason: 'Metric not returned by Meta for this post.' });
        }
      } catch (err) {
        if (err.code === 'AUTH_EXPIRED' || err.code === 'RATE_LIMITED') throw err;
        results.push({ metric_key: metricKey, value: null, availability: 'unavailable', reason: err.message.slice(0, 300) });
      }
    }
    return results;
  },

  async fetchPostMetrics(account, secret, externalId) {
    const token = secret.access_token;
    if (account.account_type === 'facebook_page') {
      const out = [];
      const body = await graph(`/${externalId}?${qs({
        fields: 'reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares',
        access_token: token
      })}`);
      out.push({ metric_key: 'likes', value: body.reactions?.summary?.total_count ?? null, availability: body.reactions ? 'available' : 'unavailable', reason: body.reactions ? null : 'Reactions not returned.' });
      out.push({ metric_key: 'comments', value: body.comments?.summary?.total_count ?? null, availability: body.comments ? 'available' : 'unavailable', reason: body.comments ? null : 'Comments not returned.' });
      // Graph omits "shares" when a post has none.
      out.push({ metric_key: 'shares', value: body.shares?.count ?? 0, availability: 'available' });
      out.push(...await meta._insights(externalId, token, {
        post_impressions: 'impressions',
        post_impressions_unique: 'reach',
        post_clicks: 'clicks'
      }));
      return out;
    }
    if (account.account_type === 'instagram_business') {
      return meta._insights(externalId, token, {
        reach: 'reach',
        views: 'views',
        likes: 'likes',
        comments: 'comments',
        shares: 'shares',
        saved: 'saves'
      });
    }
    return [];
  },

  async fetchAccountMetrics(account, secret) {
    const token = secret.access_token;
    const fields = account.account_type === 'instagram_business' ? 'followers_count' : 'followers_count,fan_count';
    const body = await graph(`/${account.external_account_id}?${qs({ fields, access_token: token })}`);
    const followers = body.followers_count ?? body.fan_count;
    return [{
      metric_key: 'followers',
      value: typeof followers === 'number' ? followers : null,
      availability: typeof followers === 'number' ? 'available' : 'unavailable',
      reason: typeof followers === 'number' ? null : 'Follower count not returned.'
    }];
  },

  async listComments(account, secret, { externalObjectIds = [] }) {
    const token = secret.access_token;
    const threads = [];
    for (const objectId of externalObjectIds.slice(0, 25)) {
      if (account.account_type === 'facebook_page') {
        const body = await graph(`/${objectId}/comments?${qs({
          fields: 'id,message,from{id,name},created_time,comments.limit(25){id,message,from{id,name},created_time}',
          order: 'reverse_chronological',
          limit: 50,
          access_token: token
        })}`);
        for (const c of body.data || []) {
          threads.push({
            externalThreadId: String(c.id),
            externalObjectId: String(objectId),
            authorName: c.from?.name || null,
            authorId: c.from?.id || null,
            text: c.message || '',
            createdAt: c.created_time || null,
            replies: (c.comments?.data || []).map(r => ({
              externalMessageId: String(r.id),
              authorName: r.from?.name || null,
              text: r.message || '',
              createdAt: r.created_time || null,
              fromAccount: r.from?.id === account.external_account_id
            }))
          });
        }
      } else if (account.account_type === 'instagram_business') {
        const body = await graph(`/${objectId}/comments?${qs({
          fields: 'id,text,username,timestamp,replies{id,text,username,timestamp}',
          limit: 50,
          access_token: token
        })}`);
        for (const c of body.data || []) {
          threads.push({
            externalThreadId: String(c.id),
            externalObjectId: String(objectId),
            authorName: c.username || null,
            authorId: null,
            text: c.text || '',
            createdAt: c.timestamp || null,
            replies: (c.replies?.data || []).map(r => ({
              externalMessageId: String(r.id),
              authorName: r.username || null,
              text: r.text || '',
              createdAt: r.timestamp || null,
              fromAccount: !!account.username && r.username === account.username
            }))
          });
        }
      }
    }
    return threads;
  },

  async replyToComment(account, secret, externalThreadId, text) {
    const path = account.account_type === 'instagram_business' ? `/${externalThreadId}/replies` : `/${externalThreadId}/comments`;
    const body = await graph(path, { method: 'POST', form: { message: text, access_token: secret.access_token } });
    return { externalId: String(body.id) };
  },

  /** Verifies X-Hub-Signature-256 against the raw body with any of the known app secrets. */
  verifyWebhookSignature(rawBody, signatureHeader, secrets = [process.env.META_APP_SECRET]) {
    if (!rawBody || !signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
    const given = Buffer.from(signatureHeader.slice(7), 'hex');
    return secrets.filter(Boolean).some(secret => {
      const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
      return expected.length === given.length && crypto.timingSafeEqual(expected, given);
    });
  }
};

module.exports = meta;
