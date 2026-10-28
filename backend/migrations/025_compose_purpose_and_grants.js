/**
 * Compose purpose audit and per-member capability grants. Additive only; creates no grants.
 *
 * A. mail_send_requests (one row per Compose send, keyed by its Idempotency-Key):
 *    declared_purpose / applied_purpose / purpose_reasons are written once, in the same INSERT that
 *    claims the key, and never updated afterwards. NULL on rows created before this migration
 *    ("not recorded" in the report — never read as transactional).
 *    Index (workspace_id, created_at) for the Owners/Admins Compose report.
 * B. workspace_member_capability_grants: capabilities granted to one member in one workspace on top
 *    of their role. Only grantable capabilities are honoured (lib/capabilityGrants.js: currently
 *    mail.send_transactional, for roles that already include mail.send); a grant is ignored as soon
 *    as the member's role no longer qualifies. Removed with the workspace or the user.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '025_compose_purpose_and_grants',

  async up(db) {
    await db.ensureColumn('mail_send_requests', 'declared_purpose', 'VARCHAR(20) NULL');
    await db.ensureColumn('mail_send_requests', 'applied_purpose', 'VARCHAR(20) NULL');
    await db.ensureColumn('mail_send_requests', 'purpose_reasons', 'VARCHAR(255) NULL');
    await db.ensureIndex('mail_send_requests', 'idx_mail_send_requests_ws_created', 'KEY idx_mail_send_requests_ws_created (workspace_id, created_at)');

    await db.ensureTable('workspace_member_capability_grants', `CREATE TABLE workspace_member_capability_grants (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      user_id INT NOT NULL,
      capability VARCHAR(64) CHARACTER SET ascii NOT NULL,
      granted_by INT NULL,
      granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_member_capability (workspace_id, user_id, capability),
      KEY idx_member_capability_user (user_id),
      CONSTRAINT fk_member_capability_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_member_capability_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_member_capability_grantor FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL
    ) ${TABLE_OPTS}`);
  }
};
