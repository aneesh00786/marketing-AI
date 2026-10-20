/**
 * YouTube Data API v3 adapter (Google OAuth 2.0 with PKCE).
 * Docs: https://developers.google.com/youtube/v3 , https://developers.google.com/identity/protocols/oauth2/web-server
 * This release supports channel statistics and comments; video upload is not implemented.
 */
const { ProviderError, providerRequest } = require('./http');

const API = 'https://www.googleapis.com/youtube/v3';

function classifyGoogle(status, body) {
  const e = body?.error || {};
  const reason = e.errors?.[0]?.reason || e.status || '';
  const msg = e.message ? `YouTube: ${e.message}` : `YouTube returned HTTP ${status}`;
  if (status === 401) return { message: msg, code: 'AUTH_EXPIRED', retryable: false };
  if (status === 403 && /quota|rateLimit/i.test(reason)) return { message: msg, code: 'RATE_LIMITED', retryable: true, retryAfterSec: 3600 };
  if (status === 403) return { message: msg, code: 'PERMISSION_DENIED', retryable: false };
  if (status === 404) return { message: msg, code: 'NOT_FOUND', retryable: false };
  if (status === 429) return { message: msg, code: 'RATE_LIMITED', retryable: true };
  if (status >= 500) return { message: msg, code: 'PROVIDER_ERROR', retryable: true };
  if (status === 400 && body?.error === 'invalid_grant') return { message: 'Google: the grant was revoked or expired.', code: 'AUTH_EXPIRED', retryable: false };
  return { message: msg, code: 'INVALID_REQUEST', retryable: false };
}

function api(path, token, opts = {}) {
  return providerRequest(`${API}${path}`, { classify: classifyGoogle, label: 'YouTube', ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } }).then(r => r.body);
}

const envApp = () => ({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET });

async function tokenRequest(form, app = envApp()) {
  const res = await providerRequest('https://oauth2.googleapis.com/token', {
    method: 'POST',
    form: { ...form, client_id: app.clientId, client_secret: app.clientSecret },
    classify: classifyGoogle,
    label: 'Google OAuth'
  });
  return res.body;
}

const youtube = {
  key: 'youtube',
  usesPkce: true,

  buildAuthorizeUrl({ state, redirectUri, scopes, codeChallenge, app = envApp() }) {
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    })}`;
  },

  async exchangeCode({ code, redirectUri, codeVerifier, app = envApp() }) {
    const tok = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier }, app);
    const scopes = String(tok.scope || '').split(' ').filter(Boolean);
    const secret = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || null,
      access_expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null
    };
    const channels = await api('/channels?part=snippet&mine=true', tok.access_token);
    const accounts = (channels.items || []).map(ch => ({
      account_type: 'youtube_channel',
      external_account_id: ch.id,
      display_name: ch.snippet?.title || ch.id,
      username: ch.snippet?.customUrl || null,
      avatar_url: ch.snippet?.thumbnails?.default?.url || null,
      profile_url: `https://www.youtube.com/channel/${ch.id}`,
      scopes,
      secret,
      token_expires_at: secret.access_expires_at ? new Date(secret.access_expires_at) : null,
      metadata: {}
    }));
    return { accounts };
  },

  async refresh(secret, app = envApp()) {
    if (!secret.refresh_token) {
      throw new ProviderError({ message: 'No Google refresh token stored; reconnect the channel.', code: 'NOT_SUPPORTED' });
    }
    const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: secret.refresh_token }, app);
    return {
      ...secret,
      access_token: tok.access_token,
      access_expires_at: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null
    };
  },

  async checkHealth(account, secret) {
    const body = await api(`/channels?part=id&id=${encodeURIComponent(account.external_account_id)}`, secret.access_token);
    return { ok: (body.items || []).length > 0, detail: 'Token valid' };
  },

  async revoke(account, secret) {
    await providerRequest(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(secret.refresh_token || secret.access_token)}`, {
      method: 'POST',
      classify: classifyGoogle,
      label: 'Google OAuth'
    });
  },

  async publish() {
    throw new ProviderError({ message: 'YouTube video publishing is not implemented in this release.', code: 'NOT_SUPPORTED' });
  },

  async fetchPostMetrics() {
    return [];
  },

  async fetchAccountMetrics(account, secret) {
    const body = await api(`/channels?part=statistics&id=${encodeURIComponent(account.external_account_id)}`, secret.access_token);
    const st = body.items?.[0]?.statistics || {};
    const out = [];
    if (st.hiddenSubscriberCount) {
      out.push({ metric_key: 'followers', value: null, availability: 'unavailable', reason: 'The channel hides its subscriber count.' });
    } else {
      out.push({ metric_key: 'followers', value: st.subscriberCount !== undefined ? Number(st.subscriberCount) : null, availability: st.subscriberCount !== undefined ? 'available' : 'unavailable', reason: st.subscriberCount !== undefined ? null : 'Not returned.' });
    }
    out.push({ metric_key: 'views', value: st.viewCount !== undefined ? Number(st.viewCount) : null, availability: st.viewCount !== undefined ? 'available' : 'unavailable', reason: st.viewCount !== undefined ? null : 'Not returned.' });
    return out;
  },

  async listComments(account, secret) {
    const body = await api(`/commentThreads?part=snippet,replies&allThreadsRelatedToChannelId=${encodeURIComponent(account.external_account_id)}&maxResults=50&order=time`, secret.access_token);
    return (body.items || []).map(t => {
      const top = t.snippet?.topLevelComment?.snippet || {};
      return {
        externalThreadId: t.snippet?.topLevelComment?.id || t.id,
        externalObjectId: t.snippet?.videoId || null,
        authorName: top.authorDisplayName || null,
        authorId: top.authorChannelId?.value || null,
        text: top.textOriginal || '',
        createdAt: top.publishedAt || null,
        replies: (t.replies?.comments || []).map(r => ({
          externalMessageId: r.id,
          authorName: r.snippet?.authorDisplayName || null,
          text: r.snippet?.textOriginal || '',
          createdAt: r.snippet?.publishedAt || null,
          fromAccount: r.snippet?.authorChannelId?.value === account.external_account_id
        }))
      };
    });
  },

  async replyToComment(account, secret, externalThreadId, text) {
    const body = await api('/comments?part=snippet', secret.access_token, {
      method: 'POST',
      json: { snippet: { parentId: externalThreadId, textOriginal: text } }
    });
    return { externalId: body.id || null };
  }
};

module.exports = youtube;
