/**
 * Platform publishing rules, checked against the stored facts of each attached file (content
 * type, size, dimensions, duration, codecs, frame rate) before anything is queued or sent.
 * "problems" block publishing; "warnings" are shown but do not block. Content is never
 * truncated or converted to make it pass: the user decides what to change.
 *
 * Sources (official publishing API documentation):
 * - Facebook Pages API: /{page}/feed, /{page}/photos (JPEG/PNG, under 4 MB), /{page}/videos.
 * - Instagram Content Publishing: JPEG images up to 8 MB, aspect ratio 4:5 to 1.91:1;
 *   Reels MP4/MOV, H.264/HEVC, AAC audio, 3 s to 15 min, up to 300 MB, 23-60 fps;
 *   carousels 2-10 items; captions 2,200 characters, 30 hashtags, 20 @mentions.
 * - LinkedIn Posts/Images/Videos APIs: JPG/PNG/GIF images up to 36,152,320 pixels, multi-image
 *   posts 2-20 images; MP4 video 75 KB-500 MB, 3 s-30 min; commentary 3,000 characters.
 * - YouTube Data API videos.insert: title up to 100 characters, description up to 5,000 bytes,
 *   neither may contain "<" or ">".
 */
const { ACCOUNT_TYPES, MANUAL_PLATFORMS } = require('./capabilities');

const MB = 1024 * 1024;

const RULES = {
  facebook_page: {
    captionMax: 63206,
    image: { mimes: ['image/jpeg', 'image/png'], maxBytes: 4 * MB, maxCount: 10, label: 'JPEG or PNG' },
    video: { mimes: ['video/mp4', 'video/quicktime'], maxBytes: 1024 * MB, maxSeconds: 240 * 60, label: 'MP4 or MOV' },
    mixMedia: false,
    linkWithMedia: false,
    needsUploadedFileFor: ['video']
  },
  instagram_business: {
    captionMax: 2200,
    hashtagMax: 30,
    mentionMax: 20,
    requiresMedia: true,
    noLinks: true,
    fetchesByUrl: true,
    image: { mimes: ['image/jpeg'], maxBytes: 8 * MB, minAspect: 0.8, maxAspect: 1.91, minWidth: 320, maxCount: 10, label: 'JPEG' },
    video: { mimes: ['video/mp4', 'video/quicktime'], maxBytes: 300 * MB, minSeconds: 3, maxSeconds: 15 * 60, carouselMaxSeconds: 60, codecs: ['h264', 'hevc'], audioCodecs: ['aac'], minFps: 23, maxFps: 60, maxWidth: 1920, minAspect: 0.01, maxAspect: 10, label: 'MP4 or MOV (H.264/HEVC)' },
    carouselMax: 10,
    mixMedia: true
  },
  linkedin_organization: {
    captionMax: 3000,
    image: { mimes: ['image/jpeg', 'image/png'], maxPixels: 36152320, maxCount: 20, label: 'JPEG or PNG' },
    video: { mimes: ['video/mp4'], minBytes: 75 * 1024, maxBytes: 500 * MB, minSeconds: 3, maxSeconds: 30 * 60, label: 'MP4' },
    mixMedia: false,
    linkWithMedia: false,
    needsUploadedFileFor: ['image', 'video']
  },
  youtube_channel: {
    descriptionBytesMax: 5000,
    titleMax: 100,
    requiresVideo: true,
    video: { mimes: ['video/mp4', 'video/quicktime'], label: 'MP4 or MOV' },
    noImages: true,
    needsUploadedFileFor: ['video']
  }
};

const fmtMb = n => `${Math.round((n / MB) * 10) / 10} MB`;

function chars(s) {
  return [...String(s || '')].length;
}

function composeText(content) {
  const parts = [content.caption || ''];
  if (content.callToAction && !String(content.caption || '').includes(content.callToAction)) parts.push(content.callToAction);
  if (content.hashtags?.length) parts.push(content.hashtags.join(' '));
  return parts.filter(Boolean).join('\n\n').trim();
}

function mentionsIn(text) {
  return (String(text || '').match(/(^|[^\w@])@[A-Za-z0-9_.]{2,}/g) || []).length;
}

function assetLabel(a, i) {
  return `${a.asset_type === 'video' ? 'Video' : 'Image'} ${i + 1}${a.original_name || a.title ? ` (${a.original_name || a.title})` : ''}`;
}

/**
 * Checks one post for one account type (or a manual platform key such as "x").
 * @param {string} accountType  e.g. instagram_business, or a manual platform key
 * @param {object} content      presented content (caption, hashtags, callToAction, linkUrl, title, platformOptions)
 * @param {object[]} assets     asset rows in attachment order
 * @param {object} env          { publicFetchProblem: string|null }
 */
