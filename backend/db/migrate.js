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

const BACKUP_MAX_AGE_HOURS = 24;

/**
 * In production, pending migrations are applied only with a verified backup of the same database.
 * The file must exist, be newer than BACKUP_MAX_AGE_HOURS, start with the mysqldump/mariadb-dump
 * header naming this database, end with the dump's "Dump completed" line (a failed or truncated
 * dump has no trailer), and record exactly the migrations applied to the target database now
 * (appliedIds), which ties it to this database's current state rather than another copy with the
 * same name. Returns a problem message or null. Only the header, the trailer and the
 * schema_migrations rows are read; the file is streamed, never loaded whole.
 */
async function backupProblem(backupPath, databaseName, appliedIds = null) {
  if (!backupPath) return `NODE_ENV=production: pending migrations are applied only with a verified backup. Run: npm run migrate -- --backup=<path to a mysqldump of ${databaseName}>`;
  let stat;
  try { stat = fs.statSync(backupPath); } catch (e) { return `Backup file not found: ${backupPath}`; }
  if (!stat.isFile() || stat.size < 1024) return `Backup file is empty or too small: ${backupPath}`;
  if (Date.now() - stat.mtimeMs > BACKUP_MAX_AGE_HOURS * 3600 * 1000) return `Backup file is older than ${BACKUP_MAX_AGE_HOURS} hours; take a fresh backup first.`;
  const fd = fs.openSync(backupPath, 'r');
  const head = Buffer.alloc(4096);
  const n = fs.readSync(fd, head, 0, head.length, 0);
  const tail = Buffer.alloc(Math.min(2048, stat.size));
  fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length);
  fs.closeSync(fd);
  const text = head.subarray(0, n).toString('utf8');
  const escaped = databaseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!/(MySQL|MariaDB) dump/i.test(text) || !new RegExp(`Database: ${escaped}(\\s|$)`).test(text)) {
    return `Backup file does not look like a mysqldump/mariadb-dump of database ${databaseName}.`;
  }
  if (!/-- Dump completed/.test(tail.toString('utf8'))) {
    return 'Backup file is incomplete: it has no "Dump completed" line (the dump failed or was cut short, or was made with --skip-comments). Take a new backup and check that mysqldump exits without errors.';
  }
  if (appliedIds) {
    const inDump = new Set();
    const lines = require('readline').createInterface({ input: fs.createReadStream(backupPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.startsWith('INSERT INTO `schema_migrations`')) continue;
      for (const m of line.matchAll(/\('([^']+)'/g)) inDump.add(m[1]);
    }
    const expected = [...appliedIds].sort();
    const found = [...inDump].sort();
    if (expected.join('|') !== found.join('|')) {
      return `Backup does not match the current state of ${databaseName}: it records ${found.length} applied migration(s), the database has ${expected.length}. Take a fresh backup of this database.`;
    }
  }
  return null;
}

async function migrate({ databaseName = process.env.DB_NAME || 'tradesage', statusOnly = false, log = console.log, backupPath = null, env = process.env } = {}) {
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

    if (pending.length && env.NODE_ENV === 'production') {
      const problem = await backupProblem(backupPath, databaseName, [...applied]);
      if (problem) {
        const err = new Error(`${problem} Pending: ${pending.map(m => m.id).join(', ')}.`);
        err.code = 'BACKUP_REQUIRED';
        throw err;
      }
      log(`Verified backup ${backupPath} for ${databaseName}.`);
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
  const backupArg = process.argv.find(a => a.startsWith('--backup='));
  migrate({ statusOnly, backupPath: backupArg ? backupArg.slice('--backup='.length) : null })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Migration failed:', err.message);
      process.exit(1);
    });
}

module.exports = { migrate, backupProblem };
