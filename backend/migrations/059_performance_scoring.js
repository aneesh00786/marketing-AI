/**
 * Team Performance scoring settings, one row per workspace: which measures make up the performance score,
 * their weights, the minimum acceptable and target value of each, and the level thresholds
 * (Excellent / On track / Needs improvement / Critical). Without a row the documented defaults apply.
 * Reversible: down() drops the table.
 */
module.exports = {
  id: '059_performance_scoring',
  async up(db) {
    await db.ensureTable('performance_scoring_configs', `CREATE TABLE performance_scoring_configs (
      workspace_id INT NOT NULL PRIMARY KEY,
      config_json TEXT NOT NULL,
      updated_by INT NULL,
      updated_at DATETIME NOT NULL,
      CONSTRAINT fk_perf_scoring_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  },
  async down(db) {
    await db.query('DROP TABLE IF EXISTS performance_scoring_configs').catch(() => null);
  }
};
