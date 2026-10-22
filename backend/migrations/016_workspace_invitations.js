/**
 * Workspace invitations. One row per invitation to one workspace:
 * - token_hash: SHA-256 of a random single-use token (the token itself is never stored);
 * - status: pending | accepted | declined | cancelled | expired, with expires_at;
 * - pending_email: a generated column set only while pending, so a UNIQUE key allows at most one
 *   pending invitation per (workspace, email) while keeping the history of earlier ones.
 * Additive only: existing users, workspaces and memberships are untouched.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '016_workspace_invitations',

  async up(db) {
    await db.ensureTable('workspace_invitations', `CREATE TABLE workspace_invitations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      email VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      token_hash CHAR(64) CHARACTER SET ascii NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      pending_email VARCHAR(255) AS (CASE WHEN status = 'pending' THEN email ELSE NULL END) STORED,
      invited_by INT NULL,
      accepted_by INT NULL,
      expires_at DATETIME NOT NULL,
      responded_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_workspace_invitations_token (token_hash),
      UNIQUE KEY uq_workspace_invitations_pending (workspace_id, pending_email),
      KEY idx_workspace_invitations_email (email, status),
      KEY idx_workspace_invitations_ws (workspace_id, status),
      CONSTRAINT fk_workspace_invitations_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_workspace_invitations_inviter FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_workspace_invitations_acceptor FOREIGN KEY (accepted_by) REFERENCES users(id) ON DELETE SET NULL
    ) ${TABLE_OPTS}`);
  }
};
