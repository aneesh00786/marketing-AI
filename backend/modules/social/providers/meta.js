/**
 * Meta Graph API adapter: Facebook Pages + Instagram Professional accounts.
 * Docs: https://developers.facebook.com/docs/graph-api , /docs/pages-api , /docs/instagram-platform
 *
 * Connection model: one Facebook Login grant (long-lived user token) yields Page access
 * tokens; Instagram Professional accounts linked to a Page are operated with that Page token.
 */
const crypto = require('crypto');
const { ProviderError, providerRequest } = require('./http');
const { openBlob } = require('./media');

const GRAPH_VERSION = () => process.env.META_GRAPH_VERSION || 'v23.0';
const GRAPH = () => `https://graph.facebook.com/${GRAPH_VERSION()}`;

function classifyMeta(status, body) {
  const e = body?.error || {};
  const code = Number(e.code);
  const base = { message: e.message ? `Meta: ${e.message}` : `Meta returned HTTP ${status}`, providerCode: e.code ? String(e.code) : null };
  if (code === 190 || code === 102) return { ...base, code: 'AUTH_EXPIRED', retryable: false };
  if (code === 10 || (code >= 200 && code <= 299)) return { ...base, code: 'PERMISSION_DENIED', retryable: false };
  if ([4, 9, 17, 32, 613].includes(code) || (code >= 80001 && code <= 80014)) return { ...base, code: 'RATE_LIMITED', retryable: true, retryAfterSec: 900 };
  if (code === 100 && status === 404) return { ...base, code: 'NOT_FOUND', retryable: false };
  if (e.is_transient || code === 1 || code === 2 || status >= 500) return { ...base, code: 'PROVIDER_ERROR', retryable: true };
  return { ...base, code: 'INVALID_REQUEST', retryable: false };
}

function graph(path, opts = {}) {
  return providerRequest(`${GRAPH()}${path}`, { classify: classifyMeta, label: 'Meta', ...opts }).then(r => r.body);
}

const GRAPH_VIDEO = () => `https://graph-video.facebook.com/${GRAPH_VERSION()}`;
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

function graphVideo(path, opts = {}) {
  return providerRequest(`${GRAPH_VIDEO()}${path}`, { classify: classifyMeta, label: 'Meta', ...opts }).then(r => r.body);
}

/** Runs a step that cannot have published anything: a failure is never an unknown outcome. */
async function safeStep(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderError) err.outcomeUnknown = false;
    throw err;
  }
}

async function uploadPhoto(page, token, img, fields) {
  if (img.filePath) {
    const fd = new FormData();
    fd.append('access_token', token);
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('source', await openBlob(img), 'image');
    return graph(`/${page}/photos`, { method: 'POST', multipart: fd, timeoutMs: 5 * 60 * 1000, sent: fields.published !== 'false' });
  }
  return graph(`/${page}/photos`, { method: 'POST', form: { url: img.url, ...fields, access_token: token }, sent: fields.published !== 'false' });
}

async function createContainer(ig, token, form) {
  return safeStep(() => graph(`/${ig}/media`, { method: 'POST', form: { ...form, access_token: token }, sent: false }));
}

/** Waits until Instagram has fetched and processed a container; videos take longer. */
async function waitForContainer(id, token, isVideo) {
  const attempts = isVideo ? meta._videoPollAttempts : 6;
  const delay = isVideo ? meta._videoPollDelayMs : meta._pollDelayMs;
  for (let i = 0; i < attempts; i++) {
    const st = await graph(`/${id}?${qs({ fields: 'status_code', access_token: token })}`);
    if (st.status_code === 'FINISHED') return;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') {
      throw new ProviderError({ message: `Instagram could not process the media (${st.status_code}). Check the file meets Instagram's requirements.`, code: 'INVALID_REQUEST' });
    }
    await new Promise(r => setTimeout(r, delay));
  }
  // Nothing was published (media_publish was not called); a later attempt creates a fresh container.
  throw new ProviderError({ message: `Instagram is still processing the ${isVideo ? 'video' : 'image'}.`, code: 'PROVIDER_ERROR', retryable: true, retryAfterSec: isVideo ? 300 : 120 });
}

/**
 * Facebook Video processing state from the Video node's "status" field:
 * video_status "ready" = live; "error"/"expired" (or a processing_phase error) = failed; else processing.
 */
