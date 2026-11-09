/**
 * Page selection after a Meta (Facebook) login:
 * - oauth_pending_selections: the Pages found during the OAuth callback, held server-side
 *   (tokens encrypted with secretBox) until the user picks which Page(s) to connect.
 *   Bound to the workspace, user and provider; single-use; expires after 15 minutes.
 *   Only a random selection id (stored hashed) ever reaches the browser — never a token.
 * Reversible: down() drops the table.
 */
module.exports = {
  id: '050_oauth_page_selection',
  async up(db) {
    await db.ensureTable('oauth_pending_selections', `CREATE TABLE oauth_pending_selections (
      id INT AUTO_INCREMENT PRIMARY KEY,
      selection_hash CHAR(64) NOT NULL,
      workspace_id INT NOT NULL,
      user_id INT NOT NULL,
      provider_key VARCHAR(30) NOT NULL,
      accounts_ciphertext MEDIUMTEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_oauth_selection (selection_hash),
      KEY idx_oauth_selection_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
  },
  async down(db) {
    await db.query('DROP TABLE IF EXISTS oauth_pending_selections');
  }
};
