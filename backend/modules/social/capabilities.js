/**
 * Capability registry: what each provider/account type supports, which OAuth scopes
 * each feature needs, and what this release has actually implemented.
 *
 * Feature status as evaluated for an account:
 *   available               implemented, provider configured and permission granted
 *   missing_permission      implemented but the account did not grant the scope
 *   not_implemented         the provider supports it, this release does not yet
 *   unsupported_by_provider the official API does not offer it
 *   setup_required          provider app credentials are not configured
 */

const FEATURES = [
  'publish_text', 'publish_link', 'publish_image', 'publish_video',
  'analytics_post', 'analytics_account',
  'comments_read', 'comments_reply',
  'messages_read', 'messages_reply'
];

const FEATURE_LABELS = {
  publish_text: 'Publish text posts',
  publish_link: 'Publish link posts',
  publish_image: 'Publish image posts',
  publish_video: 'Publish videos',
  analytics_post: 'Post analytics',
  analytics_account: 'Account analytics (followers)',
  comments_read: 'Read comments',
  comments_reply: 'Reply to comments',
  messages_read: 'Read direct messages',
  messages_reply: 'Reply to direct messages'
};

const impl = (scopes) => ({ implemented: true, scopes });
const todo = (note) => ({ implemented: false, note });
const none = (note) => ({ unsupported: true, note });

const ACCOUNT_TYPES = {
  facebook_page: {
    provider: 'meta',
    platformKey: 'facebook',
    label: 'Facebook Page',
    limits: { captionMax: 63206 },
    features: {
      publish_text: impl(['pages_manage_posts']),
      publish_link: impl(['pages_manage_posts']),
      publish_image: impl(['pages_manage_posts']),
      publish_video: todo('Video upload is planned once the Video Studio produces real video files.'),
      analytics_post: impl(['read_insights', 'pages_read_engagement']),
      analytics_account: impl(['pages_read_engagement']),
      comments_read: impl(['pages_read_engagement', 'pages_read_user_content']),
      comments_reply: impl(['pages_manage_engagement']),
      messages_read: todo('Messenger conversations need pages_messaging and Meta app review.'),
      messages_reply: todo('Messenger replies need pages_messaging and Meta app review.')
    }
  },
  instagram_business: {
    provider: 'meta',
    platformKey: 'instagram',
    label: 'Instagram Professional account',
    limits: { captionMax: 2200, hashtagMax: 30, requiresMedia: true },
    features: {
      publish_text: none('Instagram does not allow text-only posts; attach an image.'),
      publish_link: none('Instagram captions do not support clickable links.'),
      publish_image: impl(['instagram_basic', 'instagram_content_publish']),
      publish_video: todo('Reels publishing is planned once the Video Studio produces real video files.'),
      analytics_post: impl(['instagram_basic', 'instagram_manage_insights']),
      analytics_account: impl(['instagram_basic']),
      comments_read: impl(['instagram_basic', 'instagram_manage_comments']),
      comments_reply: impl(['instagram_manage_comments']),
      messages_read: todo('Instagram messaging needs instagram_manage_messages and Meta app review.'),
      messages_reply: todo('Instagram messaging needs instagram_manage_messages and Meta app review.')
    }
  },
  linkedin_organization: {
    provider: 'linkedin',
    platformKey: 'linkedin',
    label: 'LinkedIn Page',
    limits: { captionMax: 3000 },
    features: {
      publish_text: impl(['w_organization_social']),
      publish_link: impl(['w_organization_social']),
      publish_image: todo('LinkedIn image upload (Images API) is planned.'),
      publish_video: todo('LinkedIn video upload is planned.'),
      analytics_post: impl(['rw_organization_admin']),
      analytics_account: impl(['rw_organization_admin']),
      comments_read: impl(['r_organization_social']),
      comments_reply: impl(['w_organization_social']),
      messages_read: none('LinkedIn does not offer Page messaging through its public APIs.'),
      messages_reply: none('LinkedIn does not offer Page messaging through its public APIs.')
    }
  },
  youtube_channel: {
    provider: 'youtube',
    platformKey: 'youtube',
    label: 'YouTube channel',
    limits: {},
    features: {
      publish_text: none('YouTube publishes videos, not text posts.'),
      publish_link: none('YouTube publishes videos, not link posts.'),
      publish_image: none('YouTube publishes videos, not images.'),
      publish_video: todo('Resumable video upload is planned once the Video Studio produces real video files.'),
      analytics_post: todo('Per-video analytics are planned with video publishing.'),
      analytics_account: impl(['https://www.googleapis.com/auth/youtube.readonly']),
      comments_read: impl(['https://www.googleapis.com/auth/youtube.force-ssl']),
      comments_reply: impl(['https://www.googleapis.com/auth/youtube.force-ssl']),
      messages_read: none('YouTube has no direct messages.'),
      messages_reply: none('YouTube has no direct messages.')
    }
  }
};

