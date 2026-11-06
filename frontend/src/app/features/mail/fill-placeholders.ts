/**
 * "Fill in the template": finds the [bracketed] parts of an email and its sample links
 * (example.com), and puts the typed values into the HTML. Detection matches the server's
 * approval check (backend/lib/mailContent.js): visible text only, merge tags ignored.
 */
const PLACEHOLDER_RE = /\[[^[\]{}<>\n]{0,80}[A-Za-z][^[\]{}<>\n]{0,80}\]/g;
const MERGE_TAG_RE = /\$\[[^\]\n]{1,80}\]\$/g;
const SAMPLE_LINK_RE = /href=(["'])(https?:\/\/(?:www\.)?example\.(?:com|org|net)\b[^"']*)\1/gi;

function visibleText(html: string): string {
  return String(html || '')
    .replace(MERGE_TAG_RE, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#91;/g, '[').replace(/&#93;/g, ']')
    .replace(/&nbsp;/g, ' ');
}

/** The [bracketed] placeholders left in the email, in order, each once. */
export function findPlaceholders(html: string): string[] {
  const found: string[] = [];
  for (const m of visibleText(html).match(PLACEHOLDER_RE) || []) {
    const p = m.trim();
    if (!found.includes(p)) found.push(p);
  }
  return found;
}

/** Sample links (https://example.com…) still in the email, each once. */
export function findSampleLinks(html: string): string[] {
  const found: string[] = [];
  for (const m of String(html || '').matchAll(SAMPLE_LINK_RE)) if (!found.includes(m[2])) found.push(m[2]);
  return found;
}

/** "[Benefit 1, e.g. next-day delivery]" → label "Benefit 1", hint "e.g. next-day delivery". */
export function describePlaceholder(p: string): { label: string; hint: string } {
  const inner = decode(p.replace(/^\[|\]$/g, '').trim());
  const m = /^(.*?)[,;]?\s*\b(e\.g\..*)$/i.exec(inner);
  if (m && m[1].trim()) return { label: m[1].trim(), hint: m[2].trim() };
  const colon = inner.indexOf(':');
  if (colon > 0) return { label: inner.slice(0, colon).trim(), hint: inner.slice(colon + 1).trim() };
  return { label: inner, hint: '' };
}

/** Is the text a URL a person can be sent to? */
export function isWebLink(v: string): boolean {
  return /^https:\/\/[^\s"'<>]+\.[^\s"'<>]+$/i.test(v.trim()) || /^mailto:[^\s"'<>]+@[^\s"'<>]+$/i.test(v.trim()) || /^tel:\+?[0-9 ()-]{5,}$/i.test(v.trim());
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replaces every occurrence of each filled placeholder (also written as &#91;…&#93;) and each
 * filled sample link. Empty values are left as they are. Values are HTML-escaped.
 */
export function fillPlaceholders(html: string, values: Record<string, string>, links: Record<string, string> = {}): string {
  let out = String(html || '');
  for (const [p, v] of Object.entries(values)) {
    const text = String(v || '').trim();
    if (!text) continue;
    const inner = p.slice(1, -1);
    out = out.replace(new RegExp(`\\[${reEsc(inner)}\\]|&#91;${reEsc(inner)}&#93;`, 'g'), () => esc(text));
  }
  for (const [url, v] of Object.entries(links)) {
    const to = String(v || '').trim();
    if (!to || !isWebLink(to)) continue;
    out = out.replace(new RegExp(`href=(["'])${reEsc(url)}\\1`, 'g'), (_m, q) => `href=${q}${esc(to)}${q}`);
  }
  return out;
}
