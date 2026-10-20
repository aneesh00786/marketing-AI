const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const h = require('./helpers');
const mysql = require('mysql2/promise');

test.after(() => h.shutdown());

test('migrations are recorded and every migration is safe to re-apply', async () => {
  await h.prepareDatabase();
  const { migrate } = require('../db/migrate');
  const status = await migrate({ statusOnly: true, log: () => {} });
  assert.equal(status.pending.length, 0);

  // Re-run each migration body against the already-migrated schema: must be a no-op, not an error.
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME
  });
  try {
    const dir = path.resolve(__dirname, '../migrations');
    const files = fs.readdirSync(dir).filter(f => /^\d{3}_.+\.js$/.test(f)).sort();
    const created = [];
    const helpers = {
      query: (sql, p = []) => conn.query(sql, p).then(([r]) => r),
      tableExists: async t => (await conn.query('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [process.env.DB_NAME, t]))[0].length > 0,
      columnInfo: async (t, c) => (await conn.query('SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [process.env.DB_NAME, t, c]))[0][0] || null,
      ensureTable: async (t) => { if (!(await helpers.tableExists(t))) created.push(t); return false; },
      ensureColumn: async (t, c) => { if (!(await helpers.columnInfo(t, c))) created.push(`${t}.${c}`); return false; },
      ensureIndex: async () => false,
      ensureForeignKey: async () => false
    };
    for (const f of files) await require(path.join(dir, f)).up(helpers);
    assert.deepEqual(created, [], 'every table and column from the migrations exists');
  } finally {
    await conn.end();
  }
});

test('tenant-scoped foreign keys stop cross-workspace references at the database level', async () => {
  await h.prepareDatabase();
  const A = await h.createWorkspace();
  const B = await h.createWorkspace();
  const acctA = await h.createAccount(A.workspaceId);
  const { run } = h.db();
  const content = await run("INSERT INTO content_items (workspace_id, platform_key, caption_text, status, version, created_at) VALUES (?, 'facebook', 'x', 'approved', 1, UTC_TIMESTAMP())", [B.workspaceId]);
  await assert.rejects(
    () => run(
      "INSERT INTO publishing_jobs (workspace_id, content_item_id, social_account_id, content_version, idempotency_key, status, scheduled_for, next_attempt_at) VALUES (?, ?, ?, 1, 'cross', 'queued', UTC_TIMESTAMP(), UTC_TIMESTAMP())",
      [B.workspaceId, content.lastID, acctA.id]
    ),
    err => /foreign key constraint/i.test(err.message)
  );
});
