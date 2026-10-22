/**
 * Shared test setup. Tests run against a dedicated database (default tradesage_test)
 * and never touch the application database. All provider HTTP calls are mocked:
 * these are NOT live integration tests against Meta/LinkedIn/Google.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

process.env.DB_NAME = process.env.TEST_DB_NAME || 'tradesage_test';
if (!/_test$/.test(process.env.DB_NAME)) {
  throw new Error(`Refusing to run tests against non-test database "${process.env.DB_NAME}".`);
}
process.env.DB_CLIENT = 'mysql';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32 ? process.env.JWT_SECRET : 'test-secret-'.padEnd(48, 'x');
process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
// Deterministic AI routing in tests: only the mocked Groq endpoint is "configured".
for (const k of ['TELNYX_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY']) process.env[k] = '';
process.env.GROQ_API_KEY = 'test-groq-key';
// Tests never send real email: no server mailbox credentials, and SMTP/IMAP only to hosts tests choose.
for (const k of ['ZEPTOMAIL_TOKEN', 'SMTP_PASS', 'IMAP_PASS', 'MAIL_ALLOW_PRIVATE_HOSTS']) process.env[k] = '';
process.env.APP_BASE_URL = 'http://localhost:8000';
// The shared test database accumulates AI usage across runs; quota tests lower this themselves.
process.env.SOCIAL_AI_MONTHLY_REQUEST_LIMIT = '1000000';
process.env.FRONTEND_URL = 'http://localhost:4200';

const crypto = require('crypto');
const mysql = require('mysql2/promise');

let prepared = null;

async function prepareDatabase() {
  if (prepared) return prepared;
  prepared = (async () => {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT || '3306', 10),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || ''
    });
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\` DEFAULT CHARACTER SET utf8mb4`);
    const [rows] = await conn.query('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [process.env.DB_NAME, 'workspaces']);
    await conn.end();
    if (rows.length === 0) {
      const { seedMySQL } = require('../seed');
      const log = console.log;
      console.log = () => {};
      try { await seedMySQL(); } finally { console.log = log; }
    }
    const { migrate } = require('../db/migrate');
    await migrate({ log: () => {} });
    // Isolate runs: jobs left queued by an earlier run must not be picked up by this one.
    const { run } = require('../db/database');
    await run("UPDATE background_jobs SET status = 'cancelled' WHERE status IN ('queued', 'running')");
    await run("UPDATE publishing_jobs SET status = 'cancelled' WHERE status IN ('queued', 'running')");
  })();
  return prepared;
}

const db = () => require('../db/database');

/** Creates an isolated workspace with one member of the given role and returns a signed token. */
async function createWorkspace({ role = 'Workspace Owner', name = 'Test Workspace' } = {}) {
  const { run } = db();
  const { createToken, hashPassword } = require('../services/authService');
  const suffix = crypto.randomBytes(6).toString('hex');
  const email = `user-${suffix}@example.test`;
  const user = await run(
    "INSERT INTO users (email, password_hash, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'Active', UTC_TIMESTAMP(), UTC_TIMESTAMP())",
    [email, hashPassword('correct-horse-battery'), `User ${suffix}`]
  );
  const wsRes = await run(
    "INSERT INTO workspaces (name, slug, owner_email, plan, status, created_at) VALUES (?, ?, ?, 'Starter', 'Active', UTC_TIMESTAMP())",
    [`${name} ${suffix}`, `ws-${suffix}`, email]
  );
  await run(
    "INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'Active', UTC_TIMESTAMP())",
    [wsRes.lastID, user.lastID, role]
  );
  const { capabilitiesForRole } = require('../lib/permissions');
  return {
    workspaceId: wsRes.lastID,
    userId: user.lastID,
    email,
    token: createToken({ userId: user.lastID, workspaceId: wsRes.lastID, email, role }),
    ctx: { auth: { workspaceId: wsRes.lastID, userId: user.lastID, role, capabilities: capabilitiesForRole(role) } }
  };
}

