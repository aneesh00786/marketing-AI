const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { run, get, all } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { probeFile } = require('../../lib/mediaProbe');

/**
 * Social media library storage. Same model as the mail template assets: local disk (no object
 * storage is configured in this project), outside the web root, under
 * <SOCIAL_MEDIA_STORAGE_DIR>/<workspaceId>/<publicId> where publicId is a random 256-bit id.
 * Upload names and paths are never used on disk or in URLs. A file is accepted only when its
 * content is a JPEG/PNG/WebP image or an MP4/MOV video (see lib/mediaProbe). Files are never
 * overwritten, so an approval always refers to exactly the bytes that were reviewed.
 */
const MB = 1024 * 1024;
const PUBLIC_PATH = '/api/v1/social/media-files';

/**
 * The API server and the worker must resolve the same folder: a relative setting is taken
 * relative to the backend directory, not to whichever directory a process was started from.
 */
function storageRoot() {
  const backendDir = path.join(__dirname, '../..');
  return path.resolve(backendDir, process.env.SOCIAL_MEDIA_STORAGE_DIR || 'storage/social-media');
}

function limits() {
  const mb = (name, def) => (parseInt(process.env[name] || '', 10) || def) * MB;
  return {
    imageBytes: mb('SOCIAL_MEDIA_MAX_IMAGE_MB', 8),
    videoBytes: mb('SOCIAL_MEDIA_MAX_VIDEO_MB', 500),
    workspaceQuotaBytes: mb('SOCIAL_MEDIA_WORKSPACE_QUOTA_MB', 5120)
  };
}

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** The on-disk path for a stored file, guaranteed to stay inside the storage root. */
function filePath(workspaceId, publicId) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(publicId)) || !Number.isInteger(Number(workspaceId))) throw new Error('Invalid media reference.');
  const root = storageRoot();
  const p = path.resolve(root, String(Number(workspaceId)), publicId);
  if (!p.startsWith(root + path.sep)) throw new Error('Invalid media reference.');
  return p;
}

/** Public base URL that social platforms use to fetch media (Instagram requires one). */
function publicBaseUrl() {
  return (process.env.APP_BASE_URL || '').replace(/\/$/, '');
}

/**
 * Whether platforms that fetch media by URL (Instagram) can reach this server: the base URL
 * must be https and must not point at a private or local host.
 */
function publicFetchProblem() {
  const base = publicBaseUrl();
  if (!base) return 'APP_BASE_URL is not set, so Instagram cannot download the file from this server.';
  let u;
  try { u = new URL(base); } catch (e) { return 'APP_BASE_URL is not a valid URL.'; }
  if (u.protocol !== 'https:') return `APP_BASE_URL (${u.origin}) is not https; Instagram only downloads media over public HTTPS.`;
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[::1\])/i.test(u.hostname) || u.hostname.endsWith('.local')) {
    return `APP_BASE_URL (${u.hostname}) is not reachable from the internet, so Instagram cannot download the file.`;
  }
  return null;
}

function publicUrlFor(publicId) {
  const base = publicBaseUrl();
  return base ? `${base}${PUBLIC_PATH}/${publicId}` : null;
}

async function usedBytes(workspaceId) {
  const r = await get("SELECT COALESCE(SUM(size_bytes), 0) AS n FROM assets WHERE workspace_id = ? AND source = 'upload' AND status <> 'deleted'", [workspaceId]);
  return Number(r.n);
}

/**
 * Streams a request body to a temporary file, enforcing the byte limit while it arrives, then
 * identifies it by content. Returns { tmpPath, size, sha256, probe }; the caller commits or
 * discards the temporary file.
 */
