/**
 * Zoho's numeric campaign id, next to its campaign key. Zoho's content review (accounts on its newer
 * platform) is started by id, not by key.
 */
module.exports = {
  id: '040_zoho_campaign_id',
  async up(db) {
    await db.ensureColumn('mail_campaigns', 'zoho_campaign_id', 'VARCHAR(30) NULL');
  }
};
