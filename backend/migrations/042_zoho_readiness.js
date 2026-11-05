/**
 * What Zoho reports about a campaign's recipients when it was prepared or held: per list, how many
 * contacts Zoho shows as active (it emails only these), unsubscribed and bounced, and how many name
 * updates made Zoho ask for an email confirmation. Counts only, no addresses.
 */
module.exports = {
  id: '042_zoho_readiness',
  async up(db) {
    await db.ensureColumn('mail_campaigns', 'zoho_readiness_json', 'TEXT NULL');
  }
};
