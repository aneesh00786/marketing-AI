const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./helpers');
const { backupProblem, migrate } = require('../db/migrate');
const { checkConfig, enforce, enforceMigrated } = require('../lib/productionConfig');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-deploy-test-'));
const SCRATCH_DB = 'tradesage_deploycheck_test';

function dump(name, database, { ageHours = 0, size = 4096, migrations = ['001_a', '002_b'], complete = true } = {}) {
  const p = path.join(TMP, name);
  const header = `-- MariaDB dump 10.19  Distrib 10.4.28-MariaDB\n--\n-- Host: localhost    Database: ${database}\n-- ------\n`;
  const rows = migrations.length ? `INSERT INTO \`schema_migrations\` VALUES ${migrations.map(m => `('${m}','2026-10-01 00:00:00')`).join(',')};\n` : '';
  const body = `${header}${rows}`.padEnd(size, '-');
  fs.writeFileSync(p, `${body}\n${complete ? '-- Dump completed on 2026-10-26  9:00:00\n' : ''}`);
  const t = new Date(Date.now() - ageHours * 3600 * 1000);
  fs.utimesSync(p, t, t);
  return p;
}

test.after(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const conn = await require('mysql2/promise').createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: process.env.DB_PORT || 3306, user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' });
  await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
  await conn.end();
});

test('a production migration needs a recent, complete dump matching the database state', async () => {
  const applied = ['001_a', '002_b'];
  const bp = (file, db = 'tradesage') => backupProblem(file, db, applied);
  assert.match(await backupProblem(null, 'tradesage'), /--backup=/);
  assert.match(await bp(path.join(TMP, 'none.sql')), /not found/);
  assert.match(await bp(dump('small.sql', 'tradesage', { size: 200 })), /too small/);
  assert.match(await bp(dump('old.sql', 'tradesage', { ageHours: 30 })), /older than 24 hours/);
  assert.match(await bp(dump('other.sql', 'tradesage_test')), /does not look like/, 'a dump of another database is refused');
  fs.writeFileSync(path.join(TMP, 'notdump.sql'), 'hello'.padEnd(4096, ' '));
  assert.match(await bp(path.join(TMP, 'notdump.sql')), /does not look like/);
  assert.match(await bp(dump('cut.sql', 'tradesage', { complete: false })), /incomplete/, 'a failed or truncated dump is refused');
  assert.match(await bp(dump('stale.sql', 'tradesage', { migrations: ['001_a'] })), /does not match the current state/, 'a dump from another point in time is refused');
  assert.equal(await bp(dump('good.sql', 'tradesage')), null);
});

test('with NODE_ENV=production and no backup, pending migrations are not applied', async () => {
  const conn = await require('mysql2/promise').createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: process.env.DB_PORT || 3306, user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' });
  await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
  await conn.query(`CREATE DATABASE \`${SCRATCH_DB}\``);
  await conn.end();
  await assert.rejects(
    migrate({ databaseName: SCRATCH_DB, env: { NODE_ENV: 'production' }, log: () => {} }),
    err => err.code === 'BACKUP_REQUIRED' && /023_social_media_library/.test(err.message)
  );
  const status = await migrate({ databaseName: SCRATCH_DB, statusOnly: true, log: () => {} });
  assert.deepEqual(status.applied, [], 'nothing was applied');
  assert.ok(status.pending.includes('023_social_media_library'));
});

const SECRETS = { JWT_SECRET: 'j'.repeat(40), SOCIAL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'), MAIL_ASSET_STORAGE_DIR: path.join(TMP, 'mail-assets') };

test('production configuration requires the JWT secret and a valid 32-byte encryption key', () => {
  const base = { APP_BASE_URL: 'https://app.example.com', SOCIAL_MEDIA_STORAGE_DIR: path.join(TMP, 'k') };
  const p = (env) => checkConfig({ ...base, ...env }).problems.join(' | ');
  assert.equal(p(SECRETS), '');
  assert.match(p({ ...SECRETS, JWT_SECRET: 'short' }), /JWT_SECRET/);
  assert.match(p({ ...SECRETS, SOCIAL_TOKEN_ENCRYPTION_KEY: '' }), /SOCIAL_TOKEN_ENCRYPTION_KEY/);
  assert.match(p({ ...SECRETS, SOCIAL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }), /32 random bytes/);
  assert.equal(p({ ...SECRETS, SOCIAL_TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) }), '', 'hex keys are accepted');
});

