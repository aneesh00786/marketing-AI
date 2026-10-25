const sanitizeHtml = require('sanitize-html');
const { Parser } = require('htmlparser2');

/**
 * Email HTML is untrusted (uploaded files, ZIP imports, pasted code). sanitizeEmailHtml keeps
 * email markup (tables, inline styles, <style> blocks, legacy attributes) and removes everything
 * executable: scripts, event handlers, forms, frames/embeds, dangerous URL schemes and CSS
 * expressions. It runs on the server whenever template or campaign HTML is saved.
 *
 * Images may use https/http, data: and the internal asset reference mkt-asset://<id>, which is
 * turned into a public asset URL when the HTML is used (see expandAssetRefs).
 */
const ALLOWED_TAGS = [
  'html', 'head', 'body', 'meta', 'title', 'style',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'div', 'span', 'p', 'a', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'wbr',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'mark',
  'sub', 'sup', 'small', 'big', 'blockquote', 'q', 'cite', 'pre', 'code', 'abbr', 'address', 'time',
  'center', 'font', 'section', 'header', 'footer', 'article', 'main', 'nav', 'figure', 'figcaption'
];
const GLOBAL_ATTRS = ['style', 'class', 'id', 'align', 'valign', 'width', 'height', 'bgcolor', 'background', 'border', 'dir', 'lang', 'title', 'role', 'aria-*'];
const OPTIONS = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    '*': GLOBAL_ATTRS,
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height', 'border', 'hspace', 'vspace'],
    table: ['cellpadding', 'cellspacing', 'summary'],
    td: ['colspan', 'rowspan', 'nowrap', 'scope'],
    th: ['colspan', 'rowspan', 'nowrap', 'scope'],
    col: ['span'],
    colgroup: ['span'],
    font: ['color', 'face', 'size'],
    meta: ['charset', 'name', 'content'],
    ol: ['start', 'type'],
    ul: ['type'],
    li: ['value'],
    style: ['type', 'media']
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel', 'mkt-asset'],
  allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid', 'mkt-asset'] },
  allowedSchemesAppliedToAttributes: ['href', 'src', 'background', 'cite'],
  allowProtocolRelative: false,
  // <style> is needed for email layouts; its CSS is cleaned below (cleanCss).
  allowVulnerableTags: true,
  parseStyleAttributes: false,
  nonTextTags: ['script', 'noscript', 'textarea', 'option', 'select', 'iframe', 'object', 'embed', 'template', 'xmp', 'noembed', 'noframes', 'svg', 'math', 'button'],
  transformTags: {
    '*': (tagName, attribs) => {
      if (attribs.style) attribs.style = cleanCss(attribs.style, { inline: true });
      if (tagName === 'a' && attribs.target === '_blank') attribs.rel = 'noopener noreferrer';
      if (tagName === 'meta' && !/^(viewport|color-scheme|supported-color-schemes|x-apple-disable-message-reformatting|format-detection)$/i.test(attribs.name || '')) {
        delete attribs.content;
      }
      return { tagName, attribs };
    }
  }
};

