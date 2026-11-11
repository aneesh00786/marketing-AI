/**
 * Scheduled Team Performance reports: a weekly or monthly email to chosen members, covering the whole team, a
 * role or chosen people. Sent by the worker through the workspace's existing mail settings. Reversible.
 */
module.exports = {
  id: '062_performance_report_schedules',
  async up(db) {
    await db.ensureTable('performance_report_schedules', `CREATE TABLE performance_report_schedules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      frequency VARCHAR(10) NOT NULL,
      weekday TINYINT NULL,
      day_of_month TINYINT NULL,
      send_hour TINYINT NOT NULL DEFAULT 9,
      recipients_json TEXT NOT NULL,
      scope VARCHAR(10) NOT NULL DEFAULT 'team',
      scope_role VARCHAR(60) NULL,
      scope_members_json TEXT NULL,
      format VARCHAR(12) NOT NULL DEFAULT 'summary',
      active TINYINT(1) NOT NULL DEFAULT 1,
      last_period_key VARCHAR(20) NULL,
      last_sent_at DATETIME NULL,
      last_error VARCHAR(500) NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      KEY idx_perf_schedules_ws (workspace_id, active),
      CONSTRAINT fk_perf_schedules_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  },
  async down(db) {
    await db.query('DROP TABLE IF EXISTS performance_report_schedules').catch(() => null);
  }
};
