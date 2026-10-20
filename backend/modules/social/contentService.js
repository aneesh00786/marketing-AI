const { run, get, all, withTransaction } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { safeFetchText, assertSafeUrl } = require('../../lib/safeFetch');
const { ACCOUNT_TYPES, MANUAL_PLATFORMS } = require('./capabilities');
const settingsService = require('./settingsService');

/**
 * Content workflow:
 *   draft → generating → review → approved → scheduled → publishing → published
 * Alternatives: rejected, failed, cancelled.
 * "published" is only ever set by the publishing worker after provider confirmation.
 */
const STATUSES = ['draft', 'generating', 'review', 'approved', 'scheduled', 'publishing', 'published', 'rejected', 'failed', 'cancelled'];
const EDITABLE = ['draft', 'review', 'approved', 'scheduled', 'rejected', 'failed'];
const PLATFORM_KEYS = ['facebook', 'instagram', 'linkedin', 'youtube', 'x'];

function httpError(status, message, code = 'BAD_REQUEST') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

function splitHashtags(value) {
  if (Array.isArray(value)) return value.map(h => String(h).trim()).filter(Boolean).map(h => (h.startsWith('#') ? h : `#${h}`));
  return String(value || '').split(/[\s,]+/).map(h => h.trim()).filter(Boolean).map(h => (h.startsWith('#') ? h : `#${h}`));
}

