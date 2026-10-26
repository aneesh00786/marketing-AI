const { run, get, all, withTransaction } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { toDbDateTime, zonedLocalToUtc, isValidTimeZone } = require('../../lib/time');
const { getAdapter } = require('./providers');
const { canAccount, requiredPublishFeature, evaluateAccount, ACCOUNT_TYPES } = require('./capabilities');
const contentService = require('./contentService');
const accountService = require('./accountService');
const settingsService = require('./settingsService');
const { workerAuthorizationProblem } = require('../../lib/workerAuthorization');
const mediaStore = require('./mediaStore');

const fs = require('fs');

const STALE_LOCK_MINUTES = 10;
// A video still "processing" on the platform this long after upload is handed to a person.
const PROCESSING_DEADLINE_HOURS = 24;
const PROCESSING_CHECK_SECONDS = 120;
const { httpError } = contentService;

function idempotencyKey(content, accountId) {
  return `content:${content.id}:v${content.version}:account:${accountId}`;
}

/** What an adapter needs to deliver one attached file; never includes credentials. */
async function mediaForProvider(workspaceId, asset) {
  const uploaded = asset.source === 'upload';
  let thumbnailUrl = null;
  if (asset.thumbnail_asset_id) {
    const thumb = await get("SELECT public_id FROM assets WHERE workspace_id = ? AND id = ? AND status = 'ready'", [workspaceId, asset.thumbnail_asset_id]);
    if (thumb?.public_id) thumbnailUrl = mediaStore.publicUrlFor(thumb.public_id);
  }
  return {
    id: asset.id,
    kind: asset.asset_type,
    mime: asset.mime_type,
    url: uploaded ? mediaStore.publicUrlFor(asset.public_id) : asset.public_url,
    filePath: uploaded ? mediaStore.filePath(workspaceId, asset.public_id) : null,
    sizeBytes: asset.size_bytes === null ? null : Number(asset.size_bytes),
    width: asset.width,
    height: asset.height,
    durationSeconds: asset.duration_seconds === null ? null : Number(asset.duration_seconds),
    altText: asset.alt_text || null,
    title: asset.title || null,
    thumbnailUrl
  };
}

function presentJob(row) {
  return {
    id: row.id,
    contentItemId: row.content_item_id,
    contentTitle: row.content_title ?? undefined,
    platformKey: row.platform_key ?? undefined,
    socialAccountId: row.social_account_id,
    accountName: row.account_name ?? undefined,
    contentVersion: row.content_version,
    status: row.status,
    scheduledFor: row.scheduled_for,
    scheduleTimezone: row.schedule_timezone,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    externalPostId: row.external_post_id,
    externalUrl: row.external_url,
    lastErrorCode: row.last_error_code,
    lastError: row.last_error,
    note: (() => { try { return JSON.parse(row.provider_response_json || 'null')?.note || null; } catch (e) { return null; } })(),
    completedAt: row.completed_at,
    createdAt: row.created_at
  };
}

/** Everything that must hold before a post may be queued or sent. Throws a 4xx with a clear reason. */
async function preflight(workspaceId, contentRow, accountRow) {
  if (!accountRow) throw httpError(400, 'Choose a connected social account to publish to.');
  if (accountService.isDemoAccount(accountRow)) {
    throw httpError(409, 'This is a demo account with sample data; publishing to it is disabled.', 'DEMO_ACCOUNT');
  }
  if (accountRow.status !== 'connected') {
    throw httpError(409, `The account "${accountRow.display_name}" is ${accountRow.status}. Reconnect it first.`, 'ACCOUNT_NOT_CONNECTED');
  }
  const accountPlatform = ACCOUNT_TYPES[accountRow.account_type]?.platformKey;
  if (contentRow.platform_key && accountPlatform && contentRow.platform_key !== accountPlatform) {
    throw httpError(400, `This content is written for ${contentRow.platform_key}, but the account is a ${accountPlatform} account.`);
  }
  const content = contentService.present(contentRow);
  const assets = await contentService.assertAssetsInWorkspace(workspaceId, content.mediaAssetIds);
  const feature = requiredPublishFeature(contentRow, assets);
  if (!canAccount(accountRow, feature)) {
    const cap = evaluateAccount(accountRow)[feature];
    const reason = cap?.status === 'missing_permission'
      ? `missing permission (${cap.missingScopes.join(', ')}); reconnect and grant it`
      : (cap?.note || cap?.status || 'not supported');
    throw httpError(409, `${ACCOUNT_TYPES[accountRow.account_type]?.label || 'This account'} cannot ${cap?.label?.toLowerCase() || feature}: ${reason}.`, 'CAPABILITY_UNAVAILABLE');
  }
  const problems = contentService.validateForAccountType(content, accountRow.account_type, assets);
  if (problems.length) throw httpError(400, problems.join(' '), 'CONTENT_INVALID');
  await assertMediaFilesPresent(workspaceId, assets);
  const approval = await contentService.approvalProblem(workspaceId, contentRow);
  if (approval) throw httpError(409, approval, 'APPROVAL_REQUIRED');
  return { content, assets, feature };
}

