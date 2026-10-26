const { run, get, all } = require('../../db/database');
const { audit } = require('../../lib/audit');
const mediaStore = require('./mediaStore');
const contentService = require('./contentService');

const { httpError, presentAsset } = contentService;

// Posts in these states still depend on their files; deleting a file under them is refused.
const ACTIVE = ['draft', 'generating', 'review', 'approved', 'scheduled', 'publishing', 'failed', 'rejected'];
// Posts whose approval covers the file; changing the file's alt text re-opens their approval.
const APPROVAL_BOUND = ['review', 'approved', 'scheduled'];

function parseIds(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v.map(Number) : [];
  } catch (e) {
    return [];
  }
}

/** assetId -> [{ id, status, title, platformKey }] for every post in the workspace that attaches it. */
async function usageMap(workspaceId) {
  const rows = await all(
    "SELECT id, status, title, platform_key, media_asset_ids_json FROM content_items WHERE workspace_id = ? AND media_asset_ids_json IS NOT NULL AND media_asset_ids_json NOT IN ('', '[]')",
    [workspaceId]
  );
  const map = new Map();
  for (const r of rows) {
    for (const id of parseIds(r.media_asset_ids_json)) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push({ id: r.id, status: r.status, title: r.title, platformKey: r.platform_key });
    }
  }
  return map;
}

function withUsage(asset, uses, thumbs = new Map()) {
  const list = uses || [];
  const thumb = asset.thumbnail_asset_id ? thumbs.get(Number(asset.thumbnail_asset_id)) : null;
  return {
    ...presentAsset(asset),
    thumbnailPreviewPath: thumb ? `${mediaStore.PUBLIC_PATH}/${thumb}` : null,
    usedBy: list,
    activeUseCount: list.filter(u => ACTIVE.includes(u.status)).length
  };
}

/** thumbnail asset id -> public id, for the videos in rows. */
async function thumbnails(workspaceId, rows) {
  const ids = [...new Set(rows.map(r => r.thumbnail_asset_id).filter(Boolean).map(Number))];
  if (!ids.length) return new Map();
  const t = await all(`SELECT id, public_id FROM assets WHERE workspace_id = ? AND status = 'ready' AND id IN (${ids.map(() => '?').join(',')})`, [workspaceId, ...ids]);
  return new Map(t.map(x => [Number(x.id), x.public_id]));
}

