const fs = require('fs');
const path = require('path');

/**
 * Startup checks shared by the API server and the social worker. With NODE_ENV=production a
 * problem stops the process with a clear message; otherwise problems are printed as warnings so
 * local development keeps working. Values are described, never printed in full.
 */
const BACKEND_DIR = path.resolve(__dirname, '..');

function isPrivateHost(host) {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[::1\]|::1)/i.test(host) || host.endsWith('.local');
}

/** Returns { problems: string[], warnings: string[], storageRoot }. */
function checkConfig(env = process.env) {
  const problems = [];
  const warnings = [];

  const base = (env.APP_BASE_URL || '').trim();
  if (!base) {
    problems.push('APP_BASE_URL is not set. Set it to the public https:// address of the API (OAuth redirects and Instagram media downloads use it).');
  } else {
    let u = null;
    try { u = new URL(base); } catch (e) { u = null; }
    if (!u) problems.push('APP_BASE_URL is not a valid URL.');
    else if (u.protocol !== 'https:') problems.push(`APP_BASE_URL uses ${u.protocol.replace(':', '')}; it must be https:// in production.`);
    else if (isPrivateHost(u.hostname)) problems.push(`APP_BASE_URL points at a local or private host (${u.hostname}); platforms cannot reach it.`);
  }

  if ((env.JWT_SECRET || '').length < 32) problems.push('JWT_SECRET must be set to at least 32 random characters.');
  const keyRaw = (env.SOCIAL_TOKEN_ENCRYPTION_KEY || '').trim();
  const key = /^[0-9a-f]{64}$/i.test(keyRaw) ? Buffer.from(keyRaw, 'hex') : Buffer.from(keyRaw, 'base64');
  if (!keyRaw || key.length !== 32) {
    problems.push('SOCIAL_TOKEN_ENCRYPTION_KEY must be 32 random bytes (base64 or 64 hex characters). Use the same key the stored credentials were encrypted with; a different key makes them unreadable.');
  }

  const raw = (env.SOCIAL_MEDIA_STORAGE_DIR || '').trim();
  const storageRoot = path.resolve(BACKEND_DIR, raw || 'storage/social-media');
  if (!raw) {
    problems.push(`SOCIAL_MEDIA_STORAGE_DIR is not set (the default ${storageRoot} is inside the code folder and is lost if a deployment replaces it). Set an absolute path outside the code folder that is backed up.`);
  } else if (!path.isAbsolute(raw)) {
    problems.push('SOCIAL_MEDIA_STORAGE_DIR must be an absolute path, so the API server and the worker use the same folder.');
  } else if ((storageRoot + path.sep).startsWith(BACKEND_DIR + path.sep)) {
    warnings.push(`SOCIAL_MEDIA_STORAGE_DIR (${storageRoot}) is inside the code folder; make sure deployments keep it.`);
  }
  try {
    fs.mkdirSync(storageRoot, { recursive: true, mode: 0o750 });
    const probe = path.join(storageRoot, `.write-check-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    problems.push(`The media storage folder ${storageRoot} is not writable by this process (${e.code || 'error'}). The API and the worker both need read/write access.`);
  }
  // Email template images (mail module): it resolves a relative path against the process's working
  // directory, so production requires an absolute path that the API can write to.
  const mailRaw = (env.MAIL_ASSET_STORAGE_DIR || '').trim();
  if (!mailRaw) {
    problems.push('MAIL_ASSET_STORAGE_DIR is not set (email template images would go inside the code folder). Set an absolute path outside the code folder that is backed up.');
  } else if (!path.isAbsolute(mailRaw)) {
    problems.push('MAIL_ASSET_STORAGE_DIR must be an absolute path.');
  } else {
    try {
      fs.mkdirSync(mailRaw, { recursive: true, mode: 0o750 });
      const probe = path.join(mailRaw, `.write-check-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
    } catch (e) {
      problems.push(`The mail asset folder ${mailRaw} is not writable by this process (${e.code || 'error'}).`);
    }
  }
  return { problems, warnings, storageRoot };
}

/** Prints the result; in production exits the process when there are problems. */
function enforce(processName, env = process.env, { exit = (code) => process.exit(code), log = console } = {}) {
  const { problems, warnings, storageRoot } = checkConfig(env);
  const production = env.NODE_ENV === 'production';
  log.log(`[${processName}] Social media storage: ${storageRoot}`);
  for (const w of warnings) log.warn(`[${processName}] Warning: ${w}`);
  if (!problems.length) return { ok: true, storageRoot };
  for (const p of problems) log[production ? 'error' : 'warn'](`[${processName}] ${production ? 'Configuration error' : 'Warning'}: ${p}`);
  if (production) {
    log.error(`[${processName}] Refusing to start with unsafe production configuration.`);
    exit(1);
  }
  return { ok: false, storageRoot, problems };
}

/**
 * New code must not run against an unmigrated database. In production the API and the worker refuse
 * to start while migrations are pending (apply them first with a verified backup); elsewhere they warn.
 */
async function enforceMigrated(processName, env = process.env, { exit = (code) => process.exit(code), log = console, status = null } = {}) {
  let pending = [];
  try {
    pending = (status ? await status() : await require('../db/migrate').migrate({ statusOnly: true, log: () => {} })).pending;
  } catch (e) {
    log.warn(`[${processName}] Could not check migrations: ${e.message}`);
    return { ok: false };
  }
  if (!pending.length) return { ok: true };
  const message = `${pending.length} pending migration(s): ${pending.join(', ')}. Back up the database, then run "npm run migrate -- --backup=<dump>" in backend/.`;
  if (env.NODE_ENV === 'production') {
    log.error(`[${processName}] Refusing to start: ${message}`);
    exit(1);
  } else {
    log.warn(`[${processName}] ⚠️  ${message}`);
  }
  return { ok: false, pending };
}

module.exports = { checkConfig, enforce, enforceMigrated };
