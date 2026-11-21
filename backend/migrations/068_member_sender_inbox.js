/**
 * Each member's own inbox: the IMAP mailbox of their verified sender address (the login is that same address), so
 * replies to the emails they send are synced into Marketech.ai. The password is stored encrypted.
 * emails.mailbox_user_id records whose inbox a received email was synced from; that member sees it.
 * Reversible: down() drops the columns and the index.
 */
module.exports = {
  id: '068_member_sender_inbox',
  async up(db) {
    await db.ensureColumn('member_sender_addresses', 'imap_host', 'VARCHAR(255) NULL');
    await db.ensureColumn('member_sender_addresses', 'imap_port', 'INT NULL');
    await db.ensureColumn('member_sender_addresses', 'imap_tls', 'TINYINT(1) NOT NULL DEFAULT 1');
    await db.ensureColumn('member_sender_addresses', 'imap_pass', 'TEXT NULL');
    await db.ensureColumn('member_sender_addresses', 'imap_status', 'VARCHAR(20) NULL');
    await db.ensureColumn('member_sender_addresses', 'imap_error', 'VARCHAR(500) NULL');
    await db.ensureColumn('member_sender_addresses', 'imap_synced_at', 'DATETIME NULL');
    await db.ensureColumn('emails', 'mailbox_user_id', 'INT NULL');
    await db.ensureIndex('emails', 'idx_emails_mailbox_user', 'INDEX idx_emails_mailbox_user (workspace_id, mailbox_user_id)');
  },
  async down(db) {
    await db.query('ALTER TABLE emails DROP INDEX idx_emails_mailbox_user').catch(() => null);
    await db.query('ALTER TABLE emails DROP COLUMN mailbox_user_id').catch(() => null);
    for (const c of ['imap_host', 'imap_port', 'imap_tls', 'imap_pass', 'imap_status', 'imap_error', 'imap_synced_at']) {
      await db.query(`ALTER TABLE member_sender_addresses DROP COLUMN ${c}`).catch(() => null);
    }
  }
};
