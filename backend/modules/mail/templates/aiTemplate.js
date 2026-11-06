const crypto = require('crypto');
const { z } = require('zod');
const { get } = require('../../../db/database');
const safeFetch = require('../../../lib/safeFetch');
const { generateStructured, untrusted } = require('../../../lib/aiStructured');
const { expandAssetRefs } = require('../../../lib/emailHtml');
const store = require('./assetStore');

/**
 * Email Templates → "Create with AI": a prompt and/or a website link become an email template.
 *
 * Options (all optional): design style, light or dark theme, font, button shape and brand colour;
 * extra sections (feature cards, product grid, stats, testimonial, steps, FAQ, event, comparison,
 * second call to action); length, audience, language and the button link; a logo, social links
 * and the footer address.
 *
 * - The website (if given) is read with safeFetch (public http/https only, size and time limits).
 *   Its text is passed to the model as untrusted data.
 * - The model writes the words only, as a fixed JSON shape. Marketech.ai builds the HTML itself
 *   (600px tables, inline styles) for the chosen style, so every design renders in every inbox
 *   and always has the greeting ({{first_name}}) and an unsubscribe link ($[LI:UNSUBSCRIBE]$).
 * - Pictures and the logo are stored in the workspace's template images (never linked to other
 *   sites): the website's own photos (photo-shaped only), then Pixabay stock photos when
 *   PIXABAY_API_KEY is set. They stay unclaimed (importId) until the template is saved.
 * - Facts the model was not given (prices, numbers, quotes, dates, names) become
 *   [bracketed placeholders]; approval stays blocked until a person fills them in.
 */
