const { run, get, all } = require('../../db/database');
const { toDbDateTime } = require('../../lib/time');

/**
 * Durable background jobs (DB-backed queue) for AI generation and provider syncs.
 * These jobs have no externally visible side effects, so a crashed run may be re-queued.
 */
const STALE_MINUTES = 15;

async function enqueue(workspaceId, jobType, payload, { idempotencyKey = null, runAt = new Date(), createdBy = null, maxAttempts = 3 } = {}) {
  if (idempotencyKey) {
    const existing = await get('SELECT * FROM background_jobs WHERE workspace_id = ? AND idempotency_key = ?', [workspaceId, idempotencyKey]);
    if (existing) return { job: existing, created: false };
  }
  try {
    const ins = await run(
      `INSERT INTO background_jobs (workspace_id, job_type, payload_json, idempotency_key, status, run_at, max_attempts, created_by, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, UTC_TIMESTAMP())`,
      [workspaceId, jobType, JSON.stringify(payload || {}), idempotencyKey, toDbDateTime(runAt), maxAttempts, createdBy]
    );
    return { job: await get('SELECT * FROM background_jobs WHERE id = ?', [ins.lastID]), created: true };
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' && idempotencyKey) {
      return { job: await get('SELECT * FROM background_jobs WHERE workspace_id = ? AND idempotency_key = ?', [workspaceId, idempotencyKey]), created: false };
    }
    throw err;
  }
}

async function claimDue(workerId, limit = 3) {
  const due = await all(
    `SELECT id FROM background_jobs WHERE status = 'queued' AND run_at <= UTC_TIMESTAMP() ORDER BY run_at ASC LIMIT ${Math.max(1, Math.min(20, limit))}`
  );
  const claimed = [];
  for (const { id } of due) {
    const res = await run(
      `UPDATE background_jobs SET status = 'running', locked_by = ?, locked_at = UTC_TIMESTAMP(), attempt_count = attempt_count + 1
       WHERE id = ? AND status = 'queued'`,
      [workerId, id]
    );
    if (res.changes === 1) claimed.push(await get('SELECT * FROM background_jobs WHERE id = ?', [id]));
  }
  return claimed;
}

async function complete(jobId, result) {
  await run(
    "UPDATE background_jobs SET status = 'succeeded', result_json = ?, locked_by = NULL, completed_at = UTC_TIMESTAMP(), last_error = NULL WHERE id = ?",
    [JSON.stringify(result || {}).slice(0, 20000), jobId]
  );
}

async function fail(job, err) {
  const retry = (err?.retryable !== false) && job.attempt_count < job.max_attempts && err?.code !== 'QUOTA_EXCEEDED';
  const delay = Math.min(60 * Math.pow(2, job.attempt_count), 3600);
  await run(
    `UPDATE background_jobs SET status = ?, last_error = ?, locked_by = NULL,
       run_at = IF(? = 'queued', UTC_TIMESTAMP() + INTERVAL ? SECOND, run_at), completed_at = IF(? = 'failed', UTC_TIMESTAMP(), NULL)
     WHERE id = ?`,
    [retry ? 'queued' : 'failed', String(err?.message || err).slice(0, 2000), retry ? 'queued' : 'failed', delay, retry ? 'queued' : 'failed', job.id]
  );
  return retry;
}

async function recoverStale() {
  const res = await run(
    `UPDATE background_jobs SET status = IF(attempt_count < max_attempts, 'queued', 'failed'), locked_by = NULL,
       last_error = 'Worker stopped while running this job'
     WHERE status = 'running' AND locked_at < UTC_TIMESTAMP() - INTERVAL ${STALE_MINUTES} MINUTE`
  );
  return res.changes;
}

async function getJob(workspaceId, jobId) {
  return get('SELECT id, job_type, status, attempt_count, last_error, result_json, created_at, completed_at FROM background_jobs WHERE workspace_id = ? AND id = ?', [workspaceId, jobId]);
}

module.exports = { enqueue, claimDue, complete, fail, recoverStale, getJob };