function present(row) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    platformKey: row.platform_key,
    socialAccountId: row.social_account_id,
    title: row.title,
    caption: row.caption_text || '',
    hashtags: splitHashtags(row.hashtags),
    callToAction: row.call_to_action,
    linkUrl: row.link_url,
    mediaAssetIds: parseJson(row.media_asset_ids_json, []),
    imagePrompt: row.image_prompt,
    videoScript: row.video_script,
    status: row.status,
    scheduledAt: row.scheduled_at,
    scheduleTimezone: row.schedule_timezone,
    suggestedPublishAt: row.suggested_publish_at,
    publishedAt: row.published_at,
    externalPostId: row.external_post_id,
    externalUrl: row.external_url,
    lastError: row.last_error,
    version: row.version,
    variantGroup: row.variant_group,
    variantLabel: row.variant_label,
    assignedApproverId: row.assigned_approver_id,
    assumptions: parseJson(row.ai_assumptions_json, []),
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getRow(workspaceId, id) {
  return get('SELECT * FROM content_items WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
}

async function requireRow(workspaceId, id) {
  const row = await getRow(workspaceId, id);
  if (!row) throw httpError(404, 'Content not found.', 'NOT_FOUND');
  return row;
}

async function listContent(workspaceId, { status, platformKey, campaignId, accountId, q, limit = 100, offset = 0 } = {}) {
  const where = ['workspace_id = ?'];
  const params = [workspaceId];
  if (status && status !== 'all') {
    const list = String(status).split(',').filter(s => STATUSES.includes(s));
    if (list.length) { where.push(`status IN (${list.map(() => '?').join(',')})`); params.push(...list); }
  }
  if (platformKey) { where.push('platform_key = ?'); params.push(platformKey); }
  if (campaignId) { where.push('campaign_id = ?'); params.push(Number(campaignId)); }
  if (accountId) { where.push('social_account_id = ?'); params.push(Number(accountId)); }
  if (q) { where.push('(title LIKE ? OR caption_text LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const rows = await all(
    `SELECT * FROM content_items WHERE ${where.join(' AND ')} ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT ${lim} OFFSET ${off}`,
    params
  );
  const total = await get(`SELECT COUNT(*) AS c FROM content_items WHERE ${where.join(' AND ')}`, params);
  return { items: rows.map(present), total: Number(total?.c || 0), limit: lim, offset: off };
}

async function snapshotVersion(tx, row, userId, note) {
  await tx.run(
    `INSERT INTO content_versions (workspace_id, content_item_id, version_number, content_json, change_note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE content_json = VALUES(content_json)`,
    [row.workspace_id, row.id, row.version, JSON.stringify(present(row)), note || null, userId || null]
  );
}

async function assertAccountInWorkspace(workspaceId, accountId) {
  if (accountId === null || accountId === undefined) return null;
  const acct = await get('SELECT id, account_type, status FROM social_accounts WHERE workspace_id = ? AND id = ?', [workspaceId, accountId]);
  if (!acct) throw httpError(400, 'Selected social account does not belong to this workspace.');
  return acct;
}

async function assertAssetsInWorkspace(workspaceId, assetIds) {
  if (!assetIds || assetIds.length === 0) return [];
  const rows = await all(
    `SELECT * FROM assets WHERE workspace_id = ? AND id IN (${assetIds.map(() => '?').join(',')})`,
    [workspaceId, ...assetIds]
  );
  if (rows.length !== new Set(assetIds).size) throw httpError(400, 'One or more media assets do not belong to this workspace.');
  return rows;
}

async function assertCampaignInWorkspace(workspaceId, campaignId) {
  if (!campaignId) return;
  const c = await get('SELECT id FROM campaigns WHERE workspace_id = ? AND id = ?', [workspaceId, campaignId]);
  if (!c) throw httpError(400, 'Campaign does not belong to this workspace.');
}

function normalizeLink(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
    return u.toString();
  } catch (e) {
    throw httpError(400, 'Link URL must be a valid http(s) URL.');
  }
}

async function createContent(ctx, input) {
  const workspaceId = ctx.auth.workspaceId;
  if (input.platformKey && !PLATFORM_KEYS.includes(input.platformKey)) throw httpError(400, 'Unknown platform.');
  await assertCampaignInWorkspace(workspaceId, input.campaignId);
  const acct = await assertAccountInWorkspace(workspaceId, input.socialAccountId ?? null);
  await assertAssetsInWorkspace(workspaceId, input.mediaAssetIds || []);
  const platformKey = input.platformKey || (acct ? ACCOUNT_TYPES[acct.account_type]?.platformKey : null);

  const id = await withTransaction(async (tx) => {
    const ins = await tx.run(
      `INSERT INTO content_items (workspace_id, campaign_id, content_type, title, caption_text, hashtags, call_to_action,
         platform, platform_key, social_account_id, link_url, media_asset_ids_json, image_prompt, video_script,
         status, version, variant_group, variant_label, suggested_publish_at, ai_assumptions_json, source, created_by, created_at, updated_at)
       VALUES (?, ?, 'post', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [
        workspaceId, input.campaignId || null, input.title || null, input.caption || '', splitHashtags(input.hashtags).join(' '),
        input.callToAction || null, platformKey || 'All', platformKey, acct?.id || null, normalizeLink(input.linkUrl),
        JSON.stringify(input.mediaAssetIds || []), input.imagePrompt || null, input.videoScript || null,
        input.status === 'generating' ? 'generating' : 'draft', input.variantGroup || null, input.variantLabel || null,
        input.suggestedPublishAt || null, input.assumptions ? JSON.stringify(input.assumptions) : null,
        input.source || 'manual', ctx.auth.userId || null
      ]
    );
    const row = await tx.get('SELECT * FROM content_items WHERE id = ?', [ins.lastID]);
    await snapshotVersion(tx, row, ctx.auth.userId, 'Created');
    return ins.lastID;
  });
  await audit(ctx, 'social.content.created', { resourceType: 'content', resourceId: id, metadata: { platformKey, source: input.source || 'manual' } });
  return present(await getRow(workspaceId, id));
}

/**
 * Edits bump the version. Any approval belonged to the previous version, so an
 * approved or scheduled item returns to draft and its queued publication is cancelled.
 */
async function updateContent(ctx, id, input) {
  const workspaceId = ctx.auth.workspaceId;
  const row = await requireRow(workspaceId, id);
  if (!EDITABLE.includes(row.status)) throw httpError(409, `Content in status "${row.status}" cannot be edited.`, 'INVALID_STATE');
  if (input.platformKey && !PLATFORM_KEYS.includes(input.platformKey)) throw httpError(400, 'Unknown platform.');
  if (input.campaignId !== undefined) await assertCampaignInWorkspace(workspaceId, input.campaignId);
  if (input.socialAccountId !== undefined) await assertAccountInWorkspace(workspaceId, input.socialAccountId);
  if (input.mediaAssetIds !== undefined) await assertAssetsInWorkspace(workspaceId, input.mediaAssetIds);

  const fields = {
    title: input.title,
    caption_text: input.caption,
    hashtags: input.hashtags !== undefined ? splitHashtags(input.hashtags).join(' ') : undefined,
    call_to_action: input.callToAction,
    link_url: input.linkUrl !== undefined ? normalizeLink(input.linkUrl) : undefined,
    platform_key: input.platformKey,
    platform: input.platformKey,
    social_account_id: input.socialAccountId,
    media_asset_ids_json: input.mediaAssetIds !== undefined ? JSON.stringify(input.mediaAssetIds) : undefined,
    image_prompt: input.imagePrompt,
    video_script: input.videoScript,
    campaign_id: input.campaignId,
    assigned_approver_id: input.assignedApproverId
  };
  const sets = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (sets.length === 0) return present(row);

  const resetToDraft = ['review', 'approved', 'scheduled', 'failed'].includes(row.status);
  await withTransaction(async (tx) => {
    await tx.run(
      `UPDATE content_items SET ${sets.map(([k]) => `${k} = ?`).join(', ')}, version = version + 1,
         status = ?, scheduled_at = IF(? , NULL, scheduled_at), last_error = NULL, updated_at = UTC_TIMESTAMP()
       WHERE workspace_id = ? AND id = ?`,
      [...sets.map(([, v]) => (v === '' ? null : v)), resetToDraft ? 'draft' : row.status, resetToDraft ? 1 : 0, workspaceId, id]
    );
    if (resetToDraft) {
      await tx.run(
        "UPDATE publishing_jobs SET status = 'cancelled', last_error = 'Content edited after scheduling', updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND content_item_id = ? AND status = 'queued'",
        [workspaceId, id]
      );
      await tx.run(
        "UPDATE approval_requests SET status = 'superseded' WHERE workspace_id = ? AND resource_type = 'content' AND resource_id = ? AND status IN ('pending', 'approved')",
        [workspaceId, id]
      );
    }
    const updated = await tx.get('SELECT * FROM content_items WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
    await snapshotVersion(tx, updated, ctx.auth.userId, input.changeNote || 'Edited');
  });
  await audit(ctx, 'social.content.updated', { resourceType: 'content', resourceId: id, metadata: { fields: sets.map(([k]) => k), resetToDraft } });
  return present(await getRow(workspaceId, id));
}

async function duplicateContent(ctx, id) {
  const row = await requireRow(ctx.auth.workspaceId, id);
  const p = present(row);
  return createContent(ctx, {
    campaignId: p.campaignId,
    platformKey: p.platformKey,
    socialAccountId: p.socialAccountId,
    title: p.title ? `${p.title} (copy)` : null,
    caption: p.caption,
    hashtags: p.hashtags,
    callToAction: p.callToAction,
    linkUrl: p.linkUrl,
    mediaAssetIds: p.mediaAssetIds,
    imagePrompt: p.imagePrompt,
    videoScript: p.videoScript,
    variantGroup: p.variantGroup,
    source: 'duplicate'
  });
}

async function isApprover(workspaceId, userId) {
  const m = await get("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'Active'", [workspaceId, userId]);
  if (!m) return false;
  const { capabilitiesForRole } = require('../../lib/permissions');
  return capabilitiesForRole(m.role).has('content.approve');
}

async function submitForApproval(ctx, id, { approverId } = {}) {
  const workspaceId = ctx.auth.workspaceId;
  const row = await requireRow(workspaceId, id);
  if (!['draft', 'rejected', 'failed'].includes(row.status)) throw httpError(409, `Only draft, rejected or failed content can be submitted (current: ${row.status}).`, 'INVALID_STATE');
  if (approverId && !(await isApprover(workspaceId, approverId))) throw httpError(400, 'The selected approver cannot approve content in this workspace.');
  await withTransaction(async (tx) => {
    await tx.run(
      "UPDATE approval_requests SET status = 'superseded' WHERE workspace_id = ? AND resource_type = 'content' AND resource_id = ? AND status = 'pending'",
      [workspaceId, id]
    );
    await tx.run(
      `INSERT INTO approval_requests (workspace_id, resource_type, resource_id, resource_version, requested_by, assigned_approver_id, status, created_at)
       VALUES (?, 'content', ?, ?, ?, ?, 'pending', UTC_TIMESTAMP())`,
      [workspaceId, id, row.version, ctx.auth.userId, approverId || null]
    );
    await tx.run(
      "UPDATE content_items SET status = 'review', assigned_approver_id = ?, last_error = NULL, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?",
      [approverId || null, workspaceId, id]
    );
  });
  await audit(ctx, 'social.content.submitted', { resourceType: 'content', resourceId: id, metadata: { version: row.version, approverId: approverId || null } });
  return present(await getRow(workspaceId, id));
}

async function decide(ctx, id, decision, note) {
  const workspaceId = ctx.auth.workspaceId;
  const row = await requireRow(workspaceId, id);
  const allowedFrom = decision === 'approved' ? ['review', 'draft'] : ['review'];
  if (!allowedFrom.includes(row.status)) throw httpError(409, `Content in status "${row.status}" cannot be ${decision}.`, 'INVALID_STATE');
  if (decision === 'rejected' && !note) throw httpError(400, 'A rejection note is required.');

  await withTransaction(async (tx) => {
    const pending = await tx.get(
      "SELECT id FROM approval_requests WHERE workspace_id = ? AND resource_type = 'content' AND resource_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
      [workspaceId, id]
    );
    if (pending) {
      await tx.run(
        'UPDATE approval_requests SET status = ?, decision_note = ?, decided_by = ?, decided_at = UTC_TIMESTAMP(), resource_version = ? WHERE id = ?',
        [decision, note || null, ctx.auth.userId, row.version, pending.id]
      );
    } else {
      await tx.run(
        `INSERT INTO approval_requests (workspace_id, resource_type, resource_id, resource_version, requested_by, status, decision_note, decided_by, decided_at, created_at)
         VALUES (?, 'content', ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [workspaceId, id, row.version, ctx.auth.userId, decision, note || null, ctx.auth.userId]
      );
    }
    await tx.run(
      'UPDATE content_items SET status = ?, last_error = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?',
      [decision === 'approved' ? 'approved' : 'rejected', decision === 'rejected' ? `Rejected: ${note}` : null, workspaceId, id]
    );
  });
  await audit(ctx, `social.content.${decision}`, { resourceType: 'content', resourceId: id, metadata: { version: row.version, note } });
  return present(await getRow(workspaceId, id));
}

/** True when the current version of the content holds an approval (or approval is not required). */
async function hasValidApproval(workspaceId, row) {
  const settings = await settingsService.getSettings(workspaceId);
  if (!settings.requireApproval) return true;
  const ok = await get(
    "SELECT id FROM approval_requests WHERE workspace_id = ? AND resource_type = 'content' AND resource_id = ? AND resource_version = ? AND status = 'approved' LIMIT 1",
    [workspaceId, row.id, row.version]
  );
  return !!ok;
}

async function cancelContent(ctx, id) {
  const workspaceId = ctx.auth.workspaceId;
  const row = await requireRow(workspaceId, id);
  if (['publishing', 'published', 'cancelled'].includes(row.status)) throw httpError(409, `Content in status "${row.status}" cannot be cancelled.`, 'INVALID_STATE');
  await run(
    "UPDATE publishing_jobs SET status = 'cancelled', updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND content_item_id = ? AND status = 'queued'",
    [workspaceId, id]
  );
  await run("UPDATE content_items SET status = 'cancelled', scheduled_at = NULL, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?", [workspaceId, id]);
  await audit(ctx, 'social.content.cancelled', { resourceType: 'content', resourceId: id });
  return present(await getRow(workspaceId, id));
}

async function deleteContent(ctx, id) {
  const workspaceId = ctx.auth.workspaceId;
  const row = await requireRow(workspaceId, id);
  if (['publishing', 'published', 'scheduled'].includes(row.status)) {
    throw httpError(409, 'Scheduled, publishing and published content cannot be deleted; cancel it first.', 'INVALID_STATE');
  }
  const jobs = await get('SELECT COUNT(*) AS c FROM publishing_jobs WHERE workspace_id = ? AND content_item_id = ? AND status IN (\'succeeded\', \'needs_review\')', [workspaceId, id]);
  if (Number(jobs?.c || 0) > 0) throw httpError(409, 'This content has publication history and cannot be deleted.', 'INVALID_STATE');
  await run('DELETE FROM content_items WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
  await audit(ctx, 'social.content.deleted', { resourceType: 'content', resourceId: id });
  return { deleted: true };
}

async function getContentDetail(workspaceId, id) {
  const row = await requireRow(workspaceId, id);
  const versions = await all(
    'SELECT version_number, change_note, created_by, created_at FROM content_versions WHERE workspace_id = ? AND content_item_id = ? ORDER BY version_number DESC LIMIT 50',
    [workspaceId, id]
  );
  const approvals = await all(
    "SELECT id, resource_version, requested_by, assigned_approver_id, status, decision_note, decided_by, decided_at, created_at FROM approval_requests WHERE workspace_id = ? AND resource_type = 'content' AND resource_id = ? ORDER BY id DESC LIMIT 20",
    [workspaceId, id]
  );
  const jobs = await all(
    `SELECT id, social_account_id, content_version, status, scheduled_for, schedule_timezone, attempt_count, max_attempts,
            external_post_id, external_url, last_error_code, last_error, completed_at, created_at
     FROM publishing_jobs WHERE workspace_id = ? AND content_item_id = ? ORDER BY id DESC LIMIT 20`,
    [workspaceId, id]
  );
  const assetIds = parseJson(row.media_asset_ids_json, []);
  const assets = assetIds.length ? await assertAssetsInWorkspace(workspaceId, assetIds) : [];
  return { content: present(row), versions, approvals, publishingJobs: jobs, assets: assets.map(presentAsset) };
}

/** Platform rules that must hold before scheduling/publishing. Returns a list of problems. */
function validateForAccountType(content, accountType, assets) {
  const problems = [];
  const type = ACCOUNT_TYPES[accountType];
  const limits = type?.limits || {};
  const fullText = composeText(content);
  if (limits.captionMax && fullText.length > limits.captionMax) {
    problems.push(`Text is ${fullText.length} characters; ${type.label} allows ${limits.captionMax}.`);
  }
  if (limits.hashtagMax && content.hashtags.length > limits.hashtagMax) {
    problems.push(`${type.label} allows at most ${limits.hashtagMax} hashtags.`);
  }
  if (limits.requiresMedia && !assets.some(a => a.asset_type === 'image' || a.asset_type === 'video')) {
    problems.push(`${type.label} requires an image or video.`);
  }
  if (assets.filter(a => a.asset_type === 'image').length > 1) {
    problems.push('Multi-image (carousel) posts are not supported yet; attach one image.');
  }
  if (assets.some(a => a.public_url && !a.public_url.startsWith('https://'))) {
    problems.push('Media must be served over HTTPS so the platform can fetch it.');
  }
  if (!fullText.trim() && assets.length === 0) problems.push('The post has no text or media.');
  return problems;
}

function composeText(content) {
  const parts = [content.caption || ''];
  if (content.callToAction && !String(content.caption || '').includes(content.callToAction)) parts.push(content.callToAction);
  if (content.hashtags?.length) parts.push(content.hashtags.join(' '));
  return parts.filter(Boolean).join('\n\n').trim();
}

// ---------- Assets ----------
function presentAsset(a) {
  return {
    id: a.id,
    assetType: a.asset_type,
    source: a.source,
    url: a.public_url,
    mimeType: a.mime_type,
    sizeBytes: a.size_bytes,
    title: a.title,
    prompt: a.prompt,
    createdAt: a.created_at
  };
}

async function listAssets(workspaceId) {
  const rows = await all('SELECT * FROM assets WHERE workspace_id = ? ORDER BY id DESC LIMIT 200', [workspaceId]);
  return rows.map(presentAsset);
}

/** Registers a publicly reachable media URL after checking it is safe and of the declared type. */
async function registerAssetUrl(ctx, { url, assetType, title }) {
  if (!['image', 'video'].includes(assetType)) throw httpError(400, 'assetType must be image or video.');
  assertSafeUrl(url);
  if (!url.startsWith('https://')) throw httpError(400, 'Media URLs must use HTTPS so social platforms can fetch them.');
  let res;
  try {
    res = await safeFetchText(url, { timeoutMs: 8000, maxBytes: 64 * 1024 });
  } catch (err) {
    throw httpError(400, `Could not fetch the media URL: ${err.message}`);
  }
  if (!res.ok) throw httpError(400, `Media URL returned HTTP ${res.status}.`);
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!mime.startsWith(`${assetType}/`)) throw httpError(400, `URL serves "${mime || 'unknown'}", not an ${assetType}.`);
  const size = parseInt(res.headers.get('content-length') || '', 10);
  const ins = await run(
    `INSERT INTO assets (workspace_id, asset_type, source, public_url, mime_type, size_bytes, title, created_by, created_at)
     VALUES (?, ?, 'url', ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [ctx.auth.workspaceId, assetType, res.url, mime, Number.isFinite(size) ? size : null, title || null, ctx.auth.userId]
  );
  await audit(ctx, 'social.asset.registered', { resourceType: 'asset', resourceId: ins.lastID, metadata: { assetType, mime } });
  return presentAsset(await get('SELECT * FROM assets WHERE id = ?', [ins.lastID]));
}

module.exports = {
  STATUSES,
  PLATFORM_KEYS,
  MANUAL_PLATFORMS,
  present,
  presentAsset,
  splitHashtags,
  composeText,
  getRow,
  requireRow,
  listContent,
  createContent,
  updateContent,
  duplicateContent,
  submitForApproval,
  approve: (ctx, id, note) => decide(ctx, id, 'approved', note),
  reject: (ctx, id, note) => decide(ctx, id, 'rejected', note),
  hasValidApproval,
  cancelContent,
  deleteContent,
  getContentDetail,
  validateForAccountType,
  assertAssetsInWorkspace,
  listAssets,
  registerAssetUrl,
  httpError
};
