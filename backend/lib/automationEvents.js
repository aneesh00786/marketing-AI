const { run } = require('../db/database');

/**
 * Records a domain event for automation workflows. Existing modules call this after their
 * own work succeeded; it never throws, so automation can never break a lead update, a send
 * or a publish. The idempotency key makes repeated calls for the same event harmless.
 *
 * Event types: lead.created, lead.status_changed, email.replied, email.unsubscribed,
 * email.sequence_completed, social.post_published.
 */
async function emit(workspaceId, eventType, { subjectType, subjectId, payload = {}, key }) {
  if (!workspaceId || !subjectId || !key) return;
  try {
    await run(
      'INSERT IGNORE INTO automation_events (workspace_id, event_type, subject_type, subject_id, payload_json, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, \'pending\', UTC_TIMESTAMP())',
      [workspaceId, eventType, subjectType, subjectId, JSON.stringify(payload).slice(0, 4000), String(key).slice(0, 191)]
    );
  } catch (err) {
    // The automation tables may not exist yet (migration pending); the caller's work is unaffected.
    if (process.env.NODE_ENV !== 'test') console.warn('[automation] event not recorded:', err.message);
  }
}

module.exports = { emit };
