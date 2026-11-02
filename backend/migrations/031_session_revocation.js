/**
 * Real sign-out. Additive only.
 * - users.session_version: every sign-in token records the version it was issued under. Raising it
 *   ("Sign out everywhere", a password reset) makes all of that user's existing tokens invalid.
 * - revoked_tokens: the ID of a single token signed out before it expired ("Sign out" on one
 *   device). Rows are only needed until the token would have expired, then they are removed.
 * Rollback: older code ignores both. To remove them, drop revoked_tokens and the column, and delete
 * the 031_session_revocation row from schema_migrations; signed-out tokens then work again until they expire.
 */
module.exports = {
  id: '031_session_revocation',

  async up(db) {
    await db.ensureColumn('users', 'session_version', 'INT NOT NULL DEFAULT 0');
    await db.ensureTable('revoked_tokens', `CREATE TABLE revoked_tokens (
      jti CHAR(32) CHARACTER SET ascii NOT NULL PRIMARY KEY,
      user_id INT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_revoked_tokens_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
  }
};
