/**
 * Refuses staging-only operations when the environment could be production (see lib/stagingGuard.js).
 * Run it before every staging restore, worker start or live platform test:
 *
 *   node scripts/stagingPreflight.js                              (before starting the staging worker)
 *   node scripts/stagingPreflight.js --restore-target <db name>   (before restoring a dump into <db name>)
 *
 * Read-only. Exit status 1 when any problem is found.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');
const { stagingProblems } = require('../lib/stagingGuard');

(async () => {
  const i = process.argv.indexOf('--restore-target');
  const restoreTarget = i >= 0 ? (process.argv[i + 1] || '') : null;
  // Environment checks first, without any connection: a production name (in any letter case) or a
  // missing marker is refused before this script ever connects to that database.
  const early = await stagingProblems({ env: process.env, query: null, restoreTarget });
  if (early.problems.length) {
    console.log(`Staging preflight: DEPLOYMENT_ENV=${process.env.DEPLOYMENT_ENV || '(not set)'}, DB_NAME=${early.dbName}, production DB name=${early.prodDb} (not connected)`);
    for (const p of early.problems) console.log(`Problem: ${p}`);
    console.log(`REFUSED: ${early.problems.length} problem(s).`);
    process.exitCode = 1;
    return;
  }
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    // A restore check connects without selecting a database (the target may not exist yet).
    database: restoreTarget !== null ? undefined : (process.env.DB_NAME || 'tradesage')
  });
  const query = async (sql, params = []) => (await conn.query(sql, params))[0];
  try {
    const r = await stagingProblems({ env: process.env, query, restoreTarget });
    console.log(`Staging preflight: DEPLOYMENT_ENV=${process.env.DEPLOYMENT_ENV || '(not set)'}, DB_NAME=${r.dbName}, production DB name=${r.prodDb}${restoreTarget !== null ? `, restore target=${restoreTarget}` : ''}`);
    for (const w of r.warnings) console.log(`Warning: ${w}`);
    for (const p of r.problems) console.log(`Problem: ${p}`);
    console.log(r.problems.length ? `REFUSED: ${r.problems.length} problem(s).` : 'OK: staging-only operation may proceed.');
    process.exitCode = r.problems.length ? 1 : 0;
  } finally {
    await conn.end();
  }
})().catch(err => { console.error(`REFUSED: ${err.message}`); process.exit(1); });
