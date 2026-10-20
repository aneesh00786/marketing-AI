/**
 * Email outreach campaigns (AI Campaigns page): multi-step email sequences sent from the
 * workspace's own mailbox after one explicit approval.
 * Additive only: new tables, no changes to existing data. The legacy email_campaigns table
 * is left untouched.
 *
 * Delivery honesty:
 *  - outreach_sends has one row per (recipient, step) (unique), written BEFORE the provider
 *    call, so a step can never be sent twice; a crash mid-send leaves 'sending', which is
 *    reported as needs_review and never retried automatically.
 *  - Only provider-accepted messages count as sent. There is no open/click tracking.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '005_email_outreach_campaigns',

  async up(db) {
    await db.ensureTable('outreach_campaigns', `CREATE TABLE outreach_campaigns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      product_id INT NULL,
      goal TEXT NULL,
      audience_note VARCHAR(500) NULL,
      tone VARCHAR(50) NOT NULL DEFAULT 'Professional',
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
      send_days VARCHAR(20) NOT NULL DEFAULT '1,2,3,4,5',
      send_start_hour TINYINT NOT NULL DEFAULT 9,
      send_end_hour TINYINT NOT NULL DEFAULT 17,
      daily_limit INT NOT NULL DEFAULT 50,
      ai_provider VARCHAR(100) NULL,
      generated_at DATETIME NULL,
      approved_by INT NULL,
      approved_at DATETIME NULL,
      completed_at DATETIME NULL,
      last_error VARCHAR(500) NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      KEY idx_outreach_campaigns_ws (workspace_id, id),
      KEY idx_outreach_campaigns_status (status),
      CONSTRAINT fk_outreach_campaigns_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('outreach_steps', `CREATE TABLE outreach_steps (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      campaign_id INT NOT NULL,
      step_order INT NOT NULL,
      delay_days INT NOT NULL DEFAULT 0,
      subject VARCHAR(255) NOT NULL,
      body_text TEXT NOT NULL,
      needs_verification_json TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_outreach_step_order (campaign_id, step_order),
      KEY idx_outreach_steps_ws (workspace_id, campaign_id),
      CONSTRAINT fk_outreach_steps_campaign FOREIGN KEY (campaign_id) REFERENCES outreach_campaigns(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('outreach_recipients', `CREATE TABLE outreach_recipients (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      campaign_id INT NOT NULL,
      lead_id INT NULL,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(255) NULL,
      company VARCHAR(255) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      next_step_order INT NOT NULL DEFAULT 1,
      next_send_at DATETIME NULL,
      first_sent_at DATETIME NULL,
      last_sent_at DATETIME NULL,
      last_error VARCHAR(500) NULL,
      unsubscribe_token CHAR(40) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_outreach_recipient_email (campaign_id, email(191)),
      UNIQUE KEY uq_outreach_unsubscribe (unsubscribe_token),
      KEY idx_outreach_recipients_due (status, next_send_at),
      KEY idx_outreach_recipients_ws (workspace_id, campaign_id),
      CONSTRAINT fk_outreach_recipients_campaign FOREIGN KEY (campaign_id) REFERENCES outreach_campaigns(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('outreach_sends', `CREATE TABLE outreach_sends (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      campaign_id INT NOT NULL,
      recipient_id INT NOT NULL,
      step_id INT NOT NULL,
      step_order INT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'sending',
      email_id INT NULL,
      provider_message_id VARCHAR(255) NULL,
      error VARCHAR(500) NULL,
      worker_id VARCHAR(120) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at DATETIME NULL,
      UNIQUE KEY uq_outreach_send_once (recipient_id, step_id),
      KEY idx_outreach_sends_campaign (campaign_id, status, sent_at),
      CONSTRAINT fk_outreach_sends_campaign FOREIGN KEY (campaign_id) REFERENCES outreach_campaigns(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('email_suppressions', `CREATE TABLE email_suppressions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      email VARCHAR(255) NOT NULL,
      reason VARCHAR(30) NOT NULL,
      source VARCHAR(100) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_email_suppression (workspace_id, email(191)),
      CONSTRAINT fk_email_suppressions_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('worker_heartbeats', `CREATE TABLE worker_heartbeats (
      worker_kind VARCHAR(40) NOT NULL PRIMARY KEY,
      worker_id VARCHAR(120) NOT NULL,
      beat_at DATETIME NOT NULL
    ) ${TABLE_OPTS}`);
  }
};