async function addMember(workspaceId, role) {
  const { run } = db();
  const { createToken, hashPassword } = require('../services/authService');
  const suffix = crypto.randomBytes(6).toString('hex');
  const email = `member-${suffix}@example.test`;
  const user = await run(
    "INSERT INTO users (email, password_hash, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'Active', UTC_TIMESTAMP(), UTC_TIMESTAMP())",
    [email, hashPassword('correct-horse-battery'), `Member ${suffix}`]
  );
  await run(
    "INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at) VALUES (?, ?, ?, 'Active', UTC_TIMESTAMP())",
    [workspaceId, user.lastID, role]
  );
  const { capabilitiesForRole } = require('../lib/permissions');
  return {
    userId: user.lastID,
    token: createToken({ userId: user.lastID, workspaceId, email, role }),
    ctx: { auth: { workspaceId, userId: user.lastID, role, capabilities: capabilitiesForRole(role) } }
  };
}

const ALL_META_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_read_user_content', 'pages_manage_engagement', 'read_insights', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments', 'instagram_manage_insights'];

/** Inserts a connected account with an encrypted credential, as an OAuth callback would. */
async function createAccount(workspaceId, { accountType = 'facebook_page', providerKey = 'meta', scopes = ALL_META_SCOPES, secret = { access_token: 'page-token-SECRET', user_access_token: 'user-token-SECRET', meta_user_id: 'u1' }, externalId = null, status = 'connected', tokenExpiresAt = null } = {}) {
  const { run } = db();
  const secretBox = require('../lib/secretBox');
  const cred = await run(
    'INSERT INTO provider_credentials (workspace_id, provider_key, secret_ciphertext, access_expires_at, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
    [workspaceId, providerKey, secretBox.encryptJson(secret), tokenExpiresAt]
  );
  const ext = externalId || `ext-${crypto.randomBytes(5).toString('hex')}`;
  const acc = await run(
    `INSERT INTO social_accounts (workspace_id, provider_key, account_type, external_account_id, display_name, username, credential_id, scopes_json, status, token_expires_at, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [workspaceId, providerKey, accountType, ext, `Account ${ext}`, accountType === 'instagram_business' ? 'brand' : null, cred.lastID, JSON.stringify(scopes), status, tokenExpiresAt, JSON.stringify({ meta_user_id: secret.meta_user_id || null })]
  );
  return { id: acc.lastID, externalId: ext, credentialId: cred.lastID };
}

/**
 * Replaces global fetch with a router. Each route: { match: (url, init) => bool, respond: (url, init) => ({ status, json, headers }) | Error }.
 * Unmatched requests fail loudly so no test can reach a real provider.
 */
function mockFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: init.method || 'GET', body: init.body });
    const route = routes.find(r => r.match(url, init));
    if (!route) throw Object.assign(new Error(`Unmocked request: ${init.method || 'GET'} ${url}`), { cause: { code: 'ECONNREFUSED' } });
    const out = await route.respond(url, init);
    if (out instanceof Error) throw out;
    const headers = new Headers(out.headers || {});
    return new Response(out.json !== undefined ? JSON.stringify(out.json) : (out.text || ''), { status: out.status || 200, headers });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const json = (status, body, headers) => ({ status, json: body, headers });

/** Mocked Groq chat completion returning `content`. */
function groqRoute(contentFn) {
  return {
    match: url => url.startsWith('https://api.groq.com/'),
    respond: (url, init) => json(200, { choices: [{ message: { content: typeof contentFn === 'function' ? contentFn(JSON.parse(init.body)) : contentFn } }] })
  };
}

let server = null;
async function startApp() {
  if (server) return server;
  const app = require('../server');
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  return server;
}

async function api(method, pathName, { token, body: reqBody, headers = {} } = {}) {
  const s = await startApp();
  const { port } = s.address();
  const original = globalThis.__realFetch || globalThis.fetch;
  const res = await original(`http://127.0.0.1:${port}${pathName}`, {
    method,
    redirect: 'manual',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(reqBody ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: reqBody ? JSON.stringify(reqBody) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data, headers: res.headers };
}
globalThis.__realFetch = globalThis.fetch;

async function shutdown() {
  if (server) await new Promise(r => server.close(r));
  server = null;
  await db().closeDatabase();
}

module.exports = {
  prepareDatabase,
  createWorkspace,
  addMember,
  createAccount,
  mockFetch,
  json,
  groqRoute,
  api,
  startApp,
  shutdown,
  ALL_META_SCOPES,
  db
};
