/**
 * Who may get Zoho marketing campaigns (Zoho's API has no consent or "marketing subscriber" field,
 * so Marketech.ai decides whom it uploads):
 * - contacts that came from the workspace's own Zoho lists (already Zoho subscribers), or
 * - contacts whose lead has marketing consent "granted", with how and when it was given recorded
 *   (the same standard as Product Emails; a note without evidence is not trusted).
 * A withdrawn consent always wins, and the stop-list (unsubscribed, bounced, complaint) is applied
 * separately by every query that uses these.
 * `c` is the mail_contacts alias in the calling query.
 */
const GRANTED = alias => `${alias}.marketing_consent = 'granted' AND ${alias}.marketing_consent_method IS NOT NULL AND ${alias}.marketing_consent_evidence IS NOT NULL`;

const consentedSql = (c = 'c') =>
  `(${c}.source = 'zoho' OR EXISTS (SELECT 1 FROM leads cl WHERE cl.workspace_id = ${c}.workspace_id AND LOWER(TRIM(cl.email)) = ${c}.email AND ${GRANTED('cl')}))`;

const withdrawnSql = (c = 'c') =>
  `EXISTS (SELECT 1 FROM leads wl WHERE wl.workspace_id = ${c}.workspace_id AND LOWER(TRIM(wl.email)) = ${c}.email AND wl.marketing_consent = 'withdrawn')`;

/** Both rules: may get campaigns. */
const eligibleSql = (c = 'c') => `(${consentedSql(c)} AND NOT ${withdrawnSql(c)})`;

/** "method|YYYY-MM-DD" of the contact's recorded consent (newest lead), for Zoho's contact source. */
const consentInfoSql = (c = 'c') =>
  `(SELECT CONCAT_WS('|', ci.marketing_consent_method, DATE_FORMAT(COALESCE(ci.marketing_consent_obtained_at, ci.marketing_consent_at), '%Y-%m-%d'))
     FROM leads ci WHERE ci.workspace_id = ${c}.workspace_id AND LOWER(TRIM(ci.email)) = ${c}.email AND ${GRANTED('ci')} ORDER BY ci.id DESC LIMIT 1)`;

// Product Emails' consent methods (productEmails/service.js CONSENT_METHODS), as shown in Zoho.
const METHOD_LABEL = { web_form: 'web form', double_opt_in: 'double opt-in', checkbox_at_signup: 'sign-up checkbox', written: 'written', event_signup: 'event sign-up', customer_request: 'customer request', imported_with_proof: 'import with proof' };

/**
 * The text written to Zoho's (documented, free-text) contact source for a consented contact, e.g.
 * "Marketech.ai · consent: web form · 2026-10-01". Method and date only: never the evidence text.
 */
function zohoSource(consentInfo) {
  if (!consentInfo) return 'Marketech.ai';
  const [method, date] = String(consentInfo).split('|');
  const m = METHOD_LABEL[method] || String(method || '').replace(/[^a-z0-9 _-]/gi, '').replace(/_/g, ' ').slice(0, 30);
  return ['Marketech.ai', m ? `consent: ${m}` : 'consent', date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null].filter(Boolean).join(' · ').slice(0, 100);
}

module.exports = { consentedSql, withdrawnSql, eligibleSql, consentInfoSql, zohoSource };
