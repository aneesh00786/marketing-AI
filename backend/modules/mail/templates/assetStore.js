const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { run, get } = require('../../../db/database');

/**
 * Local file storage for template images and fonts (no object storage is configured in this
 * project). Files are stored as <root>/<workspaceId>/<publicId>, where publicId is a random
 * 256-bit id; file names and paths from uploads are never used on disk or in URLs. Only image
 * and font types verified by their content (magic bytes) are stored. The root is outside the web
 * root (MAIL_ASSET_STORAGE_DIR, default backend/storage/mail-assets).
 */
const TYPES = {
  png: { mime: 'image/png', test: b => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
  jpg: { mime: 'image/jpeg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { mime: 'image/jpeg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  gif: { mime: 'image/gif', test: b => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')) },
  webp: { mime: 'image/webp', test: b => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  woff: { mime: 'font/woff', test: b => b.length > 4 && b.subarray(0, 4).toString('latin1') === 'wOFF' },
  woff2: { mime: 'font/woff2', test: b => b.length > 4 && b.subarray(0, 4).toString('latin1') === 'wOF2' }
};
const SERVABLE_MIME = new Set(Object.values(TYPES).map(t => t.mime));
const MB = 1024 * 1024;

function storageRoot() {
  return path.resolve(process.env.MAIL_ASSET_STORAGE_DIR || path.join(__dirname, '../../../storage/mail-assets'));
}

const quotaBytes = () => (parseInt(process.env.MAIL_ASSET_WORKSPACE_QUOTA_MB || '200', 10) || 200) * MB;

/** The on-disk path for an asset, guaranteed to stay inside the storage root. */
function filePath(workspaceId, publicId) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(publicId)) || !Number.isInteger(Number(workspaceId))) throw new Error('Invalid asset reference.');
  const root = storageRoot();
  const p = path.resolve(root, String(Number(workspaceId)), publicId);
  if (!p.startsWith(root + path.sep)) throw new Error('Invalid asset reference.');
  return p;
}

/** Detects the type from the extension and verifies it against the content. */
function detectType(name, buf) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  const t = TYPES[ext];
  if (!t) return { ok: false, reason: 'unsupported file type' };
  if (!t.test(buf)) return { ok: false, reason: `content is not a valid ${ext.toUpperCase()} file` };
  return { ok: true, mime: t.mime };
}

async function usedBytes(workspaceId) {
  const r = await get('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM mail_template_assets WHERE workspace_id = ?', [workspaceId]);
  return Number(r.n);
}

/** Stores one verified file; returns its public id. Duplicate content within an import is reused by the caller. */
async function saveAsset({ workspaceId, buffer, mime, originalName, importId, userId }) {
  const publicId = crypto.randomBytes(32).toString('base64url');
  const p = filePath(workspaceId, publicId);
  await fs.promises.mkdir(path.dirname(p), { recursive: true, mode: 0o750 });
  await fs.promises.writeFile(p, buffer, { mode: 0o640, flag: 'wx' });
  try {
    await run(
      `INSERT INTO mail_template_assets (workspace_id, public_id, import_id, mime, size_bytes, sha256, original_name, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
      [workspaceId, publicId, importId || null, mime, buffer.length, crypto.createHash('sha256').update(buffer).digest('hex'), String(originalName || '').slice(0, 255), userId || null]
    );
  } catch (err) {
    await fs.promises.unlink(p).catch(() => {});
    throw err;
  }
  return publicId;
}

async function deleteAssetFile(workspaceId, publicId) {
  await fs.promises.unlink(filePath(workspaceId, publicId)).catch(err => { if (err.code !== 'ENOENT') throw err; });
}

/** For the public asset route: only stored, servable types. */
async function findPublic(publicId) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(publicId || ''))) return null;
  const row = await get('SELECT workspace_id, public_id, mime, size_bytes FROM mail_template_assets WHERE public_id = ?', [publicId]);
  if (!row || !SERVABLE_MIME.has(row.mime)) return null;
  return { ...row, path: filePath(row.workspace_id, row.public_id) };
}

module.exports = { TYPES, MB, storageRoot, quotaBytes, filePath, detectType, usedBytes, saveAsset, deleteAssetFile, findPublic };
