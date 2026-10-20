/**
 * Per-workspace provider app credentials ("bring your own app").
 * Each workspace can register its own Meta / LinkedIn / Google app from the UI.
 * The app secret is encrypted with SOCIAL_TOKEN_ENCRYPTION_KEY.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '003_workspace_provider_apps',

  async up(db) {
    await db.ensureTable('provider_apps', `CREATE TABLE provider_apps (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      provider_key VARCHAR(30) NOT NULL,
      client_id VARCHAR(255) NOT NULL,
      client_secret_ciphertext TEXT NOT NULL,
      settings_json LONGTEXT NULL,
      verified_at DATETIME NULL,
      verification_note VARCHAR(500) NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_provider_app (workspace_id, provider_key),
      CONSTRAINT fk_provider_apps_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);
    // Remember which app an account was connected through, so refresh/revoke use the same credentials.
    await db.ensureColumn('social_accounts', 'app_source', "VARCHAR(20) NOT NULL DEFAULT 'platform'");
  }
};