async function requireAsset(workspaceId, id) {
  const row = await get('SELECT * FROM assets WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
  if (!row || row.status === 'deleted') throw httpError(404, 'Media not found.', 'NOT_FOUND');
  return row;
}

async function list(workspaceId, { type, unused, q, limit = 100, offset = 0 } = {}) {
  const where = ["workspace_id = ?", "status <> 'deleted'", "COALESCE(JSON_VALUE(metadata_json, '$.role'), 'media') <> 'thumbnail'"];
  const params = [workspaceId];
  if (type === 'image' || type === 'video') { where.push('asset_type = ?'); params.push(type); }
  if (q) { where.push('(title LIKE ? OR original_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  let rows = await all(`SELECT * FROM assets WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${lim} OFFSET ${off}`, params);
  const usage = await usageMap(workspaceId);
  const thumbs = await thumbnails(workspaceId, rows);
  let items = rows.map(r => withUsage(r, usage.get(Number(r.id)), thumbs));
  if (unused === '1' || unused === true) items = items.filter(i => i.activeUseCount === 0);
  const lim2 = mediaStore.limits();
  return {
    items,
    storage: { usedBytes: await mediaStore.usedBytes(workspaceId), quotaBytes: lim2.workspaceQuotaBytes },
    limits: { imageBytes: lim2.imageBytes, videoBytes: lim2.videoBytes },
    publicFetchProblem: mediaStore.publicFetchProblem()
  };
}

async function detail(workspaceId, id) {
  const row = await requireAsset(workspaceId, id);
  const usage = await usageMap(workspaceId);
  const thumb = row.thumbnail_asset_id ? await get("SELECT * FROM assets WHERE workspace_id = ? AND id = ? AND status <> 'deleted'", [workspaceId, row.thumbnail_asset_id]) : null;
  return { asset: withUsage(row, usage.get(Number(row.id)), await thumbnails(workspaceId, [row])), thumbnail: thumb ? presentAsset(thumb) : null };
}

/** Edits a post's media list through the normal edit path (new version, approval revoked, queued jobs cancelled). */
async function reviseUsingPosts(ctx, posts, transform, note) {
  const revised = [];
  for (const p of posts) {
    const row = await contentService.getRow(ctx.auth.workspaceId, p.id);
    if (!row) continue;
    const ids = transform(parseIds(row.media_asset_ids_json));
    await contentService.updateContent(ctx, p.id, { mediaAssetIds: ids, changeNote: note });
    revised.push(p.id);
  }
  return revised;
}

async function update(ctx, id, { title, altText }) {
  const workspaceId = ctx.auth.workspaceId;
  const row = await requireAsset(workspaceId, id);
  const sets = [];
  const params = [];
  if (title !== undefined) { sets.push('title = ?'); params.push(String(title).trim().slice(0, 255) || null); }
  const altChanged = altText !== undefined && String(altText).trim() !== String(row.alt_text || '');
  if (altText !== undefined) { sets.push('alt_text = ?'); params.push(String(altText).trim().slice(0, 1000) || null); }
  if (!sets.length) return detail(workspaceId, id);
  // Alt text is published with the image (LinkedIn), so approvals that covered the old text lapse.
  const usage = (await usageMap(workspaceId)).get(Number(id)) || [];
  if (altChanged && usage.some(u => u.status === 'publishing')) throw httpError(409, 'A post using this file is being published right now; try again shortly.', 'IN_PROGRESS');
  await run(`UPDATE assets SET ${sets.join(', ')}, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?`, [...params, workspaceId, id]);
  let revised = [];
  if (altChanged) revised = await reviseUsingPosts(ctx, usage.filter(u => APPROVAL_BOUND.includes(u.status)), ids => ids, 'Media alt text changed');
  await audit(ctx, 'social.media.updated', { resourceType: 'asset', resourceId: id, metadata: { fields: sets.map(s => s.split(' ')[0]), approvalsReopened: revised } });
  return { ...(await detail(workspaceId, id)), approvalsReopened: revised };
}

/** Deletes a file that no draft, pending or scheduled post uses. Published history keeps the row. */
async function remove(ctx, id) {
  const workspaceId = ctx.auth.workspaceId;
  const row = await requireAsset(workspaceId, id);
  const uses = ((await usageMap(workspaceId)).get(Number(id)) || []).filter(u => ACTIVE.includes(u.status));
  if (uses.length) {
    throw httpError(409, `This file is used by ${uses.length} post(s) that are not published yet (${uses.slice(0, 5).map(u => `#${u.id} ${u.status}`).join(', ')}). Remove it from those posts first.`, 'MEDIA_IN_USE');
  }
  const toDelete = [row];
  if (row.thumbnail_asset_id) {
    const thumb = await get("SELECT * FROM assets WHERE workspace_id = ? AND id = ? AND status <> 'deleted'", [workspaceId, row.thumbnail_asset_id]);
    if (thumb) toDelete.push(thumb);
  }
  for (const a of toDelete) {
    await run("UPDATE assets SET status = 'deleted', deleted_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?", [workspaceId, a.id]);
    if (a.source === 'upload' && a.public_id) await mediaStore.deleteFile(workspaceId, a.public_id);
  }
  await audit(ctx, 'social.media.deleted', { resourceType: 'asset', resourceId: id, metadata: { deletedIds: toDelete.map(a => a.id) } });
  return { deleted: true, deletedIds: toDelete.map(a => a.id) };
}

/**
 * Replaces a file in every unpublished post that uses it with a newly uploaded file of the same
 * kind. Each affected post gets a new version, so its approval must be given again.
 * The old file stays in the library (it may appear in published history) until deleted.
 */
async function replace(ctx, id, received, { originalName } = {}) {
  const workspaceId = ctx.auth.workspaceId;
  const old = await requireAsset(workspaceId, id).catch(async (err) => {
    await require('fs').promises.unlink(received.tmpPath).catch(() => {});
    throw err;
  });
  const uses = ((await usageMap(workspaceId)).get(Number(id)) || []).filter(u => ACTIVE.includes(u.status) && u.status !== 'generating');
  const blocked = received.probe.kind !== old.asset_type
    ? httpError(400, `Replace a ${old.asset_type} with another ${old.asset_type}.`, 'INVALID_MEDIA')
    : (uses.some(u => u.status === 'publishing') ? httpError(409, 'A post using this file is being published right now; try again shortly.', 'IN_PROGRESS') : null);
  if (blocked) {
    await require('fs').promises.unlink(received.tmpPath).catch(() => {});
    throw blocked;
  }
  const newId = await mediaStore.commitUpload(ctx, received, { originalName, title: old.title || originalName });
  if (old.alt_text) await run('UPDATE assets SET alt_text = ? WHERE workspace_id = ? AND id = ?', [old.alt_text, workspaceId, newId]);
  const revised = await reviseUsingPosts(ctx, uses, ids => ids.map(x => (x === Number(id) ? newId : x)), `Media replaced (#${id} → #${newId})`);
  await audit(ctx, 'social.media.replaced', { resourceType: 'asset', resourceId: id, metadata: { newAssetId: newId, revisedPosts: revised } });
  return { ...(await detail(workspaceId, newId)), replacedAssetId: Number(id), revisedPosts: revised };
}

module.exports = { ACTIVE, usageMap, list, detail, update, remove, replace };
