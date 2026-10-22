/**
 * Mail delivery safety and Zoho Campaigns (existing campaigns only). Additive only.
 * - mail_send_requests: one row per (workspace, Idempotency-Key) of a direct send, so a retried
 *   or double-submitted request never sends twice.
 * - mail_provider_connections: a workspace's connection to an external mail provider
 *   (zoho_campaigns): data center, encrypted refresh token, status. One per workspace + provider.
 * - zoho_campaign_submissions: Marketech.ai's send requests for campaigns that live in Zoho.
 *   One row per (workspace, campaign key), so a campaign is submitted at most once; the
 *   submission status is kept apart from Zoho's own campaign/delivery status.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '017_mail_safety_and_zoho',

  async up(db) {
    await db.ensureTable('mail_send_requests', `CREATE TABLE mail_send_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      idempotency_key VARCHAR(100) CHARACTER SET ascii NOT NULL,
      request_hash CHAR(64) CHARACTER SET ascii NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'sending',
      email_id INT NULL,
      error VARCHAR(500) NULL,
      requested_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_mail_send_requests_key (workspace_id, idempotency_key),
      CONSTRAINT fk_mail_send_requests_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('mail_provider_connections', `CREATE TABLE mail_provider_connections (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      provider VARCHAR(40) NOT NULL,
      location VARCHAR(10) NULL,
      accounts_server VARCHAR(100) NULL,
      api_host VARCHAR(100) NULL,
      refresh_token_ciphertext TEXT NULL,
      scopes VARCHAR(500) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'connected',
      last_error VARCHAR(500) NULL,
      connected_by INT NULL,
      connected_at DATETIME NULL,
      last_checked_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_mail_provider_connections (workspace_id, provider),
      CONSTRAINT fk_mail_provider_connections_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('zoho_campaign_submissions', `CREATE TABLE zoho_campaign_submissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      campaign_key VARCHAR(100) NOT NULL,
      campaign_name VARCHAR(255) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'submitting',
      provider_code VARCHAR(20) NULL,
      provider_message VARCHAR(500) NULL,
      zoho_status VARCHAR(50) NULL,
      report_json TEXT NULL,
      requested_by INT NULL,
      requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      submitted_at DATETIME NULL,
      last_checked_at DATETIME NULL,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_zoho_campaign_submissions (workspace_id, campaign_key),
      KEY idx_zoho_campaign_submissions_status (workspace_id, status),
      CONSTRAINT fk_zoho_campaign_submissions_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);
  }
};
