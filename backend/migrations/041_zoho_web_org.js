/**
 * The Zoho Campaigns org number (as in campaigns.zoho.com/campaigns/org831854179/…), so "Open in Zoho"
 * links open the campaign directly instead of Zoho's sign-in page. The API does not report it, so it is
 * taken once from a Zoho Campaigns address the person pastes.
 */
module.exports = {
  id: '041_zoho_web_org',
  async up(db) {
    await db.ensureColumn('mail_provider_connections', 'web_org', 'VARCHAR(30) NULL');
  }
};
