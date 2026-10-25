/**
 * Marketing (Product Emails) delivery approval per workspace mail configuration. Additive only.
 * Product Emails are marketing email: they are never sent through ZeptoMail (transactional only)
 * and go out through the workspace's own SMTP mailbox only after an Owner/Admin confirms that the
 * mailbox provider allows marketing email. Changing the SMTP account clears the approval.
 */
module.exports = {
  id: '022_mail_marketing_approval',

  async up(db) {
    await db.ensureColumn('mail_configurations', 'marketing_approved', 'TINYINT(1) NOT NULL DEFAULT 0');
    await db.ensureColumn('mail_configurations', 'marketing_approved_by', 'INT NULL');
    await db.ensureColumn('mail_configurations', 'marketing_approved_at', 'DATETIME NULL');
    await db.ensureColumn('mail_configurations', 'marketing_approval_note', 'VARCHAR(255) NULL');
  }
};
