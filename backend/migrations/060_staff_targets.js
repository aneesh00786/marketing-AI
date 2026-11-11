/**
 * Staff targets: what a member (or everyone with a role) should reach per day, week, month, quarter or a
 * custom date range, for one measure (leads converted, calls connected, follow-ups on time …). A person's own
 * target for a measure and period type replaces their role's. Progress is computed from recorded activity,
 * never stored. Reversible: down() drops the table.
 */
module.exports = {
  id: '060_staff_targets',
  async up(db) {
    await db.ensureTable('staff_targets', `CREATE TABLE staff_targets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      scope VARCHAR(10) NOT NULL,
      user_id INT NULL,
      role VARCHAR(60) NULL,
      metric VARCHAR(40) NOT NULL,
      period_type VARCHAR(12) NOT NULL,
      target_value DECIMAL(12,2) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NULL,
      note VARCHAR(300) NULL,
      created_by INT NULL,
      updated_by INT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      KEY idx_staff_targets_ws (workspace_id, scope, metric),
      KEY idx_staff_targets_user (workspace_id, user_id),
      CONSTRAINT fk_staff_targets_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_staff_targets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  },
  async down(db) {
    await db.query('DROP TABLE IF EXISTS staff_targets').catch(() => null);
  }
};
