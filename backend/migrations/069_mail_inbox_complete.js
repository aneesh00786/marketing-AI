/**
 * Received mail, completed:
 * - emails.received_key: the Message-ID of a received email, unique per workspace, so two syncs running at the same
 *   time (automatic and the Sync button) cannot save it twice. Sent rows leave it NULL.
 * - Threads: in_reply_to / references_header of received mail, reply_to_email_id (a received reply → the email of
 *   ours it answers; a sent reply → the received email it answers), header_message_id (the Message-ID header of an
 *   email we sent, when the provider lets us know it).
 * - Where a received email lives: mailbox_source ('workspace' or 'sender:<id>'), imap_folder, imap_uid (to mark it
 *   read there too), is_spam (synced from the Spam folder).
 * - email_attachments: files of received emails (stored in the database, size-capped).
 * - mail_sync_state: the last message (IMAP UID) read from each mailbox folder, so a sync reads everything new.
 * Reversible: down() drops what this adds.
 */
module.exports = {
  id: '069_mail_inbox_complete',
  async up(db) {
    await db.ensureColumn('emails', 'received_key', 'VARCHAR(255) NULL');
    await db.ensureColumn('emails', 'in_reply_to', 'VARCHAR(500) NULL');
    await db.ensureColumn('emails', 'references_header', 'TEXT NULL');
    await db.ensureColumn('emails', 'reply_to_email_id', 'INT NULL');
    await db.ensureColumn('emails', 'header_message_id', 'VARCHAR(255) NULL');
    await db.ensureColumn('emails', 'mailbox_source', 'VARCHAR(40) NULL');
    await db.ensureColumn('emails', 'imap_folder', 'VARCHAR(255) NULL');
    await db.ensureColumn('emails', 'imap_uid', 'BIGINT NULL');
    await db.ensureColumn('emails', 'is_spam', 'TINYINT(1) NOT NULL DEFAULT 0');
    // Existing received mail: the first copy of each Message-ID keeps the key (later duplicates stay NULL).
    await db.query(`UPDATE emails e JOIN (
        SELECT MIN(id) AS id FROM emails WHERE status NOT IN ('Sent', 'Not Sent') AND message_id IS NOT NULL AND message_id <> ''
        GROUP BY workspace_id, message_id) f ON f.id = e.id
      SET e.received_key = e.message_id WHERE e.received_key IS NULL`);
    await db.ensureIndex('emails', 'uq_emails_received_key', 'UNIQUE INDEX uq_emails_received_key (workspace_id, received_key)');
    await db.ensureIndex('emails', 'idx_emails_header_mid', 'INDEX idx_emails_header_mid (workspace_id, header_message_id)');
    await db.ensureIndex('emails', 'idx_emails_message_id', 'INDEX idx_emails_message_id (workspace_id, message_id)');
    await db.ensureIndex('emails', 'idx_emails_reply_to', 'INDEX idx_emails_reply_to (workspace_id, reply_to_email_id)');
    await db.ensureTable('email_attachments', `CREATE TABLE email_attachments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      email_id INT NOT NULL,
      filename VARCHAR(255) NOT NULL,
      content_type VARCHAR(150) NULL,
      size_bytes INT NOT NULL DEFAULT 0,
      content LONGBLOB NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_attach_email (workspace_id, email_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await db.ensureTable('mail_sync_state', `CREATE TABLE mail_sync_state (
      workspace_id INT NOT NULL,
      mailbox_key VARCHAR(40) NOT NULL,
      folder VARCHAR(255) NOT NULL,
      uid_validity BIGINT NULL,
      last_uid BIGINT NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (workspace_id, mailbox_key, folder)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  },
  async down(db) {
    await db.query('DROP TABLE IF EXISTS mail_sync_state').catch(() => null);
    await db.query('DROP TABLE IF EXISTS email_attachments').catch(() => null);
    for (const i of ['uq_emails_received_key', 'idx_emails_header_mid', 'idx_emails_message_id', 'idx_emails_reply_to']) {
      await db.query(`ALTER TABLE emails DROP INDEX ${i}`).catch(() => null);
    }
    for (const c of ['received_key', 'in_reply_to', 'references_header', 'reply_to_email_id', 'header_message_id', 'mailbox_source', 'imap_folder', 'imap_uid', 'is_spam']) {
      await db.query(`ALTER TABLE emails DROP COLUMN ${c}`).catch(() => null);
    }
  }
};
