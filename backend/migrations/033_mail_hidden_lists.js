/**
 * Zoho lists hidden in Marketech.ai. Additive only.
 * - mail_hidden_lists: a Zoho Campaigns list the workspace chose to remove from Marketech.ai only
 *   (Contact lists → Delete → "Remove from Marketech.ai"). The list stays in Zoho; removing the row
 *   shows it again. Lists themselves are never stored here.
 * Rollback: older code ignores the table; drop it and delete the 033 row from schema_migrations.
 */
module.exports = {
  id: '033_mail_hidden_lists',

  async up(db) {
    await db.ensureTable('mail_hidden_lists', `CREATE TABLE mail_hidden_lists (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      provider VARCHAR(40) NOT NULL,
      list_key VARCHAR(200) NOT NULL,
      list_name VARCHAR(200) NULL,
      hidden_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mail_hidden_lists (workspace_id, provider, list_key),
      CONSTRAINT fk_mail_hidden_lists_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
  }
};