const TYPES = ['Promotion', 'Newsletter', 'Announcement', 'Welcome', 'Follow-up'];
const TONES = ['Friendly', 'Professional', 'Persuasive', 'Formal', 'Playful'];
const STYLES = ['modern', 'minimal', 'corporate', 'newsletter', 'bold'];
const SECTIONS = ['features', 'products', 'stats', 'testimonial', 'steps', 'faq', 'event', 'comparison', 'secondCta'];
const SOCIALS = ['website', 'facebook', 'instagram', 'linkedin', 'x', 'youtube', 'tiktok'];
const SOCIAL_LABELS = { website: 'Website', facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn', x: 'X', youtube: 'YouTube', tiktok: 'TikTok' };
const DEFAULT_COLOR = '#4f46e5';
const MAX_IMAGES = 6;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_MAX_BYTES = 1024 * 1024;
const EMAIL_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif']); // what every inbox shows
const ASSET_ID = /^[A-Za-z0-9_-]{43}$/;

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

const httpsUrl = z.union([z.literal(''), z.string().trim().max(500).regex(/^https:\/\/[^\s"'<>]+\.[^\s"'<>]+$/i, 'Links must start with https://')]);
const inputSchema = z.object({
  prompt: z.string().trim().max(1500).optional().default(''),
  url: z.string().trim().max(500).optional().default(''),
  type: z.enum(TYPES).optional().default('Promotion'),
  tone: z.enum(TONES).optional().default('Friendly'),
  brandColor: z.union([z.literal(''), z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #4f46e5.')]).optional().default(''),
  images: z.boolean().optional().default(true),
  // Design
  style: z.enum(STYLES).optional().default('modern'),
  theme: z.enum(['light', 'dark']).optional().default('light'),
  font: z.enum(['sans', 'serif', 'rounded']).optional().default('sans'),
  buttonShape: z.enum(['rounded', 'pill', 'square']).optional().default('rounded'),
  // Sections
  sections: z.array(z.enum(SECTIONS)).max(SECTIONS.length).optional().default(['features']),
  // Content
  length: z.enum(['short', 'medium', 'long']).optional().default('medium'),
  audience: z.string().trim().max(150).optional().default(''),
  language: z.string().trim().max(40).regex(/^[\p{L} ()-]*$/u, 'Use a language name, e.g. English.').optional().default('English'),
  ctaUrl: httpsUrl.optional().default(''),
  // Branding
  logoAssetId: z.union([z.literal(''), z.string().regex(ASSET_ID)]).optional().default(''),
  importId: z.union([z.literal(''), z.string().regex(/^[a-f0-9]{32}$/)]).optional().default(''),
  socials: z.object(Object.fromEntries(SOCIALS.map(k => [k, httpsUrl.optional().default('')]))).strict().optional().default({}),
  address: z.string().trim().max(300).optional().default('')
}).strict();

// Lenient on length: models sometimes write a little more than asked. Text is trimmed to fit and
// extra items are dropped, instead of throwing the whole answer away.
const clip = (n, min = 1) => z.preprocess(v => (typeof v === 'string' ? v.trim().slice(0, n) : v), z.string().min(min));
const opt = n => clip(n, 0).default('');
const list = (max, item) => z.preprocess(v => (Array.isArray(v) ? v.slice(0, max) : v), z.array(item));
const obj = shape => z.preprocess(v => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined), z.object(shape).optional());
/** One emoji (or a short symbol) for a card; anything else is dropped. */
const icon = z.preprocess(v => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t && [...t].length <= 3 && !/[A-Za-z0-9<>&"']/.test(t) ? t : '';
}, z.string());
const contentSchema = z.object({
  templateName: clip(80),
  subject: clip(120),
  preheader: opt(160),
  headline: clip(140),
  intro: clip(900),
  sections: list(4, z.preprocess(v => (typeof v === 'string' ? { title: '', body: v } : v),
    z.object({ title: opt(90), body: clip(900) }))).pipe(z.array(z.any()).min(1)),
  features: list(6, z.preprocess(v => (typeof v === 'string' ? { icon: '', text: v } : v),
    z.object({ icon: icon.default(''), text: clip(160) }))).default([]),
  bullets: list(6, clip(160)).default([]),
  products: list(4, z.object({ name: clip(80), description: opt(240), cta: opt(30) })).default([]),
  stats: list(4, z.object({ value: clip(24), label: clip(60) })).default([]),
  testimonial: obj({ quote: clip(400), author: opt(80), role: opt(80) }),
  steps: list(4, z.object({ title: clip(80), body: opt(240) })).default([]),
  faq: list(5, z.object({ q: clip(160), a: clip(400) })).default([]),
  event: obj({ name: opt(120), date: opt(80), time: opt(80), place: opt(160), note: opt(240) }),
  comparison: obj({ beforeTitle: opt(40), afterTitle: opt(40), rows: list(5, z.object({ before: clip(120), after: clip(120) })).default([]) }),
  secondCta: obj({ heading: opt(120), text: opt(240), button: opt(30) }),
  offer: opt(160),
  ctaText: clip(40),
  closing: opt(400),
  signoff: opt(120),
  imageQuery: opt(60),
  imageAlt: opt(120)
});

// ------------------------------------------------------------------ website

const decode = s => String(s || '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n) || 32));
const text = s => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const meta = (html, re) => { const m = re.exec(html); return m ? decode(m[1]).trim() : ''; };
const attr = (tag, name) => decode((new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag) || [])[1] || '');

/** https only, resolved against the page: images in emails must be https to show. */
function absoluteHttps(href, base) {
  try {
    const u = new URL(decode(href), base);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}

/** Content pictures of the page, best first: not icons, logos, tracking pixels or vector art. */
function pagePictures(body, url) {
  const out = [];
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = attr(tag, 'src') || attr(tag, 'data-src') || (attr(tag, 'srcset').split(',').pop() || '').trim().split(/\s+/)[0];
    if (!src || /^data:/i.test(src) || /\.svg(\?|#|$)/i.test(src)) continue;
    if (/logo|icon|sprite|pixel|avatar|badge|spinner|loader|flag|emoji|favicon/i.test(`${src} ${attr(tag, 'class')} ${attr(tag, 'alt')}`)) continue;
    const w = Number(attr(tag, 'width')) || 0;
    const h = Number(attr(tag, 'height')) || 0;
    if ((w && w < 300) || (h && h < 150)) continue;
    const abs = absoluteHttps(src, url);
    if (abs && !out.includes(abs)) out.push(abs);
    if (out.length >= 8) break;
  }
  return out;
}

/** What the page says, for the model, plus the logo, brand colour and pictures for the layout. */
function readPage(html, url) {
  const body = String(html || '').replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const title = text((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body) || [])[1]);
  const description = meta(body, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || meta(body, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
  const siteName = meta(body, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i);
  const headings = [...body.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(m => text(m[1])).filter(t => t.length > 2 && t.length < 160).slice(0, 12);
  const bullets = [...body.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(m => text(m[1])).filter(t => t.length > 8 && t.length < 200).slice(0, 15);
  const paragraphs = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => text(m[1])).filter(t => t.length > 40).slice(0, 15);
  const themeColor = meta(body, /<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{6})["']/i);
  const logoImg = /<img[^>]+(?:class|id|alt|src)=["'][^"']*logo[^"']*["'][^>]*>/i.exec(body);
  const logoSrc = logoImg ? attr(logoImg[0], 'src') : null;
  const shareImage = meta(body, /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']*)["']/i)
    || meta(body, /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']*)["']/i);
  const logo = (logoSrc && !/\.svg(\?|$)/i.test(logoSrc) && absoluteHttps(logoSrc, url)) || null;
  const pictures = [...new Set([shareImage && absoluteHttps(shareImage, url), ...pagePictures(body, url)].filter(Boolean))].filter(p => p !== logo);
  return {
    url, title, siteName, description, headings, bullets, paragraphs,
    themeColor: /^#[0-9a-fA-F]{6}$/.test(themeColor) ? themeColor : '',
    logo, pictures
  };
}

async function fetchSite(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let res;
  try {
    res = await safeFetch.safeFetchText(url, { timeoutMs: 10000, maxBytes: 1024 * 1024 });
  } catch (err) {
    throw httpError(400, `The website could not be read (${err.message}). Check the link, or describe the email instead.`, 'WEBSITE_UNREADABLE');
  }
  if (!res.ok) throw httpError(400, `The website answered with an error (HTTP ${res.status}). Check the link, or describe the email instead.`, 'WEBSITE_UNREADABLE');
  return readPage(res.text, res.url || url);
}

// ------------------------------------------------------------------ pictures

/** Stock photos for a phrase (Pixabay; needs PIXABAY_API_KEY). Never throws: no photo is fine. */
async function stockPhotos(query, count) {
  const key = process.env.PIXABAY_API_KEY;
  const q = String(query || '').replace(/[^\p{L}\p{N} -]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!key || !q || count <= 0) return [];
  try {
    const url = `https://pixabay.com/api/?${new URLSearchParams({ key, q, image_type: 'photo', orientation: 'horizontal', safesearch: 'true', per_page: '12', min_width: '1000' })}`;
    const res = await safeFetch.safeFetchText(url, { timeoutMs: 8000, maxBytes: 512 * 1024 });
    if (!res.ok) return [];
    const hits = (JSON.parse(res.text).hits || []).filter(x => x && typeof x.webformatURL === 'string');
    return hits.slice(0, count).map(x => ({ url: x.largeImageURL || x.webformatURL, fallback: x.webformatURL, source: 'stock' }));
  } catch { return []; }
}

/** Width and height read from the file itself (JPEG, PNG, GIF); null when unknown. */
function imageSize(buf, mime) {
  try {
    if (mime === 'image/png') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (mime === 'image/gif') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (mime === 'image/jpeg') {
      for (let i = 2; i < buf.length - 9;) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        // Start-of-frame markers carry the size (not DHT 0xC4, JPG 0xC8, DAC 0xCC).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch { /* unknown */ }
  return null;
}

/**
 * A picture worth putting in an email: photo-shaped (wider than tall) and large enough. Square or
 * tall images on websites are mostly logos, icons and illustrations; those make poor banners.
 */
const photoShaped = size => !!size && size.w >= 500 && size.h >= 200 && size.w / size.h >= 1.3 && size.w / size.h <= 3.5;

/** JPEG, PNG or GIF, recognised by the content (never by the name or the server's word). */
function emailImageType(buf) {
  for (const ext of ['jpg', 'png', 'gif']) {
    const t = store.detectType(`x.${ext}`, buf);
    if (t && t.ok && EMAIL_IMAGE_TYPES.has(t.mime)) return t.mime;
  }
  return null;
}

/**
 * Downloads pictures into the workspace's template images (unclaimed, tagged with importId) and
 * returns their asset ids. Pictures that cannot be read, are too big, are not photo-shaped
 * JPEG/PNG/GIF files, or would exceed the image quota are skipped.
 */
async function storePictures(ctx, candidates, importId, want) {
  const stored = [];
  if (want <= 0) return stored;
  let room = store.quotaBytes() - (await store.usedBytes(ctx.auth.workspaceId));
  for (const c of candidates) {
    if (stored.length >= want) break;
    for (const u of [c.url, c.fallback].filter(Boolean)) {
      try {
        const res = await safeFetch.safeFetchBuffer(u, { timeoutMs: 10000, maxBytes: IMAGE_MAX_BYTES });
        if (!res.ok || res.buffer.length < 2048) continue;
        const mime = emailImageType(res.buffer);
        if (!mime || res.buffer.length > room) continue;
        if (!photoShaped(imageSize(res.buffer, mime))) break; // a logo or icon: try the next picture
        const id = await store.saveAsset({ workspaceId: ctx.auth.workspaceId, buffer: res.buffer, mime, originalName: `ai-${c.source}-${stored.length + 1}`, importId, userId: ctx.auth.userId });
        room -= res.buffer.length;
        stored.push({ id, source: c.source });
        break;
      } catch { /* next one */ }
    }
  }
  return stored;
}

/** The website's logo, copied into the template images (any shape). Null when it cannot be used. */
async function storeSiteLogo(ctx, url, importId) {
  if (!url) return null;
  try {
    const res = await safeFetch.safeFetchBuffer(url, { timeoutMs: 8000, maxBytes: LOGO_MAX_BYTES });
    const mime = res.ok ? emailImageType(res.buffer) : null;
    if (!mime) return null;
    if ((await store.usedBytes(ctx.auth.workspaceId)) + res.buffer.length > store.quotaBytes()) return null;
    return await store.saveAsset({ workspaceId: ctx.auth.workspaceId, buffer: res.buffer, mime, originalName: 'ai-logo', importId, userId: ctx.auth.userId });
  } catch { return null; }
}

/** Logo upload (Branding): JPEG, PNG or GIF up to 1 MB, stored unclaimed under importId. */
async function uploadLogo(ctx, buffer, importId) {
  if (!/^[a-f0-9]{32}$/.test(String(importId || ''))) throw httpError(400, 'Missing upload id.', 'VALIDATION_ERROR');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw httpError(400, 'Choose an image file.', 'VALIDATION_ERROR');
  if (buffer.length > LOGO_MAX_BYTES) throw httpError(400, 'The logo must be 1 MB or smaller.', 'TOO_LARGE');
  const mime = emailImageType(buffer);
  if (!mime) throw httpError(400, 'Use a PNG, JPEG or GIF logo (SVG and WebP do not show in every inbox).', 'UNSUPPORTED_TYPE');
  if ((await store.usedBytes(ctx.auth.workspaceId)) + buffer.length > store.quotaBytes()) throw httpError(400, 'The workspace has no room left for template images.', 'QUOTA_EXCEEDED');
  const id = await store.saveAsset({ workspaceId: ctx.auth.workspaceId, buffer, mime, originalName: 'logo', importId, userId: ctx.auth.userId });
  const size = imageSize(buffer, mime);
  return { id, url: expandAssetRefs(`mkt-asset://${id}`), width: size?.w || null, height: size?.h || null };
}

// ------------------------------------------------------------------ the model

const LENGTHS = {
  short: 'Short: about 100 to 150 words in total; 1 short section.',
  medium: 'Medium: about 200 to 300 words in total; 1 to 3 short sections.',
  long: 'Long: about 350 to 500 words in total; 3 to 4 sections.'
};
const SECTION_ASKS = {
  features: '"features": 3 to 6 key benefits, each {"icon": one fitting emoji, "text": short}.',
  products: '"products": 2 to 4 products or services from the given facts, each {"name", "description", "cta" (2-3 words)}.',
  stats: '"stats": 3 or 4 key numbers, each {"value", "label"}. Values not given above must be placeholders like [Number].',
  testimonial: '"testimonial": {"quote", "author", "role"}. Unless a real quote is given above, use [Customer quote], [Customer name], [Role, company].',
  steps: '"steps": 3 or 4 how-it-works steps, each {"title", "body"}.',
  faq: '"faq": 3 to 5 questions, each {"q", "a"}; answers only from given facts, otherwise placeholders.',
  event: '"event": {"name", "date", "time", "place", "note"}; anything not given is a placeholder like [Event date].',
  comparison: '"comparison": {"beforeTitle" (e.g. "Without us"), "afterTitle" (e.g. "With us"), "rows": 3 to 5 of {"before", "after"}}.',
  secondCta: '"secondCta": a second, different call to action near the end: {"heading", "text", "button"}.'
};

function promptFor(input, site) {
  const siteText = site ? [
    `Page: ${site.url}`, site.siteName && `Site name: ${site.siteName}`, site.title && `Title: ${site.title}`,
    site.description && `Description: ${site.description}`,
    site.headings.length && `Headings:\n- ${site.headings.join('\n- ')}`,
    site.bullets.length && `List items:\n- ${site.bullets.join('\n- ')}`,
    site.paragraphs.length && `Text:\n${site.paragraphs.join('\n')}`
  ].filter(Boolean).join('\n\n') : '';
  const wanted = input.sections.filter(k => SECTION_ASKS[k]);
  return [
    `Write a ${input.type.toLowerCase()} marketing email in a ${input.tone.toLowerCase()} tone, in ${input.language || 'English'}.`,
    input.audience ? `It is for: ${untrusted('audience', input.audience, 150)}` : '',
    input.style === 'newsletter' ? 'It is a newsletter: write each section as a short article with a title.' : '',
    input.prompt ? `What the sender wants:\n${untrusted('sender_request', input.prompt, 1500)}` : 'The sender gave no description: base the email on the website.',
    site ? `About the business or product (from its website):\n${untrusted('website', siteText, 5000)}` : '',
    `Rules:
- Use only facts given above. Anything not given (prices, discount amounts, numbers, dates, phone numbers, addresses, names, quotes, statistics) must be a placeholder in square brackets, e.g. [Discount, e.g. 15%], [Offer end date], [Your name]. Keep placeholders in English.
- Never make claims that are not stated above, such as "no credit card required", "free", "guaranteed", "#1", "fastest" or "no setup fees". If the facts say the opposite, follow the facts.
- "secondCta" must offer something different from the main call to action (e.g. book a demo, contact sales, read a guide).
- Do not include a greeting line, the sender's name, unsubscribe text or links: the layout adds them. "signoff" is only the closing words, e.g. "Thanks,".
- "templateName" is a short, readable name with spaces.
- Length: ${LENGTHS[input.length]}
- "offer": for a promotion, one short highlighted line about the offer (placeholders for anything not given); otherwise "".
- "imageQuery": 2 to 4 plain English words for a fitting stock photo; "imageAlt": a short description of such a picture.
- Plain text only in every field (no HTML, no markdown).
${wanted.length ? `Also include:\n${wanted.map(k => `- ${SECTION_ASKS[k]}`).join('\n')}` : 'Do not include features, products, stats, testimonial, steps, faq, event, comparison or secondCta.'}
Return one JSON object with: templateName, subject, preheader, headline, intro, sections [{title, body}], offer, ctaText, closing, signoff, imageQuery, imageAlt${wanted.length ? `, ${wanted.join(', ')}` : ''}.`
  ].filter(Boolean).join('\n\n');
}

// ------------------------------------------------------------------ the layout

const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Only the closing words: a name or placeholder the model added would repeat [Your name]. */
const closingWords = s => { const t = String(s || '').split('\n')[0].replace(/\[[^\]]*\]/g, '').trim(); return t && t.length <= 40 ? t : 'Thanks,'; };

/** The brand colour mixed with another colour (amount 0..1 of it), for soft backgrounds. */
function mix(hex, other, amount) {
  const a = parseInt(hex.slice(1), 16), b = parseInt(other.slice(1), 16);
  const m = (x, y) => Math.round(x + (y - x) * amount);
  return `#${[m(a >> 16, b >> 16), m((a >> 8) & 255, (b >> 8) & 255), m(a & 255, b & 255)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
const tint = (hex, amount) => mix(hex, '#ffffff', amount);
const luminance = hex => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
/** White or dark text, whichever reads better on the colour. */
const onColor = hex => (luminance(hex) > 0.6 ? '#111827' : '#ffffff');

const FONTS = {
  sans: 'Arial, Helvetica, sans-serif',
  serif: "Georgia, 'Times New Roman', Times, serif",
  rounded: "'Trebuchet MS', Verdana, Tahoma, sans-serif"
};
const BUTTON_RADIUS = { rounded: 6, pill: 999, square: 0 };

/** Colours and sizes for a style, theme and brand colour. */
function tokens({ style, theme, color: brand, font, buttonShape }) {
  const dark = theme === 'dark';
  // On a dark theme a very dark brand colour would vanish into the background: lighten it until it stands out.
  let color = brand;
  for (let i = 0; dark && luminance(color) < 0.32 && i < 8; i++) color = tint(color, 0.18);
  const t = {
    style, dark, color, ink: onColor(color),
    font: FONTS[font] || FONTS.sans,
    btnRadius: BUTTON_RADIUS[buttonShape] ?? 6,
    page: dark ? '#0b0f19' : '#f4f5f7',
    card: dark ? '#111827' : '#ffffff',
    text: dark ? '#e5e7eb' : '#1f2937',
    heading: dark ? '#f9fafb' : '#111827',
    muted: dark ? '#9ca3af' : '#6b7280',
    line: dark ? '#1f2937' : '#e5e7eb',
    soft: dark ? mix(color, '#111827', 0.75) : tint(color, 0.9),
    footer: dark ? '#0f1522' : '#f9fafb',
    radius: { modern: 10, minimal: 4, corporate: 4, newsletter: 8, bold: 12 }[style] ?? 10,
    h1: { bold: 34, minimal: 26, corporate: 26 }[style] || 28
  };
  // On dark backgrounds the brand colour is lightened for links and figures.
  t.accentText = dark ? tint(color, 0.45) : color;
  return t;
}

const P = (t, s, extra = '') => `<p style="margin:0 0 14px;${extra}">${esc(s).split(/\n{2,}/).map(p => p.replace(/\n/g, '<br />')).join(`</p><p style="margin:0 0 14px;${extra}">`)}</p>`;
const H2 = (t, s, extra = '') => `<h2 style="margin:26px 0 10px;font-size:19px;line-height:1.3;color:${t.heading};font-family:${t.font};${extra}">${esc(s)}</h2>`;
const block = (inner, pad = '0 32px') => `
      <tr><td style="padding:${pad};">${inner}</td></tr>`;
const img = (id, alt, width, radius = 0) => `<img src="mkt-asset://${id}" alt="${esc(alt)}" width="${width}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;${radius ? `border-radius:${radius}px;` : ''}" />`;
const button = (t, text, href, { big = false, ghost = false } = {}) => {
  const label = t.style === 'bold' ? esc(text).toUpperCase() : esc(text);
  const style = ghost
    ? `display:inline-block;border:2px solid ${t.accentText};color:${t.accentText};`
    : `display:inline-block;background:${t.color};color:${t.ink};`;
  return `<a href="${esc(href)}" style="${style}text-decoration:none;font-weight:bold;font-family:${t.font};font-size:${big ? 18 : 16}px;padding:${big ? '16px 40px' : '13px 30px'};border-radius:${t.btnRadius}px;${t.style === 'bold' ? 'letter-spacing:0.04em;' : ''}">${label}</a>`;
};
/** Rows of two (or three) cells as an email-safe grid; cells in a row have equal height. */
function grid(items, perRow, cell) {
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  const w = Math.floor(100 / perRow);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="10" style="border-collapse:separate;margin:4px 0 10px;">${rows.map(r => `
          <tr>${r.map(x => cell(x, w)).join('')}${Array.from({ length: perRow - r.length }, () => `<td width="${w}%"></td>`).join('')}</tr>`).join('')}
        </table>`;
}

function headerBlock(c, t, brand, logoId) {
  const name = esc(brand || '[Your company]');
  const onBar = t.style === 'corporate';
  const mark = logoId
    ? `<img src="mkt-asset://${logoId}" alt="${name}" height="40" style="display:block;height:40px;max-width:220px;border:0;" />`
    : `<span style="font-size:22px;font-weight:bold;color:${onBar ? t.ink : t.accentText};font-family:${t.font};">${name}</span>`;
  const view = ''; // no "view in browser" page: campaigns are sent one by one with Amazon SES
  if (onBar) {
    return `
      <tr><td style="padding:16px 32px;background:${t.color};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td valign="middle">${mark}</td><td valign="middle" align="right">${view}</td></tr></table></td></tr>`;
  }
  if (t.style === 'newsletter') {
    return `
      <tr><td style="padding:12px 32px 0;text-align:right;">${view}</td></tr>
      <tr><td align="center" style="padding:14px 32px 16px;border-bottom:3px double ${t.line};">${logoId ? `<div style="display:inline-block;">${mark}</div>` : mark}
        <div style="margin-top:6px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:${t.muted};">Newsletter · [Issue date]</div></td></tr>`;
  }
  return `
      <tr><td style="padding:12px 32px 0;text-align:right;">${view}</td></tr>
      <tr><td style="padding:10px 32px ${t.style === 'minimal' ? '24px' : '16px'};">${mark}</td></tr>`;
}

function heroBlock(c, t, hero) {
  const alt = c.imageAlt || c.headline;
  const h1 = `<h1 style="margin:0;font-size:${t.h1}px;line-height:1.22;font-family:${t.font};`;
  if (t.style === 'minimal' || t.style === 'newsletter') {
    return `${hero ? `
      <tr><td style="padding:${t.style === 'newsletter' ? '20px ' : '0 '}32px 0;">${img(hero.id, alt, 536, t.radius)}</td></tr>` : ''}
      <tr><td style="padding:${hero ? 24 : 4}px 32px 0;">${h1}color:${t.heading};">${esc(c.headline)}</h1>
        ${c.preheader && t.style === 'minimal' ? `<p style="margin:10px 0 0;font-size:17px;line-height:1.5;color:${t.muted};">${esc(c.preheader)}</p>` : ''}</td></tr>`;
  }
  if (hero && t.style !== 'bold') {
    return `
      <tr><td style="padding:0;">${img(hero.id, alt, 600)}</td></tr>
      <tr><td style="padding:28px 32px 0;">${h1}color:${t.heading};">${esc(c.headline)}</h1></td></tr>`;
  }
  const bg = t.style === 'corporate' ? t.soft : t.color;
  const fg = t.style === 'corporate' ? t.heading : t.ink;
  const gradient = t.style === 'modern' ? `background-image:linear-gradient(135deg, ${t.color} 0%, ${tint(t.color, 0.25)} 100%);` : '';
  return `${hero && t.style === 'bold' ? `
      <tr><td style="padding:0;">${img(hero.id, alt, 600)}</td></tr>` : ''}
      <tr><td align="${t.style === 'bold' ? 'center' : 'left'}" style="padding:${t.style === 'bold' ? '44px 32px' : '36px 32px'};background:${bg};${gradient}">
        ${h1}color:${fg};${t.style === 'bold' ? 'text-transform:uppercase;letter-spacing:0.02em;' : ''}">${esc(c.headline)}</h1>
        ${c.preheader ? `<p style="margin:12px 0 0;font-size:${t.style === 'bold' ? 19 : 16}px;line-height:1.5;color:${fg};opacity:0.9;">${esc(c.preheader)}</p>` : ''}
      </td></tr>`;
}

function sectionsBlock(c, t, pics) {
  if (t.style === 'newsletter') {
    // Each section is an article: picture (if any), title, text, "Read more".
    return c.sections.map((s, i) => `
      <tr><td style="padding:${i ? 8 : 18}px 32px 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid ${t.line};"><tr><td style="padding:0 0 22px;">
          ${pics[i] ? `<div style="margin:0 0 14px;">${img(pics[i].id, s.title || c.imageAlt, 536, t.radius)}</div>` : ''}
          ${s.title ? H2(t, s.title, 'margin-top:0;') : ''}
          ${P(t, s.body)}
          <a href="[Article link]" style="color:${t.accentText};font-weight:bold;text-decoration:none;">Read more →</a>
        </td></tr></table>
      </td></tr>`).join('');
  }
  const divider = t.style === 'corporate' ? `border-top:1px solid ${t.line};padding-top:4px;` : '';
  return block(c.sections.map((s, i) => `${s.title ? `<div style="${i ? divider : ''}">${H2(t, s.title)}</div>` : ''}${P(t, s.body)}${pics[i] ? `<div style="margin:6px 0 18px;">${img(pics[i].id, s.title || c.imageAlt, 536, t.radius)}</div>` : ''}`).join(''));
}

function featuresBlock(c, t) {
  const feats = c.features.length ? c.features : c.bullets.map(x => ({ icon: '', text: x }));
  if (!feats.length) return '';
  if (t.style === 'minimal') {
    return block(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 12px;">${feats.map(f => `
          <tr><td width="30" valign="top" style="padding:6px 0;font-size:18px;">${esc(f.icon || '—')}</td><td style="padding:6px 0;border-bottom:1px solid ${t.line};">${esc(f.text)}</td></tr>`).join('')}
        </table>`);
  }
  return block(grid(feats, 2, (f, w) => `<td width="${w}%" valign="top" style="background:${t.soft};border-radius:${t.radius}px;padding:14px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td width="34" valign="top" style="font-size:22px;line-height:1.1;">${esc(f.icon || '✔')}</td>
              <td valign="top" style="font-size:15px;line-height:1.45;color:${t.text};">${esc(f.text)}</td>
            </tr></table></td>`));
}

function productsBlock(c, t, pics, href) {
  if (!c.products.length) return '';
  const cells = c.products.map((p, i) => ({ ...p, pic: pics[i] }));
  return block(`${H2(t, 'Featured')}${grid(cells, 2, (p, w) => `<td width="${w}%" valign="top" style="background:${t.card};border:1px solid ${t.line};border-radius:${t.radius}px;padding:0;overflow:hidden;">
            ${p.pic ? img(p.pic.id, p.name, 258, 0) : `<div style="height:6px;background:${t.color};font-size:0;line-height:0;">&nbsp;</div>`}
            <div style="padding:14px;">
              <div style="font-size:16px;font-weight:bold;color:${t.heading};margin:0 0 6px;">${esc(p.name)}</div>
              ${p.description ? `<div style="font-size:14px;line-height:1.45;color:${t.text};margin:0 0 12px;">${esc(p.description)}</div>` : ''}
              <a href="${esc(href)}" style="color:${t.accentText};font-weight:bold;text-decoration:none;font-size:14px;">${esc(p.cta || 'Learn more')} →</a>
            </div></td>`)}`);
}

function statsBlock(c, t) {
  if (!c.stats.length) return '';
  const n = c.stats.length;
  return block(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;background:${t.soft};border-radius:${t.radius}px;"><tr>${c.stats.map((s, i) => `
          <td width="${Math.floor(100 / n)}%" align="center" valign="top" style="padding:18px 8px;${i ? `border-left:1px solid ${t.dark ? t.line : tint(t.color, 0.75)};` : ''}">
            <div style="font-size:26px;font-weight:bold;color:${t.accentText};font-family:${t.font};line-height:1.15;">${esc(s.value)}</div>
            <div style="font-size:13px;color:${t.muted};margin-top:4px;line-height:1.35;">${esc(s.label)}</div></td>`).join('')}
        </tr></table>`);
}

function testimonialBlock(c, t) {
  const q = c.testimonial;
  if (!q || !q.quote) return '';
  return block(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;"><tr>
          <td style="border-left:4px solid ${t.color};background:${t.soft};border-radius:0 ${t.radius}px ${t.radius}px 0;padding:18px 20px;">
            <div style="font-size:17px;line-height:1.55;font-style:italic;color:${t.heading};">“${esc(q.quote)}”</div>
            ${q.author || q.role ? `<div style="margin-top:10px;font-size:14px;color:${t.muted};">— ${esc([q.author, q.role].filter(Boolean).join(', '))}</div>` : ''}
          </td></tr></table>`);
}

function stepsBlock(c, t) {
  if (!c.steps.length) return '';
  return block(`${H2(t, 'How it works')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;">${c.steps.map((s, i) => `
          <tr><td width="44" valign="top" style="padding:8px 0;">
              <div style="width:32px;height:32px;line-height:32px;border-radius:50%;background:${t.color};color:${t.ink};text-align:center;font-weight:bold;font-size:15px;">${i + 1}</div></td>
            <td valign="top" style="padding:8px 0;">
              <div style="font-weight:bold;color:${t.heading};font-size:16px;">${esc(s.title)}</div>
              ${s.body ? `<div style="font-size:15px;line-height:1.45;color:${t.text};margin-top:2px;">${esc(s.body)}</div>` : ''}</td></tr>`).join('')}
        </table>`);
}

function faqBlock(c, t) {
  if (!c.faq.length) return '';
  return block(`${H2(t, 'Questions you may have')}${c.faq.map(f => `
        <div style="padding:12px 0;border-top:1px solid ${t.line};">
          <div style="font-weight:bold;color:${t.heading};font-size:15px;margin-bottom:4px;">${esc(f.q)}</div>
          <div style="font-size:15px;line-height:1.5;color:${t.text};">${esc(f.a)}</div></div>`).join('')}`);
}

function eventBlock(c, t) {
  const e = c.event;
  if (!e || !(e.name || e.date || e.place)) return '';
  const row = (k, v) => (v ? `<tr><td width="70" valign="top" style="padding:4px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:${t.muted};">${k}</td><td style="padding:4px 0;font-size:15px;color:${t.heading};font-weight:bold;">${esc(v)}</td></tr>` : '');
  return block(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:2px solid ${t.color};border-radius:${t.radius}px;"><tr><td style="padding:18px 20px;">
          ${e.name ? `<div style="font-size:18px;font-weight:bold;color:${t.heading};margin-bottom:8px;">📅 ${esc(e.name)}</div>` : ''}
          <table role="presentation" cellpadding="0" cellspacing="0">${row('Date', e.date)}${row('Time', e.time)}${row('Where', e.place)}</table>
          ${e.note ? `<div style="margin-top:8px;font-size:14px;color:${t.text};">${esc(e.note)}</div>` : ''}
        </td></tr></table>`);
}

function comparisonBlock(c, t) {
  const k = c.comparison;
  if (!k || !k.rows || !k.rows.length) return '';
  const head = (s, bg, fg) => `<td width="50%" style="padding:10px 12px;background:${bg};color:${fg};font-weight:bold;font-size:14px;">${esc(s)}</td>`;
  return block(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid ${t.line};border-radius:${t.radius}px;border-collapse:separate;overflow:hidden;">
          <tr>${head(k.beforeTitle || 'Before', t.dark ? '#1f2937' : '#f3f4f6', t.muted)}${head(k.afterTitle || 'After', t.color, t.ink)}</tr>${k.rows.map(r => `
          <tr><td valign="top" style="padding:10px 12px;border-top:1px solid ${t.line};font-size:14px;color:${t.muted};">✕ ${esc(r.before)}</td>
            <td valign="top" style="padding:10px 12px;border-top:1px solid ${t.line};font-size:14px;color:${t.text};background:${t.soft};">✓ ${esc(r.after)}</td></tr>`).join('')}
        </table>`);
}

function offerBlock(c, t, type) {
  if (!c.offer || type !== 'Promotion') return '';
  const big = t.style === 'bold';
  return `
      <tr><td style="padding:6px 32px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${big ? `background:${t.color};` : `border:2px dashed ${t.color};background:${t.soft};`}border-radius:${t.radius}px;"><tr>
          <td align="center" style="padding:${big ? '26px 20px' : '18px 20px'};font-size:${big ? 24 : 18}px;line-height:1.35;font-weight:bold;color:${big ? t.ink : t.heading};font-family:${t.font};">${esc(c.offer)}</td>
        </tr></table>
      </td></tr>`;
}

function secondCtaBlock(c, t, href) {
  const s = c.secondCta;
  if (!s || !(s.heading || s.text || s.button)) return '';
  return `
      <tr><td style="padding:8px 32px 26px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.soft};border-radius:${t.radius}px;"><tr><td align="center" style="padding:22px 20px;">
          ${s.heading ? `<div style="font-size:18px;font-weight:bold;color:${t.heading};margin-bottom:6px;font-family:${t.font};">${esc(s.heading)}</div>` : ''}
          ${s.text ? `<div style="font-size:15px;line-height:1.5;color:${t.text};margin-bottom:14px;">${esc(s.text)}</div>` : ''}
          ${button(t, s.button || 'Get in touch', href, { ghost: true })}
        </td></tr></table>
      </td></tr>`;
}

function footerBlock(t, brand, socials, address) {
  const name = esc(brand || '[Your company]');
  const links = SOCIALS.filter(k => socials[k]).map(k => `<a href="${esc(socials[k])}" style="color:${t.accentText};text-decoration:none;font-weight:bold;">${SOCIAL_LABELS[k]}</a>`);
  return `
      <tr><td style="padding:22px 32px;background:${t.footer};border-top:1px solid ${t.line};font-size:12px;line-height:1.6;color:${t.muted};text-align:center;">
        ${links.length ? `<p style="margin:0 0 12px;font-size:13px;">${links.join(' &nbsp;·&nbsp; ')}</p>` : ''}
        <p style="margin:0 0 8px;">You are receiving this email because you are a contact of ${name}.</p>
        <p style="margin:0 0 8px;">${address ? esc(address).replace(/\n/g, '<br />') : '[Your company address]'}</p>
        <p style="margin:0;"><a href="$[LI:UNSUBSCRIBE]$" style="color:${t.muted};">Unsubscribe</a></p>
      </td></tr>`;
}

/**
 * Builds the email. opts: brand, color, ctaUrl, images ([{id}] in order of use), logoId, type,
 * style, theme, font, buttonShape, socials, address.
 */
function render(c, opts) {
  const style = opts.style || 'modern';
  const t = tokens({ style, theme: opts.theme || 'light', color: opts.color || DEFAULT_COLOR, font: opts.font || 'sans', buttonShape: opts.buttonShape || 'rounded' });
  const images = opts.images || [];
  const hero = images[0] || null;
  const rest = images.slice(1);
  const products = c.products || [];
  const sectionPics = style === 'newsletter' ? rest.slice(0, c.sections.length) : rest.slice(0, Math.max(0, rest.length - products.length)).slice(0, 2);
  const productPics = rest.slice(sectionPics.length);
  const href = opts.ctaUrl || 'https://example.com';
  const body = [
    headerBlock(c, t, opts.brand, opts.logoId),
    heroBlock(c, t, hero),
    block(`<p style="margin:0 0 14px;">Hi {{first_name}},</p>${P(t, c.intro)}`, '24px 32px 0'),
    sectionsBlock(c, t, sectionPics),
    featuresBlock({ features: [], bullets: [], ...c }, t),
    productsBlock({ products: [], ...c }, t, productPics, href),
    stepsBlock({ steps: [], ...c }, t),
    statsBlock({ stats: [], ...c }, t),
    comparisonBlock(c, t),
    testimonialBlock(c, t),
    faqBlock({ faq: [], ...c }, t),
    eventBlock(c, t),
    offerBlock(c, t, opts.type),
    `
      <tr><td align="center" style="padding:10px 32px 30px;">${button(t, c.ctaText, href, { big: style === 'bold' })}</td></tr>`,
    secondCtaBlock(c, t, href),
    block(`${c.closing ? P(t, c.closing) : ''}<p style="margin:0;">${esc(closingWords(c.signoff))}<br />[Your name]<br />${esc(opts.brand || '[Your company]')}</p>`, '0 32px 28px'),
    footerBlock(t, opts.brand, opts.socials || {}, opts.address || '')
  ].join('');
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="color-scheme" content="${t.dark ? 'dark' : 'light'}" /><title>${esc(c.subject)}</title></head>
<body style="margin:0;padding:0;background:${t.page};">
<div style="display:none;max-height:0;overflow:hidden;">${esc(c.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.page};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${t.card};border-radius:${Math.min(t.radius, 12)}px;overflow:hidden;font-family:${t.font};font-size:16px;line-height:1.6;color:${t.text};">${body}
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** Generates a template (not saved; its pictures and logo are stored unclaimed under importId). */
async function generate(ctx, body) {
  const input = inputSchema.parse(body || {});
  if (!input.prompt && !input.url) throw httpError(400, 'Describe the email, or give a website link (or both).', 'VALIDATION_ERROR');
  const importId = input.importId || crypto.randomBytes(16).toString('hex');
  let logoId = null;
  if (input.logoAssetId) {
    const own = await get('SELECT public_id FROM mail_template_assets WHERE workspace_id = ? AND public_id = ? AND import_id = ? AND template_id IS NULL',
      [ctx.auth.workspaceId, input.logoAssetId, importId]);
    if (!own) throw httpError(400, 'The uploaded logo was not found. Upload it again.', 'VALIDATION_ERROR');
    logoId = own.public_id;
  }
  const site = await fetchSite(input.url);
  let data, provider;
  try {
    ({ data, provider } = await generateStructured({
      workspaceId: ctx.auth.workspaceId,
      prompt: promptFor(input, site),
      system: 'You are an expert email marketer who writes clear, honest B2B and B2C marketing emails. You never invent facts: anything not given becomes a [bracketed placeholder].',
      schema: contentSchema,
      referenceType: 'email_template_ai',
      maxTokens: 3000,
      // Telnyx's small voice model is for short spoken replies; whole emails need a writing model.
      excludeProviders: ['telnyx']
    }));
  } catch (err) {
    // No model configured, quota reached or unusable output: the message is meant for the person.
    if (/^AI_|QUOTA/.test(String(err.code || ''))) err.expose = true;
    throw err;
  }
  // The layout already greets the reader: a greeting the model put at the start of the intro is dropped.
  data.intro = String(data.intro).replace(/^\s*(hi|hello|hey|dear|greetings)\b[^.!?\n]{0,80}[,.!?]\s*/i, '').trim() || data.intro;
  // A second call to action that repeats the first is replaced with a different one.
  if (data.secondCta && String(data.secondCta.button || '').trim().toLowerCase() === String(data.ctaText).trim().toLowerCase()) data.secondCta.button = 'Contact us';
  // Only the sections asked for are shown.
  const want = new Set(input.sections);
  for (const k of ['features', 'products', 'stats', 'steps', 'faq']) if (!want.has(k)) data[k] = [];
  if (!want.has('features')) data.bullets = [];
  for (const k of ['testimonial', 'event', 'comparison', 'secondCta']) if (!want.has(k)) data[k] = undefined;

  // Pictures: banner, then the newsletter articles or a couple for the body, then one per product.
  let images = [];
  if (input.images) {
    const need = Math.min(MAX_IMAGES, 1 + (input.style === 'newsletter' ? data.sections.length : 1) + data.products.length);
    const candidates = (site?.pictures || []).map(url => ({ url, source: 'website' }));
    images = await storePictures(ctx, candidates, importId, need);
    if (images.length < need) {
      const stock = await stockPhotos(data.imageQuery || data.headline, need - images.length + 3);
      images = images.concat(await storePictures(ctx, stock, importId, need - images.length));
    }
  }
  if (!logoId && site?.logo) logoId = await storeSiteLogo(ctx, site.logo, importId);

  const color = input.brandColor || site?.themeColor || DEFAULT_COLOR;
  const brand = site?.siteName || (site?.title ? site.title.split(/\s[|\-–—:]\s/)[0].slice(0, 60) : '');
  const ctaUrl = input.ctaUrl || (site ? site.url : 'https://example.com');
  const html = render(data, {
    brand, color, ctaUrl, images, logoId, type: input.type,
    style: input.style, theme: input.theme, font: input.font, buttonShape: input.buttonShape,
    socials: input.socials, address: input.address
  });
  const category = input.style === 'newsletter' ? 'Newsletter'
    : { Promotion: 'Promotion', Newsletter: 'Newsletter', Announcement: 'Announcement', Welcome: 'Welcome', 'Follow-up': 'Custom' }[input.type];
  const usedAssets = images.length || logoId;
  return {
    name: data.templateName, subject: data.subject, category, provider,
    html: expandAssetRefs(html),
    importId: usedAssets ? importId : null,
    images: { website: images.filter(i => i.source === 'website').length, stock: images.filter(i => i.source === 'stock').length, stockAvailable: !!process.env.PIXABAY_API_KEY, logo: !!logoId },
    website: site ? { url: site.url, title: site.title || null, logo: !!site.logo, color: site.themeColor || null } : null
  };
}

module.exports = { generate, uploadLogo, readPage, render, tokens, contentSchema, inputSchema, stockPhotos, imageSize, photoShaped, TYPES, TONES, STYLES, SECTIONS, SOCIALS };
