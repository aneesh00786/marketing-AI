const { run: dbRun, get } = require('../db/database');

/**
 * Internal marker for rows created by the demo seed scripts (table demo_seed_records, migration
 * 012). `recordingRun` wraps `run`: every single-row INSERT it executes is recorded with its table
 * and id. Without the migration the scripts still work and simply record nothing.
 */
let available = null;
async function registryAvailable() {
  if (available === null) available = !!(await get("SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'demo_seed_records'"));
  return available;
}

function recordingRun(seededBy, workspaceId = () => null) {
  return async (sql, params = []) => {
    const r = await dbRun(sql, params);
    const m = /^\s*INSERT\s+(?:IGNORE\s+)?INTO\s+`?(\w+)`?/i.exec(sql);
    if (m && r.lastID && await registryAvailable()) {
      await dbRun('INSERT IGNORE INTO demo_seed_records (workspace_id, table_name, record_id, seeded_by, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
        [workspaceId(), m[1], r.lastID, seededBy]);
    }
    return r;
  };
}

/** True when the row was created by a demo seed script. */
async function isSeededRecord(table, id) {
  if (!(await registryAvailable())) return false;
  return !!(await get('SELECT 1 AS x FROM demo_seed_records WHERE table_name = ? AND record_id = ?', [table, Number(id)]));
}

module.exports = { recordingRun, isSeededRecord, registryAvailable };
