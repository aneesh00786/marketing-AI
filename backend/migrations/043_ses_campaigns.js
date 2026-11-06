/**
 * Amazon SES as a campaign sender, next to Zoho Campaigns. Additive only.
 *
 * - mail_delivery_settings: per workspace, which service sends campaigns ('zoho' by default) and the
 *   Amazon SES connection (region, access key id, encrypted secret, configuration set, sending
 *   rate). The server's .env (AWS_SES_*) is used when a workspace has no keys of its own.
 * - mail_campaign_recipients: one row per person an SES campaign goes to, for that campaign version
 *   (unique per address, so a retried job never emails anyone twice). The delivery, open and click
 *   history lives in mail_message_tracking / mail_events (the same tracking as Compose emails).
 * - mail_message_tracking.campaign_id / campaign_recipient_id: links tracking to the campaign.
 * - mail_ses_notifications: SNS message ids already handled (SNS may deliver a message twice).
 * - mail_campaigns.provider: the service a campaign was sent with.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '043_ses_campaigns',

  async up(db) {
    await db.ensureTable('mail_delivery_settings', `CREATE TABLE mail_delivery_settings (
      workspace_id INT NOT NULL PRIMARY KEY,
      campaign_provider VARCHAR(20) NOT NULL DEFAULT 'zoho',
      ses_region VARCHAR(30) NULL,
      ses_access_key_id VARCHAR(128) NULL,
      ses_secret_ciphertext TEXT NULL,
      ses_configuration_set VARCHAR(64) NULL,
      ses_max_per_second INT NULL,
      sns_token CHAR(32) CHARACTER SET ascii NULL,
      ses_sns_topic_arn VARCHAR(255) NULL,
      ses_last_checked_at DATETIME NULL,
      ses_last_error VARCHAR(500) NULL,
      updated_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mail_delivery_sns (sns_token),
      CONSTRAINT fk_mail_delivery_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('mail_campaign_recipients', `CREATE TABLE mail_campaign_recipients (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      campaign_id INT NOT NULL,
      version INT NOT NULL,
      email VARCHAR(255) NOT NULL,
      first_name VARCHAR(100) NULL,
      last_name VARCHAR(100) NULL,
      contact_id INT NULL,
      lead_id INT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'queued',
      tracking_id INT NULL,
      provider_message_id VARCHAR(255) NULL,
      error_code VARCHAR(64) NULL,
      error VARCHAR(255) NULL,
      sent_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mail_campaign_recipient (campaign_id, version, email),
      KEY idx_mail_campaign_recipients_status (campaign_id, status),
      KEY idx_mail_campaign_recipients_msg (provider_message_id(191)),
      CONSTRAINT fk_mail_campaign_recipients_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_mail_campaign_recipients_campaign FOREIGN KEY (campaign_id) REFERENCES mail_campaigns(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('mail_ses_notifications', `CREATE TABLE mail_ses_notifications (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      sns_message_id VARCHAR(100) NOT NULL,
      event_type VARCHAR(30) NULL,
      received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mail_ses_notification (workspace_id, sns_message_id),
      KEY idx_mail_ses_notifications_received (received_at),
      CONSTRAINT fk_mail_ses_notifications_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureColumn('mail_message_tracking', 'campaign_id', 'INT NULL');
    await db.ensureColumn('mail_message_tracking', 'campaign_recipient_id', 'INT NULL');
    await db.ensureIndex('mail_message_tracking', 'idx_mail_tracking_campaign', 'KEY idx_mail_tracking_campaign (workspace_id, campaign_id)');
    await db.ensureColumn('mail_campaigns', 'provider', 'VARCHAR(20) NULL');
  }
};
