const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');
const store = require('./assetStore');

/**
 * Imports an uploaded .html/.htm file or a .zip package (HTML + CSS + images). Untrusted input:
 * - the archive is inspected (entry list, sizes, types, paths) before anything is extracted;
 * - limits are configurable (env) and enforced on declared AND actual sizes;
 * - absolute paths, "..", backslashes, symlinks, encrypted entries, executables and zip bombs
 *   reject the whole package with a reason;
 * - nothing is fetched from the network (no SSRF): remote stylesheets/imports are only reported;
 * - images/fonts are stored through assetStore (content-verified, opaque ids).
 * The result is raw processed HTML; the caller sanitizes it (lib/emailHtml) before preview/save.
 */
const KB = 1024;
const MB = 1024 * 1024;
const intEnv = (name, def) => { const v = parseInt(process.env[name] || '', 10); return Number.isFinite(v) && v > 0 ? v : def; };
const limits = () => ({
  htmlBytes: intEnv('MAIL_TEMPLATE_MAX_HTML_KB', 1024) * KB,
  zipBytes: intEnv('MAIL_TEMPLATE_ZIP_MAX_MB', 10) * MB,
  expandedBytes: intEnv('MAIL_TEMPLATE_ZIP_MAX_EXPANDED_MB', 30) * MB,
  entries: intEnv('MAIL_TEMPLATE_ZIP_MAX_ENTRIES', 200),
  fileBytes: intEnv('MAIL_TEMPLATE_ZIP_MAX_FILE_MB', 5) * MB,
  ratio: intEnv('MAIL_TEMPLATE_ZIP_MAX_RATIO', 100)
});

const HTML_EXT = new Set(['html', 'htm']);
const ASSET_EXT = new Set(Object.keys(store.TYPES));
const REJECT_EXT = new Set(['exe', 'dll', 'bat', 'cmd', 'com', 'msi', 'sh', 'bash', 'ps1', 'php', 'phtml', 'jsp', 'asp', 'aspx', 'cgi', 'pl', 'py', 'rb', 'jar', 'war', 'class', 'scr', 'vbs', 'wsf', 'apk', 'app', 'dmg', 'so', 'dylib', 'zip', 'rar', '7z', 'gz', 'tar']);
const IGNORE_RE = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

function importError(message, code = 'IMPORT_REJECTED') {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  err.expose = true;
  return err;
}

const ext = name => String(name).toLowerCase().split('.').pop();

/** Strict UTF-8 text (BOM removed); binary or undecodable content is rejected. */
function decodeText(buf, label) {
  if (buf.includes(0)) throw importError(`${label} is not a text file.`, 'INVALID_FILE');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch (e) {
    throw importError(`${label} is not valid UTF-8 text. Save it as UTF-8 and upload again.`, 'INVALID_ENCODING');
  }
}

/** A single .html/.htm file. Relative images cannot be resolved (reported by the analyzer). */
function importHtmlFile({ buffer, filename }) {
  const L = limits();
  if (!HTML_EXT.has(ext(filename))) throw importError('Upload an .html or .htm file, or a .zip package.', 'INVALID_FILE');
  if (!buffer.length) throw importError('The file is empty.', 'INVALID_FILE');
  if (buffer.length > L.htmlBytes) throw importError(`The HTML file is larger than ${Math.round(L.htmlBytes / KB)} KB.`, 'TOO_LARGE');
  const html = decodeText(buffer, 'The file');
  if (!/<\s*[a-z!]/i.test(html)) throw importError('The file does not contain HTML.', 'INVALID_FILE');
  return { html, warnings: [], entry: filename, entries: [filename] };
}

// ------------------------------------------------------------------ ZIP

function safeClose(zip) {
  try { zip.close(); } catch (e) { /* already closed */ }
}

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, decodeStrings: true, autoClose: false }, (err, zip) => {
      if (err) return reject(/absolute path|relative path|invalid characters/i.test(err.message) ? importError('The package contains unsafe file paths.', 'UNSAFE_PATH') : importError('The ZIP file could not be read (damaged or unsupported).', 'INVALID_ZIP'));
      resolve(zip);
    });
  });
}

