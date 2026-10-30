#!/usr/bin/env node
/**
 * LOCAL release verification and migration rehearsal on a DISPOSABLE database.
 *
 *   cd backend && node scripts/localVerify.js --db mt_rehearsal_<suffix> [--skip-suites] [--keep]
 *
 * Safety:
 * - The target name is checked BEFORE any connection: it must be mt_rehearsal_<a-z0-9_>, must not be
 *   the configured DB_NAME, PRODUCTION_DB_NAME, "tradesage" or the test database, and must not exist
 *   yet (it is never reused or replaced, and a rejected name is never swapped for another one).
 * - Every process started here runs with scripts/lib/blockNetwork.js: no provider, SMTP/IMAP or
 *   external DNS can be reached; provider credentials are blanked for the app start check.
 * - Only databases created by this run (<db>, <db>_restore, <db>_rollback) are dropped at the end
 *   (unless --keep). Dumps and the temporary client option file live in a private temp folder that
 *   is deleted afterwards.
 *
 * Steps: dependencies; fresh install up to 023 (production's current schema); verified backup;
 * 024/025 through the production backup guard; schema checks (tables, columns, indexes, unique keys,
 * foreign keys, no grants); idempotent re-run; workspace/user cascades; retention purge; app start
 * against the migrated database; post-migration backup + restore check; rollback rehearsal (restore
 * the pre-migration backup); backend tests, frontend tests and production build (unless
 * --skip-suites); release package contents. Prints a PASS/FAIL report; exit status 1 on any FAIL.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

require('./lib/blockNetwork');
const BACKEND = path.resolve(__dirname, '..');
const REPO = path.resolve(BACKEND, '..');
require('dotenv').config({ path: path.join(BACKEND, '.env') });

const GUARD = path.join(__dirname, 'lib', 'blockNetwork.js');
const args = process.argv.slice(2);
const arg = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const has = flag => args.includes(flag);

const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const fail = (msg) => { console.error(`REFUSED: ${msg}`); process.exit(2); };

// ---------------------------------------------------------------- target name (before any connection)
const target = arg('--db');
const configured = String(process.env.DB_NAME || '').toLowerCase();
const forbidden = new Set(['tradesage', 'tradesage_test', configured, String(process.env.PRODUCTION_DB_NAME || '').toLowerCase(), String(process.env.TEST_DB_NAME || '').toLowerCase()].filter(Boolean));
if (!target) fail('pass --db mt_rehearsal_<suffix> (a new, disposable database name).');
if (!/^mt_rehearsal_[a-z0-9_]{1,40}$/.test(target)) fail(`"${target}" is not a disposable rehearsal name (expected mt_rehearsal_<a-z0-9_>).`);
for (const name of [target, `${target}_restore`, `${target}_rollback`]) {
  if (forbidden.has(name.toLowerCase())) fail(`"${name}" is a configured, production or test database; refusing.`);
}
if (process.env.DEPLOYMENT_ENV === 'staging' || process.env.NODE_ENV === 'production') {
  fail('backend/.env is a staging or production configuration; run this only on a development machine.');
}
// Disposable databases are created and dropped only on a database server on this machine: a DB_HOST
// pointing elsewhere (e.g. a production or RDS server) is refused before connecting.
const dbHost = String(process.env.DB_HOST || '127.0.0.1').trim().toLowerCase();
if (!/^(localhost|127\.\d+\.\d+\.\d+|::1)$/.test(dbHost)) fail(`DB_HOST "${dbHost}" is not a local database server; this script only creates databases on this machine.`);

const BIN = process.env.MYSQL_BIN_DIR || (fs.existsSync('/Applications/XAMPP/xamppfiles/bin/mysqldump') ? '/Applications/XAMPP/xamppfiles/bin' : '');
const tool = name => (BIN ? path.join(BIN, name) : name);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-verify-'));
fs.chmodSync(tmp, 0o700);
const cnf = path.join(tmp, 'client.cnf');
// The option file holds the database password: remove the folder even if the run is interrupted.
const removeTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* already gone */ } };
let interrupted = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    if (interrupted) return;
    interrupted = true;
    console.log(`\n${sig}: cleaning up`);
    await dropCreated();
    removeTmp();
    process.exit(130);
  });
}
process.on('exit', removeTmp);
fs.writeFileSync(cnf, `[client]\nhost=${process.env.DB_HOST || '127.0.0.1'}\nport=${process.env.DB_PORT || 3306}\nuser=${process.env.DB_USER || 'root'}\npassword=${process.env.DB_PASSWORD || ''}\n`, { mode: 0o600 });

