/**
 * Follow-up calls from a campaign: the call log keeps which campaign and which recipient (email)
 * it was for, so the campaign's recipient history can show it. Call logs stay global CRM records
 * (no workspace column); the workspace comes from the linked campaign.
 */
module.exports = {
  id: '035_call_log_context',
  async up(db) {
    await db.ensureColumn('crm_call_logs', 'campaign_id', 'INT NULL');
    await db.ensureColumn('crm_call_logs', 'email', 'VARCHAR(255) NULL');
    await db.ensureIndex('crm_call_logs', 'idx_crm_call_logs_campaign', 'KEY idx_crm_call_logs_campaign (campaign_id)');
    // An early local version of this migration added a workspace column; the CRM has none.
    if (await db.columnInfo('crm_call_logs', 'workspace_id')) {
      await db.query('ALTER TABLE `crm_call_logs` DROP INDEX `idx_crm_call_logs_ws_email`').catch(() => null);
      await db.query('ALTER TABLE `crm_call_logs` DROP COLUMN `workspace_id`');
    }
  }
};
