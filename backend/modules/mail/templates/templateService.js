const { z } = require('zod');
const { run, get, all } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const { sanitizeEmailHtml, analyzeEmailHtml, expandAssetRefs, collapseAssetUrls, assetIdsIn } = require('../../../lib/emailHtml');
const { unresolvedPlaceholders, TEMPLATE_TOKENS } = require('../../../lib/mailContent');
const importer = require('./importer');
const store = require('./assetStore');

/**
 * Reusable email templates of one workspace (Mail Center > Email Templates).
 * Saved HTML is always sanitized on the server; images are stored as mkt-asset://<id> and turned
 * into public asset URLs whenever the HTML is shown or used. Using a template in an email, draft
 * or campaign copies its HTML: editing the copy never changes the template, and vice versa.
 * Permissions: read/use mail.view; create/edit/import/duplicate/delete mail.compose;
 * asset cleanup mail.configure.
 */
const ws = ctx => ctx.auth.workspaceId;

const CATEGORIES = ['Newsletter', 'Promotion', 'Announcement', 'Welcome', 'Transactional', 'Custom'];
const SOURCES = ['blank', 'html', 'zip', 'duplicate', 'email', 'campaign'];
const MAX_HTML = 1024 * 1024;

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.expose = true;
  return err;
}

const category = z.string().trim().min(1).max(50).regex(/^[\p{L}\p{N} &/_-]+$/u, 'Use letters, numbers, spaces and & / _ -');
const createSchema = z.object({
  name: z.string().trim().min(1, 'Enter a template name.').max(150),
  description: z.string().trim().max(500).nullable().optional(),
  category: category.optional(),
  html: z.string().max(MAX_HTML, 'The template is larger than 1 MB.').optional(),
  source: z.enum(['blank', 'html', 'zip', 'email', 'campaign']).optional(),
  sourceFilename: z.string().trim().max(255).nullable().optional(),
  importId: z.string().regex(/^[a-f0-9]{32}$/).nullable().optional()
}).strict();
const updateSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  category: category.optional(),
  html: z.string().max(MAX_HTML, 'The template is larger than 1 MB.').optional(),
  version: z.number().int().positive().optional(),
  importId: z.string().regex(/^[a-f0-9]{32}$/).nullable().optional()
}).strict();

function parse(v, d) { try { return v ? JSON.parse(v) : d; } catch (e) { return d; } }

function present(row, { full = false } = {}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    source: row.source,
    sourceFilename: row.source_filename,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    ...(full ? {
      html: expandAssetRefs(row.html),
      warnings: parse(row.warnings_json, []),
      placeholders: unresolvedPlaceholders({ html: row.html })
    } : {})
  };
}

async function requireRow(ctx, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid id.', 'VALIDATION_ERROR');
  const row = await get('SELECT * FROM mail_templates WHERE id = ? AND workspace_id = ?', [id, ws(ctx)]);
  if (!row) throw httpError(404, 'Template not found.', 'NOT_FOUND');
  return row;
}

/**
 * Untrusted HTML -> what is stored: sanitized, own asset URLs collapsed to references, and
 * references to assets of other workspaces removed. Returns warnings for everything changed.
 */
async function prepareHtml(ctx, rawHtml, extraWarnings = []) {
  const warnings = [...extraWarnings, ...analyzeEmailHtml(rawHtml)];
  const ids = [...assetIdsIn(rawHtml)];
  const own = new Set(ids.length
    ? (await all(`SELECT public_id FROM mail_template_assets WHERE workspace_id = ? AND public_id IN (${ids.map(() => '?').join(',')})`, [ws(ctx), ...ids])).map(r => r.public_id)
    : []);
  let html = collapseAssetUrls(rawHtml, own);
  let foreign = 0;
  html = html.replace(/mkt-asset:\/\/([A-Za-z0-9_-]{43})/g, (m, id) => (own.has(id) ? m : (foreign++, '')));
  if (foreign) warnings.push(`${foreign} image reference(s) not belonging to this workspace were removed.`);
  html = sanitizeEmailHtml(html);
  return { html, warnings: [...new Set(warnings)], assetIds: [...assetIdsIn(html)] };
}

async function claimAssets(ctx, templateId, importId, assetIds) {
  if (!importId || !assetIds.length) return;
  await run(
    `UPDATE mail_template_assets SET template_id = ?, import_id = NULL WHERE workspace_id = ? AND import_id = ? AND public_id IN (${assetIds.map(() => '?').join(',')})`,
    [templateId, ws(ctx), importId, ...assetIds]
  );
}

// ------------------------------------------------------------------ list / read

