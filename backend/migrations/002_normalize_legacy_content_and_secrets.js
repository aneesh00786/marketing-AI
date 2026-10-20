/**
 * 1. Map legacy content statuses onto the publishing workflow.
 *    Legacy "Published" was a manual button with no provider confirmation, so it
 *    becomes "approved" with an explanatory note — it is never shown as published.
 * 2. Encrypt plaintext mailbox credentials when an encryption key is configured.
 *
 * Status comparisons use BINARY: the column collation is case-insensitive, and the new
 * lowercase workflow statuses ('published', 'scheduled') must never match the legacy ones.
 */
const secretBox = require('../lib/secretBox');

const PLATFORM_KEYS = {
  linkedin: 'linkedin',
  twitter: 'x',
  x: 'x',
  instagram: 'instagram',
  facebook: 'facebook',
  youtube: 'youtube'
};

module.exports = {
  id: '002_normalize_legacy_content_and_secrets',

  async up(db) {
    await db.query("UPDATE content_items SET status = 'draft' WHERE BINARY status IN ('Draft')");
    await db.query("UPDATE content_items SET status = 'review' WHERE BINARY status IN ('Pending Approval')");
    await db.query("UPDATE content_items SET status = 'approved' WHERE BINARY status IN ('Approved')");
    await db.query("UPDATE content_items SET status = 'rejected' WHERE BINARY status IN ('Rejected')");
    await db.query(
      `UPDATE content_items
       SET status = 'approved', published_at = NULL, scheduled_at = NULL,
           last_error = 'Imported from the old studio, where it was marked "Published"/"Scheduled" manually. No platform confirmation exists.'
       WHERE BINARY status IN ('Published', 'Scheduled')`
    );

    const rows = await db.query('SELECT id, platform FROM content_items WHERE platform_key IS NULL');
    for (const row of rows) {
      const key = PLATFORM_KEYS[String(row.platform || '').toLowerCase()] || null;
      if (key) await db.query('UPDATE content_items SET platform_key = ? WHERE id = ?', [key, row.id]);
    }

    if (!(await db.tableExists('mail_configurations'))) return;
    // Ciphertext is longer than the plaintext; widen VARCHAR(255) password columns first.
    for (const col of ['smtp_pass', 'imap_pass']) {
      const info = await db.columnInfo('mail_configurations', col);
      if (info && /^varchar/i.test(info.COLUMN_TYPE)) {
        await db.query(`ALTER TABLE mail_configurations MODIFY COLUMN \`${col}\` TEXT NULL`);
      }
    }
    if (!secretBox.isConfigured()) {
      console.warn('  ! SOCIAL_TOKEN_ENCRYPTION_KEY not set: mailbox passwords left as-is. Set the key and re-save mail settings.');
      return;
    }
    const configs = await db.query('SELECT id, smtp_pass, imap_pass FROM mail_configurations');
    for (const cfg of configs) {
      const update = {};
      for (const col of ['smtp_pass', 'imap_pass']) {
        const v = cfg[col];
        if (v && !secretBox.isEncrypted(v) && !v.startsWith('[env:')) update[col] = secretBox.encrypt(v);
      }
      if (Object.keys(update).length > 0) {
        const sets = Object.keys(update).map(c => `${c} = ?`).join(', ');
        await db.query(`UPDATE mail_configurations SET ${sets} WHERE id = ?`, [...Object.values(update), cfg.id]);
      }
    }
  }
};
