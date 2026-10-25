/**
 * Consent evidence, unsubscribe processing and background sending of product email batches.
 * Additive only; existing consent values and records are not changed.
 * - leads: how consent was obtained (method), when it was given (obtained_at) and the evidence
 *   reference (form submission id, document, URL...). Recording consent now requires these.
 * - lead_consent_events: append-only history of every consent change (who, when, how, evidence).
 * - email_drafts: per-recipient send state of batch emails (sent_at, email_id, batch_outcome,
 *   send_error), so batches resume without resending and replies can be matched to a send.
 * - mail_draft_batches: queue/lock fields for the background worker.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '021_consent_evidence_and_batch_worker',

  async up(db) {
    await db.ensureColumn('leads', 'marketing_consent_method', 'VARCHAR(40) NULL');
    await db.ensureColumn('leads', 'marketing_consent_obtained_at', 'DATETIME NULL');
    await db.ensureColumn('leads', 'marketing_consent_evidence', 'VARCHAR(500) NULL');

    await db.ensureTable('lead_consent_events', `CREATE TABLE lead_consent_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      lead_id INT NOT NULL,
      status VARCHAR(20) NOT NULL,
      method VARCHAR(40) NULL,
      obtained_at DATETIME NULL,
      evidence VARCHAR(500) NULL,
      note VARCHAR(255) NULL,
      actor_type VARCHAR(20) NOT NULL DEFAULT 'user',
      actor_user_id INT NULL,
      reference VARCHAR(100) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_lead_consent_events_lead (workspace_id, lead_id, id),
      CONSTRAINT fk_lead_consent_events_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureColumn('email_drafts', 'sent_at', 'DATETIME NULL');
    await db.ensureColumn('email_drafts', 'email_id', 'INT NULL');
    await db.ensureColumn('email_drafts', 'batch_outcome', 'VARCHAR(20) NULL');
    await db.ensureColumn('email_drafts', 'send_error', 'VARCHAR(500) NULL');

    await db.ensureColumn('mail_draft_batches', 'queued_at', 'DATETIME NULL');
    await db.ensureColumn('mail_draft_batches', 'locked_by', 'VARCHAR(100) NULL');
    await db.ensureColumn('mail_draft_batches', 'locked_at', 'DATETIME NULL');
    await db.ensureColumn('mail_draft_batches', 'last_error', 'VARCHAR(500) NULL');
    await db.ensureIndex('mail_draft_batches', 'idx_mail_draft_batches_status', 'KEY idx_mail_draft_batches_status (status, queued_at)');
  }
};
