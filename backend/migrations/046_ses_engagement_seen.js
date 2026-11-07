/**
 * mail_delivery_settings.ses_engagement_seen_at: the last time Amazon SES published its own Open or
 * Click event for the workspace (SES open/click tracking on in the configuration set). Those events
 * are ignored, since Marketech.ai tracks opens and clicks itself; Settings asks to turn SES's off.
 */
module.exports = {
  id: '046_ses_engagement_seen',
  async up(db) {
    await db.ensureColumn('mail_delivery_settings', 'ses_engagement_seen_at', 'DATETIME NULL');
  }
};
