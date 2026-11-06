/**
 * Who may get marketing campaigns: everyone in the list except people whose lead withdrew marketing
 * consent. Recording consent is not required for campaigns (Product Emails still require it). The
 * stop-list (unsubscribed, bounced, complaint) is applied separately by every query that uses these.
 * `c` is the mail_contacts alias in the calling query.
 */
const GRANTED = alias => `${alias}.marketing_consent = 'granted' AND ${alias}.marketing_consent_method IS NOT NULL AND ${alias}.marketing_consent_evidence IS NOT NULL`;

const consentedSql = (c = 'c') =>
  `(EXISTS (SELECT 1 FROM leads cl WHERE cl.workspace_id = ${c}.workspace_id AND LOWER(TRIM(cl.email)) = ${c}.email AND ${GRANTED('cl')}))`;

const withdrawnSql = (c = 'c') =>
  `EXISTS (SELECT 1 FROM leads wl WHERE wl.workspace_id = ${c}.workspace_id AND LOWER(TRIM(wl.email)) = ${c}.email AND wl.marketing_consent = 'withdrawn')`;

/** May get campaigns: not withdrawn. (consentedSql: consent recorded, for display only.) */
const eligibleSql = (c = 'c') => `(NOT ${withdrawnSql(c)})`;

module.exports = { consentedSql, withdrawnSql, eligibleSql };
