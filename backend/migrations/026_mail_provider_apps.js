/**
 * Zoho Campaigns API client entered in Mail Center → Settings, per workspace. Additive only.
 *
 * mail_provider_apps holds the OAuth client (Client ID + Client Secret) a workspace registered in
 * the Zoho API Console. The secret is stored encrypted with SOCIAL_TOKEN_ENCRYPTION_KEY (like the
 * Zoho refresh token and mailbox passwords) and is never returned by the API. When a workspace has
 * no row, the server's ZOHO_CAMPAIGNS_CLIENT_ID / ZOHO_CAMPAIGNS_CLIENT_SECRET are used as before.
 * Deleting the workspace deletes its row.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '026_mail_provider_apps',

  async up(db) {
    await db.ensureTable('mail_provider_apps', `CREATE TABLE mail_provider_apps (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      provider VARCHAR(40) NOT NULL,
      client_id VARCHAR(150) NOT NULL,
      client_secret_ciphertext TEXT NOT NULL,
      updated_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_mail_provider_apps (workspace_id, provider),
      CONSTRAINT fk_mail_provider_apps_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);
  }
};
