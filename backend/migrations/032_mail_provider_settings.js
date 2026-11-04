/**
 * Zoho Campaigns plan limit per workspace. Additive only.
 * - mail_provider_settings.contact_limit: how many contacts the workspace's Zoho plan allows
 *   (subscriber-based plans). Zoho does not report it through its API, so an admin types it in;
 *   Marketech.ai uses it to warn before adding or importing contacts. Zoho still enforces the limit.
 * Rollback: older code ignores the table; drop it and delete the 032 row from schema_migrations.
 */
module.exports = {
  id: '032_mail_provider_settings',

  async up(db) {
    await db.ensureTable('mail_provider_settings', `CREATE TABLE mail_provider_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      provider VARCHAR(40) NOT NULL,
      contact_limit INT NULL,
      updated_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_mail_provider_settings (workspace_id, provider),
      CONSTRAINT fk_mail_provider_settings_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
  }
};
