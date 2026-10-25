/**
 * Product-based personalized emails (Mail Center: Product -> Leads -> Emails -> Preview -> Send).
 * Additive only; existing leads keep marketing_consent = 'unknown' (consent is never assumed).
 * - leads.marketing_consent (unknown | granted | withdrawn) with source, time and who recorded it.
 *   Bulk marketing sends go only to leads with consent recorded as granted.
 * - mail_draft_batches: one product email batch (product, template, goal, approval, send status).
 * - email_drafts.batch_id: the per-recipient drafts of a batch (each sent and tracked as a draft).
 * - email_drafts.unsubscribe_token: per-recipient unsubscribe link token for batch emails.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '020_product_email_batches',

  async up(db) {
    await db.ensureColumn('leads', 'marketing_consent', "VARCHAR(20) NOT NULL DEFAULT 'unknown'");
    await db.ensureColumn('leads', 'marketing_consent_source', 'VARCHAR(255) NULL');
    await db.ensureColumn('leads', 'marketing_consent_at', 'DATETIME NULL');
    await db.ensureColumn('leads', 'marketing_consent_by', 'INT NULL');

    await db.ensureTable('mail_draft_batches', `CREATE TABLE mail_draft_batches (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      product_id INT NULL,
      product_name VARCHAR(255) NULL,
      template_id INT NULL,
      goal VARCHAR(2000) NULL,
      tone VARCHAR(100) NULL,
      subject VARCHAR(255) NULL,
      sender_name VARCHAR(150) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      recipients INT NOT NULL DEFAULT 0,
      created_by INT NULL,
      approved_by INT NULL,
      approved_at DATETIME NULL,
      sent_by INT NULL,
      sent_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      KEY idx_mail_draft_batches_ws (workspace_id, created_at),
      CONSTRAINT fk_mail_draft_batches_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureColumn('email_drafts', 'batch_id', 'INT NULL');
    await db.ensureColumn('email_drafts', 'unsubscribe_token', 'CHAR(40) CHARACTER SET ascii NULL');
    await db.ensureIndex('email_drafts', 'idx_email_drafts_batch', 'KEY idx_email_drafts_batch (workspace_id, batch_id)');
    await db.ensureIndex('email_drafts', 'uq_email_drafts_unsub', 'UNIQUE KEY uq_email_drafts_unsub (unsubscribe_token)');
  }
};
