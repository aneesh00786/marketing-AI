const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const DB_CLIENT = process.env.DB_CLIENT || 'mysql';

let sqliteDb = null;
let mysqlPool = null;

if (DB_CLIENT === 'mysql') {
  const mysql = require('mysql2/promise');
  mysqlPool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'tradesage',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // Store and read DATETIME values as UTC so scheduling is exact regardless of host time zone.
    timezone: 'Z'
  });
  mysqlPool.pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });
  console.log(`[DB] Configured for MySQL at ${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || '3306'} (Database: ${process.env.DB_NAME || 'tradesage'})`);
} else {
  const sqlite3 = require('sqlite3').verbose();
  const DB_PATH = path.resolve(__dirname, '../../tradesage.db');
  sqliteDb = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.error('Failed to connect to SQLite database:', err.message);
    } else {
      console.log('Connected to SQLite database at:', DB_PATH);
    }
  });
}

// MySQL rejects `undefined` as a parameter; a value that was never set is stored as NULL.
const cleanParams = params => (Array.isArray(params) ? params.map(p => (p === undefined ? null : p)) : params);

// Universal query helpers
function run(sql, params = []) {
  params = cleanParams(params);
  if (DB_CLIENT === 'mysql') {
    return mysqlPool.execute(sql, params).then(([result]) => ({
      lastID: result.insertId,
      changes: result.affectedRows
    }));
  }
  return new Promise((resolve, reject) => {
    sqliteDb.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  params = cleanParams(params);
  if (DB_CLIENT === 'mysql') {
    return mysqlPool.execute(sql, params).then(([rows]) => rows[0] || null);
  }
  return new Promise((resolve, reject) => {
    sqliteDb.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  params = cleanParams(params);
  if (DB_CLIENT === 'mysql') {
    return mysqlPool.execute(sql, params).then(([rows]) => rows || []);
  }
  return new Promise((resolve, reject) => {
    sqliteDb.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

/**
 * Startup check. The schema comes only from migrations (backend/migrations, applied with
 * `node db/migrate.js`); the server never creates tables or inserts data on its own.
 * Pending migrations are reported so they can be applied before the app is used.
 */
async function initDatabase() {
  if (DB_CLIENT !== 'mysql') {
    console.warn('[DB] Only MySQL is supported: set DB_CLIENT=mysql and apply the migrations (node db/migrate.js).');
    return;
  }
  try {
    const { migrate } = require('./migrate');
    const { pending } = await migrate({ statusOnly: true, log: () => {} });
    if (pending.length) {
      console.warn(`[DB] ${pending.length} migration(s) not applied: ${pending.join(', ')}. Run: cd backend && node db/migrate.js`);
    } else {
      console.log('[DB] Schema is up to date.');
    }
  } catch (err) {
    console.error(`[DB] Could not check migrations: ${err.message}. For a new install run: cd backend && node db/migrate.js --create-database`);
  }
}

// Optional live integration with an external Traivo MySQL database (legacy workspace only).
// Off unless TRAIVO_DB_NAME is set; host, port, user and password come from TRAIVO_DB_*.
let traivoPool = null;
const traivoDbName = () => (process.env.TRAIVO_DB_NAME || '').trim() || null;

function getTraivoPool() {
  if (!traivoPool) {
    try {
      const mysql = require('mysql2/promise');
      if (!traivoDbName()) return null;
      traivoPool = mysql.createPool({
        host: process.env.TRAIVO_DB_HOST || '127.0.0.1',
        port: parseInt(process.env.TRAIVO_DB_PORT || '3306', 10),
        user: process.env.TRAIVO_DB_USER || 'root',
        password: process.env.TRAIVO_DB_PASSWORD || '',
        database: traivoDbName(),
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0
      });
    } catch (e) {
      console.warn('MySQL pool initialization warning:', e.message);
    }
  }
  return traivoPool;
}

async function queryTraivoMySQL() {
  try {
    const pool = getTraivoPool();
    // Counts are reported only when the Traivo database answers; never placeholder numbers.
    if (!pool) return { connected: false, database: traivoDbName(), message: traivoDbName() ? 'MySQL driver unavailable' : 'No Traivo database is configured (TRAIVO_DB_NAME).', totalProducts: null, totalOrders: null, sampleProducts: [] };
    const [productsCount] = await pool.query('SELECT count(*) as count FROM products');
    const [ordersCount] = await pool.query('SELECT count(*) as count FROM sales_orders');
    const [sampleProducts] = await pool.query('SELECT id, name, category_id, base_sell_price FROM products LIMIT 6');
    return {
      connected: true,
      database: traivoDbName(),
      totalProducts: Number(productsCount[0]?.count || 0),
      totalOrders: Number(ordersCount[0]?.count || 0),
      sampleProducts: sampleProducts || []
    };
  } catch (err) {
    return {
      connected: false,
      database: traivoDbName(),
      error: err.message,
      totalProducts: null,
      totalOrders: null,
      sampleProducts: []
    };
  }
}

/** Runs fn(tx) inside a transaction on one pooled connection (MySQL only). */
async function withTransaction(fn) {
  if (DB_CLIENT !== 'mysql') throw new Error('Transactions require DB_CLIENT=mysql');
  const conn = await mysqlPool.getConnection();
  const tx = {
    run: (sql, params = []) => conn.execute(sql, params).then(([r]) => ({ lastID: r.insertId, changes: r.affectedRows })),
    get: (sql, params = []) => conn.execute(sql, params).then(([rows]) => rows[0] || null),
    all: (sql, params = []) => conn.execute(sql, params).then(([rows]) => rows || [])
  };
  try {
    await conn.beginTransaction();
    const result = await fn(tx);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function closeDatabase() {
  if (traivoPool) { await traivoPool.end().catch(() => {}); traivoPool = null; }
  if (mysqlPool) await mysqlPool.end();
  if (sqliteDb) sqliteDb.close();
}

module.exports = {
  withTransaction,
  closeDatabase,
  DB_CLIENT,
  db: sqliteDb,
  sqliteDb,
  mysqlPool,
  run,
  get,
  all,
  initDatabase,
  queryTraivoMySQL
};

if (require.main === module) {
  initDatabase().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('[DB] Database initialization failed:', err);
    process.exit(1);
  });
}