/** Platforms that have no API integration in this release; content can still be drafted and posted manually. */
const MANUAL_PLATFORMS = {
  x: {
    label: 'X (Twitter)',
    limits: { captionMax: 280 },
    note: 'The X API requires a paid plan and is not integrated. Drafts can be copied and posted manually; they are never marked published by Marketech.ai.'
  }
};

const PROVIDERS = {
  meta: {
    label: 'Meta (Facebook Pages & Instagram)',
    accountTypes: ['facebook_page', 'instagram_business'],
    env: ['META_APP_ID', 'META_APP_SECRET'],
    scopes: [
      'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_read_user_content',
      'pages_manage_engagement', 'read_insights', 'business_management',
      'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights'
    ],
    docs: 'https://developers.facebook.com/docs/pages-api and https://developers.facebook.com/docs/instagram-platform'
  },
  linkedin: {
    label: 'LinkedIn Pages',
    accountTypes: ['linkedin_organization'],
    env: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    scopes: ['r_organization_social', 'w_organization_social', 'rw_organization_admin'],
    docs: 'https://learn.microsoft.com/linkedin/marketing/community-management/'
  },
  youtube: {
    label: 'YouTube',
    accountTypes: ['youtube_channel'],
    env: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    scopes: [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/youtube.force-ssl'
    ],
    docs: 'https://developers.google.com/youtube/v3'
  }
};

function isProviderConfigured(providerKey) {
  const p = PROVIDERS[providerKey];
  return !!p && p.env.every(k => !!process.env[k]);
}

function parseScopes(scopesJson) {
  if (!scopesJson) return [];
  if (Array.isArray(scopesJson)) return scopesJson;
  try {
    const v = JSON.parse(scopesJson);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return String(scopesJson).split(/[\s,]+/).filter(Boolean);
  }
}

/** Evaluates every feature for a connected account row. */
function evaluateAccount(account) {
  const type = ACCOUNT_TYPES[account.account_type];
  if (!type) return {};
  const granted = new Set(parseScopes(account.scopes_json));
  const out = {};
  for (const f of FEATURES) {
    const spec = type.features[f];
    let status;
    let missing = [];
    if (!spec || spec.unsupported) status = 'unsupported_by_provider';
    else if (!spec.implemented) status = 'not_implemented';
    else {
      missing = spec.scopes.filter(s => !granted.has(s));
      status = missing.length === 0 ? 'available' : 'missing_permission';
    }
    out[f] = { status, label: FEATURE_LABELS[f], note: spec?.note || null, missingScopes: missing };
  }
  return out;
}

function canAccount(account, feature) {
  return evaluateAccount(account)[feature]?.status === 'available';
}

/** Which publish feature a content item needs, based on its media. */
function requiredPublishFeature(content, assets = []) {
  if (assets.some(a => a.asset_type === 'video')) return 'publish_video';
  if (assets.some(a => a.asset_type === 'image')) return 'publish_image';
  if (content.link_url) return 'publish_link';
  return 'publish_text';
}

function registrySnapshot() {
  return {
    features: FEATURE_LABELS,
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, {
      label: p.label,
      platformAppConfigured: isProviderConfigured(k),
      requiredEnv: p.env,
      scopes: p.scopes,
      docs: p.docs,
      accountTypes: p.accountTypes
    }])),
    accountTypes: Object.fromEntries(Object.entries(ACCOUNT_TYPES).map(([k, t]) => [k, {
      provider: t.provider,
      platformKey: t.platformKey,
      label: t.label,
      limits: t.limits,
      features: Object.fromEntries(Object.entries(t.features).map(([f, s]) => [f, {
        status: s.unsupported ? 'unsupported_by_provider' : (s.implemented ? 'implemented' : 'not_implemented'),
        scopes: s.scopes || [],
        note: s.note || null
      }]))
    }])),
    manualPlatforms: MANUAL_PLATFORMS
  };
}

module.exports = {
  FEATURES,
  ACCOUNT_TYPES,
  PROVIDERS,
  MANUAL_PLATFORMS,
  isProviderConfigured,
  parseScopes,
  evaluateAccount,
  canAccount,
  requiredPublishFeature,
  registrySnapshot
};