test('production configuration requires a public https APP_BASE_URL and an absolute, writable storage folder', () => {
  const storage = path.join(TMP, 'media');
  assert.deepEqual(checkConfig({ ...SECRETS, APP_BASE_URL: 'https://app.example.com', SOCIAL_MEDIA_STORAGE_DIR: storage }).problems, []);
  assert.ok(fs.existsSync(storage), 'the folder is created');
  const p = (env) => checkConfig(env).problems.join(' | ');
  assert.match(p({ SOCIAL_MEDIA_STORAGE_DIR: storage }), /APP_BASE_URL is not set/);
  assert.match(p({ APP_BASE_URL: 'http://app.example.com', SOCIAL_MEDIA_STORAGE_DIR: storage }), /must be https/);
  assert.match(p({ APP_BASE_URL: 'https://localhost:8000', SOCIAL_MEDIA_STORAGE_DIR: storage }), /local or private/);
  assert.match(p({ APP_BASE_URL: 'https://app.example.com' }), /SOCIAL_MEDIA_STORAGE_DIR is not set/);
  assert.match(p({ APP_BASE_URL: 'https://app.example.com', SOCIAL_MEDIA_STORAGE_DIR: 'storage/media' }), /absolute path/);
  const ro = path.join(TMP, 'readonly');
  fs.mkdirSync(ro);
  fs.chmodSync(ro, 0o500);
  try {
    if (process.getuid && process.getuid() !== 0) assert.match(p({ APP_BASE_URL: 'https://app.example.com', SOCIAL_MEDIA_STORAGE_DIR: ro }), /not writable/);
  } finally { fs.chmodSync(ro, 0o700); }
});

test('the API and worker stop on unsafe production configuration but only warn in development', () => {
  const quiet = { log() {}, warn() {}, error() {} };
  const exits = [];
  enforce('api', { NODE_ENV: 'production', APP_BASE_URL: 'http://localhost:8000', SOCIAL_MEDIA_STORAGE_DIR: path.join(TMP, 'm2') }, { exit: c => exits.push(c), log: quiet });
  assert.deepEqual(exits, [1]);
  enforce('api', { NODE_ENV: 'development', APP_BASE_URL: 'http://localhost:8000' }, { exit: c => exits.push(c), log: quiet });
  assert.deepEqual(exits, [1], 'development does not exit');
  const ok = enforce('social-worker', { ...SECRETS, NODE_ENV: 'production', APP_BASE_URL: 'https://app.example.com', SOCIAL_MEDIA_STORAGE_DIR: path.join(TMP, 'm3') }, { exit: c => exits.push(c), log: quiet });
  assert.equal(ok.ok, true);
  assert.equal(ok.storageRoot, path.join(TMP, 'm3'));
});

test('the API server and the worker resolve the same storage folder', () => {
  const mediaStore = require('../modules/social/mediaStore');
  const saved = process.env.SOCIAL_MEDIA_STORAGE_DIR;
  try {
    process.env.SOCIAL_MEDIA_STORAGE_DIR = path.join(TMP, 'shared');
    assert.equal(mediaStore.storageRoot(), checkConfig(process.env).storageRoot);
  } finally {
    if (saved === undefined) delete process.env.SOCIAL_MEDIA_STORAGE_DIR; else process.env.SOCIAL_MEDIA_STORAGE_DIR = saved;
  }
  assert.ok(h);
});

test('the storage verification script finds missing, damaged and orphan files without changing anything', async () => {
  const { verify } = require('../scripts/verifyMediaStorage');
  const root = path.join(TMP, 'verify');
  const id = (c) => c.repeat(43);
  fs.mkdirSync(path.join(root, '5'), { recursive: true });
  fs.writeFileSync(path.join(root, '5', id('a')), 'abcd');
  fs.writeFileSync(path.join(root, '5', id('b')), 'ab');
  fs.writeFileSync(path.join(root, '5', id('c')), 'orphan');
  const rows = [
    { id: 1, workspace_id: 5, public_id: id('a'), size_bytes: 4 },
    { id: 2, workspace_id: 5, public_id: id('b'), size_bytes: 9 },
    { id: 3, workspace_id: 5, public_id: id('d'), size_bytes: 1 }
  ];
  const r = await verify({ all: async () => rows, storageRoot: root });
  assert.equal(r.checked, 3);
  assert.deepEqual(r.missing.map(m => m.assetId), [3]);
  assert.deepEqual(r.damaged.map(m => m.assetId), [2]);
  assert.deepEqual(r.orphans, [`5/${id('c')}`]);
  assert.ok(fs.existsSync(path.join(root, '5', id('c'))), 'nothing is deleted');
});