/** Removes executable or dangerous CSS: expressions, script URLs, bindings, remote @imports. */
function cleanCss(css, { inline = false } = {}) {
  let out = String(css || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<\/?\s*style/gi, '')
    .replace(/expression\s*\(/gi, 'blocked(')
    .replace(/(java|vb)script\s*:/gi, 'blocked:')
    .replace(/behavior\s*:/gi, 'blocked-behavior:')
    .replace(/-moz-binding\s*:/gi, 'blocked-binding:')
    .replace(/url\(\s*(['"]?)\s*data:(?!image\/(png|jpe?g|gif|webp);)[^)]*\)/gi, 'none');
  if (!inline) out = out.replace(/@import[^;]*;?/gi, '');
  return out;
}

function sanitizeEmailHtml(html) {
  const clean = sanitizeHtml(String(html || ''), OPTIONS);
  // <style> contents are not filtered by sanitize-html; clean them here.
  return clean.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) => `${open}${cleanCss(css)}${close}`);
}

/**
 * Compatibility and safety warnings for the raw (unsanitized) HTML, so nothing is removed or
 * changed silently. Returned as user-facing sentences.
 */
function analyzeEmailHtml(html) {
  const raw = String(html || '');
  const found = { scripts: 0, handlers: 0, forms: 0, frames: 0, media: 0, svg: 0, externalCss: 0, base: 0, refresh: 0, jsUrls: 0, insecureImages: 0, dataImages: 0, relative: new Set() };
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === 'script') found.scripts++;
      if (['form', 'input', 'button', 'select', 'textarea'].includes(name)) found.forms++;
      if (['iframe', 'frame', 'frameset', 'object', 'embed', 'applet'].includes(name)) found.frames++;
      if (['video', 'audio', 'canvas'].includes(name)) found.media++;
      if (name === 'svg' || name === 'math') found.svg++;
      if (name === 'base') found.base++;
      if (name === 'link' && /stylesheet/i.test(attrs.rel || '')) found.externalCss++;
      if (name === 'meta' && /refresh/i.test(attrs['http-equiv'] || '')) found.refresh++;
      for (const [k, v] of Object.entries(attrs)) {
        if (/^on/i.test(k)) found.handlers++;
        if (/^\s*(java|vb)script:/i.test(v || '')) found.jsUrls++;
      }
      const src = name === 'img' ? attrs.src : (attrs.background || null);
      if (src) {
        if (/^http:\/\//i.test(src)) found.insecureImages++;
        else if (/^data:/i.test(src)) found.dataImages++;
        else if (!/^(https:|cid:|mkt-asset:)/i.test(src) && !/^\$\[/.test(src)) found.relative.add(src.slice(0, 120));
      }
    }
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.write(raw);
  parser.end();

  const w = [];
  if (found.scripts) w.push(`Removed ${found.scripts} <script> element(s): email clients never run scripts.`);
  if (found.handlers) w.push(`Removed ${found.handlers} event-handler attribute(s) (onclick, onload...).`);
  if (found.jsUrls) w.push('Removed javascript: links.');
  if (found.forms) w.push('Removed form elements (forms, inputs, buttons): most email clients block them. Use links instead.');
  if (found.frames) w.push('Removed iframes/embeds/objects: email clients do not show them.');
  if (found.media) w.push('Removed video/audio/canvas: most email clients do not play them. Use an image linking to the video.');
  if (found.svg) w.push('Removed inline SVG/MathML: poorly supported in email. Use PNG or JPG images.');
  if (found.base) w.push('Removed the <base> tag.');
  if (found.refresh) w.push('Removed a meta refresh.');
  if (found.externalCss) w.push('Stylesheet links (<link rel="stylesheet">) are not loaded by email clients and were removed. Styles from a ZIP package are embedded instead.');
  if (/<!--\[if/i.test(raw)) w.push('Removed Outlook conditional comments (<!--[if mso]>): Outlook-specific fixes in them are lost.');
  if (/@import/i.test(raw)) w.push('Removed CSS @import rules that could not be embedded.');
  if (/<style/i.test(raw)) w.push('Uses a <style> block: some email clients ignore it. Inline style="" attributes are the most reliable.');
  if (/position\s*:\s*(fixed|absolute|sticky)/i.test(raw)) w.push('Uses CSS positioning (fixed/absolute/sticky), which most email clients ignore.');
  if (/display\s*:\s*(flex|grid|inline-flex|inline-grid)/i.test(raw)) w.push('Uses CSS flexbox/grid, which many email clients (e.g. Outlook) do not support. Table layouts are safer.');
  if (/@font-face/i.test(raw)) w.push('Uses web fonts (@font-face): many email clients fall back to system fonts.');
  if (found.insecureImages) w.push(`${found.insecureImages} image(s) use http:// URLs: recipients may see broken or blocked images. Use https://.`);
  if (found.dataImages) w.push(`${found.dataImages} image(s) are embedded as data: URLs, which several email clients block.`);
  if (found.relative.size) w.push(`Missing image files (relative paths that cannot be loaded): ${[...found.relative].slice(0, 10).join(', ')}. Upload them in a ZIP package or use https:// image URLs.`);
  if (Buffer.byteLength(raw, 'utf8') > 102 * 1024) w.push('Larger than 102 KB: Gmail clips long messages.');
  return w;
}

// ------------------------------------------------------------------ asset references

const ASSET_REF_RE = /mkt-asset:\/\/([A-Za-z0-9_-]{43})/g;
const ASSET_URL_RE = /https?:\/\/[^\s"'()<>]+?\/api\/v1\/mail\/assets\/([A-Za-z0-9_-]{43})/g;

function assetBaseUrl() {
  return (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 8000}`).replace(/\/$/, '');
}

const assetUrl = publicId => `${assetBaseUrl()}/api/v1/mail/assets/${publicId}`;

/** mkt-asset://id -> public asset URL (used when the HTML goes into an email, campaign or preview). */
function expandAssetRefs(html) {
  return String(html || '').replace(ASSET_REF_RE, (m, id) => assetUrl(id));
}

/** Public asset URLs of the given ids -> mkt-asset://id, so saved templates survive domain changes. */
function collapseAssetUrls(html, ownIds) {
  return String(html || '').replace(ASSET_URL_RE, (m, id) => (ownIds.has(id) ? `mkt-asset://${id}` : m));
}

function assetIdsIn(html) {
  const ids = new Set();
  for (const m of String(html || '').matchAll(ASSET_REF_RE)) ids.add(m[1]);
  for (const m of String(html || '').matchAll(ASSET_URL_RE)) ids.add(m[1]);
  return ids;
}

/** Plain-text alternative from HTML (for the text/plain part of emails). */
function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
}

module.exports = { sanitizeEmailHtml, analyzeEmailHtml, cleanCss, expandAssetRefs, collapseAssetUrls, assetIdsIn, assetUrl, htmlToText, ASSET_REF_RE };
