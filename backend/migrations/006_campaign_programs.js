/**
 * Campaign Command Center: a "program" holds the AI strategy brief, the chosen CRM audience,
 * and links to the email sequence (outreach_campaigns) and social campaign (campaigns) it
 * builds. Sending and publishing stay in those existing modules and their approval flows.
 * Additive only: one new table, no changes to existing data.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '006_campaign_programs',

  async up(db) {
    await db.ensureTable('campaign_programs', `CREATE TABLE campaign_programs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      product_id INT NULL,
      goal TEXT NULL,
      target_audience VARCHAR(2000) NULL,
      tone VARCHAR(50) NOT NULL DEFAULT 'Professional',
      channels_json TEXT NOT NULL,
      budget_amount DECIMAL(12,2) NULL,
      budget_currency CHAR(3) NULL,
      budget_note VARCHAR(500) NULL,
      start_date DATE NULL,
      end_date DATE NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      brief_json LONGTEXT NULL,
      brief_flags_json TEXT NULL,
      brief_provider VARCHAR(100) NULL,
      brief_generated_at DATETIME NULL,
      brief_approved_by INT NULL,
      brief_approved_at DATETIME NULL,
      lead_ids_json TEXT NULL,
      audience_filter_json TEXT NULL,
      outreach_campaign_id INT NULL,
      social_campaign_id INT NULL,
      last_error VARCHAR(1000) NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      KEY idx_campaign_programs_ws (workspace_id, id),
      CONSTRAINT fk_campaign_programs_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);
  }
};