async function receiveUpload(req, workspaceId) {
  const lim = limits();
  const maxBytes = Math.max(lim.imageBytes, lim.videoBytes);
  const declared = parseInt(req.headers['content-length'] || '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw httpError(413, `The file is larger than the ${Math.round(maxBytes / MB)} MB upload limit.`, 'TOO_LARGE');
  }
  const dir = path.join(storageRoot(), String(Number(workspaceId)));
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o750 });
  const tmpPath = path.join(dir, `.upload-${crypto.randomBytes(16).toString('hex')}`);
  const hash = crypto.createHash('sha256');
  let size = 0;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath, { mode: 0o640, flags: 'wx' });
    let failed = false;
    const abort = (err) => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      out.destroy();
      req.resume();
      reject(err);
    };
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) return abort(httpError(413, `The file is larger than the ${Math.round(maxBytes / MB)} MB upload limit.`, 'TOO_LARGE'));
      hash.update(chunk);
    });
    req.on('aborted', () => abort(httpError(400, 'The upload was interrupted.', 'UPLOAD_ABORTED')));
    req.on('error', abort);
    out.on('error', abort);
    out.on('finish', () => { if (!failed) resolve(); });
    req.pipe(out);
  }).catch(async (err) => {
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  });

  if (size === 0) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw httpError(400, 'Send the file as the request body.', 'VALIDATION_ERROR');
  }
  let probe;
  try {
    probe = await probeFile(tmpPath);
  } catch (err) {
    probe = { ok: false, reason: 'the file could not be read' };
  }
  if (!probe.ok) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw httpError(400, `This file cannot be used: ${probe.reason}.`, 'INVALID_MEDIA');
  }
  const kindLimit = probe.kind === 'image' ? lim.imageBytes : lim.videoBytes;
  if (size > kindLimit) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw httpError(413, `${probe.kind === 'image' ? 'Images' : 'Videos'} can be at most ${Math.round(kindLimit / MB)} MB.`, 'TOO_LARGE');
  }
  return { tmpPath, size, sha256: hash.digest('hex'), probe };
}

function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f\u007f<>"\\/]/g, '').trim().slice(0, 255) || null;
}