/**
 * Uploaded files must still be in storage, intact, before anything is sent: a post must never go
 * out with part of its media missing. The message names the file, never a server path.
 */
async function assertMediaFilesPresent(workspaceId, assets) {
  for (const a of assets) {
    if (a.source !== 'upload') continue;
    let stat = null;
    try { stat = await fs.promises.stat(mediaStore.filePath(workspaceId, a.public_id)); } catch (e) { stat = null; }
    if (!stat || (a.size_bytes !== null && a.size_bytes !== undefined && stat.size !== Number(a.size_bytes))) {
      throw httpError(409, `The media file "${a.original_name || a.title || `#${a.id}`}" is missing or damaged in storage. Upload it again and attach the new file.`, 'MEDIA_MISSING');
    }
  }
}

/** Error text safe to store and show: provider messages as they are, anything else without internals. */
function safeErrorMessage(err) {
  if (err?.name === 'ProviderError' || (err?.status && err.status < 500)) return String(err.message || err).slice(0, 2000);
  return `Internal error while publishing${err?.code ? ` (${err.code})` : ''}.`;
}

async function enqueue(ctx, contentId, { accountId, scheduledForUtc, timezone, mode }) {
  const workspaceId = ctx.auth.workspaceId;
  const row = await contentService.requireRow(workspaceId, contentId);
  const settings = await settingsService.getSettings(workspaceId);
  const allowedFrom = settings.requireApproval ? ['approved', 'scheduled', 'failed'] : ['draft', 'approved', 'scheduled', 'failed'];
  if (!allowedFrom.includes(row.status)) {
    throw httpError(409, settings.requireApproval && ['draft', 'review'].includes(row.status)
      ? 'Approve this content before scheduling or publishing.'
      : `Content in status "${row.status}" cannot be scheduled.`, 'INVALID_STATE');
  }
  const targetAccountId = accountId || row.social_account_id;
  const account = targetAccountId ? await accountService.getAccountRow(workspaceId, targetAccountId) : null;
  if (targetAccountId && !account) throw httpError(400, 'Social account not found in this workspace.');
  await preflight(workspaceId, row, account);

  const key = idempotencyKey(row, account.id);
  const scheduledDb = toDbDateTime(scheduledForUtc);
  const jobId = await withTransaction(async (tx) => {
    const existing = await tx.get('SELECT * FROM publishing_jobs WHERE workspace_id = ? AND idempotency_key = ?', [workspaceId, key]);
    let id;
    if (existing) {
      if (existing.status === 'succeeded') throw httpError(409, 'This version is already published to that account.', 'ALREADY_PUBLISHED');
      if (existing.status === 'running') throw httpError(409, 'This post is being published right now.', 'IN_PROGRESS');
      if (existing.status === 'processing') throw httpError(409, 'The platform is still processing this upload; it is marked published when the platform reports it ready.', 'IN_PROGRESS');
      if (existing.status === 'needs_review') {
        throw httpError(409, 'A previous attempt has an unknown outcome. Check the platform, then use "Retry" in the Publishing Queue and confirm it was not posted.', 'NEEDS_REVIEW');
      }
      await tx.run(
        `UPDATE publishing_jobs SET status = 'queued', scheduled_for = ?, schedule_timezone = ?, next_attempt_at = ?,
           max_attempts = attempt_count + 3, last_error = NULL, last_error_code = NULL, requested_by = ?, updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [scheduledDb, timezone, scheduledDb, ctx.auth.userId, existing.id]
      );
      id = existing.id;
    } else {
      const ins = await tx.run(
        `INSERT INTO publishing_jobs (workspace_id, content_item_id, social_account_id, content_version, idempotency_key, status,
           scheduled_for, schedule_timezone, next_attempt_at, requested_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [workspaceId, row.id, account.id, row.version, key, scheduledDb, timezone, scheduledDb, ctx.auth.userId]
      );
      id = ins.lastID;
    }
    // Only one live publication per content item.
    await tx.run(
      "UPDATE publishing_jobs SET status = 'cancelled', updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND content_item_id = ? AND status = 'queued' AND id <> ?",
      [workspaceId, row.id, id]
    );
    await tx.run(
      `UPDATE content_items SET status = 'scheduled', social_account_id = ?, scheduled_at = ?, schedule_timezone = ?, last_error = NULL, updated_at = UTC_TIMESTAMP()
       WHERE workspace_id = ? AND id = ?`,
      [account.id, scheduledDb, timezone, workspaceId, row.id]
    );
    return id;
  });
  await audit(ctx, mode === 'now' ? 'social.publish.requested' : 'social.publish.scheduled', {
    resourceType: 'content',
    resourceId: row.id,
    metadata: { jobId, accountId: account.id, scheduledFor: scheduledDb, timezone, version: row.version }
  });
  return presentJob(await get('SELECT * FROM publishing_jobs WHERE id = ?', [jobId]));
}

async function schedule(ctx, contentId, { accountId, localDateTime, timezone }) {
  const settings = await settingsService.getSettings(ctx.auth.workspaceId);
  const tz = timezone || settings.timezone;
  if (!isValidTimeZone(tz)) throw httpError(400, `Unknown time zone: ${tz}`);
  const utc = zonedLocalToUtc(localDateTime, tz);
  if (utc.getTime() < Date.now() + 60 * 1000) throw httpError(400, 'Schedule time must be at least one minute in the future.');
  if (utc.getTime() > Date.now() + 180 * 24 * 3600 * 1000) throw httpError(400, 'Schedule time must be within 180 days.');
  return enqueue(ctx, contentId, { accountId, scheduledForUtc: utc, timezone: tz, mode: 'scheduled' });
}

async function publishNow(ctx, contentId, { accountId }) {
  const settings = await settingsService.getSettings(ctx.auth.workspaceId);
  return enqueue(ctx, contentId, { accountId, scheduledForUtc: new Date(), timezone: settings.timezone, mode: 'now' });
}

async function cancelSchedule(ctx, contentId) {
  const workspaceId = ctx.auth.workspaceId;
  const row = await contentService.requireRow(workspaceId, contentId);
  if (row.status !== 'scheduled') throw httpError(409, 'Only scheduled content can be unscheduled.', 'INVALID_STATE');
  const res = await run(
    "UPDATE publishing_jobs SET status = 'cancelled', updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND content_item_id = ? AND status = 'queued'",
    [workspaceId, contentId]
  );
  const running = await get("SELECT id FROM publishing_jobs WHERE workspace_id = ? AND content_item_id = ? AND status IN ('running', 'processing')", [workspaceId, contentId]);
  if (running) throw httpError(409, 'Publishing has already started and cannot be cancelled.', 'IN_PROGRESS');
  await run("UPDATE content_items SET status = 'approved', scheduled_at = NULL, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?", [workspaceId, contentId]);
  await audit(ctx, 'social.publish.unscheduled', { resourceType: 'content', resourceId: contentId, metadata: { cancelledJobs: res.changes } });
  return contentService.present(await contentService.getRow(workspaceId, contentId));
}

async function listQueue(workspaceId, { status, accountId, from, to, limit = 100 } = {}) {
  const where = ['j.workspace_id = ?'];
  const params = [workspaceId];
  if (status && status !== 'all') {
    const list = String(status).split(',');
    where.push(`j.status IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (accountId) { where.push('j.social_account_id = ?'); params.push(Number(accountId)); }
  if (from) { where.push('j.scheduled_for >= ?'); params.push(toDbDateTime(from)); }
  if (to) { where.push('j.scheduled_for <= ?'); params.push(toDbDateTime(to)); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 300);
  const rows = await all(
    `SELECT j.*, c.title AS content_title, c.platform_key, a.display_name AS account_name
     FROM publishing_jobs j
     JOIN content_items c ON c.workspace_id = j.workspace_id AND c.id = j.content_item_id
     JOIN social_accounts a ON a.workspace_id = j.workspace_id AND a.id = j.social_account_id
     WHERE ${where.join(' AND ')}
     ORDER BY FIELD(j.status, 'needs_review', 'failed', 'running', 'processing', 'queued', 'succeeded', 'cancelled'), j.scheduled_for ASC
     LIMIT ${lim}`,
    params
  );
  return rows.map(presentJob);
}

async function requireJob(workspaceId, jobId) {
  const job = await get('SELECT * FROM publishing_jobs WHERE workspace_id = ? AND id = ?', [workspaceId, jobId]);
  if (!job) throw httpError(404, 'Publishing job not found.', 'NOT_FOUND');
  return job;
}

/**
 * Retries a failed job. Jobs with an unknown outcome require the user to confirm
 * that the post did not appear on the platform, preventing duplicate posts.
 */
async function retryJob(ctx, jobId, { confirmNotPublished = false } = {}) {
  const workspaceId = ctx.auth.workspaceId;
  const job = await requireJob(workspaceId, jobId);
  if (!['failed', 'needs_review'].includes(job.status)) throw httpError(409, `A ${job.status} job cannot be retried.`, 'INVALID_STATE');
  if (job.status === 'needs_review' && !confirmNotPublished) {
    throw httpError(409, 'Confirm that the post does not already appear on the platform before retrying.', 'CONFIRMATION_REQUIRED');
  }
  const content = await contentService.requireRow(workspaceId, job.content_item_id);
  if (content.version !== job.content_version) throw httpError(409, 'The content changed since this job was created; schedule the new version instead.', 'STALE_JOB');
  const account = await accountService.getAccountRow(workspaceId, job.social_account_id);
  await preflight(workspaceId, content, account);
  // A person confirmed the post is not on the platform, so an upload id kept from a processing
  // timeout no longer stands for a published post: the retry uploads again.
  await run(
    `UPDATE publishing_jobs SET status = 'queued', next_attempt_at = UTC_TIMESTAMP(), max_attempts = attempt_count + 3,
       external_post_id = IF(status = 'needs_review', NULL, external_post_id), external_url = IF(status = 'needs_review', NULL, external_url),
       last_error = NULL, last_error_code = NULL, locked_by = NULL, locked_at = NULL, requested_by = ?, updated_at = UTC_TIMESTAMP()
     WHERE workspace_id = ? AND id = ? AND status IN ('failed', 'needs_review')`,
    [ctx.auth.userId || null, workspaceId, jobId]
  );
  await run(
    "UPDATE content_items SET status = 'scheduled', last_error = NULL, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?",
    [workspaceId, job.content_item_id]
  );
  await audit(ctx, 'social.publish.retried', { resourceType: 'publishing_job', resourceId: jobId, metadata: { previousStatus: job.status, confirmNotPublished } });
  return presentJob(await requireJob(workspaceId, jobId));
}

async function cancelJob(ctx, jobId) {
  const workspaceId = ctx.auth.workspaceId;
  const job = await requireJob(workspaceId, jobId);
  if (!['queued', 'failed', 'needs_review'].includes(job.status)) throw httpError(409, `A ${job.status} job cannot be cancelled.`, 'INVALID_STATE');
  await run("UPDATE publishing_jobs SET status = 'cancelled', updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?", [workspaceId, jobId]);
  await run(
    "UPDATE content_items SET status = 'approved', scheduled_at = NULL, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ? AND status IN ('scheduled', 'failed')",
    [workspaceId, job.content_item_id]
  );
  await audit(ctx, 'social.publish.job_cancelled', { resourceType: 'publishing_job', resourceId: jobId, metadata: { previousStatus: job.status } });
  return presentJob(await requireJob(workspaceId, jobId));
}

// ======================= Worker side =======================

function backoffSeconds(attempt, retryAfterSec) {
  // Daily quotas (YouTube) reset up to a day away; waiting less only burns an attempt.
  if (retryAfterSec) return Math.min(retryAfterSec, 26 * 3600);
  return Math.min(60 * Math.pow(2, attempt - 1), 3600);
}

/** Atomically claims due jobs; a job can only be claimed by one worker. */
async function claimDueJobs(workerId, limit = 5) {
  const due = await all(
    `SELECT id FROM publishing_jobs WHERE status = 'queued' AND next_attempt_at <= UTC_TIMESTAMP() ORDER BY next_attempt_at ASC LIMIT ${Math.max(1, Math.min(50, parseInt(limit, 10) || 5))}`
  );
  const claimed = [];
  for (const { id } of due) {
    const res = await run(
      `UPDATE publishing_jobs SET status = 'running', locked_by = ?, locked_at = UTC_TIMESTAMP(), attempt_count = attempt_count + 1, updated_at = UTC_TIMESTAMP()
       WHERE id = ? AND status = 'queued' AND next_attempt_at <= UTC_TIMESTAMP()`,
      [workerId, id]
    );
    if (res.changes === 1) claimed.push(await get('SELECT * FROM publishing_jobs WHERE id = ?', [id]));
  }
  return claimed;
}

/** A job left "running" by a crashed worker may or may not have posted: never auto-retry it. */
async function recoverStaleJobs() {
  const stale = await all(
    `SELECT id, workspace_id, content_item_id FROM publishing_jobs WHERE status = 'running' AND locked_at < UTC_TIMESTAMP() - INTERVAL ${STALE_LOCK_MINUTES} MINUTE`
  );
  for (const job of stale) {
    const res = await run(
      `UPDATE publishing_jobs SET status = 'needs_review', last_error_code = 'OUTCOME_UNKNOWN',
         last_error = 'The worker stopped while publishing. Check the platform before retrying.', locked_by = NULL, updated_at = UTC_TIMESTAMP()
       WHERE id = ? AND status = 'running'`,
      [job.id]
    );
    if (res.changes === 1) {
      await run(
        "UPDATE content_items SET status = 'failed', last_error = 'Publishing outcome unknown; check the platform, then retry from the Publishing Queue.', updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?",
        [job.workspace_id, job.content_item_id]
      );
      await audit({ workspaceId: job.workspace_id, actorType: 'worker' }, 'social.publish.outcome_unknown', { resourceType: 'publishing_job', resourceId: job.id });
    }
  }
  return stale.length;
}

async function finishAttempt(attemptId, { outcome, err = null, response = null }) {
  await run(
    'UPDATE publishing_attempts SET outcome = ?, error_code = ?, error_message = ?, http_status = ?, response_json = ?, finished_at = UTC_TIMESTAMP() WHERE id = ?',
    [outcome, err?.code || null, err ? String(err.message).slice(0, 2000) : null, err?.httpStatus || null, response ? JSON.stringify(response).slice(0, 20000) : null, attemptId]
  );
}

async function failJob(job, status, err, contentStatus, contentMessage) {
  await run(
    'UPDATE publishing_jobs SET status = ?, last_error_code = ?, last_error = ?, locked_by = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?',
    [status, err?.code || 'ERROR', safeErrorMessage(err), job.id]
  );
  if (contentStatus) {
    await run(
      'UPDATE content_items SET status = ?, last_error = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?',
      [contentStatus, contentMessage || safeErrorMessage(err), job.workspace_id, job.content_item_id]
    );
  }
}

/**
 * Executes one claimed job end to end. While it runs (uploads can take many minutes) the lock is
 * refreshed, so another worker's stale-job recovery never takes over a live job.
 */
async function executeJob(job, workerId) {
  const beat = setInterval(() => {
    run("UPDATE publishing_jobs SET locked_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'running' AND locked_by = ?", [job.id, workerId]).catch(() => {});
  }, module.exports._heartbeatMs);
  try {
    return await runJob(job, workerId);
  } finally {
    clearInterval(beat);
  }
}

/** Records a provider-confirmed post (job and content in one transaction). */
async function recordPublished(job, content, account, { externalId, url, raw, note }) {
  await withTransaction(async (tx) => {
    await tx.run(
      `UPDATE publishing_jobs SET status = 'succeeded', external_post_id = ?, external_url = COALESCE(?, external_url), provider_response_json = ?,
         locked_by = NULL, completed_at = UTC_TIMESTAMP(), last_error = NULL, last_error_code = NULL, updated_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [externalId, url || null, JSON.stringify({ ...(raw || {}), ...(note ? { note } : {}) }).slice(0, 20000), job.id]
    );
    await tx.run(
      `UPDATE content_items SET status = 'published', published_at = UTC_TIMESTAMP(), external_post_id = ?, external_url = COALESCE(?, external_url), last_error = ?, updated_at = UTC_TIMESTAMP()
       WHERE workspace_id = ? AND id = ?`,
      [externalId, url || null, note || null, job.workspace_id, content.id]
    );
  });
  await require('../../lib/automationEvents').emit(job.workspace_id, 'social.post_published', { subjectType: 'content', subjectId: content.id, payload: { socialCampaignId: content.campaign_id || null, platformKey: content.platform_key || null }, key: `social.published:${content.id}:${job.id}` });
  await accountService.recordAccountSuccess(account);
  await audit({ workspaceId: job.workspace_id, actorType: 'worker' }, 'social.publish.succeeded', {
    resourceType: 'content',
    resourceId: content.id,
    metadata: { jobId: job.id, provider: account.provider_key, externalPostId: externalId }
  });
}

async function runJob(job, workerId) {
  const workerCtx = { workspaceId: job.workspace_id, actorType: 'worker' };
  const content = await contentService.getRow(job.workspace_id, job.content_item_id);
  const account = await accountService.getAccountRow(job.workspace_id, job.social_account_id);

  if (!content) {
    const owner = await get('SELECT workspace_id FROM content_items WHERE id = ?', [job.content_item_id]);
    if (owner) {
      // The content exists in another workspace: never publish it from this job.
      const problem = { code: 'CONTENT_WORKSPACE_MISMATCH', message: 'The content belongs to a different workspace.' };
      await failJob(job, 'failed', problem, null);
      await audit(workerCtx, 'social.publish.blocked', { resourceType: 'publishing_job', resourceId: job.id, metadata: { reason: problem.code } });
      return { status: 'failed', code: problem.code };
    }
  }
  if (!content || content.version !== job.content_version || !['scheduled', 'publishing'].includes(content.status)) {
    await run("UPDATE publishing_jobs SET status = 'cancelled', last_error = 'Content changed or was unscheduled before publishing', locked_by = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?", [job.id]);
    return { status: 'cancelled' };
  }
  if (job.external_post_id) {
    // Already confirmed by the provider in an earlier attempt; never post twice.
    await run("UPDATE publishing_jobs SET status = 'succeeded', locked_by = NULL, completed_at = COALESCE(completed_at, UTC_TIMESTAMP()) WHERE id = ?", [job.id]);
    return { status: 'succeeded' };
  }

  // Authorization is re-checked right before publishing: the workspace must be active, the
  // account must belong to the job's workspace, and the scheduler must still be allowed to publish.
  // A refused job is blocked like a failed preflight (nothing was sent, so no outcome is unknown);
  // "Retry" in the Publishing Queue by an authorized member re-queues it under their name.
  const accountOwner = await get('SELECT workspace_id FROM social_accounts WHERE id = ?', [job.social_account_id]);
  const problem = (accountOwner && Number(accountOwner.workspace_id) !== Number(job.workspace_id))
    ? { code: 'ACCOUNT_WORKSPACE_MISMATCH', message: 'The social account belongs to a different workspace.' }
    : await workerAuthorizationProblem(job.workspace_id, job.requested_by, 'content.publish');
  if (problem) {
    await failJob(job, 'failed', problem, 'failed', `Not published: ${problem.message}`);
    await audit(workerCtx, 'social.publish.blocked', { resourceType: 'publishing_job', resourceId: job.id, metadata: { reason: problem.code } });
    return { status: 'failed', code: problem.code };
  }

  let prepared;
  try {
    prepared = await preflight(job.workspace_id, content, account);
  } catch (err) {
    await failJob(job, 'failed', err, 'failed', `Not published: ${err.message}`);
    await audit(workerCtx, 'social.publish.blocked', { resourceType: 'publishing_job', resourceId: job.id, metadata: { reason: err.message } });
    return { status: 'failed' };
  }

  await run("UPDATE content_items SET status = 'publishing', updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?", [job.workspace_id, content.id]);
  const attempt = await run(
    "INSERT INTO publishing_attempts (workspace_id, publishing_job_id, attempt_number, worker_id, outcome, started_at) VALUES (?, ?, ?, ?, 'started', UTC_TIMESTAMP())",
    [job.workspace_id, job.id, job.attempt_count, workerId]
  );

  const adapter = getAdapter(account.provider_key);
  try {
    const secret = await accountService.getUsableSecret(account);
    const media = [];
    for (const a of prepared.assets) media.push(await mediaForProvider(job.workspace_id, a));
    const result = await adapter.publish(account, secret, {
      text: contentService.composeText(prepared.content),
      title: prepared.content.title,
      linkUrl: prepared.content.linkUrl,
      hashtags: prepared.content.hashtags,
      options: prepared.content.platformOptions || {},
      media,
      imageUrls: media.filter(m => m.kind === 'image').map(m => m.url),
      videoUrls: media.filter(m => m.kind === 'video').map(m => m.url)
    });
    if (result.processing) {
      // Accepted by the platform but not yet live: keep the id (so it is never uploaded twice) and check back.
      const note = result.note || `Uploaded to ${account.provider_key}; waiting for the platform to finish processing.`;
      await run(
        `UPDATE publishing_jobs SET status = 'processing', external_post_id = ?, external_url = ?, provider_response_json = ?,
           next_attempt_at = UTC_TIMESTAMP() + INTERVAL ${PROCESSING_CHECK_SECONDS} SECOND, locked_by = NULL, last_error = NULL, last_error_code = NULL, updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [result.externalId, result.url || null, JSON.stringify({ ...(result.raw || {}), note, processingStartedAt: new Date().toISOString() }).slice(0, 20000), job.id]
      );
      await run('UPDATE content_items SET external_post_id = ?, last_error = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?', [result.externalId, note, job.workspace_id, content.id]);
      await finishAttempt(attempt.lastID, { outcome: 'processing', response: result.raw });
      await audit(workerCtx, 'social.publish.processing', { resourceType: 'publishing_job', resourceId: job.id, metadata: { provider: account.provider_key, externalPostId: result.externalId } });
      return { status: 'processing', externalId: result.externalId };
    }
    await recordPublished(job, content, account, result);
    await finishAttempt(attempt.lastID, { outcome: 'succeeded', response: result.raw });
    return { status: 'succeeded', externalId: result.externalId };
  } catch (err) {
    if (err.name !== 'ProviderError') {
      // An unexpected error inside a publish may come after the platform accepted the post:
      // never assume it was not published.
      await finishAttempt(attempt.lastID, { outcome: 'unknown', err: { code: 'INTERNAL_ERROR', message: safeErrorMessage(err) } });
      await failJob(job, 'needs_review', { code: 'INTERNAL_ERROR', message: safeErrorMessage(err) }, 'failed', 'Publishing stopped with an internal error. Check the platform before retrying.');
      await audit(workerCtx, 'social.publish.outcome_unknown', { resourceType: 'publishing_job', resourceId: job.id, metadata: { code: 'INTERNAL_ERROR' } });
      return { status: 'needs_review' };
    }
    if (err.outcomeUnknown) {
      await finishAttempt(attempt.lastID, { outcome: 'unknown', err });
      await failJob(job, 'needs_review', err, 'failed', `Publishing outcome unknown (${err.message}). Check the platform before retrying.`);
      await audit(workerCtx, 'social.publish.outcome_unknown', { resourceType: 'publishing_job', resourceId: job.id, metadata: { code: err.code } });
      return { status: 'needs_review' };
    }
    if (err.code === 'AUTH_EXPIRED' || err.code === 'PERMISSION_DENIED') await accountService.recordAccountFailure(account, err);
    if (err.retryable && job.attempt_count < job.max_attempts) {
      const delay = backoffSeconds(job.attempt_count, err.retryAfterSec);
      await finishAttempt(attempt.lastID, { outcome: 'retry', err });
      await run(
        `UPDATE publishing_jobs SET status = 'queued', next_attempt_at = UTC_TIMESTAMP() + INTERVAL ? SECOND,
           last_error_code = ?, last_error = ?, locked_by = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?`,
        [delay, err.code, String(err.message).slice(0, 2000), job.id]
      );
      await run(
        "UPDATE content_items SET status = 'scheduled', last_error = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?",
        [`Attempt ${job.attempt_count} failed (${err.message}); retrying in ${Math.round(delay / 60)} min.`, job.workspace_id, content.id]
      );
      return { status: 'retry_scheduled', delay };
    }
    await finishAttempt(attempt.lastID, { outcome: 'failed', err });
    await failJob(job, 'failed', err, 'failed');
    await audit(workerCtx, 'social.publish.failed', { resourceType: 'publishing_job', resourceId: job.id, metadata: { code: err.code, message: err.message } });
    return { status: 'failed' };
  }
}

/**
 * Follows uploads the platform is still processing (Facebook and YouTube videos). Ready -> published;
 * processing failed -> failed (nothing is live, a retry uploads again); still processing after the
 * deadline -> needs_review for a person. Lookup errors leave the job processing for the next check.
 */
async function checkProcessingJobs(workerId, limit = 10) {
  const due = await all(
    `SELECT id FROM publishing_jobs WHERE status = 'processing' AND next_attempt_at <= UTC_TIMESTAMP() ORDER BY next_attempt_at ASC LIMIT ${Math.max(1, Math.min(50, limit))}`
  );
  const results = [];
  for (const { id } of due) {
    const claim = await run(
      `UPDATE publishing_jobs SET locked_by = ?, locked_at = UTC_TIMESTAMP(), next_attempt_at = UTC_TIMESTAMP() + INTERVAL ${PROCESSING_CHECK_SECONDS} SECOND
       WHERE id = ? AND status = 'processing' AND next_attempt_at <= UTC_TIMESTAMP()`,
      [workerId, id]
    );
    if (claim.changes !== 1) continue;
    const job = await get('SELECT * FROM publishing_jobs WHERE id = ?', [id]);
    results.push(await checkOne(job));
  }
  return results;
}

async function checkOne(job) {
  const workerCtx = { workspaceId: job.workspace_id, actorType: 'worker' };
  const content = await contentService.getRow(job.workspace_id, job.content_item_id);
  const account = await accountService.getAccountRow(job.workspace_id, job.social_account_id);
  let stored = {};
  try { stored = JSON.parse(job.provider_response_json || '{}') || {}; } catch (e) { stored = {}; }
  const started = stored.processingStartedAt ? new Date(stored.processingStartedAt).getTime() : Date.now();
  const adapter = account ? getAdapter(account.provider_key) : null;
  let check = { state: 'processing' };
  if (account && content && typeof adapter.checkProcessing === 'function') {
    try {
      check = await adapter.checkProcessing(account, await accountService.getUsableSecret(account), job.external_post_id);
    } catch (err) {
      if ((err.code === 'AUTH_EXPIRED' || err.code === 'PERMISSION_DENIED') && account.status === 'connected') await accountService.recordAccountFailure(account, err);
      check = { state: 'processing', note: `Could not check processing status: ${safeErrorMessage(err)}` };
    }
  }
  if (check.state === 'ready' && content) {
    await recordPublished(job, content, account, { externalId: job.external_post_id, url: check.url || job.external_url, raw: stored, note: check.note || null });
    return { id: job.id, status: 'succeeded' };
  }
  if (check.state === 'failed') {
    const message = `The platform could not process the upload (${check.reason || 'no reason given'}). It is not live; upload id ${job.external_post_id}. Retry to upload it again.`;
    await run(
      `UPDATE publishing_jobs SET status = 'failed', last_error_code = 'PROCESSING_FAILED', last_error = ?, external_post_id = NULL, external_url = NULL,
         locked_by = NULL, provider_response_json = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'processing'`,
      [message.slice(0, 2000), JSON.stringify({ ...stored, failedUploadId: job.external_post_id, note: check.note || null }).slice(0, 20000), job.id]
    );
    await run("UPDATE content_items SET status = 'failed', external_post_id = NULL, last_error = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?", [message.slice(0, 2000), job.workspace_id, job.content_item_id]);
    await audit(workerCtx, 'social.publish.processing_failed', { resourceType: 'publishing_job', resourceId: job.id, metadata: { reason: check.reason || null } });
    return { id: job.id, status: 'failed' };
  }
  if (Date.now() - started > PROCESSING_DEADLINE_HOURS * 3600 * 1000) {
    const message = `Still processing after ${PROCESSING_DEADLINE_HOURS} hours (upload id ${job.external_post_id}). Check the platform. If it is not there, delete any partial upload there and use Retry; if it is live, it will not be posted again.`;
    await run(
      "UPDATE publishing_jobs SET status = 'needs_review', last_error_code = 'PROCESSING_TIMEOUT', last_error = ?, locked_by = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'processing'",
      [message, job.id]
    );
    await run("UPDATE content_items SET status = 'failed', last_error = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?", [message, job.workspace_id, job.content_item_id]);
    await audit(workerCtx, 'social.publish.outcome_unknown', { resourceType: 'publishing_job', resourceId: job.id, metadata: { code: 'PROCESSING_TIMEOUT' } });
    return { id: job.id, status: 'needs_review' };
  }
  await run("UPDATE publishing_jobs SET locked_by = NULL, provider_response_json = ? WHERE id = ? AND status = 'processing'", [JSON.stringify({ ...stored, ...(check.note ? { note: check.note } : {}) }).slice(0, 20000), job.id]);
  return { id: job.id, status: 'processing' };
}

module.exports = {
  _heartbeatMs: 60 * 1000,
  checkProcessingJobs,
  assertMediaFilesPresent,
  idempotencyKey,
  presentJob,
  preflight,
  schedule,
  publishNow,
  cancelSchedule,
  listQueue,
  retryJob,
  cancelJob,
  claimDueJobs,
  recoverStaleJobs,
  executeJob,
  mediaForProvider,
  backoffSeconds
};
