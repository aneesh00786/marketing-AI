/**
 * Who may get marketing campaigns:
 * - contacts imported earlier from the workspace's Zoho Campaigns lists (source 'zoho': they were
 *   subscribers there), or
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

module.exports = { consentedSql, withdrawnSql, eligibleSql };
