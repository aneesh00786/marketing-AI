/**
 * Call log for browser calling. Additive only: one new table, and no workspace_id, like the rest of
 * the global CRM.
 *
 * crm_call_logs: one row per call started from a phone icon. Audio is never stored. When the
 * caller ticks "Transcribe this call", each side's audio passes through the server to Telnyx
 * speech-to-text and only the text is kept: agent_segments and customer_segments are JSON lists of
 * { start, end, text }, merged in time order when read. transcript_status: none, pending, done,
 * failed.
 *
 * Deleting a contact keeps the log without the link; deleting a user clears their name.
 * Rollback: older code ignores this table. To remove it, drop crm_call_logs and delete the
 * 029_crm_call_logs row from schema_migrations; that deletes all call logs, so back up first.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '029_crm_call_logs',

  async up(db) {
    await db.ensureTable('crm_call_logs', `CREATE TABLE crm_call_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      contact_id INT NULL,
      phone VARCHAR(30) NOT NULL,
      name VARCHAR(255) NULL,
      transcribe TINYINT(1) NOT NULL DEFAULT 0,
      transcript_status VARCHAR(20) NOT NULL DEFAULT 'none',
      agent_segments MEDIUMTEXT NULL,
      customer_segments MEDIUMTEXT NULL,
      answered TINYINT(1) NOT NULL DEFAULT 0,
      duration_seconds INT NULL,
      started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME NULL,
      KEY idx_crm_call_logs_started (started_at),
      KEY idx_crm_call_logs_contact (contact_id),
      KEY idx_crm_call_logs_user (user_id),
      CONSTRAINT fk_crm_call_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_crm_call_logs_contact FOREIGN KEY (contact_id) REFERENCES crm_contacts(id) ON DELETE SET NULL
    ) ${TABLE_OPTS}`);
  }
};
