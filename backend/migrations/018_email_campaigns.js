/**
 * Email campaigns written, approved and managed in Marketech.ai and delivered through Zoho
 * Campaigns. Additive only.
 * - Content, sender, selected Zoho mailing lists (by key) and the approval live here.
 * - version / approved_version: any edit after approval needs a new approval.
 * - zoho_campaign_key (+ zoho_key_version): the internal Zoho delivery object created for one
 *   approved version; unique per workspace so it is never created or sent twice by mistake.
 * - status (draft, approved, submitting, submitted, failed, needs_review) is Marketech.ai's
 *   submission state; zoho_status and report_json are Zoho's own delivery status and figures.
 * - content_token_hash: hash of the single-purpose token in the public content URL Zoho imports
 *   the HTML from (createCampaign takes a content URL); expires.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '018_email_campaigns',

  async up(db) {
    await db.ensureTable('mail_campaigns', `CREATE TABLE mail_campaigns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      name VARCHAR(150) NOT NULL,
      subject VARCHAR(255) NULL,
      from_name VARCHAR(100) NULL,
      from_email VARCHAR(255) NULL,
      html_content MEDIUMTEXT NULL,
      list_keys_json TEXT NULL,
      list_names_json TEXT NULL,
      topic_id VARCHAR(100) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      version INT NOT NULL DEFAULT 1,
      approved_version INT NULL,
      approved_by INT NULL,
      approved_at DATETIME NULL,
      submit_stage VARCHAR(10) NULL,
      zoho_campaign_key VARCHAR(100) NULL,
      zoho_key_version INT NULL,
      zoho_status VARCHAR(50) NULL,
      provider_code VARCHAR(20) NULL,
      provider_message VARCHAR(500) NULL,
      report_json TEXT NULL,
      content_token_hash CHAR(64) CHARACTER SET ascii NULL,
      content_token_expires_at DATETIME NULL,
      created_by INT NULL,
      updated_by INT NULL,
      submitted_by INT NULL,
      submitted_at DATETIME NULL,
      last_checked_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_mail_campaigns_key (workspace_id, zoho_campaign_key),
      UNIQUE KEY uq_mail_campaigns_token (content_token_hash),
      KEY idx_mail_campaigns_ws (workspace_id, status),
      CONSTRAINT fk_mail_campaigns_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);
  }
};
