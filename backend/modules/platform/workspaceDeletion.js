const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { run, get, all, withTransaction } = require('../../db/database');
const { audit } = require('../../lib/audit');

/**
 * Deleting a workspace (platform admin only, see routes.js).
 *
 * Delete: the workspace closes at once. Nobody can sign in to it or open it (middleware/auth.js),
 * background work for it is not picked up (lib/workspaceStatus.js), and what was waiting to run is
 * stopped so it never runs late after a restore: scheduled social posts and queued jobs are
 * cancelled, running outreach and product email batches are paused, waiting automation steps end.
 * The data is kept for RESTORE_DAYS so it can be restored.
 *
 * Erase (worker, after RESTORE_DAYS): every row of the workspace in every table with a
 * workspace_id is deleted, and its uploaded files. The audit log is kept (who did what, incl. the
 * deletion), and the workspace row stays as a record with status 'Purged'. Accounts of the people
 * who were in it are not deleted (they may belong to other workspaces).
 */
const RESTORE_DAYS = 30;
const STOPPED = 'The workspace was deleted.';
const KEEP_TABLES = new Set(['audit_logs']);

function httpError(status, message, code = 'BAD_REQUEST') {
  return Object.assign(new Error(message), { status, code, expose: true });
}
const auditIn = (ctx, workspaceId, action, opts) => audit({ auth: { ...ctx.auth, workspaceId }, requestId: ctx.requestId, ip: ctx.ip }, action, opts);

const deleteSchema = z.object({
  confirmName: z.string().trim().min(1, 'Type the workspace name to confirm.').max(100),
  reason: z.string().trim().max(500).optional().nullable()
}).strict();

async function requireRow(rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid workspace id.', 'VALIDATION_ERROR');
  const row = await get('SELECT * FROM workspaces WHERE id = ?', [id]);
  if (!row) throw httpError(404, 'Workspace not found.', 'NOT_FOUND');
  return row;
}

async function deleteWorkspace(ctx, rawId, input) {
  const { LEGACY_WORKSPACE_ID } = require('../../middleware/auth');
  const row = await requireRow(rawId);
  const v = deleteSchema.parse(input || {});
  if (row.id === LEGACY_WORKSPACE_ID) throw httpError(403, 'The platform workspace cannot be deleted.', 'PROTECTED_WORKSPACE');
  if (row.status && row.status !== 'Active') throw httpError(409, 'This workspace is already deleted.', 'ALREADY_DELETED');
  if (row.id === ctx.auth.workspaceId) throw httpError(409, 'You are signed in to this workspace. Switch to another workspace first, then delete it.', 'CURRENT_WORKSPACE');
  if (v.confirmName.toLowerCase() !== String(row.name).trim().toLowerCase()) throw httpError(400, 'The name you typed does not match the workspace name.', 'CONFIRMATION_MISMATCH');

  const stopped = await withTransaction(async tx => {
    const changed = await tx.run(`UPDATE workspaces SET status = 'Deleted', deleted_at = UTC_TIMESTAMP(), deleted_by = ?, delete_reason = ?,
      purge_after = UTC_TIMESTAMP() + INTERVAL ${RESTORE_DAYS} DAY WHERE id = ? AND (status IS NULL OR status = 'Active')`, [ctx.auth.userId, v.reason || null, row.id]);
    if (changed.changes !== 1) throw httpError(409, 'This workspace is already deleted.', 'ALREADY_DELETED');
    const n = async (sql) => (await tx.run(sql, [row.id])).changes;
    return {
      scheduledPosts: await n(`UPDATE publishing_jobs SET status = 'cancelled', last_error = '${STOPPED}', locked_by = NULL, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND status = 'queued'`),
      jobs: await n(`UPDATE background_jobs SET status = 'failed', last_error = '${STOPPED}', completed_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND status = 'queued'`),
      outreachCampaigns: await n("UPDATE outreach_campaigns SET status = 'paused', updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND status = 'running'"),
      emailBatches: await n(`UPDATE mail_draft_batches SET status = 'paused', last_error = '${STOPPED}', locked_by = NULL, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND status IN ('queued', 'sending')`),
      automationRuns: await n(`UPDATE automation_runs SET status = 'failed', exit_reason = 'workspace_deleted', last_error = '${STOPPED}', locked_by = NULL, finished_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND status = 'waiting'`)
    };
  });
  await auditIn(ctx, row.id, 'platform.workspace_deleted', { resourceType: 'workspace', resourceId: row.id, metadata: { name: row.name, reason: v.reason || null, stopped } });
  const fresh = await get('SELECT purge_after FROM workspaces WHERE id = ?', [row.id]);
  return { deleted: true, purgeAfter: fresh.purge_after, restoreDays: RESTORE_DAYS, stopped };
}

