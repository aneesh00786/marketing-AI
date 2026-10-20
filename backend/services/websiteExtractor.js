const aiEngine = require('./aiEngine');
const { assertSafeUrl, safeFetchText } = require('../lib/safeFetch');

/**
 * Live website product extractor shared by the Products hub and the social campaign builder.
 * Fetches through the SSRF-safe client, parses visible structure, then asks the AI engine
 * to summarise real features. Pricing is never returned.
 */
function normalizeUrl(url) {
  let targetUrl = String(url || '').trim();
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }
  return targetUrl;
}

function parseHtml(html) {
  let pageTitle = '';
  const headings = [];
  const bulletPoints = [];

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) pageTitle = titleMatch[1].trim();

  // Extract headings for real feature detection
  for (const m of html.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)) {
    const hText = m[1].replace(/<[^>]+>/g, '').trim();
    if (hText && hText.length > 3 && hText.length < 140 && !headings.includes(hText)) {
      headings.push(hText);
    }
  }

  // Extract list items or module bullet lines
  for (const m of html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const liText = m[1].replace(/<[^>]+>/g, '').trim();
    if (liText && liText.length > 5 && liText.length < 200 && !bulletPoints.includes(liText)) {
      bulletPoints.push(liText);
    }
  }

  // Strip scripts, styles, tags for clean textual analysis
  const textContent = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 5000);

  return { pageTitle, headings, bulletPoints, textContent };
}

/** @returns {Promise<{ product: object, fetched: boolean }>} throws UnsafeUrlError for blocked destinations */
async function extractFromUrl(url) {
  const targetUrl = normalizeUrl(url);
  assertSafeUrl(targetUrl);

  let parsed = { pageTitle: '', headings: [], bulletPoints: [], textContent: '' };
  let fetched = false;
  try {
    const resp = await safeFetchText(targetUrl, {
      timeoutMs: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TradeSageBot/1.0; +website-import)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (resp.ok) {
      parsed = parseHtml(resp.text);
      fetched = true;
    }
  } catch (fetchErr) {
    if (fetchErr.code === 'UNSAFE_URL') throw fetchErr;
    console.warn(`Live URL fetch warning for ${targetUrl}:`, fetchErr.message);
  }

  const product = await aiEngine.extractProductFromWebpage(targetUrl, parsed.textContent, parsed.pageTitle, {
    headings: parsed.headings,
    bulletPoints: parsed.bulletPoints
  });
  // Guarantee no pricing is returned for any product
  product.pricing = [];
  return { product, fetched };
}

module.exports = { extractFromUrl, parseHtml, normalizeUrl };
