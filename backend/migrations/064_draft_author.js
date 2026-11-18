/**
 * Who created each email draft, so people see only their own drafts in Mail Center (Owners/Admins and "View all
 * mail" see all). Filled in for existing drafts only from recorded evidence: the product-email batch they belong
 * to (its creator), or the Sent email they became (its sender). Others stay unattributed (visible to admins).
 * Reversible: down() drops the column.
 */
module.exports = {
  id: '064_draft_author',
  async up(db) {
    await db.ensureColumn('email_drafts', 'created_by_user_id', 'INT NULL');
    await db.ensureIndex('email_drafts', 'idx_email_drafts_ws_author', 'KEY idx_email_drafts_ws_author (workspace_id, created_by_user_id)');
    if (await db.tableExists('mail_draft_batches')) {
      await db.query(`UPDATE email_drafts d JOIN mail_draft_batches b ON b.id = d.batch_id AND b.workspace_id = d.workspace_id
        SET d.created_by_user_id = COALESCE(b.created_by, b.sent_by) WHERE d.created_by_user_id IS NULL`).catch(() => null);
    }
    if (await db.columnInfo('emails', 'sent_by_user_id')) {
      await db.query(`UPDATE email_drafts d JOIN emails e ON e.id = d.email_id AND e.workspace_id = d.workspace_id
        SET d.created_by_user_id = e.sent_by_user_id WHERE d.created_by_user_id IS NULL AND e.sent_by_user_id IS NOT NULL`).catch(() => null);
    }
  },
  async down(db) {
    await db.query('ALTER TABLE email_drafts DROP INDEX idx_email_drafts_ws_author').catch(() => null);
    await db.query('ALTER TABLE email_drafts DROP COLUMN created_by_user_id').catch(() => null);
  }
};
