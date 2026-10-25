/**
 * Personalization tokens in template HTML ({{first_name}}, {{company}}; same syntax as outreach)
 * and HTML-escaped filling for single emails. The server re-checks that none remain before sending.
 */
export const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]{0,40})\s*\}\}/g;

/** Distinct token names used in the HTML, e.g. ['first_name', 'company']. */
export function findTokens(html: string): string[] {
  const names = new Set<string>();
  for (const m of String(html || '').matchAll(TOKEN_RE)) names.add(m[1]);
  return [...names];
}

export function escapeHtml(v: string): string {
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

/** Replaces the given tokens with escaped values; tokens without a value are left in place. */
export function fillTokens(html: string, values: Record<string, string>): string {
  return String(html || '').replace(TOKEN_RE, (m, name) => {
    const v = (values[name] || '').trim();
    return v ? escapeHtml(v) : m;
  });
}

/** Sensible defaults from a recipient name. */
export function defaultTokenValues(tokens: string[], recipientName: string): Record<string, string> {
  const first = String(recipientName || '').trim().split(/\s+/)[0] || '';
  return Object.fromEntries(tokens.map(t => [t, t === 'first_name' ? first : '']));
}
