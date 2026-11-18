/**
 * Email campaigns: send to chosen contacts of a contact list instead of the whole list.
 * mail_campaigns.mail_list_picks_json maps a chosen list's id to the contact ids picked from it
 * ({"12": [5, 9]}); a chosen list that is not in the map goes to everyone in it (as before).
 * Existing campaigns are unchanged (NULL = whole lists). Reversible: down() drops the column.
 */
module.exports = {
  id: '065_campaign_list_picks',
  async up(db) {
    await db.ensureColumn('mail_campaigns', 'mail_list_picks_json', 'MEDIUMTEXT NULL');
  },
  async down(db) {
    await db.query('ALTER TABLE mail_campaigns DROP COLUMN mail_list_picks_json').catch(() => null);
  }
};