async function list(ctx, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(query.pageSize, 10) || 12));
  const where = ['workspace_id = ?'];
  const params = [ws(ctx)];
  const q = String(query.q || '').trim().slice(0, 100);
  if (q) { where.push('(name LIKE ? OR description LIKE ?)'); params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`, `%${q.replace(/[%_\\]/g, '\\$&')}%`); }
  if (query.category) { where.push('category = ?'); params.push(String(query.category).slice(0, 50)); }
  const total = Number((await get(`SELECT COUNT(*) AS n FROM mail_templates WHERE ${where.join(' AND ')}`, params)).n);
  const rows = await all(`SELECT id, name, description, category, source, source_filename, version, created_at, updated_at FROM mail_templates WHERE ${where.join(' AND ')} ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
  return { templates: rows.map(r => present(r)), page, pageSize, total };
}

async function categories(ctx) {
  const rows = await all('SELECT DISTINCT category FROM mail_templates WHERE workspace_id = ? ORDER BY category', [ws(ctx)]);
  const caps = ctx.auth.capabilities || new Set();
  return {
    categories: [...new Set([...CATEGORIES, ...rows.map(r => r.category)])],
    tokens: TEMPLATE_TOKENS,
    // What this member may do here (the server enforces it on every request anyway).
    canManage: caps.has('mail.compose'),
    canCleanup: caps.has('mail.configure'),
    limits: { htmlKb: Math.round(importer.limits().htmlBytes / 1024), zipMb: Math.round(importer.limits().zipBytes / 1048576) }
  };
}

async function getOne(ctx, id) {
  return present(await requireRow(ctx, id), { full: true });
}

/** HTML of a template for use in an email, draft or campaign (a copy with public asset URLs). */
async function htmlForUse(workspaceId, rawId) {
  const row = await requireRow({ auth: { workspaceId } }, rawId);
  return { template: row, html: expandAssetRefs(row.html) };
}

/** Sanitize + analyze without saving (editor "Validate", preview of unsaved edits). */
async function analyze(ctx, input) {
  const html = z.string().max(MAX_HTML, 'The template is larger than 1 MB.').parse(input?.html || '');
  const p = await prepareHtml(ctx, html);
  return { html: expandAssetRefs(p.html), warnings: p.warnings, placeholders: unresolvedPlaceholders({ html: p.html }) };
}

// ------------------------------------------------------------------ write

async function create(ctx, input) {
  const v = createSchema.parse(input || {});
  const p = await prepareHtml(ctx, v.html || '<!doctype html>\n<html><body>\n<p>Hello {{first_name}},</p>\n</body></html>');
  const ins = await run(
    `INSERT INTO mail_templates (workspace_id, name, description, category, html, source, source_filename, warnings_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ws(ctx), v.name, v.description || null, v.category || 'Custom', p.html, v.source || (v.html ? 'html' : 'blank'), v.sourceFilename || null,
      JSON.stringify(p.warnings), ctx.auth.userId, ctx.auth.userId]
  );
  await claimAssets(ctx, ins.lastID, v.importId, p.assetIds);
  await audit(ctx, v.source === 'zip' || v.source === 'html' ? 'mail.template_imported' : 'mail.template_created', { resourceType: 'mail_template', resourceId: ins.lastID, metadata: { source: v.source || 'blank', assets: p.assetIds.length } });
  return getOne(ctx, ins.lastID);
}

/** Saves edits; with version given, refuses to overwrite someone else's newer save. */
async function update(ctx, id, input) {
  const row = await requireRow(ctx, id);
  const v = updateSchema.parse(input || {});
  if (v.version && v.version !== row.version) throw httpError(409, 'This template was changed by someone else since you opened it. Reload it before saving.', 'VERSION_CONFLICT');
  const sets = [];
  const params = [];
  for (const [k, col] of [['name', 'name'], ['description', 'description'], ['category', 'category']]) {
    if (v[k] !== undefined) { sets.push(`${col} = ?`); params.push(v[k] === '' ? null : v[k]); }
  }
  let prepared = null;
  if (v.html !== undefined) {
    prepared = await prepareHtml(ctx, v.html);
    sets.push('html = ?', 'warnings_json = ?');
    params.push(prepared.html, JSON.stringify(prepared.warnings));
  }
  if (!sets.length) throw httpError(400, 'Nothing to update.', 'VALIDATION_ERROR');
  const r = await run(
    `UPDATE mail_templates SET ${sets.join(', ')}, version = version + 1, updated_by = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ? AND version = ?`,
    [...params, ctx.auth.userId, row.id, ws(ctx), row.version]
  );
  if (!r.changes) throw httpError(409, 'This template was changed by someone else since you opened it. Reload it before saving.', 'VERSION_CONFLICT');
  if (prepared) await claimAssets(ctx, row.id, v.importId, prepared.assetIds);
  await audit(ctx, 'mail.template_updated', { resourceType: 'mail_template', resourceId: row.id, metadata: { fields: Object.keys(v).filter(k => k !== 'version' && k !== 'importId') } });
  return getOne(ctx, row.id);
}

async function duplicate(ctx, id) {
  const row = await requireRow(ctx, id);
  const name = `${row.name.slice(0, 140)} (copy)`;
  const ins = await run(
    `INSERT INTO mail_templates (workspace_id, name, description, category, html, source, source_filename, warnings_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'duplicate', ?, ?, 1, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ws(ctx), name, row.description, row.category, row.html, row.source_filename, row.warnings_json, ctx.auth.userId, ctx.auth.userId]
  );
  await audit(ctx, 'mail.template_duplicated', { resourceType: 'mail_template', resourceId: ins.lastID, metadata: { from: row.id } });
  return getOne(ctx, ins.lastID);
}

