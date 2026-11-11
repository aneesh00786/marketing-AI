/**
 * Indexes for Team Performance's aggregate queries (per member and period): calls by caller and time,
 * activities by performer and time, follow-ups by due time, audit entries by action and time, lead status
 * changes by subject, and leads by creation time. Additive; down() drops them.
 */
const INDEXES = [
  ['crm_call_logs', 'idx_crm_call_logs_user_started', 'KEY idx_crm_call_logs_user_started (user_id, started_at)'],
  ['lead_activities', 'idx_lead_activities_ws_performer', 'KEY idx_lead_activities_ws_performer (workspace_id, performed_by, activity_at)'],
  ['lead_activities', 'idx_lead_activities_ws_at', 'KEY idx_lead_activities_ws_at (workspace_id, activity_at)'],
  ['lead_followups', 'idx_lead_followups_ws_due', 'KEY idx_lead_followups_ws_due (workspace_id, due_at)'],
  ['audit_logs', 'idx_audit_ws_action_created', 'KEY idx_audit_ws_action_created (workspace_id, action, created_at)'],
  ['automation_events', 'idx_automation_events_subject', 'KEY idx_automation_events_subject (workspace_id, event_type, subject_id, created_at)'],
  ['leads', 'idx_leads_ws_created', 'KEY idx_leads_ws_created (workspace_id, created_at)']
];
module.exports = {
  id: '061_performance_indexes',
  async up(db) {
    for (const [table, name, def] of INDEXES) if (await db.tableExists(table)) await db.ensureIndex(table, name, def);
  },
  async down(db) {
    for (const [table, name] of INDEXES) await db.query(`ALTER TABLE ${table} DROP INDEX ${name}`).catch(() => null);
  }
};
