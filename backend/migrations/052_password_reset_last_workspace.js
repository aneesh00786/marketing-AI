/**
 * Sign-in improvements:
 * - password_resets: single-use "forgot password" links. Only the SHA-256 of the token is stored;
 *   a link expires after PASSWORD_RESET_TTL_MINUTES (default 30) and a new request replaces older ones.
 * - users.last_workspace_id: the workspace a user last opened, so signing in returns them there
 *   (e.g. the team workspace they were invited to, not an empty one of their own).
 * Reversible: down() drops both.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';
module.exports = {
  id: '052_password_reset_last_workspace',
  async up(db) {
    await db.ensureTable('password_resets', `CREATE TABLE password_resets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      requested_ip VARCHAR(64) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_password_reset_token (token_hash),
      KEY idx_password_reset_user (user_id),
      KEY idx_password_reset_expires (expires_at),
      CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);
    await db.ensureColumn('users', 'last_workspace_id', 'INT NULL');
  },
  async down(db) {
    await db.query('DROP TABLE IF EXISTS password_resets');
    await db.query('ALTER TABLE users DROP COLUMN IF EXISTS last_workspace_id').catch(() => null);
  }
};
