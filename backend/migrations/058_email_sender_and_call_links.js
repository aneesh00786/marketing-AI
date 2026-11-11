/**
 * Staff performance: who sent each email, and older calls linked to their lead.
 *
 * - emails.sent_by_user_id: the member who sent it (Compose, Mail Center drafts, product emails and the
 *   lead panel's "Send email", which opens Compose). Set on every send from now on. Existing emails are
 *   filled in only from recorded evidence:
 *     1. mail_send_requests.requested_by for the email (every Compose send);
 *     2. the audit log entry "mail.sent" (Compose) or "mail.draft_sent" (drafts and product emails).
 *   Emails without evidence (e.g. received mail) stay NULL. One column, so an email is counted once.
 * - crm_call_logs: calls made before calls were linked to leads (e.g. with the 📞 in the Leads list) are
 *   linked to their lead when exactly one lead in the caller's workspaces has that number (last 9
 *   digits). Ambiguous or unmatched calls are left as they are.
 * Reversible: down() drops the column (call links are kept; they are correct data).
 */
module.exports = {
  id: '058_email_sender_and_call_links',
  async up(db) {
    await db.ensureColumn('emails', 'sent_by_user_id', 'INT NULL');
    await db.ensureIndex('emails', 'idx_emails_ws_sender', 'KEY idx_emails_ws_sender (workspace_id, sent_by_user_id, sent_at)');

    // 1. Compose sends.
    if (await db.tableExists('mail_send_requests')) {
      await db.query(`UPDATE emails e JOIN mail_send_requests r ON r.email_id = e.id AND r.workspace_id = e.workspace_id
        SET e.sent_by_user_id = r.requested_by WHERE e.sent_by_user_id IS NULL AND r.requested_by IS NOT NULL`).catch(() => null);
    }
    // 2. Audit log: Compose ("mail.sent", resource = the email) and drafts / product emails ("mail.draft_sent", metadata.emailId).
    await db.query(`UPDATE emails e JOIN audit_logs a ON a.workspace_id = e.workspace_id AND a.action = 'mail.sent' AND a.resource_type = 'email'
        AND CAST(a.resource_id AS UNSIGNED) = e.id
      SET e.sent_by_user_id = a.actor_user_id WHERE e.sent_by_user_id IS NULL AND a.actor_user_id IS NOT NULL`).catch(() => null);
    await db.query(`UPDATE emails e JOIN audit_logs a ON a.workspace_id = e.workspace_id AND a.action = 'mail.draft_sent'
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.emailId')) AS UNSIGNED) = e.id
      SET e.sent_by_user_id = a.actor_user_id WHERE e.sent_by_user_id IS NULL AND a.actor_user_id IS NOT NULL`).catch(() => null);

    // Older calls → their lead, only when the match is unique.
    if (await db.columnInfo('crm_call_logs', 'lead_id')) {
      await db.query(`UPDATE crm_call_logs c JOIN (
          SELECT c2.id AS call_id, MIN(l.id) AS lead_id, MIN(l.workspace_id) AS ws, COUNT(DISTINCT l.id) AS n
          FROM crm_call_logs c2
          JOIN workspace_members m ON m.user_id = c2.user_id
          JOIN leads l ON l.workspace_id = m.workspace_id AND l.phone IS NOT NULL
            AND LENGTH(REGEXP_REPLACE(l.phone, '[^0-9]', '')) >= 7
            AND RIGHT(REGEXP_REPLACE(l.phone, '[^0-9]', ''), 9) = RIGHT(REGEXP_REPLACE(c2.phone, '[^0-9]', ''), 9)
          WHERE c2.lead_id IS NULL AND c2.campaign_id IS NULL AND c2.user_id IS NOT NULL
          GROUP BY c2.id HAVING n = 1
        ) x ON x.call_id = c.id
        SET c.lead_id = x.lead_id, c.lead_workspace_id = x.ws
        WHERE c.lead_id IS NULL`).catch(() => null);
    }
  },
  async down(db) {
    await db.query('ALTER TABLE emails DROP INDEX idx_emails_ws_sender').catch(() => null);
    await db.query('ALTER TABLE emails DROP COLUMN IF EXISTS sent_by_user_id').catch(() => null);
  }
};
