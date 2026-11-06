/**
 * Deliverability of Amazon SES campaigns:
 * - mail_delivery_settings.ses_warmup_enabled: new sender domains send a little more each day
 *   (on by default; an Owner/Admin can turn it off for a domain that is already warmed up elsewhere).
 * - an index for "emails sent in the last 24 hours / 14 days" (warm-up allowance, bounce and complaint rates).
 */
module.exports = {
  id: '045_ses_deliverability',
  async up(db) {
    await db.ensureColumn('mail_delivery_settings', 'ses_warmup_enabled', 'TINYINT(1) NOT NULL DEFAULT 1');
    await db.ensureIndex('mail_campaign_recipients', 'idx_mail_campaign_recipients_sent', 'KEY idx_mail_campaign_recipients_sent (workspace_id, status, sent_at)');
  }
};
