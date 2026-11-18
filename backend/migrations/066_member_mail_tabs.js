/**
 * Mail Center tab access per member: workspace_members.mail_tabs_json lists the Mail Center tabs
 * (inbox, campaigns, deliverability, templates, logs) a member may open. NULL = all of them, so every
 * existing member keeps the access they had. Owners and Admins always have every tab.
 * Reversible: down() drops the column.
 */
module.exports = {
  id: '066_member_mail_tabs',
  async up(db) {
    await db.ensureColumn('workspace_members', 'mail_tabs_json', 'TEXT NULL');
  },
  async down(db) {
    await db.query('ALTER TABLE workspace_members DROP COLUMN mail_tabs_json').catch(() => null);
  }
};