async function fbVideoState(videoId, token) {
  const body = await graph(`/${videoId}?${qs({ fields: 'status', access_token: token })}`);
  const st = body.status || {};
  if (st.video_status === 'ready') return { state: 'ready' };
  if (['error', 'expired'].includes(st.video_status) || st.processing_phase?.status === 'error') {
    return { state: 'failed', reason: st.processing_phase?.errors?.[0]?.message || `video status ${st.video_status || 'error'}` };
  }
  return { state: 'processing' };
}

async function fbPermalink(postId, token) {
  try {
    const p = await graph(`/${postId}?${qs({ fields: 'permalink_url', access_token: token })}`);
    return p.permalink_url ? (String(p.permalink_url).startsWith('/') ? `https://www.facebook.com${p.permalink_url}` : p.permalink_url) : null;
  } catch (e) {
    return null;
  }
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

  /**
   * Facebook Page: text/link posts (/feed), one photo (/photos), several photos (each uploaded
   * unpublished, then one /feed post with attached_media), one video (/videos on graph-video).
   * Instagram: one image, one Reel, or a carousel (2-10 items) through media containers.
   * Uploads and containers are invisible until the final call, so only that call can have an
   * unknown outcome; earlier failures are always safe to retry.
   */
  async publish(account, secret, { text, title, linkUrl, media, imageUrls = [], videoUrls = [] }) {
    const token = secret.access_token;
    const items = media && media.length
      ? media
      : [...imageUrls.map(url => ({ kind: 'image', url })), ...videoUrls.map(url => ({ kind: 'video', url }))];
    const images = items.filter(m => m.kind === 'image');
    const videos = items.filter(m => m.kind === 'video');

    if (account.account_type === 'facebook_page') {
      const page = account.external_account_id;
      let created;
      if (videos.length) {
        const v = videos[0];
        if (!v.filePath) throw new ProviderError({ message: 'Facebook video publishing needs an uploaded file.', code: 'INVALID_REQUEST' });
        const fd = new FormData();
        fd.append('access_token', token);
        fd.append('description', text || '');
        if (title) fd.append('title', String(title).slice(0, 255));
        fd.append('source', await openBlob(v), 'video');
        created = await graphVideo(`/${page}/videos`, { method: 'POST', multipart: fd, timeoutMs: UPLOAD_TIMEOUT_MS });
        // An accepted upload is not yet a live video: check processing before reporting it published.
        let state = { state: 'processing' };
        for (let i = 0; i < meta._videoStatusPolls; i++) {
          try { state = await fbVideoState(created.id, token); } catch (e) { state = { state: 'processing' }; }
          if (state.state !== 'processing') break;
          await new Promise(r => setTimeout(r, meta._videoPollDelayMs));
        }
        if (state.state === 'failed') {
          throw new ProviderError({ message: `Facebook could not process the video (${state.reason}); it is not live.`, code: 'INVALID_REQUEST', retryable: false });
        }
        const url = await fbPermalink(created.id, token);
        if (state.state === 'processing') {
          return { externalId: String(created.id), url, raw: created, processing: true, note: 'Uploaded to Facebook; waiting for Facebook to finish processing the video.' };
        }
        return { externalId: String(created.id), url, raw: created };
      } else if (images.length > 1) {
        const ids = [];
        for (const img of images) {
          const photo = await safeStep(() => uploadPhoto(page, token, img, { published: 'false' }));
          ids.push(String(photo.id));
        }
        const form = { message: text || '', access_token: token };
        ids.forEach((id, i) => { form[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
        created = await graph(`/${page}/feed`, { method: 'POST', form });
      } else if (images.length === 1) {
        created = await uploadPhoto(page, token, images[0], { published: 'true', caption: text || '' });
      } else {
        created = await graph(`/${page}/feed`, {
          method: 'POST',
          form: { message: text || '', ...(linkUrl ? { link: linkUrl } : {}), access_token: token }
        });
      }
      const postId = created.post_id || created.id;
      return { externalId: String(postId), url: await fbPermalink(postId, token), raw: created };
    }

    if (account.account_type === 'instagram_business') {
      const ig = account.external_account_id;
      if (items.length === 0) {
        throw new ProviderError({ message: 'Instagram requires an image or video.', code: 'INVALID_REQUEST' });
      }
      const containerFor = (m, extra) => (m.kind === 'video'
        ? { media_type: extra.carousel ? 'VIDEO' : 'REELS', video_url: m.url, ...(extra.carousel ? {} : { share_to_feed: 'true', ...(m.thumbnailUrl ? { cover_url: m.thumbnailUrl } : {}) }) }
        : { image_url: m.url });
      let containerId;
      const raw = {};
      if (items.length === 1) {
        const c = await createContainer(ig, token, { ...containerFor(items[0], {}), caption: text || '' });
        await waitForContainer(c.id, token, items[0].kind === 'video');
        containerId = c.id;
        raw.container = c;
      } else {
        const children = [];
        for (const m of items) {
          const c = await createContainer(ig, token, { ...containerFor(m, { carousel: true }), is_carousel_item: 'true' });
          await waitForContainer(c.id, token, m.kind === 'video');
          children.push(c.id);
        }
        const parent = await createContainer(ig, token, { media_type: 'CAROUSEL', children: children.join(','), caption: text || '' });
        await waitForContainer(parent.id, token, false);
        containerId = parent.id;
        raw.children = children;
        raw.container = parent;
      }
      const published = await graph(`/${ig}/media_publish`, {
        method: 'POST',
        form: { creation_id: containerId, access_token: token }
      });
      raw.published = published;
      let url = null;
      try {
        const m = await graph(`/${published.id}?${qs({ fields: 'permalink', access_token: token })}`);
        url = m.permalink || null;
      } catch (e) { /* optional */ }
      return { externalId: String(published.id), url, raw };
    }
    throw new ProviderError({ message: `Unsupported Meta account type ${account.account_type}`, code: 'NOT_SUPPORTED' });
  },

  /** Follow-up check for uploads reported as processing (Facebook videos). */
  async checkProcessing(account, secret, externalId) {
    if (account.account_type !== 'facebook_page') return { state: 'ready' };
    const state = await fbVideoState(externalId, secret.access_token);
    if (state.state === 'ready') state.url = await fbPermalink(externalId, secret.access_token);
    return state;
  },

  _pollDelayMs: 2000,
  _videoStatusPolls: 6,
  _videoPollAttempts: 36,
  _videoPollDelayMs: 5000,

  /** Requests insight metrics one call at a time so one deprecated metric cannot hide the others. */
  async _insights(objectId, token, metricMap, edge = 'insights') {
    const results = [];
    for (const [providerMetric, target] of Object.entries(metricMap)) {
      // A target is a metric key, or { key, scale } for unit conversion (e.g. ms -> s).
      const metricKey = typeof target === 'string' ? target : target.key;
      const scale = typeof target === 'string' ? 1 : target.scale;
      try {
        const body = await graph(`/${objectId}/${edge}?${qs({ metric: providerMetric, access_token: token })}`);
        const entry = (body.data || [])[0];
        const value = entry?.values?.[0]?.value ?? entry?.total_value?.value;
        if (typeof value === 'number') {
          results.push({ metric_key: metricKey, value: Math.round(value * scale * 100) / 100, availability: 'available', period: entry.period || 'lifetime' });
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

  async fetchPostMetrics(account, secret, externalId, { mediaKind = null } = {}) {
    const token = secret.access_token;
    if (account.account_type === 'facebook_page' && mediaKind === 'video') {
      // Video posts are Video objects: engagement edges plus Video Insights.
      const body = await graph(`/${externalId}?${qs({ fields: 'likes.summary(true).limit(0),comments.summary(true).limit(0)', access_token: token })}`);
      const out = [
        { metric_key: 'likes', value: body.likes?.summary?.total_count ?? null, availability: body.likes ? 'available' : 'unavailable', reason: body.likes ? null : 'Likes not returned.' },
        { metric_key: 'comments', value: body.comments?.summary?.total_count ?? null, availability: body.comments ? 'available' : 'unavailable', reason: body.comments ? null : 'Comments not returned.' }
      ];
      out.push(...await meta._insights(externalId, token, {
        total_video_views: 'views',
        total_video_impressions: 'impressions',
        total_video_impressions_unique: 'reach',
        total_video_avg_time_watched: { key: 'avg_watch_time', scale: 0.001 }
      }, 'video_insights'));
      return out;
    }
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
        saved: 'saves',
        ...(mediaKind === 'video' ? { ig_reels_avg_watch_time: { key: 'avg_watch_time', scale: 0.001 } } : {})
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