/** Lists entries without extracting; applies every structural check. */
function inspect(zip, L) {
  return new Promise((resolve, reject) => {
    const files = [];
    const seen = new Set();
    let declared = 0;
    let count = 0;
    let done = false;
    const fail = e => { if (done) return; done = true; safeClose(zip); reject(e); };
    zip.on('error', err => fail(/absolute path|relative path|invalid characters/i.test(err.message)
      ? importError('The package contains unsafe file paths.', 'UNSAFE_PATH')
      : importError('The ZIP file is damaged or uses unsupported features.', 'INVALID_ZIP')));
    zip.on('entry', entry => {
      count++;
      if (count > L.entries) return fail(importError(`The package has more than ${L.entries} entries.`, 'TOO_MANY_ENTRIES'));
      const name = entry.fileName;
      if (/[\\:\0]/.test(name) || name.startsWith('/') || name.split('/').includes('..')) return fail(importError('The package contains unsafe file paths.', 'UNSAFE_PATH'));
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (mode === 0o120000) return fail(importError('The package contains symbolic links, which are not allowed.', 'UNSAFE_ENTRY'));
      if (entry.generalPurposeBitFlag & 0x1) return fail(importError('Encrypted ZIP packages are not supported.', 'UNSAFE_ENTRY'));
      if (name.endsWith('/') || IGNORE_RE.test(name)) { zip.readEntry(); return; }
      const e = ext(name);
      if (REJECT_EXT.has(e)) return fail(importError(`The package contains a file type that is not allowed (.${e}).`, 'SUSPICIOUS_FILE'));
      if (entry.uncompressedSize > L.fileBytes) return fail(importError(`${path.posix.basename(name)} is larger than ${Math.round(L.fileBytes / MB)} MB.`, 'TOO_LARGE'));
      if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > L.ratio && entry.uncompressedSize > MB) {
        return fail(importError('The package looks like a ZIP bomb (extreme compression ratio).', 'ZIP_BOMB'));
      }
      declared += entry.uncompressedSize;
      if (declared > L.expandedBytes) return fail(importError(`The unpacked package would exceed ${Math.round(L.expandedBytes / MB)} MB.`, 'TOO_LARGE'));
      const key = name.toLowerCase();
      if (seen.has(key)) return fail(importError('The package contains duplicate file names.', 'UNSAFE_ENTRY'));
      seen.add(key);
      files.push({ name, entry, ext: e });
      zip.readEntry();
    });
    zip.on('end', () => resolve(files));
    zip.readEntry();
  });
}

/** Reads one entry, counting real bytes (never trusting the declared size). */
function readEntry(zip, entry, maxBytes) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(importError('A file in the package could not be read.', 'INVALID_ZIP'));
      const chunks = [];
      let n = 0;
      stream.on('data', c => {
        n += c.length;
        if (n > maxBytes) { stream.destroy(); reject(importError('A file in the package is larger than declared or allowed.', 'TOO_LARGE')); return; }
        chunks.push(c);
      });
      stream.on('error', () => reject(importError('A file in the package is damaged.', 'INVALID_ZIP')));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function chooseEntry(htmlFiles, requested) {
  const names = htmlFiles.map(f => f.name);
  if (requested) {
    if (!names.includes(requested)) throw importError('The selected HTML file is not in the package.', 'INVALID_ENTRY');
    return requested;
  }
  if (names.length === 1) return names[0];
  const rootIndex = names.filter(n => /^index\.html?$/i.test(n));
  if (rootIndex.length === 1) return rootIndex[0];
  return null;
}

