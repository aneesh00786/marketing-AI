/**
 * A/B tests for AI Campaigns.
 * - Email: a variant B of one sequence step (subject/body). Recipients are split when the
 *   sequence is approved; each send records the variant it used.
 * - Social: compares existing variant posts (content_items.variant_group) using
 *   platform-reported metrics.
 * The success metric, direction, minimum sample and significance level are fixed when the
 * test is created/locked, before any variant is sent or published.
 * Additive only: new tables and nullable columns; existing campaigns are unchanged.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '007_ab_tests',

  async up(db) {
    await db.ensureTable('ab_tests', `CREATE TABLE ab_tests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      kind VARCHAR(10) NOT NULL,
      name VARCHAR(255) NOT NULL,
      hypothesis VARCHAR(1000) NULL,
      outreach_campaign_id INT NULL,
      step_order INT NULL,
      social_campaign_id INT NULL,
      variant_group VARCHAR(64) NULL,
      metric VARCHAR(40) NOT NULL,
      direction VARCHAR(10) NOT NULL,
      min_sample_per_variant INT NOT NULL,
      wait_days INT NOT NULL DEFAULT 0,
      alpha DECIMAL(4,3) NOT NULL DEFAULT 0.050,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      locked_at DATETIME NULL,
      winner_label VARCHAR(8) NULL,
      decision VARCHAR(30) NULL,
      decision_note VARCHAR(1000) NULL,
      result_json LONGTEXT NULL,
      concluded_by INT NULL,
      concluded_at DATETIME NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      KEY idx_ab_tests_ws (workspace_id, id),
      KEY idx_ab_tests_outreach (outreach_campaign_id),
      CONSTRAINT fk_ab_tests_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('outreach_step_variants', `CREATE TABLE outreach_step_variants (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      campaign_id INT NOT NULL,
      step_order INT NOT NULL,
      label VARCHAR(8) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      body_text TEXT NOT NULL,
      needs_verification_json TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      UNIQUE KEY uq_outreach_step_variant (campaign_id, step_order, label),
      CONSTRAINT fk_outreach_step_variants_campaign FOREIGN KEY (campaign_id) REFERENCES outreach_campaigns(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureColumn('outreach_recipients', 'variant_label', 'VARCHAR(8) NULL');
    await db.ensureColumn('outreach_sends', 'variant_label', 'VARCHAR(8) NULL');
  }
};
