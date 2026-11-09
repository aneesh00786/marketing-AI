/**
 * "Make calls" permission (Members → Permissions), separate from CRM access.
 * - user_calling_access: people who may make calls through the company's Telnyx account (the 📞
 *   button). Granted and removed by the platform admin only, because calls are charged to the
 *   company and anyone who registers owns a workspace. CRM "manage" access still allows calling, as
 *   before, so nobody loses it.
 * Reversible: down() drops the table.
 */
module.exports = {
  id: '055_calling_access',
  async up(db) {
    await db.ensureTable('user_calling_access', `CREATE TABLE user_calling_access (
      user_id INT NOT NULL PRIMARY KEY,
      granted_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_user_calling_access_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_user_calling_access_granter FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
  },
  async down(db) {
    await db.query('DROP TABLE IF EXISTS user_calling_access');
  }
};
