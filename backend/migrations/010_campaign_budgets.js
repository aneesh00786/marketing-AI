/**
 * Budget & ROI tracking for AI Campaigns (Command Center campaigns).
 * - campaign_budgets: the budget you set (a plan, never spend).
 * - budget_spend_entries: ACTUAL spend only, from a connected provider (synced, idempotent per
 *   source+day) or entered manually (labelled, with an evidence reference). Entries are voided,
 *   never deleted, so the audit trail stays complete.
 * - budget_revenue_entries: revenue a person recorded (deal won, invoice paid). Nothing is inferred.
 * - budget_spend_sources: provider ad accounts linked to a budget (e.g. Meta Ads via the existing
 *   Meta connection, only when it has the ads_read permission).
 * - budget_alerts: each alert fires once (unique per budget + key).
 * Forecasts and pacing are computed on read and never stored as spend. Additive only.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '010_campaign_budgets',

  async up(db) {
    await db.ensureTable('campaign_budgets', `CREATE TABLE campaign_budgets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      program_id INT NOT NULL,
      amount DECIMAL(14,2) NOT NULL,
      currency CHAR(3) NOT NULL,
      period_start DATE NOT NULL,
      period_end DATE NOT NULL,
      alert_thresholds_json VARCHAR(200) NOT NULL DEFAULT '[50,80,100]',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_campaign_budget_program (program_id),
      KEY idx_campaign_budgets_ws (workspace_id, status),
      CONSTRAINT fk_campaign_budgets_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_campaign_budgets_program FOREIGN KEY (program_id) REFERENCES campaign_programs(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('budget_spend_sources', `CREATE TABLE budget_spend_sources (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      budget_id INT NOT NULL,
      provider_key VARCHAR(30) NOT NULL,
      social_account_id INT NOT NULL,
      external_account_id VARCHAR(64) NOT NULL,
      external_campaign_ids_json TEXT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      last_synced_at DATETIME NULL,
      last_error VARCHAR(1000) NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_budget_spend_source (budget_id, provider_key, external_account_id),
      CONSTRAINT fk_budget_spend_sources_budget FOREIGN KEY (budget_id) REFERENCES campaign_budgets(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('budget_spend_entries', `CREATE TABLE budget_spend_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      budget_id INT NOT NULL,
      source_type VARCHAR(20) NOT NULL,
      source_id INT NULL,
      spend_date DATE NOT NULL,
      amount DECIMAL(14,2) NOT NULL,
      currency CHAR(3) NOT NULL,
      external_ref VARCHAR(191) NOT NULL,
      description VARCHAR(500) NULL,
      evidence_ref VARCHAR(255) NULL,
      entered_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      voided_at DATETIME NULL,
      voided_by INT NULL,
      void_reason VARCHAR(500) NULL,
      UNIQUE KEY uq_budget_spend_ref (budget_id, external_ref),
      KEY idx_budget_spend_date (budget_id, spend_date),
      CONSTRAINT fk_budget_spend_entries_budget FOREIGN KEY (budget_id) REFERENCES campaign_budgets(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('budget_revenue_entries', `CREATE TABLE budget_revenue_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      budget_id INT NOT NULL,
      lead_id INT NULL,
      amount DECIMAL(14,2) NOT NULL,
      currency CHAR(3) NOT NULL,
      received_date DATE NOT NULL,
      description VARCHAR(500) NULL,
      evidence_ref VARCHAR(255) NULL,
      entered_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      voided_at DATETIME NULL,
      voided_by INT NULL,
      void_reason VARCHAR(500) NULL,
      KEY idx_budget_revenue (budget_id),
      CONSTRAINT fk_budget_revenue_entries_budget FOREIGN KEY (budget_id) REFERENCES campaign_budgets(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('budget_alerts', `CREATE TABLE budget_alerts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      budget_id INT NOT NULL,
      alert_key VARCHAR(100) NOT NULL,
      severity VARCHAR(20) NOT NULL,
      message VARCHAR(1000) NOT NULL,
      metrics_json TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      acknowledged_at DATETIME NULL,
      acknowledged_by INT NULL,
      UNIQUE KEY uq_budget_alert (budget_id, alert_key),
      CONSTRAINT fk_budget_alerts_budget FOREIGN KEY (budget_id) REFERENCES campaign_budgets(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);
  }
};
