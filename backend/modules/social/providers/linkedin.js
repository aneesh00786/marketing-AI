/**
 * LinkedIn Pages adapter (Community Management API, versioned REST endpoints).
 * Docs: https://learn.microsoft.com/linkedin/marketing/community-management/
 * Requires an approved LinkedIn app with the Community Management API product.
 */
const { ProviderError, providerRequest } = require('./http');
const { openBlob } = require('./media');

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

const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

/** Upload URLs come from LinkedIn's responses; only https linkedin.com hosts are used. */
function assertUploadUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { u = null; }
  if (!u || u.protocol !== 'https:' || !/(^|\.)linkedin\.com$/i.test(u.hostname)) {
    throw new ProviderError({ message: 'LinkedIn returned an unexpected upload address.', code: 'PROVIDER_ERROR', retryable: false });
  }
}

/** Images API: initialize, then PUT the bytes. Nothing is visible until the post is created. */
async function uploadImage(account, token, m) {
  if (!m.filePath) throw new ProviderError({ message: 'LinkedIn needs the uploaded image file.', code: 'INVALID_REQUEST' });
  const init = await rest('/images?action=initializeUpload', token, { method: 'POST', json: { initializeUploadRequest: { owner: orgUrn(account) } }, sent: false });
  const { uploadUrl, image } = init.body?.value || {};
  if (!uploadUrl || !image) throw new ProviderError({ message: 'LinkedIn did not return an image upload address.', code: 'PROVIDER_ERROR', retryable: true });
  assertUploadUrl(uploadUrl);
  await providerRequest(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': m.mime || 'application/octet-stream' },
    body: await openBlob(m),
    classify: classifyLinkedIn,
    label: 'LinkedIn image upload',
    timeoutMs: UPLOAD_TIMEOUT_MS,
    sent: false
  });
  // The post is created only once LinkedIn reports the image AVAILABLE.
  for (let i = 0; i < linkedin._imagePollAttempts; i++) {
    const st = await rest(`/images/${enc(image)}`, token);
    const status = st.body?.status;
    if (status === 'AVAILABLE') return image;
    if (status === 'PROCESSING_FAILED') throw new ProviderError({ message: 'LinkedIn could not process the image.', code: 'INVALID_REQUEST' });
    await new Promise(r => setTimeout(r, linkedin._imagePollDelayMs));
  }
  // Nothing was posted; a later attempt uploads again.
  throw new ProviderError({ message: 'LinkedIn is still processing the image.', code: 'PROVIDER_ERROR', retryable: true, retryAfterSec: 120 });
}

/** Videos API: initialize, PUT each part, finalize with the part ETags, wait until AVAILABLE. */
async function uploadVideo(account, token, m) {
  if (!m.filePath) throw new ProviderError({ message: 'LinkedIn needs the uploaded video file.', code: 'INVALID_REQUEST' });
  const init = await rest('/videos?action=initializeUpload', token, {
    method: 'POST',
    json: { initializeUploadRequest: { owner: orgUrn(account), fileSizeBytes: Number(m.sizeBytes), uploadCaptions: false, uploadThumbnail: false } },
    sent: false
  });
  const v = init.body?.value || {};
  if (!v.video || !Array.isArray(v.uploadInstructions) || !v.uploadInstructions.length) {
    throw new ProviderError({ message: 'LinkedIn did not return video upload instructions.', code: 'PROVIDER_ERROR', retryable: true });
  }
  const partIds = [];
  for (const part of v.uploadInstructions) {
    assertUploadUrl(part.uploadUrl);
    const res = await providerRequest(part.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await openBlob(m, Number(part.firstByte), Number(part.lastByte) + 1),
      classify: classifyLinkedIn,
      label: 'LinkedIn video upload',
      timeoutMs: UPLOAD_TIMEOUT_MS,
      sent: false
    });
    const etag = res.headers.get('etag');
    if (!etag) throw new ProviderError({ message: 'LinkedIn did not confirm a video part upload.', code: 'PROVIDER_ERROR', retryable: true });
    partIds.push(etag);
  }
  await rest('/videos?action=finalizeUpload', token, {
    method: 'POST',
    json: { finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken || '', uploadedPartIds: partIds } },
    sent: false
  });
  for (let i = 0; i < linkedin._videoPollAttempts; i++) {
    const st = await rest(`/videos/${enc(v.video)}`, token);
    const status = st.body?.status;
    if (status === 'AVAILABLE') return v.video;
    if (status === 'PROCESSING_FAILED') throw new ProviderError({ message: 'LinkedIn could not process the video.', code: 'INVALID_REQUEST' });
    await new Promise(r => setTimeout(r, linkedin._videoPollDelayMs));
  }
  // Nothing was posted; a later attempt uploads again.
  throw new ProviderError({ message: 'LinkedIn is still processing the video.', code: 'PROVIDER_ERROR', retryable: true, retryAfterSec: 300 });
}

const linkedin = {
  key: 'linkedin',
  _videoPollAttempts: 40,
  _imagePollAttempts: 10,
  _imagePollDelayMs: 1000,
  _videoPollDelayMs: 3000,

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

  async publish(account, secret, { text, linkUrl, title, media = [] }) {
    const token = secret.access_token;
    const images = media.filter(m => m.kind === 'image');
    const videos = media.filter(m => m.kind === 'video');
    let content = null;
    if (videos.length) {
      content = { media: { title: String(title || '').slice(0, 200), id: await uploadVideo(account, token, videos[0]) } };
    } else if (images.length === 1) {
      const id = await uploadImage(account, token, images[0]);
      content = { media: { id, ...(images[0].altText ? { altText: String(images[0].altText).slice(0, 4086) } : {}) } };
    } else if (images.length > 1) {
      const list = [];
      for (const img of images) list.push({ id: await uploadImage(account, token, img), ...(img.altText ? { altText: String(img.altText).slice(0, 4086) } : {}) });
      content = { multiImage: { images: list } };
    } else if (linkUrl) {
      content = { article: { source: linkUrl, title: (title || linkUrl).slice(0, 200) } };
    }
    const body = {
      author: orgUrn(account),
      commentary: text || '',
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false
    };
    if (content) body.content = content;
    const res = await rest('/posts', token, { method: 'POST', json: body });
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