async function restoreWorkspace(ctx, rawId) {
  const row = await requireRow(rawId);
  if (row.status === 'Purged') throw httpError(410, 'This workspace was erased and cannot be restored.', 'PURGED');
  if (row.status !== 'Deleted') throw httpError(409, 'This workspace is not deleted.', 'NOT_DELETED');
  const changed = await run(`UPDATE workspaces SET status = 'Active', deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, purge_after = NULL
    WHERE id = ? AND status = 'Deleted' AND purged_at IS NULL`, [row.id]);
  if (changed.changes !== 1) throw httpError(409, 'This workspace could not be restored. Reload and try again.', 'NOT_DELETED');
  await auditIn(ctx, row.id, 'platform.workspace_restored', { resourceType: 'workspace', resourceId: row.id, metadata: { deletedAt: row.deleted_at } });
  return { restored: true, note: 'Members can sign in again. Social posts that were scheduled, paused outreach and email batches, and automations that were waiting need to be scheduled or resumed again.' };
}

// ------------------------------------------------------------------ erase after the restore period

const removeDir = dir => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => null);

/**
 * Deletes a workspace's rows from these tables (workspace_id = ?), in chunks. A table whose rows are
 * still referenced by another table's rows is retried after the others. Returns the rows deleted.
 */
async function deleteRows(workspaceId, tableList) {
  let tables = [...new Set(tableList)];
  let rows = 0;
  for (let pass = 0; pass < 6 && tables.length; pass++) {
    const blocked = [];
    for (const t of tables) {
      try {
        for (;;) {
          const r = await run(`DELETE FROM \`${t}\` WHERE workspace_id = ? LIMIT 5000`, [workspaceId]);
          rows += r.changes;
          if (r.changes < 5000) break;
        }
      } catch (err) {
        if (err.errno === 1451 || err.code === 'ER_ROW_IS_REFERENCED_2') blocked.push(t); else throw err;
      }
    }
    tables = blocked;
  }
  if (tables.length) throw new Error(`Could not delete the data of workspace ${workspaceId}: still referenced (${tables.join(', ')}).`);
  return rows;
}

/** Erases one deleted workspace's data. Rows referenced by others are retried in a later pass. */
async function eraseWorkspace(workspaceId) {
  const row = await get('SELECT id, status FROM workspaces WHERE id = ?', [workspaceId]);
  if (!row || row.status !== 'Deleted') return { erased: false };
  // Call logs are global CRM records: they keep the call, not the link to this workspace's campaign.
  await run('UPDATE crm_call_logs SET campaign_id = NULL, email = NULL WHERE campaign_id IN (SELECT id FROM mail_campaigns WHERE workspace_id = ?)', [workspaceId]).catch(() => null);
  const tables = (await all(`SELECT c.TABLE_NAME AS t FROM information_schema.COLUMNS c JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME
    WHERE c.TABLE_SCHEMA = DATABASE() AND c.COLUMN_NAME = 'workspace_id' AND tb.TABLE_TYPE = 'BASE TABLE'`)).map(r => r.t).filter(t => !KEEP_TABLES.has(t));
  const rows = await deleteRows(workspaceId, tables);
  await removeDir(path.join(require('../social/mediaStore').storageRoot(), String(workspaceId)));
  await removeDir(path.join(require('../mail/templates/assetStore').storageRoot(), String(workspaceId)));
  await run("UPDATE workspaces SET status = 'Purged', purged_at = UTC_TIMESTAMP() WHERE id = ?", [workspaceId]);
  await audit({ auth: { workspaceId, actorType: 'worker' } }, 'platform.workspace_purged', { resourceType: 'workspace', resourceId: workspaceId, metadata: { rows } });
  return { erased: true, rows };
}

/** Worker: erases workspaces whose restore period is over. */
async function purgeDue(limit = 2) {
  const due = await all(`SELECT id FROM workspaces WHERE status = 'Deleted' AND purge_after <= UTC_TIMESTAMP() ORDER BY purge_after LIMIT ${Math.max(1, Math.min(10, limit))}`);
  const out = [];
  for (const w of due) out.push({ id: w.id, ...(await eraseWorkspace(w.id)) });
  return out;
}

module.exports = { deleteWorkspace, restoreWorkspace, eraseWorkspace, purgeDue, deleteRows, removeDir, RESTORE_DAYS };
