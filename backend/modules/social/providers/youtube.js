/**
 * YouTube Data API v3 adapter (Google OAuth 2.0 with PKCE).
 * Docs: https://developers.google.com/youtube/v3 , https://developers.google.com/identity/protocols/oauth2/web-server
 * Supports resumable video upload (videos.insert), per-video statistics, channel statistics
 * and comments. Videos uploaded through an API project that Google has not audited are locked
 * to private viewing by YouTube regardless of the requested privacy.
 */
const { ProviderError, providerRequest } = require('./http');
const { openBlob } = require('./media');

const UPLOAD_TIMEOUT_MS = 60 * 60 * 1000;

const API = 'https://www.googleapis.com/youtube/v3';

/** Seconds until the next midnight Pacific Time, when the YouTube Data API daily quota resets. */
function secondsUntilQuotaReset(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, parseInt(p.value, 10)]));
  const elapsed = parts.hour * 3600 + parts.minute * 60 + parts.second;
  return 24 * 3600 - elapsed + 120;
}

function classifyGoogle(status, body) {
  const e = body?.error || {};
  const reason = e.errors?.[0]?.reason || e.status || '';
  const msg = e.message ? `YouTube: ${e.message}` : `YouTube returned HTTP ${status}`;
  if (/^(quotaExceeded|dailyLimitExceeded)$/.test(reason)) {
    return { message: `${msg} The project's daily YouTube API quota is used up; it resets at midnight Pacific Time, and the upload will be retried after that.`, code: 'RATE_LIMITED', retryable: true, retryAfterSec: secondsUntilQuotaReset() };
  }
  if (reason === 'uploadLimitExceeded') {
    return { message: `${msg} The channel reached YouTube's upload limit; the upload will be retried after the daily reset (midnight Pacific Time).`, code: 'RATE_LIMITED', retryable: true, retryAfterSec: secondsUntilQuotaReset() };
  }
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

/** YouTube may keep an upload private (API projects that Google has not audited); say so. */
function privacyNote(requested, actual) {
  if (!actual || actual === requested) return null;
  return `YouTube set this video to ${actual} (you asked for ${requested}). Uploads from API projects that Google has not audited stay private until the project passes its audit.`;
}

const youtube = {
  key: 'youtube',
  _secondsUntilQuotaReset: secondsUntilQuotaReset,
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

  async publish(account, secret, { text, title, media = [], hashtags = [], options = {} }) {
    const video = media.find(m => m.kind === 'video');
    if (!video || !video.filePath) throw new ProviderError({ message: 'YouTube needs one uploaded video file.', code: 'INVALID_REQUEST' });
    const yt = options.youtube || {};
    const metadata = {
      snippet: {
        title: String(title || '').slice(0, 100),
        description: text || '',
        tags: hashtags.map(h => String(h).replace(/^#/, '')).filter(Boolean).slice(0, 30),
        categoryId: '22'
      },
      status: {
        privacyStatus: ['public', 'unlisted', 'private'].includes(yt.privacyStatus) ? yt.privacyStatus : 'public',
        selfDeclaredMadeForKids: yt.madeForKids === true
      }
    };
    // Starting a resumable session creates nothing on the channel.
    const session = await providerRequest('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      json: metadata,
      headers: {
        Authorization: `Bearer ${secret.access_token}`,
        'X-Upload-Content-Length': String(video.sizeBytes),
        'X-Upload-Content-Type': video.mime || 'video/*'
      },
      classify: classifyGoogle,
      label: 'YouTube',
      sent: false
    });
    const location = session.headers.get('location');
    let host = null;
    try { host = new URL(location).hostname; } catch (e) { host = null; }
    if (host !== 'www.googleapis.com') {
      throw new ProviderError({ message: 'YouTube did not return a valid upload session.', code: 'PROVIDER_ERROR', retryable: true });
    }
    // Uploading the bytes creates the video, so a failure here has an unknown outcome.
    const uploaded = await providerRequest(location, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${secret.access_token}`, 'Content-Type': video.mime || 'video/*' },
      body: await openBlob(video),
      classify: classifyGoogle,
      label: 'YouTube upload',
      timeoutMs: UPLOAD_TIMEOUT_MS
    });
    const id = uploaded.body?.id;
    if (!id) throw new ProviderError({ message: 'YouTube accepted the upload but returned no video id.', code: 'PROVIDER_ERROR', outcomeUnknown: true });
    const st = uploaded.body?.status || {};
    const requested = metadata.status.privacyStatus;
    const raw = { id, requestedPrivacy: requested, privacyStatus: st.privacyStatus || null, uploadStatus: st.uploadStatus || null };
    const note = privacyNote(requested, st.privacyStatus);
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    if (st.uploadStatus === 'failed' || st.uploadStatus === 'rejected') {
      // Not live; the failed upload stays in YouTube Studio for the channel owner to delete.
      throw new ProviderError({ message: `YouTube ${st.uploadStatus} the upload (${st.failureReason || st.rejectionReason || 'no reason given'}); video ${id} is not live. Delete it in YouTube Studio before retrying.`, code: 'INVALID_REQUEST' });
    }
    if (st.uploadStatus === 'processed') return { externalId: String(id), url, raw, note };
    // "uploaded" (or not reported): YouTube is still processing the video.
    return { externalId: String(id), url, raw, note: note || 'Uploaded to YouTube; waiting for YouTube to finish processing.', processing: true };
  },

  /** Follow-up check of an upload that YouTube was still processing. */
  async checkProcessing(account, secret, externalId) {
    const body = await api(`/videos?part=status,processingDetails&id=${encodeURIComponent(externalId)}`, secret.access_token);
    const v = body.items?.[0];
    if (!v) return { state: 'failed', reason: 'the video is no longer on the channel (deleted?)' };
    const st = v.status || {};
    if (st.uploadStatus === 'processed') return { state: 'ready', note: st.privacyStatus && st.privacyStatus !== 'public' ? `Live on YouTube as ${st.privacyStatus}.` : null };
    if (st.uploadStatus === 'failed') return { state: 'failed', reason: `failed: ${st.failureReason || 'unknown'}` };
    if (st.uploadStatus === 'rejected') return { state: 'failed', reason: `rejected: ${st.rejectionReason || 'unknown'}` };
    if (st.uploadStatus === 'deleted') return { state: 'failed', reason: 'deleted' };
    return { state: 'processing' };
  },

  async fetchPostMetrics(account, secret, externalId) {
    const body = await api(`/videos?part=statistics&id=${encodeURIComponent(externalId)}`, secret.access_token);
    const st = body.items?.[0]?.statistics;
    const metric = (key, field, reason) => (st && st[field] !== undefined
      ? { metric_key: key, value: Number(st[field]), availability: 'available', period: 'lifetime' }
      : { metric_key: key, value: null, availability: 'unavailable', reason: st ? reason : 'The video was not found or is not visible to this channel.' });
    return [
      metric('views', 'viewCount', 'Views not returned.'),
      metric('likes', 'likeCount', 'The channel hides like counts for this video.'),
      metric('comments', 'commentCount', 'Comments are disabled or hidden for this video.'),
      { metric_key: 'avg_watch_time', value: null, availability: 'unavailable', reason: 'Watch time needs the YouTube Analytics API (yt-analytics.readonly scope), which this integration does not request.' }
    ];
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
