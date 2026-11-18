/**
 * In-app notifications per person (the bell). Each is keyed by what it is about (e.g. one overdue follow-up), so
 * it is shown once, keeps its read state, and is marked resolved when the thing is dealt with (e.g. the follow-up
 * is completed). Reversible: down() drops the table.
 */
module.exports = {
  id: '063_user_notifications',
  async up(db) {
    await db.ensureTable('user_notifications', `CREATE TABLE user_notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      user_id INT NOT NULL,
      kind VARCHAR(40) NOT NULL,
      ref_key VARCHAR(120) NOT NULL,
      title VARCHAR(200) NOT NULL,
      detail VARCHAR(300) NULL,
      tone VARCHAR(10) NOT NULL DEFAULT 'info',
      icon VARCHAR(20) NOT NULL DEFAULT 'bell',
      link_json VARCHAR(500) NULL,
      occurred_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL,
      read_at DATETIME NULL,
      resolved_at DATETIME NULL,
      UNIQUE KEY uq_user_notification (workspace_id, user_id, ref_key),
      KEY idx_user_notifications_open (workspace_id, user_id, resolved_at, occurred_at),
      CONSTRAINT fk_user_notifications_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_user_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  },
  async down(db) {
    await db.query('DROP TABLE IF EXISTS user_notifications').catch(() => null);
  }
};