/** Moves a received upload into place and records it. Enforces the workspace storage quota. */
async function commitUpload(ctx, received, { originalName, title, thumbnailFor = null } = {}) {
  const workspaceId = ctx.auth.workspaceId;
  const { tmpPath, size, sha256, probe } = received;
  try {
    const lim = limits();
    if ((await usedBytes(workspaceId)) + size > lim.workspaceQuotaBytes) {
      throw httpError(413, `This workspace's media storage (${Math.round(lim.workspaceQuotaBytes / MB)} MB) is full. Delete unused media first.`, 'QUOTA_EXCEEDED');
    }
    let videoAsset = null;
    if (thumbnailFor) {
      if (probe.kind !== 'image') throw httpError(400, 'A video thumbnail must be an image.', 'INVALID_MEDIA');
      videoAsset = await get("SELECT id FROM assets WHERE workspace_id = ? AND id = ? AND asset_type = 'video' AND status <> 'deleted'", [workspaceId, thumbnailFor]);
      if (!videoAsset) throw httpError(404, 'The video for this thumbnail was not found.', 'NOT_FOUND');
    }
    const publicId = crypto.randomBytes(32).toString('base64url');
    const finalPath = filePath(workspaceId, publicId);
    await fs.promises.rename(tmpPath, finalPath);
    let ins;
    try {
      ins = await run(
        `INSERT INTO assets (workspace_id, asset_type, source, public_id, storage_key, mime_type, size_bytes, width, height, duration_seconds,
           video_codec, audio_codec, frame_rate, checksum, title, original_name, metadata_json, status, created_by, created_at, updated_at)
         VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [workspaceId, probe.kind, publicId, publicId, probe.mime, size, probe.width || null, probe.height || null,
          probe.durationSeconds ?? null, probe.videoCodec || null, probe.audioCodec || null, probe.frameRate ?? null, sha256,
          cleanName(title) || cleanName(originalName), cleanName(originalName),
          JSON.stringify({ format: probe.format, hasAudio: probe.hasAudio ?? null, progressive: probe.progressive ?? null, role: thumbnailFor ? 'thumbnail' : 'media' }),
          ctx.auth.userId || null]
      );
    } catch (err) {
      await fs.promises.unlink(finalPath).catch(() => {});
      throw err;
    }
    if (videoAsset) {
      await run('UPDATE assets SET thumbnail_asset_id = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?', [ins.lastID, workspaceId, videoAsset.id]);
    }
    await audit(ctx, 'social.media.uploaded', {
      resourceType: 'asset',
      resourceId: ins.lastID,
      metadata: { kind: probe.kind, mime: probe.mime, sizeBytes: size, width: probe.width || null, height: probe.height || null, durationSeconds: probe.durationSeconds ?? null, thumbnailFor: videoAsset?.id || null }
    });
    return ins.lastID;
  } catch (err) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function deleteFile(workspaceId, publicId) {
  await fs.promises.unlink(filePath(workspaceId, publicId)).catch(err => { if (err.code !== 'ENOENT') throw err; });
}

/** For the public file route: only stored, live uploads of verified types. */
async function findPublic(publicId) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(publicId || ''))) return null;
  const row = await get("SELECT workspace_id, public_id, mime_type FROM assets WHERE public_id = ? AND source = 'upload' AND status = 'ready'", [publicId]);
  if (!row || !['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'].includes(row.mime_type)) return null;
  return { mime: row.mime_type, path: filePath(row.workspace_id, row.public_id) };
}

/**
 * Serves a stored file with single-range support (video players and Instagram's fetcher use
 * Range requests). The stored, verified type is always sent; the content is never executed.
 */
async function serve(req, res, publicId) {
  const f = await findPublic(publicId);
  if (!f) return res.status(404).type('text/plain').send('Not found');
  let stat;
  try { stat = await fs.promises.stat(f.path); } catch (e) { return res.status(404).type('text/plain').send('Not found'); }
  res.set({
    'Content-Type': f.mime,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Content-Disposition': 'inline',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Robots-Tag': 'noindex'
  });
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? parseInt(range[1], 10) : stat.size - parseInt(range[2], 10);
    let end = range[1] && range[2] ? parseInt(range[2], 10) : stat.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, stat.size - 1);
    if (start > end || start >= stat.size) {
      res.set('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }
    res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(end - start + 1) });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(f.path, { start, end }).on('error', () => res.destroy()).pipe(res);
  }
  res.set('Content-Length', String(stat.size));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f.path).on('error', () => res.destroy()).pipe(res);
}

/** Removes temporary upload files left by interrupted requests (older than an hour). */
async function sweepTemporaryFiles() {
  const root = storageRoot();
  let removed = 0;
  let dirs = [];
  try { dirs = await fs.promises.readdir(root); } catch (e) { return 0; }
  for (const d of dirs.filter(x => /^\d+$/.test(x))) {
    const dir = path.join(root, d);
    for (const name of await fs.promises.readdir(dir).catch(() => [])) {
      if (!name.startsWith('.upload-')) continue;
      const p = path.join(dir, name);
      const st = await fs.promises.stat(p).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 3600 * 1000) { await fs.promises.unlink(p).catch(() => {}); removed += 1; }
    }
  }
  return removed;
}

/** All live uploads still on disk for a workspace (used by tests and maintenance). */
async function listStored(workspaceId) {
  return all("SELECT id, public_id FROM assets WHERE workspace_id = ? AND source = 'upload' AND status = 'ready'", [workspaceId]);
}

module.exports = {
  MB,
  PUBLIC_PATH,
  storageRoot,
  limits,
  filePath,
  publicBaseUrl,
  publicFetchProblem,
  publicUrlFor,
  usedBytes,
  receiveUpload,
  commitUpload,
  deleteFile,
  findPublic,
  serve,
  sweepTemporaryFiles,
  listStored
};
