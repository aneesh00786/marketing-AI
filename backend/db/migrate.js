/**
 * TradeSage AI - forward-only schema migrations (MySQL / MariaDB).
 *
 *   npm run migrate            apply pending migrations to DB_NAME
 *   npm run migrate -- --status
 *
 * Migrations live in backend/migrations/NNN_name.js and export { id, up(db) }.
 * MySQL DDL auto-commits, so every migration must be idempotent: use the
 * ensure* helpers below instead of bare ALTER/CREATE statements.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

function connectionConfig(databaseName) {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: databaseName,
    timezone: 'Z',
    multipleStatements: false
  };
}

function createHelpers(conn, databaseName, log) {
  const db = {
    databaseName,
    query: (sql, params = []) => conn.query(sql, params).then(([rows]) => rows),

    async tableExists(table) {
      const rows = await db.query(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [databaseName, table]
      );
      return rows.length > 0;
    },

    async columnInfo(table, column) {
      const rows = await db.query(
        'SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [databaseName, table, column]
      );
      return rows[0] || null;
    },

    async ensureTable(table, createSql) {
      if (await db.tableExists(table)) return false;
      await db.query(createSql);
      log(`  + table ${table}`);
      return true;
    },

    async ensureColumn(table, column, definition) {
      if (await db.columnInfo(table, column)) return false;
      await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      log(`  + column ${table}.${column}`);
      return true;
    },

    async ensureIndex(table, indexName, definitionSql) {
      const rows = await db.query(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?',
        [databaseName, table, indexName]
      );
      if (rows.length > 0) return false;
      await db.query(`ALTER TABLE \`${table}\` ADD ${definitionSql}`);
      log(`  + index ${table}.${indexName}`);
      return true;
    },

    async ensureForeignKey(table, constraintName, definitionSql) {
      const rows = await db.query(
        `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
        [databaseName, table, constraintName]
      );
      if (rows.length > 0) return false;
      await db.query(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`${constraintName}\` ${definitionSql}`);
      log(`  + foreign key ${table}.${constraintName}`);
      return true;
    }
  };
  return db;
}

function loadMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{3}_.+\.js$/.test(f))
    .sort()
    .map(f => {
      const mod = require(path.join(MIGRATIONS_DIR, f));
      if (!mod.id || typeof mod.up !== 'function') {
        throw new Error(`Migration ${f} must export { id, up }`);
      }
      return mod;
    });
}

async function migrate({ databaseName = process.env.DB_NAME || 'tradesage', statusOnly = false, log = console.log } = {}) {
  if ((process.env.DB_CLIENT || 'mysql') !== 'mysql') {
    throw new Error('Migrations require DB_CLIENT=mysql.');
  }
  const conn = await mysql.createConnection(connectionConfig(databaseName));
  try {
    await conn.query("SET time_zone = '+00:00'");
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    const [appliedRows] = await conn.query('SELECT id FROM schema_migrations');
    const applied = new Set(appliedRows.map(r => r.id));
    const migrations = loadMigrations();
    const pending = migrations.filter(m => !applied.has(m.id));

    if (statusOnly) {
      for (const m of migrations) log(`${applied.has(m.id) ? '[applied]' : '[pending]'} ${m.id}`);
      return { applied: [...applied], pending: pending.map(m => m.id) };
    }

    const db = createHelpers(conn, databaseName, log);
    for (const m of pending) {
      log(`Applying ${m.id} to ${databaseName}...`);
      await m.up(db);
      await conn.query('INSERT INTO schema_migrations (id) VALUES (?)', [m.id]);
      log(`✓ ${m.id}`);
    }
    if (pending.length === 0) log(`Database ${databaseName} is up to date.`);
    return { applied: pending.map(m => m.id) };
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  const statusOnly = process.argv.includes('--status');
  migrate({ statusOnly })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Migration failed:', err.message);
      process.exit(1);
    });
}

module.exports = { migrate };