function evaluate(accountType, content, assets = [], env = {}) {
  const problems = [];
  const warnings = [];
  const text = composeText(content);

  if (MANUAL_PLATFORMS[accountType]) {
    const m = MANUAL_PLATFORMS[accountType];
    if (m.limits?.captionMax && chars(text) > m.limits.captionMax) problems.push(`Text is ${chars(text)} characters; ${m.label} allows ${m.limits.captionMax}.`);
    warnings.push(m.note);
    return { problems, warnings };
  }
  const rules = RULES[accountType];
  const label = ACCOUNT_TYPES[accountType]?.label || accountType;
  if (!rules) return { problems: [`${label} is not a supported publishing target.`], warnings };

  const live = assets.filter(a => a.status !== 'deleted');
  if (live.length !== assets.length) problems.push('An attached file was deleted from the media library; remove it from the post.');
  const images = live.filter(a => a.asset_type === 'image');
  const videos = live.filter(a => a.asset_type === 'video');

  // ---- Text ----
  if (rules.captionMax && chars(text) > rules.captionMax) problems.push(`Text is ${chars(text)} characters; ${label} allows ${rules.captionMax}.`);
  if (rules.hashtagMax && (content.hashtags || []).length > rules.hashtagMax) problems.push(`${label} allows at most ${rules.hashtagMax} hashtags (this post has ${content.hashtags.length}).`);
  if (rules.mentionMax && mentionsIn(text) > rules.mentionMax) problems.push(`${label} allows at most ${rules.mentionMax} @mentions.`);
  if (!rules.mentionMax && mentionsIn(text) > 0 && accountType !== 'youtube_channel') {
    warnings.push(`@mentions are published as plain text on ${label}; the API does not tag accounts from text.`);
  }
  if (accountType === 'youtube_channel') {
    const title = String(content.title || '').trim();
    if (!title) problems.push('YouTube needs a video title (use the Title field).');
    else if (chars(title) > rules.titleMax) problems.push(`YouTube titles allow ${rules.titleMax} characters (this one has ${chars(title)}).`);
    if (/[<>]/.test(title) || /[<>]/.test(text)) problems.push('YouTube titles and descriptions cannot contain "<" or ">".');
    if (Buffer.byteLength(text, 'utf8') > rules.descriptionBytesMax) problems.push(`The YouTube description is ${Buffer.byteLength(text, 'utf8')} bytes; the limit is ${rules.descriptionBytesMax}.`);
    const privacy = content.platformOptions?.youtube?.privacyStatus;
    if (privacy && !['public', 'unlisted', 'private'].includes(privacy)) problems.push('YouTube privacy must be public, unlisted or private.');
  }

  // ---- Links ----
  if (content.linkUrl && rules.noLinks) problems.push(`${label} does not support link attachments. Remove the link (a URL typed in the caption is shown as plain text).`);
  if (content.linkUrl && live.length && rules.linkWithMedia === false) {
    problems.push(`${label} cannot show a link preview on a post with media. Remove the link, or remove the media, or put the URL in the caption.`);
  }

  // ---- Media combinations ----
  if (rules.requiresMedia && live.length === 0) problems.push(`${label} requires at least one image or video.`);
  if (rules.requiresVideo && videos.length === 0) problems.push(`${label} publishes videos; attach one video.`);
  if (rules.noImages && images.length) problems.push(`${label} cannot publish images; remove them.`);
  if (accountType === 'youtube_channel' && videos.length > 1) problems.push('Attach exactly one video for YouTube.');
  if (!rules.mixMedia && images.length && videos.length) problems.push(`${label} cannot combine images and video in one post.`);
  if (!rules.carouselMax && videos.length > 1) problems.push(`${label} supports one video per post.`);
  if (rules.carouselMax && live.length > rules.carouselMax) problems.push(`${label} carousels hold at most ${rules.carouselMax} items.`);
  if (!rules.carouselMax && rules.image?.maxCount && images.length > rules.image.maxCount) problems.push(`${label} posts hold at most ${rules.image.maxCount} images.`);
  const isCarousel = !!rules.carouselMax && live.length > 1;

  // ---- Per file ----
  live.forEach((a, i) => {
    const name = assetLabel(a, i);
    const spec = a.asset_type === 'video' ? rules.video : rules.image;
    if (!spec) return;
    const uploaded = a.source === 'upload';
    if (!uploaded && rules.needsUploadedFileFor?.includes(a.asset_type)) {
      problems.push(`${name} is a linked URL; ${label} needs the file itself. Upload it to the media library.`);
      return;
    }
    if (!uploaded) {
      warnings.push(`${name} is a linked URL, so its size and dimensions were not verified. Upload the file to validate it before publishing.`);
    }
    if (a.mime_type && !spec.mimes.includes(a.mime_type)) {
      problems.push(`${name} is ${String(a.mime_type).replace(/^(image|video)\//, '').toUpperCase()}; ${label} accepts ${spec.label}.`);
    }
    const size = Number(a.size_bytes || 0);
    if (spec.maxBytes && size > spec.maxBytes) problems.push(`${name} is ${fmtMb(size)}; ${label} allows ${fmtMb(spec.maxBytes)}.`);
    if (spec.minBytes && size && size < spec.minBytes) problems.push(`${name} is smaller than ${label}'s minimum of ${Math.round(spec.minBytes / 1024)} KB.`);
    const w = Number(a.width || 0);
    const h = Number(a.height || 0);
    if (uploaded && (!w || !h)) problems.push(`${name}: the dimensions could not be read.`);
    if (w && h) {
      const ratio = w / h;
      if (spec.minAspect && ratio < spec.minAspect - 0.005) problems.push(`${name} is ${w}×${h} (aspect ${ratio.toFixed(2)}); ${label} needs at least ${spec.minAspect}:1 for this media type.`);
      if (spec.maxAspect && ratio > spec.maxAspect + 0.005) problems.push(`${name} is ${w}×${h} (aspect ${ratio.toFixed(2)}); ${label} allows at most ${spec.maxAspect}:1.`);
      if (spec.minWidth && w < spec.minWidth) warnings.push(`${name} is ${w}px wide; ${label} upscales images narrower than ${spec.minWidth}px.`);
      if (spec.maxPixels && w * h > spec.maxPixels) problems.push(`${name} has ${w * h} pixels; ${label} allows ${spec.maxPixels}.`);
      if (spec.maxWidth && Math.min(w, h) > spec.maxWidth) warnings.push(`${name} is larger than ${spec.maxWidth}px; ${label} will downscale it.`);
    }
    if (a.asset_type === 'video') {
      const d = a.duration_seconds === null || a.duration_seconds === undefined ? null : Number(a.duration_seconds);
      if (uploaded && d === null) problems.push(`${name}: the duration could not be read.`);
      const maxSeconds = isCarousel && spec.carouselMaxSeconds ? spec.carouselMaxSeconds : spec.maxSeconds;
      if (d !== null && spec.minSeconds && d < spec.minSeconds) problems.push(`${name} is ${d}s long; ${label} needs at least ${spec.minSeconds}s.`);
      if (d !== null && maxSeconds && d > maxSeconds) problems.push(`${name} is ${Math.round(d)}s long; ${label} allows ${maxSeconds >= 60 ? `${maxSeconds / 60} min` : `${maxSeconds}s`}${isCarousel ? ' per carousel video' : ''}.`);
      if (spec.codecs && a.video_codec && !spec.codecs.includes(a.video_codec)) problems.push(`${name} uses the ${a.video_codec} codec; ${label} accepts ${spec.codecs.join(' or ').toUpperCase()}.`);
      if (spec.audioCodecs && a.audio_codec && !spec.audioCodecs.includes(a.audio_codec)) problems.push(`${name} has ${a.audio_codec} audio; ${label} accepts ${spec.audioCodecs.join(', ').toUpperCase()}.`);
      const fps = a.frame_rate === null || a.frame_rate === undefined ? null : Number(a.frame_rate);
      if (fps !== null && spec.minFps && (fps < spec.minFps - 0.5 || fps > spec.maxFps + 0.5)) problems.push(`${name} runs at ${fps} fps; ${label} accepts ${spec.minFps}-${spec.maxFps} fps.`);
      if (accountType === 'instagram_business' && !isCarousel && w && h && Math.abs(w / h - 9 / 16) > 0.02) {
        warnings.push(`${name} is not 9:16; Instagram shows Reels full-screen at 9:16 and may crop it.`);
      }
    }
  });

  // ---- Delivery ----
  if (rules.fetchesByUrl && live.some(a => a.source === 'upload') && env.publicFetchProblem) {
    problems.push(`Instagram downloads media from this server by URL: ${env.publicFetchProblem}`);
  }
  if (rules.fetchesByUrl && live.some(a => a.source !== 'upload' && a.public_url && !String(a.public_url).startsWith('https://'))) {
    problems.push('Linked media must be served over HTTPS so Instagram can fetch it.');
  }
  if (!text && live.length === 0) problems.push('The post has no text or media.');
  return { problems, warnings };
}

module.exports = { RULES, evaluate, composeText, chars };