test('the encrypted-credential check counts unreadable values without exposing them', async () => {
  const { verify } = require('../scripts/verifyEncryptedSecrets');
  const tables = { 'provider_credentials.secret_ciphertext': ['enc:v1:good', 'enc:v1:bad'] };
  const all = async (sql) => {
    if (sql.includes('information_schema')) return [{ t: 'provider_credentials', c: 'secret_ciphertext' }, { t: 'leads', c: 'name' }];
    return tables['provider_credentials.secret_ciphertext'].map(v => ({ v }));
  };
  const r = await verify({ all, databaseName: 'x', decrypt: v => { if (v.endsWith('bad')) throw new Error('auth failed'); return 'plain'; } });
  assert.deepEqual(r, [{ column: 'provider_credentials.secret_ciphertext', ok: 1, failed: 1 }]);
});

test('the API and worker refuse to start in production while migrations are pending', async () => {
  const quiet = { log() {}, warn() {}, error() {} };
  const exits = [];
  const pending = async () => ({ pending: ['023_social_media_library'] });
  await enforceMigrated('api', { NODE_ENV: 'production' }, { exit: c => exits.push(c), log: quiet, status: pending });
  assert.deepEqual(exits, [1]);
  await enforceMigrated('social-worker', { NODE_ENV: 'development' }, { exit: c => exits.push(c), log: quiet, status: pending });
  assert.deepEqual(exits, [1], 'development only warns');
  const ok = await enforceMigrated('social-worker', { NODE_ENV: 'production' }, { exit: c => exits.push(c), log: quiet, status: async () => ({ pending: [] }) });
  assert.equal(ok.ok, true);
});

test('production configuration requires an absolute, writable mail asset folder', () => {
  const base = { ...SECRETS, APP_BASE_URL: 'https://app.example.com', SOCIAL_MEDIA_STORAGE_DIR: path.join(TMP, 'sm') };
  const p = (env) => checkConfig({ ...base, ...env }).problems.join(' | ');
  assert.equal(p({}), '');
  assert.match(p({ MAIL_ASSET_STORAGE_DIR: '' }), /MAIL_ASSET_STORAGE_DIR is not set/);
  assert.match(p({ MAIL_ASSET_STORAGE_DIR: 'storage/mail' }), /must be an absolute path/);
});

test('mail template assets are verified with the same checks as social media', async () => {
  const { verify, MAIL_SQL } = require('../scripts/verifyMediaStorage');
  const root = path.join(TMP, 'mailverify');
  fs.mkdirSync(path.join(root, '2'), { recursive: true });
  fs.writeFileSync(path.join(root, '2', 'm'.repeat(43)), 'xyz');
  let usedSql = null;
  const r = await verify({ all: async (sql) => { usedSql = sql; return [{ id: 9, workspace_id: 2, public_id: 'm'.repeat(43), size_bytes: 3 }, { id: 10, workspace_id: 2, public_id: 'n'.repeat(43), size_bytes: 1 }]; }, storageRoot: root, sql: MAIL_SQL });
  assert.equal(usedSql, MAIL_SQL);
  assert.deepEqual(r.missing.map(m => m.assetId), [10]);
  assert.equal(r.damaged.length, 0);
});

test('a migration status check never writes to the database it inspects', async () => {
  const mysql = require('mysql2/promise');
  const cfg = { host: process.env.DB_HOST || '127.0.0.1', port: process.env.DB_PORT || 3306, user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '' };
  const c = await mysql.createConnection(cfg);
  const EMPTY = 'tradesage_statuscheck_test';
  await c.query(`DROP DATABASE IF EXISTS \`${EMPTY}\``);
  await c.query(`CREATE DATABASE \`${EMPTY}\``);
  try {
    const st = await migrate({ databaseName: EMPTY, statusOnly: true, log: () => {} });
    assert.deepEqual(st.applied, []);
    assert.ok(st.pending.includes('023_social_media_library'));
    const [t] = await c.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [EMPTY]);
    assert.deepEqual(t, [], 'no table was created');
  } finally {
    await c.query(`DROP DATABASE IF EXISTS \`${EMPTY}\``);
    await c.end();
  }
});
