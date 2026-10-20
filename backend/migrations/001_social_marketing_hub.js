/**
 * Social Media Marketing Hub schema.
 * Additive only: new tables, new nullable columns, indexes and tenant-scoped foreign keys.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '001_social_marketing_hub',

  async up(db) {
    // ---------- Existing tables: extend, never replace ----------
    await db.ensureColumn('workspaces', 'timezone', "VARCHAR(64) NOT NULL DEFAULT 'UTC'");

    // usage_ledger legacy columns were NOT NULL without defaults; relax them so new writers work.
    for (const [col, type] of [['metric_type', 'VARCHAR(100)'], ['units_consumed', 'DECIMAL(10,2)'], ['cost_usd', 'DECIMAL(10,4)']]) {
      const info = await db.columnInfo('usage_ledger', col);
      if (info && info.IS_NULLABLE === 'NO') {
        await db.query(`ALTER TABLE usage_ledger MODIFY COLUMN \`${col}\` ${type} NULL`);
      }
    }
    await db.ensureColumn('usage_ledger', 'provider_key', 'VARCHAR(64) NULL');
    await db.ensureColumn('usage_ledger', 'model_key', 'VARCHAR(128) NULL');
    await db.ensureColumn('usage_ledger', 'is_estimate', 'TINYINT(1) NOT NULL DEFAULT 1');

    // campaigns -> AI campaign builder
    const campaignCols = [
      ['product_id', 'INT NULL'],
      ['offer', 'TEXT NULL'],
      ['key_message', 'TEXT NULL'],
      ['start_date', 'DATE NULL'],
      ['end_date', 'DATE NULL'],
      ['landing_url', 'VARCHAR(500) NULL'],
      ['tone', 'VARCHAR(100) NULL'],
      ['language', "VARCHAR(20) NOT NULL DEFAULT 'en'"],
      ['desired_post_count', 'INT NULL'],
      ['platforms_json', 'LONGTEXT NULL'],
      ['account_ids_json', 'LONGTEXT NULL'],
      ['image_requirements', 'TEXT NULL'],
      ['video_requirements', 'TEXT NULL'],
      ['call_to_action', 'VARCHAR(255) NULL'],
      ['brief_json', 'LONGTEXT NULL'],
      ['assumptions_json', 'LONGTEXT NULL'],
      ['generation_status', "VARCHAR(30) NOT NULL DEFAULT 'not_started'"],
      ['generation_error', 'TEXT NULL'],
      ['source', "VARCHAR(30) NOT NULL DEFAULT 'legacy'"],
      ['created_by', 'INT NULL'],
      ['updated_at', 'DATETIME NULL']
    ];
    for (const [c, d] of campaignCols) await db.ensureColumn('campaigns', c, d);
    await db.ensureIndex('campaigns', 'idx_campaigns_ws_id', 'UNIQUE KEY idx_campaigns_ws_id (workspace_id, id)');

    // content_items -> social content workflow
    const contentCols = [
      ['platform_key', 'VARCHAR(30) NULL'],
      ['social_account_id', 'INT NULL'],
      ['variant_group', 'VARCHAR(64) NULL'],
      ['variant_label', 'VARCHAR(64) NULL'],
      ['link_url', 'VARCHAR(500) NULL'],
      ['media_asset_ids_json', 'LONGTEXT NULL'],
      ['image_prompt', 'TEXT NULL'],
      ['video_script', 'LONGTEXT NULL'],
      ['suggested_publish_at', 'DATETIME NULL'],
      ['ai_assumptions_json', 'LONGTEXT NULL'],
      ['assigned_approver_id', 'INT NULL'],
      ['schedule_timezone', 'VARCHAR(64) NULL'],
      ['external_post_id', 'VARCHAR(255) NULL'],
      ['external_url', 'VARCHAR(500) NULL'],
      ['last_error', 'TEXT NULL'],
      ['version', 'INT NOT NULL DEFAULT 1'],
      ['source', "VARCHAR(30) NOT NULL DEFAULT 'legacy'"],
      ['created_by', 'INT NULL'],
      ['updated_at', 'DATETIME NULL']
    ];
    for (const [c, d] of contentCols) await db.ensureColumn('content_items', c, d);
    await db.ensureIndex('content_items', 'idx_content_ws_id', 'UNIQUE KEY idx_content_ws_id (workspace_id, id)');
    await db.ensureIndex('content_items', 'idx_content_ws_status', 'KEY idx_content_ws_status (workspace_id, status, scheduled_at)');
    await db.ensureIndex('content_items', 'idx_content_ws_campaign', 'KEY idx_content_ws_campaign (workspace_id, campaign_id)');

    // ---------- New tables ----------
    await db.ensureTable('social_settings', `CREATE TABLE social_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
      require_approval TINYINT(1) NOT NULL DEFAULT 1,
      auto_reply_enabled TINYINT(1) NOT NULL DEFAULT 0,
      default_hashtags VARCHAR(500) NULL,
      analytics_poll_minutes INT NOT NULL DEFAULT 360,
      inbox_poll_minutes INT NOT NULL DEFAULT 30,
      settings_json LONGTEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_social_settings_ws (workspace_id),
      CONSTRAINT fk_social_settings_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('provider_credentials', `CREATE TABLE provider_credentials (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      provider_key VARCHAR(30) NOT NULL,
      secret_ciphertext TEXT NOT NULL,
      access_expires_at DATETIME NULL,
      refresh_expires_at DATETIME NULL,
      key_version INT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_cred_ws_id (workspace_id, id),
      CONSTRAINT fk_cred_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('oauth_states', `CREATE TABLE oauth_states (
      id INT AUTO_INCREMENT PRIMARY KEY,
      state_hash CHAR(64) NOT NULL,
      workspace_id INT NOT NULL,
      user_id INT NOT NULL,
      provider_key VARCHAR(30) NOT NULL,
      code_verifier_ciphertext TEXT NULL,
      return_path VARCHAR(255) NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_oauth_state (state_hash),
      KEY idx_oauth_expires (expires_at),
      CONSTRAINT fk_oauth_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('social_accounts', `CREATE TABLE social_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      provider_key VARCHAR(30) NOT NULL,
      account_type VARCHAR(40) NOT NULL,
      external_account_id VARCHAR(191) NOT NULL,
      display_name VARCHAR(255) NULL,
      username VARCHAR(255) NULL,
      avatar_url VARCHAR(1000) NULL,
      profile_url VARCHAR(500) NULL,
      parent_account_id INT NULL,
      credential_id INT NULL,
      scopes_json LONGTEXT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'connected',
      status_detail VARCHAR(500) NULL,
      token_expires_at DATETIME NULL,
      last_success_at DATETIME NULL,
      last_checked_at DATETIME NULL,
      last_error VARCHAR(1000) NULL,
      metadata_json LONGTEXT NULL,
      connected_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_social_account (workspace_id, provider_key, external_account_id),
      UNIQUE KEY uq_social_account_ws_id (workspace_id, id),
      KEY idx_social_accounts_status (workspace_id, status),
      CONSTRAINT fk_social_accounts_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_social_accounts_cred FOREIGN KEY (workspace_id, credential_id) REFERENCES provider_credentials(workspace_id, id) ON DELETE RESTRICT
    ) ${TABLE_OPTS}`);

    await db.ensureTable('assets', `CREATE TABLE assets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      asset_type VARCHAR(30) NOT NULL,
      source VARCHAR(30) NOT NULL DEFAULT 'url',
      public_url VARCHAR(1000) NULL,
      storage_key VARCHAR(500) NULL,
      mime_type VARCHAR(100) NULL,
      size_bytes BIGINT NULL,
      width INT NULL,
      height INT NULL,
      duration_seconds DECIMAL(10,2) NULL,
      checksum CHAR(64) NULL,
      title VARCHAR(255) NULL,
      prompt TEXT NULL,
      metadata_json LONGTEXT NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_assets_ws_id (workspace_id, id),
      CONSTRAINT fk_assets_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('content_versions', `CREATE TABLE content_versions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      content_item_id INT NOT NULL,
      version_number INT NOT NULL,
      content_json LONGTEXT NOT NULL,
      change_note VARCHAR(255) NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_content_version (content_item_id, version_number),
      CONSTRAINT fk_content_versions_item FOREIGN KEY (workspace_id, content_item_id) REFERENCES content_items(workspace_id, id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('approval_requests', `CREATE TABLE approval_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      resource_type VARCHAR(40) NOT NULL,
      resource_id INT NOT NULL,
      resource_version INT NULL,
      requested_by INT NULL,
      assigned_approver_id INT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      decision_note TEXT NULL,
      decided_by INT NULL,
      decided_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_approvals_resource (workspace_id, resource_type, resource_id, status),
      KEY idx_approvals_assignee (workspace_id, assigned_approver_id, status),
      CONSTRAINT fk_approvals_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('publishing_jobs', `CREATE TABLE publishing_jobs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      content_item_id INT NOT NULL,
      social_account_id INT NOT NULL,
      content_version INT NOT NULL,
      idempotency_key VARCHAR(191) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'queued',
      scheduled_for DATETIME NOT NULL,
      schedule_timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
      attempt_count INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 3,
      next_attempt_at DATETIME NOT NULL,
      locked_by VARCHAR(100) NULL,
      locked_at DATETIME NULL,
      external_post_id VARCHAR(255) NULL,
      external_url VARCHAR(500) NULL,
      last_error_code VARCHAR(64) NULL,
      last_error TEXT NULL,
      provider_response_json LONGTEXT NULL,
      requested_by INT NULL,
      completed_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_publishing_idempotency (workspace_id, idempotency_key),
      KEY idx_publishing_due (status, next_attempt_at),
      KEY idx_publishing_ws (workspace_id, status, scheduled_for),
      CONSTRAINT fk_publishing_content FOREIGN KEY (workspace_id, content_item_id) REFERENCES content_items(workspace_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_publishing_account FOREIGN KEY (workspace_id, social_account_id) REFERENCES social_accounts(workspace_id, id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('publishing_attempts', `CREATE TABLE publishing_attempts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      publishing_job_id INT NOT NULL,
      attempt_number INT NOT NULL,
      worker_id VARCHAR(100) NULL,
      outcome VARCHAR(20) NOT NULL DEFAULT 'started',
      error_code VARCHAR(64) NULL,
      error_message TEXT NULL,
      http_status INT NULL,
      response_json LONGTEXT NULL,
      started_at DATETIME NOT NULL,
      finished_at DATETIME NULL,
      UNIQUE KEY uq_publishing_attempt (publishing_job_id, attempt_number),
      CONSTRAINT fk_attempt_job FOREIGN KEY (publishing_job_id) REFERENCES publishing_jobs(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('social_metric_snapshots', `CREATE TABLE social_metric_snapshots (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      social_account_id INT NOT NULL,
      content_item_id INT NULL,
      external_object_id VARCHAR(255) NOT NULL,
      object_type VARCHAR(20) NOT NULL,
      metric_key VARCHAR(64) NOT NULL,
      metric_value DECIMAL(20,4) NULL,
      availability VARCHAR(20) NOT NULL DEFAULT 'available',
      unavailable_reason VARCHAR(500) NULL,
      period VARCHAR(20) NOT NULL DEFAULT 'lifetime',
      period_start DATETIME NULL,
      period_end DATETIME NULL,
      source VARCHAR(64) NOT NULL,
      collected_at DATETIME NOT NULL,
      KEY idx_metrics_lookup (workspace_id, external_object_id, metric_key, collected_at),
      KEY idx_metrics_account (workspace_id, social_account_id, collected_at),
      KEY idx_metrics_content (workspace_id, content_item_id),
      CONSTRAINT fk_metrics_account FOREIGN KEY (workspace_id, social_account_id) REFERENCES social_accounts(workspace_id, id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('engagement_threads', `CREATE TABLE engagement_threads (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      social_account_id INT NOT NULL,
      provider_key VARCHAR(30) NOT NULL,
      thread_type VARCHAR(20) NOT NULL,
      external_thread_id VARCHAR(255) NOT NULL,
      external_object_id VARCHAR(255) NULL,
      content_item_id INT NULL,
      author_name VARCHAR(255) NULL,
      author_external_id VARCHAR(255) NULL,
      preview_text VARCHAR(500) NULL,
      last_message_at DATETIME NULL,
      ai_category VARCHAR(20) NULL,
      ai_summary TEXT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      assigned_user_id INT NULL,
      lead_id INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_thread (workspace_id, provider_key, external_thread_id),
      UNIQUE KEY uq_thread_ws_id (workspace_id, id),
      KEY idx_threads_status (workspace_id, status, last_message_at),
      CONSTRAINT fk_threads_account FOREIGN KEY (workspace_id, social_account_id) REFERENCES social_accounts(workspace_id, id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('engagement_messages', `CREATE TABLE engagement_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      thread_id INT NOT NULL,
      direction VARCHAR(10) NOT NULL,
      external_message_id VARCHAR(255) NULL,
      author_name VARCHAR(255) NULL,
      body_text TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'received',
      ai_suggested TINYINT(1) NOT NULL DEFAULT 0,
      approved_by INT NULL,
      sent_by INT NULL,
      sent_at DATETIME NULL,
      error_message TEXT NULL,
      provider_created_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_message_external (workspace_id, thread_id, external_message_id),
      KEY idx_messages_thread (workspace_id, thread_id, created_at),
      CONSTRAINT fk_messages_thread FOREIGN KEY (workspace_id, thread_id) REFERENCES engagement_threads(workspace_id, id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('provider_webhook_events', `CREATE TABLE provider_webhook_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      provider_key VARCHAR(30) NOT NULL,
      event_key CHAR(64) NOT NULL,
      signature_valid TINYINT(1) NOT NULL,
      workspace_id INT NULL,
      payload_json LONGTEXT NULL,
      received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME NULL,
      UNIQUE KEY uq_webhook_event (provider_key, event_key)
    ) ${TABLE_OPTS}`);

    await db.ensureTable('background_jobs', `CREATE TABLE background_jobs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      job_type VARCHAR(40) NOT NULL,
      payload_json LONGTEXT NULL,
      idempotency_key VARCHAR(191) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'queued',
      run_at DATETIME NOT NULL,
      attempt_count INT NOT NULL DEFAULT 0,
      max_attempts INT NOT NULL DEFAULT 3,
      locked_by VARCHAR(100) NULL,
      locked_at DATETIME NULL,
      last_error TEXT NULL,
      result_json LONGTEXT NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME NULL,
      UNIQUE KEY uq_background_idempotency (workspace_id, idempotency_key),
      KEY idx_background_due (status, run_at),
      CONSTRAINT fk_background_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('audit_logs', `CREATE TABLE audit_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NULL,
      actor_user_id INT NULL,
      actor_type VARCHAR(20) NOT NULL DEFAULT 'user',
      action VARCHAR(100) NOT NULL,
      resource_type VARCHAR(40) NULL,
      resource_id VARCHAR(64) NULL,
      request_id VARCHAR(64) NULL,
      ip_address VARCHAR(64) NULL,
      metadata_json LONGTEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_audit_ws (workspace_id, created_at),
      KEY idx_audit_resource (workspace_id, resource_type, resource_id)
    ) ${TABLE_OPTS}`);
  }
};
