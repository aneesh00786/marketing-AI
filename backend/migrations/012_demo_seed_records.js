/**
 * Internal marker for demo data: every row the demo seed scripts insert is recorded here
 * (table + id + which script), so seeded rows can be told apart from rows people create in the
 * demo workspace, and removed precisely. Never shown as a label in the UI. Additive only.
 */
module.exports = {
  id: '012_demo_seed_records',

  async up(db) {
    await db.ensureTable('demo_seed_records', `CREATE TABLE demo_seed_records (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NULL,
      table_name VARCHAR(64) NOT NULL,
      record_id BIGINT NOT NULL,
      seeded_by VARCHAR(40) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_demo_seed_record (table_name, record_id),
      KEY idx_demo_seed_ws (workspace_id, table_name),
      CONSTRAINT fk_demo_seed_records_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
  }
};
