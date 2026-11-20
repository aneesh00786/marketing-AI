/**
 * Personal sender addresses: each member adds their own email address in Marketech.ai and proves they own it
 * with a link sent to it. Once verified, their campaigns and Compose emails go from that address; members who
 * are not Owners/Admins cannot send email without one. Reversible: down() drops the table.
 */
module.exports = {
  id: '067_member_senders',
  async up(db) {
    await db.ensureTable('member_sender_addresses', `CREATE TABLE member_sender_addresses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      user_id INT NOT NULL,
      email VARCHAR(255) NOT NULL,
      display_name VARCHAR(100) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      token_hash CHAR(64) NULL,
      token_expires_at DATETIME NULL,
      verified_at DATETIME NULL,
      last_sent_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_sender_ws_email (workspace_id, email),
      KEY idx_sender_user (workspace_id, user_id, status),
      UNIQUE KEY uq_sender_token (token_hash)
    )`);
  },
  async down(db) {
    await db.query('DROP TABLE IF EXISTS member_sender_addresses').catch(() => null);
  }
};
