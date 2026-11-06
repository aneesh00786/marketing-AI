/**
 * Campaign merge tags filled by Marketech.ai:
 * - business_profiles.address: the workspace's business address, filled into $[HF:ORGADDRESS]$
 *   (anti-spam laws ask for a postal address in marketing email).
 * - mail_campaign_recipients.view_token: each recipient's own "View in browser" page
 *   ($[LI:VIEWINBROWSER]$), an opaque random token (unique), showing that person's email.
 */
module.exports = {
  id: '044_campaign_merge_tags',
  async up(db) {
    await db.ensureColumn('business_profiles', 'address', 'TEXT NULL');
    await db.ensureColumn('mail_campaign_recipients', 'view_token', 'CHAR(32) CHARACTER SET ascii NULL');
    await db.ensureIndex('mail_campaign_recipients', 'uq_mail_campaign_recipient_view', 'UNIQUE KEY uq_mail_campaign_recipient_view (view_token)');
  }
};