const isRemote = u => /^(https?:)?\/\//i.test(u);
const isSkippable = u => !u || /^(data:|cid:|mailto:|tel:|#|mkt-asset:|\$\[)/i.test(u) || /^\{\{/.test(u);

/** Resolves a reference relative to a file inside the package; null when it leaves the package. */
function resolveRef(fromFile, ref) {
  let clean = String(ref).trim().split(/[?#]/)[0];
  try { clean = decodeURIComponent(clean); } catch (e) { /* keep as is */ }
  if (!clean || clean.startsWith('/') || /^[a-z]+:/i.test(clean)) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean));
  if (joined.startsWith('..') || joined.startsWith('/')) return null;
  return joined;
}

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?[^;]*;/gi;

/**
 * Imports a .zip package. Returns { needsEntry, entries } when several HTML files could be the
 * template and none was chosen; otherwise the processed HTML with its stored assets.
 */
async function importZip({ buffer, filename, entry: requestedEntry, workspaceId, userId }) {
  const L = limits();
  if (ext(filename) !== 'zip') throw importError('Upload a .zip package.', 'INVALID_FILE');
  if (buffer.length > L.zipBytes) throw importError(`The ZIP file is larger than ${Math.round(L.zipBytes / MB)} MB.`, 'TOO_LARGE');
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw importError('The file is not a ZIP package (or it is empty).', 'INVALID_ZIP');

  const zip = await openZip(buffer);
  try {
    const files = await inspect(zip, L);
    const htmlFiles = files.filter(f => HTML_EXT.has(f.ext));
    if (!htmlFiles.length) throw importError('The package contains no .html file.', 'NO_HTML');
    const entries = htmlFiles.map(f => f.name);
    const entryName = chooseEntry(htmlFiles, requestedEntry);
    if (!entryName) return { needsEntry: true, entries };

    // Read the files that may be needed (bounded by the limits above).
    const byName = new Map();
    // Every file name in the package (read or not), so unsupported files are reported as such.
    const lower = new Map(files.map(f => [f.name.toLowerCase(), f.name]));
    let total = 0;
    for (const f of files) {
      if (!(HTML_EXT.has(f.ext) ? f.name === entryName : (f.ext === 'css' || ASSET_EXT.has(f.ext)))) continue;
      const buf = await readEntry(zip, f.entry, L.fileBytes);
      total += buf.length;
      if (total > L.expandedBytes) throw importError(`The unpacked package exceeds ${Math.round(L.expandedBytes / MB)} MB.`, 'TOO_LARGE');
      byName.set(f.name, buf);
    }
    const lookup = p => lower.get(String(p).toLowerCase()) || null;

    const warnings = [];
    const missing = new Set();
    const unsupported = new Set();
    const remote = new Set();
    const used = new Set();
    const importId = crypto.randomBytes(16).toString('hex');
    const stored = new Map(); // package path -> publicId
    const pending = []; // [packagePath, mime]

    // Pass 1: decide which assets are referenced and valid (no writes yet).
    const assetRef = (fromFile, ref) => {
      if (isSkippable(ref)) return null;
      if (isRemote(ref)) { if (/^http:/i.test(ref)) remote.add(ref); return null; }
      const p = resolveRef(fromFile, ref);
      const hit = p && lookup(p);
      if (!hit) { missing.add(ref); return null; }
      if (!ASSET_EXT.has(ext(hit)) || !byName.has(hit)) { unsupported.add(hit); return null; }
      const t = store.detectType(hit, byName.get(hit));
      if (!t.ok) { unsupported.add(`${hit} (${t.reason})`); return null; }
      if (!stored.has(hit)) { stored.set(hit, null); pending.push([hit, t.mime]); }
      used.add(hit);
      return hit;
    };

    const rewriteCssUrls = (css, fromFile) => css.replace(CSS_URL_RE, (m, q, ref) => {
      const hit = assetRef(fromFile, ref);
      return hit ? `url("__ASSET__${hit}__")` : m;
    });

    const visited = new Set();
    const loadCss = (cssPath, depth) => {
      if (depth > 5 || visited.has(cssPath)) return '';
      visited.add(cssPath);
      used.add(cssPath);
      let css = decodeText(byName.get(cssPath), path.posix.basename(cssPath));
      css = css.replace(CSS_IMPORT_RE, (m, q, ref) => {
        if (isRemote(ref)) { remote.add(ref); return ''; }
        const p = resolveRef(cssPath, ref);
        const hit = p && lookup(p);
        if (!hit || ext(hit) !== 'css' || !byName.has(hit)) { missing.add(ref); return ''; }
        return `\n${loadCss(hit, depth + 1)}\n`;
      });
      return rewriteCssUrls(css, cssPath);
    };

    let html = decodeText(byName.get(entryName), path.posix.basename(entryName));
    used.add(entryName);
    const embedded = [];
    // <link rel="stylesheet" href="..."> -> embedded <style>
    html = html.replace(/<link\b[^>]*>/gi, tag => {
      if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) return tag;
      const href = (tag.match(/href\s*=\s*(["'])(.*?)\1/i) || tag.match(/href\s*=\s*([^\s>]+)/i) || [])[2] || (tag.match(/href\s*=\s*([^\s>]+)/i) || [])[1];
      if (!href) return '';
      if (isRemote(href)) { remote.add(href); return tag; }
      const p = resolveRef(entryName, href);
      const hit = p && lookup(p);
      if (!hit || ext(hit) !== 'css') { missing.add(href); return ''; }
      embedded.push(loadCss(hit, 0));
      return '';
    });
    // @import inside <style> blocks, then url() anywhere (style attributes and <style> blocks).
    html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) => `${open}${css.replace(CSS_IMPORT_RE, (mm, q, ref) => {
      if (isRemote(ref)) { remote.add(ref); return ''; }
      const p = resolveRef(entryName, ref);
      const hit = p && lookup(p);
      if (!hit || ext(hit) !== 'css') { missing.add(ref); return ''; }
      return `\n${loadCss(hit, 1)}\n`;
    })}${close}`);
    html = rewriteCssUrls(html, entryName);
    // src / background attributes.
    html = html.replace(/(\s(?:src|background)\s*=\s*)(["'])(.*?)\2/gi, (m, attr, q, ref) => {
      const hit = assetRef(entryName, ref);
      return hit ? `${attr}${q}__ASSET__${hit}__${q}` : m;
    });
    if (embedded.length) {
      const block = `<style type="text/css">\n${embedded.join('\n')}\n</style>`;
      html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${block}\n</head>`) : `${block}\n${html}`;
      warnings.push(`Embedded ${embedded.length} stylesheet(s) from the package into a <style> block. Some email clients ignore <style>; inline styles are the most reliable.`);
    }

    // Pass 2: store the referenced assets (quota-checked), then replace markers.
    const newBytes = pending.reduce((n, [p]) => n + byName.get(p).length, 0);
    if (newBytes && (await store.usedBytes(workspaceId)) + newBytes > store.quotaBytes()) {
      throw importError('This workspace has reached its template image storage limit. Delete unused templates or images first.', 'QUOTA_EXCEEDED');
    }
    const sameContent = new Map();
    for (const [p, mime] of pending) {
      const digest = crypto.createHash('sha256').update(byName.get(p)).digest('hex');
      if (sameContent.has(digest)) { stored.set(p, sameContent.get(digest)); continue; }
      const id = await store.saveAsset({ workspaceId, buffer: byName.get(p), mime, originalName: path.posix.basename(p), importId, userId });
      stored.set(p, id);
      sameContent.set(digest, id);
    }
    html = html.replace(/__ASSET__(.+?)__/g, (m, p) => (stored.get(p) ? `mkt-asset://${stored.get(p)}` : m));

    if (missing.size) warnings.push(`Missing files referenced by the template: ${[...missing].slice(0, 10).join(', ')}. Add them to the package or use https:// URLs.`);
    if (unsupported.size) warnings.push(`Unsupported or invalid files were not used: ${[...unsupported].slice(0, 10).join(', ')}. Images must be PNG, JPG, GIF or WebP; fonts WOFF/WOFF2.`);
    if (remote.size) warnings.push(`Remote resources were not imported (left as links): ${[...remote].slice(0, 5).join(', ')}.`);
    const ignored = files.filter(f => !used.has(f.name) && !HTML_EXT.has(f.ext));
    if (ignored.length) warnings.push(`${ignored.length} file(s) in the package are not used by the template and were ignored (e.g. ${ignored.slice(0, 3).map(f => f.name).join(', ')}).`);
    if (entries.length > 1) warnings.push(`The package has ${entries.length} HTML files; using ${entryName}.`);
    return { html, warnings, entry: entryName, entries, importId: stored.size ? importId : null, assetCount: new Set(stored.values()).size };
  } finally {
    safeClose(zip);
  }
}

module.exports = { importHtmlFile, importZip, limits, importError };
