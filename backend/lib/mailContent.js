/**
 * Unresolved [bracketed placeholders] in an email ("[Your name]", "[pricing details]").
 * AI and template drafts mark facts they could not fill this way; such an email must not be
 * approved or sent until a person replaces them. HTML is checked on its visible text only
 * (styles, scripts, comments such as <!--[if mso]> and tags are ignored).
 */
const PLACEHOLDER_RE = /\[[^[\]{}<>\n]{0,80}[A-Za-z][^[\]{}<>\n]{0,80}\]/g;
// Template personalization tokens, e.g. {{first_name}}, {{company}} (same syntax as outreach).
const TOKEN_RE = /\{\{\s*[A-Za-z_][A-Za-z0-9_.]{0,40}\s*\}\}/g;
// Zoho Campaigns merge tags ($[LI:UNSUBSCRIBE]$) are filled by Zoho, not placeholders.
const ZOHO_TAG_RE = /\$\[[^\]\n]{1,80}\]\$/g;
const TEMPLATE_TOKENS = ['first_name', 'company'];

/** A single placeholder string, either style. */
function isPlaceholderKey(k) {
  return new RegExp(`^(?:${PLACEHOLDER_RE.source}|${TOKEN_RE.source})$`).test(String(k));
}

function visibleText(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#91;/g, '[').replace(/&#93;/g, ']')
    .replace(/&nbsp;/g, ' ');
}

function unresolvedPlaceholders({ subject = '', text = '', html = '' } = {}) {
  const found = new Set();
  for (const part of [subject, text, visibleText(html)]) {
    const p = String(part || '').replace(ZOHO_TAG_RE, '');
    for (const m of p.match(PLACEHOLDER_RE) || []) found.add(m.trim());
    for (const m of p.match(TOKEN_RE) || []) found.add(m.trim());
  }
  return [...found].slice(0, 20);
}

function placeholderError(list) {
  const err = new Error(`Replace the placeholders before sending: ${list.join(', ')}.`);
  err.status = 400;
  err.code = 'UNRESOLVED_PLACEHOLDERS';
  err.placeholders = list;
  return err;
}

/** Throws UNRESOLVED_PLACEHOLDERS when the email still contains placeholders. */
function assertNoPlaceholders(parts) {
  const list = unresolvedPlaceholders(parts);
  if (list.length) throw placeholderError(list);
}

const escapeHtml = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Replaces exact placeholders with values (HTML-escaped in the HTML body). */
function fillPlaceholders({ subject = '', text = '', html = '' }, replacements) {
  let s = String(subject || '');
  let t = String(text || '');
  let hBody = String(html || '');
  for (const [key, value] of Object.entries(replacements)) {
    s = s.split(key).join(value);
    t = t.split(key).join(value);
    hBody = hBody.split(key).join(escapeHtml(value));
  }
  return { subject: s, text: t, html: hBody };
}

module.exports = { PLACEHOLDER_RE, TOKEN_RE, ZOHO_TAG_RE, TEMPLATE_TOKENS, isPlaceholderKey, unresolvedPlaceholders, assertNoPlaceholders, fillPlaceholders };