const created = [];
const childEnv = extra => ({ ...process.env, NODE_OPTIONS: `--require ${GUARD}`, ...extra });
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

async function main() {
  const mysql = require('mysql2/promise');
  const server = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: +(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' });
  const q = async (sql, p = []) => (await server.query(sql, p))[0];

  // ------------------------------------------------------------ dependencies
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  record('Node.js >= 18', nodeMajor >= 18, process.versions.node);
  const dumpV = run(tool('mysqldump'), ['--version']);
  record('mysqldump available', dumpV.status === 0, (dumpV.stdout || '').trim().split('\n')[0]);
  record('mysql client available', run(tool('mysql'), ['--version']).status === 0);
  record('backend and frontend dependencies installed', fs.existsSync(path.join(BACKEND, 'node_modules')) && fs.existsSync(path.join(REPO, 'frontend', 'node_modules')));
  const [srv] = await q('SELECT VERSION() AS v, @@hostname AS h');
  record('database server reachable', true, srv.v);
  const prodHost = String(process.env.PRODUCTION_DB_HOSTNAME || '').trim().toLowerCase();
  if (prodHost && String(srv.h).toLowerCase() === prodHost) { record('database server is not the production server', false, `@@hostname is ${srv.h}`); return; }
  record('database server is not the production server', true, prodHost ? `@@hostname ${srv.h}` : 'PRODUCTION_DB_HOSTNAME not set; local host only');

  for (const name of [target, `${target}_restore`, `${target}_rollback`]) {
    const exists = await q('SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [name]);
    if (exists.length) { record(`target ${name} does not exist yet`, false, 'refusing to reuse an existing database'); return; }
  }
  await q(`CREATE DATABASE \`${target}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  created.push(target);

  // ------------------------------------------------------------ fresh install to 023
  const env = childEnv({ DB_NAME: target, NODE_ENV: 'development' });
  const seed = run('node', ['seed.js'], { cwd: BACKEND, env });
  record('fresh install: base schema (seed.js)', seed.status === 0, seed.status === 0 ? '' : (seed.stderr || seed.stdout).slice(-300));
  const to023 = run('node', ['db/migrate.js', '--until=023_social_media_library'], { cwd: BACKEND, env });
  record('fresh install: migrations up to 023 (production\'s current schema)', to023.status === 0, (to023.stderr || '').slice(-200));
  const { migrate, backupProblem } = require('../db/migrate');
  const status023 = await migrate({ databaseName: target, statusOnly: true, log: () => {} });
  record('status at 023: 024, 025 and 026 pending', status023.pending.join(',') === '024_mail_tracking,025_compose_purpose_and_grants,026_mail_provider_apps', `pending: ${status023.pending.join(', ')}`);

  // ------------------------------------------------------------ verified pre-migration backup
  const pre = path.join(tmp, `${target}-pre.sql`);
  // Same options as scripts/backup.sh: --triggers but no --routines (the app has no stored routines,
  // and --routines aborts on MariaDB servers whose mysql.proc table is outdated).
  const dump = (db, file) => run(tool('mysqldump'), [`--defaults-extra-file=${cnf}`, '--single-transaction', '--triggers', '--hex-blob', db], { maxBuffer: 512 * 1024 * 1024 });
  let d = dump(target, pre);
  if (d.status === 0) fs.writeFileSync(pre, d.stdout, { mode: 0o600 });
  record('pre-migration backup (mysqldump)', d.status === 0, d.status === 0 ? `${(fs.statSync(pre).size / 1024).toFixed(0)} KB` : d.stderr.slice(-200));
  const preProblem = await backupProblem(pre, target, status023.applied);
  record('pre-migration backup accepted by the production backup check', !preProblem, preProblem || 'header, "Dump completed" trailer and migration list match');

  // ------------------------------------------------------------ 024/025 through the production guard
  const refused = await migrate({ databaseName: target, env: { NODE_ENV: 'production' }, log: () => {} }).then(() => null, e => e);
  record('production mode refuses to migrate without a backup', refused && refused.code === 'BACKUP_REQUIRED');
  const applied = await migrate({ databaseName: target, env: { NODE_ENV: 'production' }, backupPath: pre, log: () => {} }).then(r => r, e => ({ error: e }));
  record('024, 025 and 026 applied with the verified backup', !applied.error && applied.applied.join(',') === '024_mail_tracking,025_compose_purpose_and_grants,026_mail_provider_apps', applied.error ? applied.error.message : applied.applied.join(', '));

  const db = (sql, p = []) => q(sql.replace(/\bTARGET\b/g, target), p);
  const tables = (await db("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'TARGET'")).map(r => r.t);
  const need = ['mail_message_tracking', 'mail_tracked_links', 'mail_events', 'mail_webhook_endpoints', 'workspace_member_capability_grants', 'mail_provider_apps'];
  record('024/025/026 tables exist', need.every(t => tables.includes(t)), need.filter(t => !tables.includes(t)).join(', '));
  const cols = await db("SELECT TABLE_NAME AS t, COLUMN_NAME AS c, IS_NULLABLE AS n, COLUMN_DEFAULT AS d FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'TARGET' AND ((TABLE_NAME = 'mail_configurations' AND COLUMN_NAME IN ('track_opens','track_clicks','tracking_updated_by','tracking_updated_at')) OR (TABLE_NAME = 'mail_send_requests' AND COLUMN_NAME IN ('declared_purpose','applied_purpose','purpose_reasons')))");
  const col = (t, c) => cols.find(x => x.t === t && x.c === c);
  record('tracking switches default to off', ['track_opens', 'track_clicks'].every(c => col('mail_configurations', c) && String(col('mail_configurations', c).d) === '0'));
  record('purpose columns are nullable (legacy rows "not recorded")', ['declared_purpose', 'applied_purpose', 'purpose_reasons'].every(c => col('mail_send_requests', c) && col('mail_send_requests', c).n === 'YES'));
  const idx = (await db("SELECT TABLE_NAME AS t, INDEX_NAME AS i, NON_UNIQUE AS u FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = 'TARGET'")).map(r => `${r.t}.${r.i}:${r.u}`);
  const wantIdx = ['mail_message_tracking.uq_mail_tracking_token:0', 'mail_tracked_links.uq_mail_link_token:0', 'mail_events.uq_mail_events_dedupe:0', 'mail_webhook_endpoints.uq_mail_webhook_token:0', 'mail_webhook_endpoints.uq_mail_webhook_ws_provider:0', 'workspace_member_capability_grants.uq_member_capability:0', 'mail_send_requests.idx_mail_send_requests_ws_created:1', 'mail_events.idx_mail_events_received:1'];
  record('unique keys and indexes', wantIdx.every(i => idx.includes(i)), wantIdx.filter(i => !idx.includes(i)).join(', '));
  const fks = (await db("SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS c, DELETE_RULE AS d FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = 'TARGET'")).map(r => `${r.c}:${r.d}`);
  const wantFk = ['fk_mail_tracking_ws:CASCADE', 'fk_mail_links_ws:CASCADE', 'fk_mail_links_tracking:CASCADE', 'fk_mail_events_ws:CASCADE', 'fk_mail_events_tracking:CASCADE', 'fk_mail_webhooks_ws:CASCADE', 'fk_member_capability_ws:CASCADE', 'fk_member_capability_user:CASCADE', 'fk_member_capability_grantor:SET NULL', 'fk_mail_provider_apps_ws:CASCADE'];
  record('foreign keys and delete rules', wantFk.every(f => fks.includes(f)), wantFk.filter(f => !fks.includes(f)).join(', '));
  const [grants] = await db('SELECT COUNT(*) AS n FROM TARGET.workspace_member_capability_grants');
  record('no capability grants created by the migration', Number(grants.n) === 0, `${grants.n} rows`);

  // ------------------------------------------------------------ idempotent re-run
  const again = await migrate({ databaseName: target, log: () => {} });
  record('re-running migrate applies nothing', again.applied.length === 0);
  await db("DELETE FROM TARGET.schema_migrations WHERE id IN ('024_mail_tracking','025_compose_purpose_and_grants','026_mail_provider_apps')");
  const rerun = await migrate({ databaseName: target, log: () => {} }).then(r => r, e => ({ error: e }));
  record('024/025/026 are safe to apply twice (ensure* helpers)', !rerun.error && rerun.applied.length === 3, rerun.error ? rerun.error.message : '');

  // ------------------------------------------------------------ cascades and retention
  const ws = (await db("INSERT INTO TARGET.workspaces (name, slug, owner_email, plan, status, created_at) VALUES ('Rehearsal', CONCAT('rh-', UUID_SHORT()), 'owner@rehearsal.invalid', 'Starter', 'Active', UTC_TIMESTAMP())")).insertId;
  const user = (await db("INSERT INTO TARGET.users (email, password_hash, display_name, status, created_at, updated_at) VALUES (CONCAT('u', UUID_SHORT(), '@rehearsal.invalid'), 'x', 'Rehearsal', 'Active', UTC_TIMESTAMP(), UTC_TIMESTAMP())")).insertId;
  await db("INSERT INTO TARGET.workspace_member_capability_grants (workspace_id, user_id, capability) VALUES (?, ?, 'mail.send_transactional')", [ws, user]);
  const tr = (await db("INSERT INTO TARGET.mail_message_tracking (workspace_id, tracking_token) VALUES (?, REPLACE(UUID(), '-', ''))", [ws])).insertId;
  await db("INSERT INTO TARGET.mail_events (workspace_id, tracking_id, source, event_type, occurred_at, received_at, dedupe_key) VALUES (?, ?, 'app', 'queued', UTC_TIMESTAMP(), UTC_TIMESTAMP() - INTERVAL 500 DAY, SHA2(UUID(), 256))", [ws, tr]);
  await db("INSERT INTO TARGET.mail_tracked_links (workspace_id, tracking_id, link_token, url, url_hash, created_at) VALUES (?, ?, REPLACE(UUID(), '-', ''), 'https://example.invalid/', SHA2('x', 256), UTC_TIMESTAMP() - INTERVAL 500 DAY)", [ws, tr]);
  let dupe = null;
  try { await db("INSERT INTO TARGET.workspace_member_capability_grants (workspace_id, user_id, capability) VALUES (?, ?, 'mail.send_transactional')", [ws, user]); } catch (e) { dupe = e.code; }
  record('a grant cannot be duplicated (unique key)', dupe === 'ER_DUP_ENTRY');

  process.env.DB_NAME = target; // in-process modules below use the disposable database only
  const purge = await require('../modules/mail/tracking/trackingService').purgeExpired();
  record('retention purge removes expired events and links, keeps the summary', purge.events >= 1 && purge.links >= 1 && (await db('SELECT COUNT(*) AS n FROM TARGET.mail_message_tracking WHERE id = ?', [tr]))[0].n === 1, JSON.stringify(purge));
  await require('../db/database').closeDatabase?.();

  await db('DELETE FROM TARGET.users WHERE id = ?', [user]);
  record('deleting a user removes their grants', (await db('SELECT COUNT(*) AS n FROM TARGET.workspace_member_capability_grants WHERE workspace_id = ?', [ws]))[0].n === 0);
  await db('DELETE FROM TARGET.workspaces WHERE id = ?', [ws]);
  record('deleting a workspace removes its tracking data', (await db('SELECT COUNT(*) AS n FROM TARGET.mail_message_tracking WHERE workspace_id = ?', [ws]))[0].n === 0);

  // ------------------------------------------------------------ app start against the migrated database
  record('app starts on the migrated database (no providers)', await appStartCheck(), 'GET /api/status, pixel, webhook disabled');

  // ------------------------------------------------------------ post-migration backup, restore, rollback
  const post = path.join(tmp, `${target}-post.sql`);
  d = dump(target, post);
  if (d.status === 0) fs.writeFileSync(post, d.stdout, { mode: 0o600 });
  const postApplied = (await migrate({ databaseName: target, statusOnly: true, log: () => {} })).applied;
  const postProblem = d.status === 0 ? await backupProblem(post, target, postApplied) : d.stderr;
  record('post-migration backup verified', !postProblem, postProblem || '');
  const restoreInto = async (name, file) => {
    await q(`CREATE DATABASE \`${name}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created.push(name);
    return run(tool('mysql'), [`--defaults-extra-file=${cnf}`, name], { input: fs.readFileSync(file) });
  };
  const r1 = await restoreInto(`${target}_restore`, post);
  const countTables = async name => Number((await q('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [name]))[0].n);
  const sameMigrations = async (a, b) => JSON.stringify((await q(`SELECT id FROM \`${a}\`.schema_migrations ORDER BY id`)).map(r => r.id)) === JSON.stringify((await q(`SELECT id FROM \`${b}\`.schema_migrations ORDER BY id`)).map(r => r.id));
  record('restore of the post-migration backup matches (tables, migrations)', r1.status === 0 && await countTables(`${target}_restore`) === await countTables(target) && await sameMigrations(target, `${target}_restore`), r1.status === 0 ? '' : r1.stderr.slice(-200));
  const r2 = await restoreInto(`${target}_rollback`, pre);
  const rbTables = r2.status === 0 ? (await q("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('mail_events','workspace_member_capability_grants','mail_provider_apps')", [`${target}_rollback`])).length : -1;
  const rbLast = r2.status === 0 ? (await q(`SELECT id FROM \`${target}_rollback\`.schema_migrations ORDER BY id DESC LIMIT 1`))[0]?.id : null;
  record('rollback rehearsal: restoring the pre-migration backup gives the 023 schema', r2.status === 0 && rbTables === 0 && rbLast === '023_social_media_library', `latest migration: ${rbLast}`);

  // ------------------------------------------------------------ suites and build
  if (!has('--skip-suites')) {
    const bt = run('npm', ['test'], { cwd: BACKEND, env: childEnv({}) });
    const m = /ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(bt.stdout || '');
    record('backend tests (test database, network blocked)', bt.status === 0, m ? `${m[1]} passed, ${m[2]} failed` : (bt.stdout || '').slice(-200));
    const ft = run('npx', ['ng', 'test', '--watch=false', '--browsers=ChromeHeadless'], { cwd: path.join(REPO, 'frontend') });
    const fm = /TOTAL: (\d+) SUCCESS/.exec(ft.stdout || '');
    record('frontend tests', ft.status === 0, fm ? `${fm[1]} passed` : (ft.stdout || '').split('\n').filter(l => /FAILED|TOTAL/.test(l)).slice(-3).join(' '));
    const fb = run('npx', ['ng', 'build', '--configuration', 'production'], { cwd: path.join(REPO, 'frontend') });
    const warnings = ((fb.stdout || '') + (fb.stderr || '')).match(/\[WARNING\]/g) || [];
    record('production build', fb.status === 0, `${warnings.length} warning(s)`);
    const dirty = run('git', ['status', '--porcelain', 'frontend/dist'], { cwd: REPO });
    record('committed frontend/dist matches a fresh build', !dirty.stdout.trim(), dirty.stdout.trim() ? 'dist differs: rebuild and commit it' : '');
  }

  // ------------------------------------------------------------ release package (committed HEAD)
  const zip = path.join(tmp, 'release.zip');
  const pk = run('node', ['backend/scripts/packageRelease.js', '--out', zip], { cwd: REPO });
  // git archive puts everything under one top-level folder (e.g. marketing-AI/); compare without it.
  const list = pk.status === 0 ? run('unzip', ['-Z1', zip]).stdout.split('\n').filter(Boolean).map(n => n.replace(/^[^/]+\//, '')).filter(Boolean) : [];
  const want = ['frontend/dist/frontend/browser/index.html', 'backend/migrations/024_mail_tracking.js', 'backend/migrations/025_compose_purpose_and_grants.js', 'backend/migrations/026_mail_provider_apps.js', 'backend/.env.example'];
  const bad = list.filter(n => /(^|\/)\.env$|\.env\.(?!example$)|\.(sql|dump|log|bak|pem|key)$|(^|\/)(node_modules|storage|logs?|scratch)\//i.test(n));
  record('release package (git HEAD): passes its checks and has the migrations and built frontend', pk.status === 0 && want.every(w => list.includes(w)) && !bad.length, pk.status === 0 ? `${list.length} entries${bad.length ? `; forbidden: ${bad.join(', ')}` : ''}` : (pk.stderr || pk.stdout).slice(-200));
  const uncommitted = run('git', ['status', '--porcelain'], { cwd: REPO }).stdout.trim();
  if (uncommitted) console.log(`NOTE  uncommitted changes are not in the package (git archive of HEAD):\n${uncommitted}`);

  await server.end();
}

function freePort() {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function get(port, p, method = 'GET') {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json' } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: b })); });
    req.on('error', () => resolve({ status: 0 }));
    req.end(method === 'POST' ? '{}' : undefined);
  });
}
async function appStartCheck() {
  const port = await freePort();
  const blank = Object.fromEntries(['ZEPTOMAIL_TOKEN', 'SMTP_PASS', 'IMAP_PASS', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'TELNYX_API_KEY', 'ELEVENLABS_API_KEY', 'ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'GOOGLE_PLACES_API_KEY', 'ZEPTOMAIL_WEBHOOKS_ENABLED', 'DEPLOYMENT_ENV'].map(k => [k, '']));
  const child = spawn('node', ['server.js'], { cwd: BACKEND, env: childEnv({ ...blank, DB_NAME: target, PORT: String(port), NODE_ENV: 'development' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', c => out += c); child.stderr.on('data', c => out += c);
  try {
    const started = Date.now();
    while (Date.now() - started < 30000 && !/Running on/.test(out)) await new Promise(r => setTimeout(r, 250));
    if (!/Running on/.test(out)) { console.log(out.slice(-500)); return false; }
    const status = await get(port, '/api/status');
    const pixel = await get(port, `/api/v1/mail/t/o/${'a'.repeat(32)}.gif`);
    const hook = await get(port, `/api/v1/mail/t/webhooks/zeptomail/${'b'.repeat(32)}`, 'POST');
    return status.status === 200 && /"productEmails"/.test(status.body) && pixel.status === 200 && /image\/gif/.test(pixel.type) && hook.status === 404;
  } finally {
    child.kill('SIGTERM');
  }
}

/** Drops only the databases this run created (never anything else), unless --keep. */
async function dropCreated() {
  if (has('--keep') || !created.length) { if (created.length) console.log(`kept: ${created.join(', ')}`); return; }
  try {
    const mysql = require('mysql2/promise');
    const c = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: +(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' });
    for (const name of created.splice(0)) if (/^mt_rehearsal_[a-z0-9_]+$/.test(name)) { await c.query(`DROP DATABASE IF EXISTS \`${name}\``); console.log(`cleanup: dropped ${name} (created by this run)`); }
    await c.end();
  } catch (e) { console.log(`cleanup failed: ${e.message}`); }
}

main()
  .catch(err => record('unexpected error', false, err.message))
  .finally(async () => {
    if (interrupted) return;
    await dropCreated();
    fs.rmSync(tmp, { recursive: true, force: true });
    const failed = results.filter(r => !r.ok);
    console.log(`\n${failed.length ? 'RESULT: FAIL' : 'RESULT: PASS'} — ${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
