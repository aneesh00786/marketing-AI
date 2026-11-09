/**
 * Lead follow-ups (Leads → a lead → Follow-ups). Email and calls reuse what the email campaign's
 * "Follow up" already has: Compose for email, the 📞 call button (crm_call_logs, optional
 * transcript) and the same email + call history. Added only what leads were missing:
 *
 * - crm_call_logs.lead_id / lead_workspace_id: the lead a call was made from (NULL for other calls),
 *   and followup_id: the scheduled follow-up the call was made for.
 * - lead_activities: notes, meetings, WhatsApp / SMS / call / email logs and general activities.
 * - lead_followups: scheduled follow-up tasks (assigned, due, priority, completed / cancelled).
 * Reversible: down() drops the tables and columns.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '054_lead_followups',
  async up(db) {
    const cols = [
      ['lead_id', 'INT NULL'],
      ['lead_workspace_id', 'INT NULL'],
      ['followup_id', 'INT NULL']
    ];
    for (const [c, d] of cols) await db.ensureColumn('crm_call_logs', c, d);
    await db.ensureIndex('crm_call_logs', 'idx_crm_call_logs_lead', 'KEY idx_crm_call_logs_lead (lead_workspace_id, lead_id)');
    await db.ensureForeignKey('crm_call_logs', 'fk_crm_call_logs_lead', 'FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL');
    await db.ensureForeignKey('crm_call_logs', 'fk_crm_call_logs_lead_ws', 'FOREIGN KEY (lead_workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE');

    await db.ensureTable('lead_activities', `CREATE TABLE lead_activities (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      lead_id INT NOT NULL,
      activity_type VARCHAR(20) NOT NULL,
      note_category VARCHAR(30) NULL,
      title VARCHAR(255) NULL,
      description TEXT NULL,
      status VARCHAR(20) NULL,
      duration_minutes INT NULL,
      next_followup_at DATETIME NULL,
      activity_at DATETIME NOT NULL,
      followup_id INT NULL,
      performed_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_lead_activities_lead (workspace_id, lead_id, activity_at),
      CONSTRAINT fk_lead_activities_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_lead_activities_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
      CONSTRAINT fk_lead_activities_user FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL
    ) ${TABLE_OPTS}`);

    await db.ensureTable('lead_followups', `CREATE TABLE lead_followups (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      lead_id INT NOT NULL,
      assigned_user_id INT NULL,
      followup_type VARCHAR(20) NOT NULL,
      title VARCHAR(255) NOT NULL,
      description TEXT NULL,
      priority VARCHAR(10) NOT NULL DEFAULT 'medium',
      due_at DATETIME NOT NULL,
      reminder_minutes INT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      completed_at DATETIME NULL,
      completed_by INT NULL,
      completion_notes TEXT NULL,
      call_log_id INT NULL,
      created_by INT NULL,
      assigned_by INT NULL,
      assigned_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_lead_followups_lead (workspace_id, lead_id, status, due_at),
      KEY idx_lead_followups_assignee (workspace_id, assigned_user_id, status, due_at),
      CONSTRAINT fk_lead_followups_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_lead_followups_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
      CONSTRAINT fk_lead_followups_assignee FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_lead_followups_call FOREIGN KEY (call_log_id) REFERENCES crm_call_logs(id) ON DELETE SET NULL
    ) ${TABLE_OPTS}`);
  },
  async down(db) {
    await db.query('DROP TABLE IF EXISTS lead_followups');
    await db.query('DROP TABLE IF EXISTS lead_activities');
    for (const fk of ['fk_crm_call_logs_lead', 'fk_crm_call_logs_lead_ws']) await db.query(`ALTER TABLE crm_call_logs DROP FOREIGN KEY ${fk}`).catch(() => null);
    for (const ix of ['idx_crm_call_logs_lead']) await db.query(`ALTER TABLE crm_call_logs DROP INDEX ${ix}`).catch(() => null);
    for (const c of ['lead_id', 'lead_workspace_id', 'followup_id']) {
      await db.query(`ALTER TABLE crm_call_logs DROP COLUMN IF EXISTS ${c}`).catch(() => null);
    }
  }
};
