const { run, get, all, withTransaction } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { toDbDateTime, zonedLocalToUtc, isValidTimeZone } = require('../../lib/time');
const { getAdapter } = require('./providers');
const { canAccount, requiredPublishFeature, evaluateAccount, ACCOUNT_TYPES } = require('./capabilities');
const contentService = require('./contentService');
const accountService = require('./accountService');
const settingsService = require('./settingsService');

const STALE_LOCK_MINUTES = 10;
const { httpError } = contentService;

function idempotencyKey(content, accountId) {
  return `content:${content.id}:v${content.version}:account:${accountId}`;
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
    completedAt: row.completed_at,
    createdAt: row.created_at
  };
}

/** Everything that must hold before a post may be queued or sent. Throws a 4xx with a clear reason. */
async function preflight(workspaceId, contentRow, accountRow) {
  if (!accountRow) throw httpError(400, 'Choose a connected social account to publish to.');
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
  if (!(await contentService.hasValidApproval(workspaceId, contentRow))) {
    throw httpError(409, 'This version of the content has not been approved.', 'APPROVAL_REQUIRED');
  }
  return { content, assets, feature };
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
  const running = await get("SELECT id FROM publishing_jobs WHERE workspace_id = ? AND content_item_id = ? AND status = 'running'", [workspaceId, contentId]);
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
     ORDER BY FIELD(j.status, 'needs_review', 'failed', 'running', 'queued', 'succeeded', 'cancelled'), j.scheduled_for ASC
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
  await run(
    `UPDATE publishing_jobs SET status = 'queued', next_attempt_at = UTC_TIMESTAMP(), max_attempts = attempt_count + 3,
       last_error = NULL, last_error_code = NULL, locked_by = NULL, locked_at = NULL, updated_at = UTC_TIMESTAMP()
     WHERE workspace_id = ? AND id = ? AND status IN ('failed', 'needs_review')`,
    [workspaceId, jobId]
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
  if (retryAfterSec) return Math.min(retryAfterSec, 6 * 3600);
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
    [status, err?.code || 'ERROR', String(err?.message || err).slice(0, 2000), job.id]
  );
  if (contentStatus) {
    await run(
      'UPDATE content_items SET status = ?, last_error = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?',
      [contentStatus, contentMessage || String(err?.message || err).slice(0, 2000), job.workspace_id, job.content_item_id]
    );
  }
}

/** Executes one claimed job end to end. Content is marked published only on provider confirmation. */
async function executeJob(job, workerId) {
  const workerCtx = { workspaceId: job.workspace_id, actorType: 'worker' };
  const content = await contentService.getRow(job.workspace_id, job.content_item_id);
  const account = await accountService.getAccountRow(job.workspace_id, job.social_account_id);

  if (!content || content.version !== job.content_version || !['scheduled', 'publishing'].includes(content.status)) {
    await run("UPDATE publishing_jobs SET status = 'cancelled', last_error = 'Content changed or was unscheduled before publishing', locked_by = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?", [job.id]);
    return { status: 'cancelled' };
  }
  if (job.external_post_id) {
    // Already confirmed by the provider in an earlier attempt; never post twice.
    await run("UPDATE publishing_jobs SET status = 'succeeded', locked_by = NULL, completed_at = COALESCE(completed_at, UTC_TIMESTAMP()) WHERE id = ?", [job.id]);
    return { status: 'succeeded' };
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
    const result = await adapter.publish(account, secret, {
      text: contentService.composeText(prepared.content),
      title: prepared.content.title,
      linkUrl: prepared.content.linkUrl,
      imageUrls: prepared.assets.filter(a => a.asset_type === 'image').map(a => a.public_url),
      videoUrls: prepared.assets.filter(a => a.asset_type === 'video').map(a => a.public_url)
    });
    await withTransaction(async (tx) => {
      await tx.run(
        `UPDATE publishing_jobs SET status = 'succeeded', external_post_id = ?, external_url = ?, provider_response_json = ?,
           locked_by = NULL, completed_at = UTC_TIMESTAMP(), last_error = NULL, last_error_code = NULL, updated_at = UTC_TIMESTAMP()
         WHERE id = ?`,
        [result.externalId, result.url || null, JSON.stringify(result.raw || {}).slice(0, 20000), job.id]
      );
      await tx.run(
        `UPDATE content_items SET status = 'published', published_at = UTC_TIMESTAMP(), external_post_id = ?, external_url = ?, last_error = NULL, updated_at = UTC_TIMESTAMP()
         WHERE workspace_id = ? AND id = ?`,
        [result.externalId, result.url || null, job.workspace_id, content.id]
      );
    });
    await finishAttempt(attempt.lastID, { outcome: 'succeeded', response: result.raw });
    await accountService.recordAccountSuccess(account);
    await audit(workerCtx, 'social.publish.succeeded', {
      resourceType: 'content',
      resourceId: content.id,
      metadata: { jobId: job.id, provider: account.provider_key, externalPostId: result.externalId }
    });
    return { status: 'succeeded', externalId: result.externalId };
  } catch (err) {
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

module.exports = {
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
  backoffSeconds
};
