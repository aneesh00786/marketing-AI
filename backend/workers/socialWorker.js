/**
 * TradeSage social worker: publishes scheduled posts and runs background jobs.
 *
 *   npm run worker
 *
 * All state lives in MySQL (publishing_jobs, background_jobs), so the worker can be
 * restarted at any time. Several workers may run; jobs are claimed atomically.
 */
const path = require('path');
const os = require('os');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { all, closeDatabase } = require('../db/database');
const publishingService = require('../modules/social/publishingService');
const jobsService = require('../modules/social/jobsService');
const campaignService = require('../modules/social/campaignService');
const analyticsService = require('../modules/social/analyticsService');
const inboxService = require('../modules/social/inboxService');
const accountService = require('../modules/social/accountService');
const outreachSender = require('../modules/outreach/outreachSender');
const automationEngine = require('../modules/automation/automationEngine');
const budgetService = require('../modules/budget/budgetService');

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const POLL_MS = parseInt(process.env.SOCIAL_WORKER_POLL_MS || '5000', 10);
const SCHEDULER_MS = 60 * 1000;

const HANDLERS = {
  generate_campaign: job => campaignService.runGeneration(job),
  sync_analytics: job => analyticsService.syncAccountAnalytics(job),
  sync_inbox: job => inboxService.syncAccountInbox(job),
  check_account: async job => {
    const { accountId } = JSON.parse(job.payload_json || '{}');
    return accountService.checkAccountHealth({ auth: { workspaceId: job.workspace_id, actorType: 'worker' } }, accountId);
  }
};

let stopping = false;
const log = (...args) => console.log(new Date().toISOString(), '[social-worker]', ...args);

async function processPublishing() {
  const jobs = await publishingService.claimDueJobs(WORKER_ID, 5);
  for (const job of jobs) {
    try {
      const result = await publishingService.executeJob(job, WORKER_ID);
      log(`publishing job ${job.id} -> ${result.status}`);
    } catch (err) {
      // Unexpected internal error: outcome may be unknown, so never auto-retry.
      log(`publishing job ${job.id} crashed:`, err.message);
      await require('../db/database').run(
        "UPDATE publishing_jobs SET status = 'needs_review', last_error_code = 'WORKER_ERROR', last_error = ?, locked_by = NULL WHERE id = ? AND status = 'running'",
        [String(err.message).slice(0, 2000), job.id]
      );
    }
  }
  return jobs.length;
}

async function processBackground() {
  const jobs = await jobsService.claimDue(WORKER_ID, 3);
  for (const job of jobs) {
    const handler = HANDLERS[job.job_type];
    if (!handler) {
      await jobsService.fail({ ...job, max_attempts: 0 }, new Error(`Unknown job type ${job.job_type}`));
      continue;
    }
    try {
      const result = await handler(job);
      await jobsService.complete(job.id, result);
      log(`${job.job_type} job ${job.id} completed`);
    } catch (err) {
      const retry = await jobsService.fail(job, err);
      log(`${job.job_type} job ${job.id} failed (${retry ? 'will retry' : 'final'}):`, err.message);
    }
  }
  return jobs.length;
}

/** Email outreach campaigns: sends due sequence emails inside each campaign's window and limits. */
async function processOutreach() {
  try {
    return await outreachSender.processOutreach(WORKER_ID);
  } catch (err) {
    log('outreach error:', err.message);
    return 0;
  }
}

/**
 * Product email batches: send queued emails (resumable, one claim per email) and apply
 * unsubscribe replies (the inbox sync is shared with outreach and rate-limited per workspace).
 */
async function processProductEmails() {
  const productEmails = require('../modules/mail/productEmails/service');
  try {
    const watched = await productEmails.monitoredWorkspaces();
    if (watched.length) {
      await outreachSender.syncInboxes(watched);
      await productEmails.detectUnsubscribeReplies();
    }
    return await productEmails.processBatches(WORKER_ID);
  } catch (err) {
    log('product email error:', err.message);
    return 0;
  }
}

/** Automation workflows: match recorded events to active workflows, then run due steps. */
async function processAutomation() {
  try {
    return await automationEngine.processAutomation(WORKER_ID);
  } catch (err) {
    log('automation error:', err.message);
    return 0;
  }
}

/** Campaign budgets: sync provider spend (every 6 hours) and evaluate pacing alerts. */
async function processBudgets() {
  try {
    await budgetService.processBudgets();
  } catch (err) {
    log('budget error:', err.message);
  }
}

/** Enqueues periodic syncs per account, using time buckets as idempotency keys. */
async function scheduleRecurring() {
  const accounts = await all(
    `SELECT a.id, a.workspace_id, COALESCE(s.analytics_poll_minutes, 360) AS analytics_minutes, COALESCE(s.inbox_poll_minutes, 30) AS inbox_minutes
     FROM social_accounts a LEFT JOIN social_settings s ON s.workspace_id = a.workspace_id
     WHERE a.status = 'connected' AND a.external_account_id NOT LIKE 'demo\\_%'`
  );
  const now = Date.now();
  for (const a of accounts) {
    const aBucket = Math.floor(now / (a.analytics_minutes * 60000));
    const iBucket = Math.floor(now / (a.inbox_minutes * 60000));
    const hBucket = Math.floor(now / (12 * 3600000));
    await jobsService.enqueue(a.workspace_id, 'sync_analytics', { accountId: a.id }, { idempotencyKey: `auto_analytics:${a.id}:${aBucket}` });
    await jobsService.enqueue(a.workspace_id, 'sync_inbox', { accountId: a.id }, { idempotencyKey: `auto_inbox:${a.id}:${iBucket}` });
    await jobsService.enqueue(a.workspace_id, 'check_account', { accountId: a.id }, { idempotencyKey: `auto_health:${a.id}:${hBucket}`, maxAttempts: 1 });
  }
  const stalePublishing = await publishingService.recoverStaleJobs();
  const staleBackground = await jobsService.recoverStale();
  if (stalePublishing || staleBackground) log(`recovered stale jobs: publishing=${stalePublishing} background=${staleBackground}`);
}

async function loop() {
  let lastSchedule = 0;
  log(`started (poll ${POLL_MS}ms)`);
  while (!stopping) {
    try {
      if (Date.now() - lastSchedule > SCHEDULER_MS) {
        await scheduleRecurring();
        await processBudgets();
        lastSchedule = Date.now();
      }
      const worked = (await processPublishing()) + (await processBackground()) + (await processOutreach()) + (await processProductEmails()) + (await processAutomation());
      if (worked > 0) continue;
    } catch (err) {
      log('loop error:', err.message);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  log('stopped');
  await closeDatabase();
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  log('shutting down after the current job...');
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) {
  loop().then(() => process.exit(0));
}

module.exports = { processPublishing, processBackground, processOutreach, processProductEmails, processAutomation, scheduleRecurring, HANDLERS };
