/**
 * Turns untrusted email HTML into a document that is safe to show in a sandboxed preview iframe.
 *
 * Angular's HTML sanitizer is not used because it strips <style> and style="" attributes, which
 * would make every email preview wrong. Instead the preview has three layers:
 *  1. this function, which parses the HTML in an inert document (nothing runs or loads while
 *     parsing) and removes active content: scripts, frames, plugins, <base>, meta refresh,
 *     event-handler attributes and javascript:/vbscript:/data:text/html URLs; forms become plain
 *     blocks and links keep their text but lose their target, so nothing can navigate or submit;
 *  2. a Content-Security-Policy inside the preview document: no scripts, no connections, no
 *     frames, no form submission; only images, fonts and styles (what an email needs) may load;
 *  3. the iframe's sandbox="" attribute: unique origin (no cookies, storage, tokens or parent
 *     access), no scripts, forms, popups, plugins or top-level navigation.
 * Unsubscribe placeholders such as $[LI:UNSUBSCRIBE]$ stay visible as link text; they are never
 * followed.
 */
export interface PreparedPreview {
  /** Complete document for iframe srcdoc. */
  doc: string;
  /** True when the HTML has nothing that would show (e.g. only tags, or broken markup). */
  nothingVisible: boolean;
}

export const PREVIEW_CSP = "default-src 'none'; img-src https: data: cid:; style-src 'unsafe-inline' https:; font-src https: data:; form-action 'none'; base-uri 'none'; frame-src 'none'; child-src 'none'; media-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'";

const REMOVE = 'script, noscript, iframe, frame, frameset, object, embed, applet, base, portal, template, meta[http-equiv], link:not([rel~="stylesheet"])';
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'xlink:href', 'background', 'poster', 'srcset', 'lowsrc', 'dynsrc', 'data', 'ping'];
const DANGEROUS_URL = /^\s*(javascript|vbscript|data\s*:\s*text\/html)/i;
const VISIBLE = 'img, table, hr, svg, video, picture, input, button, textarea, select';

const BASE_STYLE = 'html,body{margin:0;padding:0}body{padding:12px;overflow-wrap:anywhere;-webkit-text-size-adjust:100%}img{max-width:100%;height:auto}a[data-preview-href]{cursor:default}';

/** A plain-text email shown in the preview: escaped, never interpreted as HTML. */
export function textToPreviewHtml(text: string | null | undefined): string {
  const t = String(text ?? '');
  if (!t.trim()) return '';
  const esc = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<pre style="white-space:pre-wrap;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;margin:0">${esc}</pre>`;
}

export function prepareEmailPreview(html: string): PreparedPreview {
  const parsed = new DOMParser().parseFromString(html || '', 'text/html');

  parsed.querySelectorAll(REMOVE).forEach(el => el.remove());

  // Forms keep their look but cannot submit anything.
  parsed.querySelectorAll('form').forEach(form => {
    const div = parsed.createElement('div');
    for (const a of Array.from(form.attributes)) if (a.name === 'class' || a.name === 'style') div.setAttribute(a.name, a.value);
    while (form.firstChild) div.appendChild(form.firstChild);
    form.replaceWith(div);
  });

  for (const el of Array.from(parsed.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
      if (URL_ATTRS.includes(name) && DANGEROUS_URL.test(attr.value)) el.removeAttribute(attr.name);
    }
    // Links show their text (and where they point, on hover) but are not followed.
    const tag = el.tagName.toLowerCase();
    if ((tag === 'a' || tag === 'area') && el.hasAttribute('href')) {
      const href = el.getAttribute('href') || '';
      el.removeAttribute('href');
      el.setAttribute('data-preview-href', href);
      if (!el.hasAttribute('title')) el.setAttribute('title', `Link (not opened in preview): ${href}`);
    }
    if (el.hasAttribute('xlink:href')) el.removeAttribute('xlink:href');
    if (el.hasAttribute('target')) el.removeAttribute('target');
  }

  const body = parsed.body;
  const nothingVisible = !(body?.textContent || '').trim() && !body?.querySelector(VISIBLE);

  const head = parsed.head;
  const prepend = (node: Element) => head.insertBefore(node, head.firstChild);
  const style = parsed.createElement('style');
  style.textContent = BASE_STYLE;
  prepend(style); // first, so the email's own styles win
  const csp = parsed.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', PREVIEW_CSP);
  prepend(csp);
  const referrer = parsed.createElement('meta');
  referrer.setAttribute('name', 'referrer');
  referrer.setAttribute('content', 'no-referrer');
  prepend(referrer);
  const charset = parsed.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  prepend(charset);

  return { doc: '<!doctype html>\n' + parsed.documentElement.outerHTML, nothingVisible };
}