/** Deletes the template only. Its images stay: emails and campaigns made from it may use them. */
async function remove(ctx, id) {
  const row = await requireRow(ctx, id);
  await run('DELETE FROM mail_templates WHERE id = ? AND workspace_id = ?', [row.id, ws(ctx)]);
  await audit(ctx, 'mail.template_deleted', { resourceType: 'mail_template', resourceId: row.id, metadata: { name: row.name } });
  return { deleted: true };
}

/**
 * Upload preview: an .html/.htm file or a .zip package is processed and sanitized but NOT saved
 * as a template. Its images are stored under an import id and attached when the template is
 * saved; unsaved imports are removed by the cleanup.
 */
async function importUpload(ctx, { buffer, filename, entry }) {
  const name = String(filename || '').trim().slice(0, 255);
  if (!name) throw httpError(400, 'The file name is missing.', 'VALIDATION_ERROR');
  const isZip = /\.zip$/i.test(name);
  const r = isZip
    ? await importer.importZip({ buffer, filename: name, entry: entry ? String(entry).slice(0, 500) : null, workspaceId: ws(ctx), userId: ctx.auth.userId })
    : importer.importHtmlFile({ buffer, filename: name });
  if (r.needsEntry) return { needsEntry: true, entries: r.entries };
  const p = await prepareHtml(ctx, r.html, r.warnings);
  await audit(ctx, 'mail.template_import_previewed', { resourceType: 'mail_template_import', resourceId: r.importId || null, metadata: { type: isZip ? 'zip' : 'html', assets: r.assetCount || 0 } });
  return {
    needsEntry: false,
    source: isZip ? 'zip' : 'html',
    sourceFilename: name,
    suggestedName: name.replace(/\.(zip|html?)$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 150) || 'Imported template',
    entry: r.entry,
    entries: r.entries,
    importId: r.importId || null,
    html: expandAssetRefs(p.html),
    warnings: p.warnings,
    placeholders: unresolvedPlaceholders({ html: p.html })
  };
}

/**
 * Removes stored images that nothing uses any more: not in a template, campaign, draft or sent
 * email of the workspace, and older than the grace period (so unsaved imports and recent copies
 * are kept). Sent emails keep their images forever.
 */
async function cleanupAssets(ctx, { graceHours = 24 } = {}) {
  const hours = Math.max(1, Math.min(24 * 365, Number(graceHours) || 24));
  const candidates = await all(`SELECT public_id FROM mail_template_assets WHERE workspace_id = ? AND created_at < UTC_TIMESTAMP() - INTERVAL ${hours} HOUR`, [ws(ctx)]);
  let removed = 0;
  for (const { public_id: id } of candidates) {
    const like = `%${id}%`;
    const used = await get(
      `SELECT 1 AS x FROM mail_templates WHERE workspace_id = ? AND html LIKE ?
       UNION ALL SELECT 1 FROM mail_campaigns WHERE workspace_id = ? AND html_content LIKE ?
       UNION ALL SELECT 1 FROM email_drafts WHERE workspace_id = ? AND (body_html LIKE ? OR html_body LIKE ?)
       UNION ALL SELECT 1 FROM emails WHERE workspace_id = ? AND html_body LIKE ?
       LIMIT 1`,
      [ws(ctx), like, ws(ctx), like, ws(ctx), like, like, ws(ctx), like]
    );
    if (used) continue;
    const del = await run('DELETE FROM mail_template_assets WHERE workspace_id = ? AND public_id = ?', [ws(ctx), id]);
    if (del.changes) { await store.deleteAssetFile(ws(ctx), id); removed++; }
  }
  await audit(ctx, 'mail.template_assets_cleaned', { resourceType: 'mail_template_asset', metadata: { removed, checked: candidates.length } });
  return { removed, checked: candidates.length };
}

module.exports = { CATEGORIES, SOURCES, list, categories, getOne, htmlForUse, analyze, create, update, duplicate, remove, importUpload, cleanupAssets };
