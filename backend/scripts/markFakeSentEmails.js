/**
 * One-off, reversible correction for emails that the old "1-Click Dispatch" route recorded
 * as Sent/Delivered although nothing was sent (no provider message id, no sender).
 *
 *   node scripts/markFakeSentEmails.js            # dry run (default): shows the exact rows and changes
 *   node scripts/markFakeSentEmails.js --apply    # applies the correction in one transaction + audit entry
 *   node scripts/markFakeSentEmails.js --revert   # restores the values saved in the audit entry
 *
 * Only rows that still match every guard are touched; rows are never deleted.
 * DB_NAME selects the database (use a copy first).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { get, all, withTransaction, closeDatabase } = require('../db/database');

const TARGET_IDS = [3, 4, 5, 6, 7];
const EXPECTED = {
  workspace_id: 1,
  status: 'Sent',
  subjectPrefix: 'Cut order-entry delays by 80%',
  sentAt: '2026-10-20 07:43:41'
};
const NEW_STATUS = 'Not Sent';
const NEW_SMTP_STATUS = 'Not sent: recorded by old dispatch route';
const AUDIT_ACTION = 'mail.correction.fake_sent_marked';
const REVERT_ACTION = 'mail.correction.fake_sent_reverted';

const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--revert') ? 'revert' : 'dry-run';
const fmt = d => (d instanceof Date ? d.toISOString().replace('T', ' ').substring(0, 19) : d);

async function loadRows(q = all) {
  return q(
    `SELECT id, workspace_id, status, smtp_status, sender, sender_email, message_id, recipient_email, subject, sent_at, received_at
     FROM emails WHERE id IN (${TARGET_IDS.map(() => '?').join(',')}) ORDER BY id`,
    TARGET_IDS
  );
}

function guardFailures(r) {
  const fails = [];
  if (Number(r.workspace_id) !== EXPECTED.workspace_id) fails.push(`workspace_id=${r.workspace_id}`);
  if (r.status !== EXPECTED.status) fails.push(`status=${r.status}`);
  if (r.message_id) fails.push('has message_id (may have been really sent)');
  if (r.sender || r.sender_email) fails.push('has sender');
  if (!String(r.subject || '').startsWith(EXPECTED.subjectPrefix)) fails.push('subject differs');
  if (fmt(r.sent_at) !== EXPECTED.sentAt) fails.push(`sent_at=${fmt(r.sent_at)}`);
  return fails;
}

async function main() {
  console.log(`Database: ${process.env.DB_NAME || 'tradesage'} | mode: ${mode}`);

  if (mode === 'revert') {
    const entry = await get('SELECT id, metadata_json, created_at FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1', [AUDIT_ACTION]);
    if (!entry) { console.log('No correction audit entry found; nothing to revert.'); return; }
    const before = JSON.parse(entry.metadata_json).before;
    await withTransaction(async tx => {
      let restored = 0;
      for (const b of before) {
        const r = await tx.run('UPDATE emails SET status = ?, smtp_status = ? WHERE id = ? AND status = ? AND smtp_status = ?', [b.status, b.smtp_status, b.id, NEW_STATUS, NEW_SMTP_STATUS]);
        restored += r.changes;
      }
      await tx.run(
        "INSERT INTO audit_logs (workspace_id, actor_user_id, actor_type, action, resource_type, resource_id, metadata_json, created_at) VALUES (?, NULL, 'system', ?, 'email', NULL, ?, UTC_TIMESTAMP())",
        [EXPECTED.workspace_id, REVERT_ACTION, JSON.stringify({ revertedAuditId: entry.id, restored })]
      );
      console.log(`Restored ${restored} row(s) from audit entry #${entry.id}.`);
    });
    return;
  }

  const rows = await loadRows();
  const eligible = [];
  for (const r of rows) {
    const fails = guardFailures(r);
    console.log(`#${r.id} ws=${r.workspace_id} to=${r.recipient_email} status=${r.status} smtp_status=${r.smtp_status} sender=${r.sender || '∅'} message_id=${r.message_id || '∅'} sent_at=${fmt(r.sent_at)} subject="${String(r.subject).slice(0, 55)}"`);
    if (fails.length) console.log(`   SKIP: ${fails.join('; ')}`);
    else {
      eligible.push(r);
      console.log(`   CHANGE: status "${r.status}" -> "${NEW_STATUS}", smtp_status "${r.smtp_status}" -> "${NEW_SMTP_STATUS}" (all other columns unchanged)`);
    }
  }
  const missing = TARGET_IDS.filter(id => !rows.some(r => r.id === id));
  if (missing.length) console.log(`Not found: ${missing.join(', ')}`);
  console.log(`${eligible.length} of ${TARGET_IDS.length} row(s) eligible.`);
  if (mode !== 'apply' || !eligible.length) {
    if (mode !== 'apply') console.log('Dry run only: nothing was changed. Re-run with --apply to correct these rows.');
    return;
  }

  await withTransaction(async tx => {
    let changed = 0;
    for (const r of eligible) {
      // Re-checks the guards inside the update so a concurrent change is never overwritten.
      const res = await tx.run(
        `UPDATE emails SET status = ?, smtp_status = ?
         WHERE id = ? AND workspace_id = ? AND status = ? AND message_id IS NULL AND sender IS NULL AND sender_email IS NULL`,
        [NEW_STATUS, NEW_SMTP_STATUS, r.id, EXPECTED.workspace_id, EXPECTED.status]
      );
      changed += res.changes;
    }
    if (changed !== eligible.length) throw new Error(`Expected to change ${eligible.length} rows but changed ${changed}; rolled back.`);
    await tx.run(
      "INSERT INTO audit_logs (workspace_id, actor_user_id, actor_type, action, resource_type, resource_id, metadata_json, created_at) VALUES (?, NULL, 'system', ?, 'email', NULL, ?, UTC_TIMESTAMP())",
      [EXPECTED.workspace_id, AUDIT_ACTION, JSON.stringify({
        reason: 'Recorded as sent by the old /marketing/dispatch-campaign route without sending',
        before: eligible.map(r => ({ id: r.id, status: r.status, smtp_status: r.smtp_status })),
        after: { status: NEW_STATUS, smtp_status: NEW_SMTP_STATUS }
      })]
    );
    console.log(`Applied: ${changed} row(s) corrected; audit entry written (${AUDIT_ACTION}).`);
  });
}

main()
  .catch(err => { console.error('FAILED:', err.message); process.exitCode = 1; })
  .finally(() => closeDatabase());
