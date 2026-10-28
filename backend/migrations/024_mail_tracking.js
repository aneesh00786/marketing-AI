/**
 * Email delivery, open and click tracking for individual emails (Mail Drafts, Compose). Additive only.
 *
 * - mail_message_tracking: one row per tracked outgoing email. Provider acceptance and confirmed
 *   delivery are separate states (accepted_at vs delivered_at); delivery_status is derived from the
 *   event history by precedence, so events arriving out of order cannot move it backwards.
 * - mail_tracked_links: original destinations of rewritten links (SMTP click tracking). The click
 *   URL carries only an opaque token, so it can only ever redirect to a stored destination.
 * - mail_events: the event history. dedupe_key is unique, so a repeated webhook or pixel hit is
 *   stored once. Only safe, short details are kept: no raw payloads, email content, IP addresses,
 *   user agents or secrets.
 * - mail_webhook_endpoints: per-workspace provider webhook (opaque URL token + encrypted signing
 *   key). Disabled until an admin enables it.
 * - mail_configurations.track_opens / track_clicks: workspace policy, off by default.
 *
 * Retention: events and tracked links older than MAIL_TRACKING_RETENTION_DAYS (default 395) are
 * deleted by the mail tracking module; everything is removed with the workspace (ON DELETE CASCADE).
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '024_mail_tracking',

  async up(db) {
    await db.ensureTable('mail_message_tracking', `CREATE TABLE mail_message_tracking (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      email_id INT NULL,
      draft_id INT NULL,
      provider VARCHAR(20) NULL,
      provider_message_id VARCHAR(255) NULL,
      tracking_token CHAR(32) CHARACTER SET ascii NOT NULL,
      track_opens TINYINT(1) NOT NULL DEFAULT 0,
      track_clicks TINYINT(1) NOT NULL DEFAULT 0,
      delivery_status VARCHAR(20) NOT NULL DEFAULT 'queued',
      status_rank TINYINT NOT NULL DEFAULT 0,
      status_event_at DATETIME(3) NULL,
      accepted_at DATETIME NULL,
      delivered_at DATETIME NULL,
      bounced_at DATETIME NULL,
      complained_at DATETIME NULL,
      failure_code VARCHAR(64) NULL,
      failure_reason VARCHAR(255) NULL,
      first_open_at DATETIME NULL,
      last_open_at DATETIME NULL,
      open_events INT NOT NULL DEFAULT 0,
      first_click_at DATETIME NULL,
      last_click_at DATETIME NULL,
      click_events INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mail_tracking_token (tracking_token),
      KEY idx_mail_tracking_email (workspace_id, email_id),
      KEY idx_mail_tracking_draft (workspace_id, draft_id),
      KEY idx_mail_tracking_provider (workspace_id, provider, provider_message_id(191)),
      CONSTRAINT fk_mail_tracking_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('mail_tracked_links', `CREATE TABLE mail_tracked_links (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      tracking_id INT NOT NULL,
      link_token CHAR(32) CHARACTER SET ascii NOT NULL,
      url TEXT NOT NULL,
      url_hash CHAR(64) CHARACTER SET ascii NOT NULL,
      position SMALLINT NOT NULL DEFAULT 0,
      click_events INT NOT NULL DEFAULT 0,
      first_click_at DATETIME NULL,
      last_click_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mail_link_token (link_token),
      KEY idx_mail_links_tracking (tracking_id),
      KEY idx_mail_links_created (created_at),
      CONSTRAINT fk_mail_links_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_mail_links_tracking FOREIGN KEY (tracking_id) REFERENCES mail_message_tracking(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('mail_events', `CREATE TABLE mail_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      tracking_id INT NULL,
      source VARCHAR(20) NOT NULL,
      event_type VARCHAR(20) NOT NULL,
      occurred_at DATETIME(3) NOT NULL,
      received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      provider_event_id VARCHAR(128) NULL,
      dedupe_key CHAR(64) CHARACTER SET ascii NOT NULL,
      link_id INT NULL,
      detail_code VARCHAR(64) NULL,
      detail VARCHAR(255) NULL,
      client_hint VARCHAR(20) NULL,
      outcome VARCHAR(20) NOT NULL DEFAULT 'applied',
      UNIQUE KEY uq_mail_events_dedupe (dedupe_key),
      KEY idx_mail_events_tracking (workspace_id, tracking_id, occurred_at),
      KEY idx_mail_events_received (received_at),
      CONSTRAINT fk_mail_events_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_mail_events_tracking FOREIGN KEY (tracking_id) REFERENCES mail_message_tracking(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('mail_webhook_endpoints', `CREATE TABLE mail_webhook_endpoints (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      provider VARCHAR(20) NOT NULL,
      endpoint_token CHAR(32) CHARACTER SET ascii NOT NULL,
      secret_ciphertext TEXT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 0,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_event_at DATETIME NULL,
      UNIQUE KEY uq_mail_webhook_token (endpoint_token),
      UNIQUE KEY uq_mail_webhook_ws_provider (workspace_id, provider),
      CONSTRAINT fk_mail_webhooks_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureColumn('mail_configurations', 'track_opens', 'TINYINT(1) NOT NULL DEFAULT 0');
    await db.ensureColumn('mail_configurations', 'track_clicks', 'TINYINT(1) NOT NULL DEFAULT 0');
    await db.ensureColumn('mail_configurations', 'tracking_updated_by', 'INT NULL');
    await db.ensureColumn('mail_configurations', 'tracking_updated_at', 'DATETIME NULL');
  }
};
