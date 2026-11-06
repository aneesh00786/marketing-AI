/**
 * Email purpose for Compose & Send: transactional/direct or marketing.
 *
 * The sender declares a purpose, but the server never trusts it on its own. A message is treated as
 * transactional ONLY when it was declared transactional AND nothing in it points to marketing:
 *  - the declared purpose is missing or invalid                       -> marketing (stricter rule)
 *  - a template was used whose category is not Transactional, Welcome or Custom (Newsletter,
 *    Promotion, Announcement, or any other category)                   -> marketing
 *  - the template id is not one of this workspace's templates          -> marketing
 *  - the message contains the content of one of the workspace's marketing templates (even when
 *    no template id is sent)                                           -> marketing
 *  - marketing markers: unsubscribe links or wording, campaign merge tags         -> marketing
 *  - two or more promotional phrases (discount/% off/sale/promo code/coupon/limited time/
 *    special or exclusive offer/buy, shop or order now/free trial/newsletter/subscribe now)
 *                                                                      -> marketing
 * Heuristics can miss a promotional message written by hand and declared transactional; every send
 * records the declared and the applied purpose (with reason codes) in the audit log.
 */
const { all, get } = require('../db/database');

const TRANSACTIONAL_TEMPLATE_CATEGORIES = new Set(['transactional', 'welcome']);
const NEUTRAL_TEMPLATE_CATEGORIES = new Set(['custom']);
const PROMO_PHRASES = [
  /\b\d{1,3}\s?%\s?off\b/i, /\bdiscount(s|ed)?\b/i, /\bsale\b/i, /\bpromo(tion(al)?)?\s?codes?\b/i, /\bcoupons?\b/i,
  /\blimited[-\s]time\b/i, /\b(special|exclusive)\s+offers?\b/i, /\b(buy|shop|order)\s+now\b/i, /\bfree\s+trial\b/i,
  /\bnewsletter\b/i, /\bsubscribe\s+now\b/i
];

const toText = html => String(html || '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
  .replace(/\s+/g, ' ').trim().toLowerCase();

/** Long literal pieces of a template (placeholders split it), used to recognise it inside a message. */
function templateSegments(html) {
  return toText(html).split(/\{\{[^}]*\}\}|\$\[[^\]]*\]\$|\[[^\]]{1,40}\]/).map(s => s.trim()).filter(s => s.length >= 40);
}

function contentSignals({ subject, html, text }) {
  const raw = `${subject || ''}\n${html || ''}\n${text || ''}`;
  const plain = `${String(subject || '').toLowerCase()} ${toText(html)} ${String(text || '').toLowerCase()}`;
  const reasons = [];
  if (/\$\[[A-Z]{2}:[A-Z_]+\]\$/.test(raw)) reasons.push('merge_tags');
  if (/\bunsubscribe\b|\bopt[-\s]?out\b|manage (your )?(email )?preferences/i.test(plain)) reasons.push('unsubscribe_wording');
  const promo = PROMO_PHRASES.filter(re => re.test(plain)).length;
  if (promo >= 2) reasons.push('promotional_phrases');
  return reasons;
}

/**
 * Returns { purpose: 'transactional' | 'marketing', declared, reasons: string[], reclassified: boolean }.
 * reasons explain why the stricter marketing rule applies (empty for a transactional result).
 */
async function classify(workspaceId, { declared, subject, html, text, templateId }) {
  const reasons = [];
  const d = declared === 'transactional' || declared === 'marketing' ? declared : null;
  if (!d) reasons.push('purpose_missing');
  if (d === 'marketing') reasons.push('declared_marketing');

  if (templateId !== undefined && templateId !== null) {
    const t = await get('SELECT category FROM mail_templates WHERE id = ? AND workspace_id = ?', [templateId, workspaceId]);
    if (!t) reasons.push('template_unknown');
    else {
      const cat = String(t.category || '').trim().toLowerCase();
      if (!TRANSACTIONAL_TEMPLATE_CATEGORIES.has(cat) && !NEUTRAL_TEMPLATE_CATEGORIES.has(cat)) reasons.push('template_marketing_category');
    }
  }

  // The content of a marketing template, pasted or loaded without saying so.
  const msgText = `${toText(html)} ${String(text || '').toLowerCase().replace(/\s+/g, ' ')}`;
  if (msgText.trim().length >= 40) {
    const templates = await all("SELECT category, html FROM mail_templates WHERE workspace_id = ? AND LOWER(category) NOT IN ('transactional', 'welcome', 'custom') ORDER BY id DESC LIMIT 200", [workspaceId]);
    if (templates.some(t => { const segs = templateSegments(t.html); return segs.length && segs.filter(s => msgText.includes(s)).length >= Math.min(2, segs.length); })) {
      reasons.push('matches_marketing_template');
    }
  }

  reasons.push(...contentSignals({ subject, html, text }));
  const purpose = d === 'transactional' && !reasons.length ? 'transactional' : 'marketing';
  return { purpose, declared: d, reasons: [...new Set(reasons)], reclassified: d === 'transactional' && purpose === 'marketing' };
}

module.exports = { classify, contentSignals, templateSegments, toText };
