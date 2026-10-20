const { run, get } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { isValidTimeZone } = require('../../lib/time');

const DEFAULTS = {
  timezone: 'UTC',
  requireApproval: true,
  autoReplyEnabled: false,
  defaultHashtags: '',
  analyticsPollMinutes: 360,
  inboxPollMinutes: 30
};

function present(row) {
  if (!row) return { ...DEFAULTS };
  return {
    timezone: row.timezone,
    requireApproval: !!row.require_approval,
    autoReplyEnabled: !!row.auto_reply_enabled,
    defaultHashtags: row.default_hashtags || '',
    analyticsPollMinutes: row.analytics_poll_minutes,
    inboxPollMinutes: row.inbox_poll_minutes
  };
}

async function getSettings(workspaceId) {
  const row = await get('SELECT * FROM social_settings WHERE workspace_id = ?', [workspaceId]);
  if (row) return present(row);
  const ws = await get('SELECT timezone FROM workspaces WHERE id = ?', [workspaceId]);
  return { ...DEFAULTS, timezone: ws?.timezone && isValidTimeZone(ws.timezone) ? ws.timezone : 'UTC' };
}

async function updateSettings(ctx, input) {
  const current = await getSettings(ctx.auth.workspaceId);
  const next = { ...current };
  if (input.timezone !== undefined) {
    if (!isValidTimeZone(input.timezone)) {
      const err = new Error(`Unknown time zone: ${input.timezone}`);
      err.status = 400;
      throw err;
    }
    next.timezone = input.timezone;
  }
  if (input.requireApproval !== undefined) next.requireApproval = !!input.requireApproval;
  if (input.defaultHashtags !== undefined) next.defaultHashtags = String(input.defaultHashtags).slice(0, 500);
  if (input.analyticsPollMinutes !== undefined) next.analyticsPollMinutes = Math.min(Math.max(parseInt(input.analyticsPollMinutes, 10) || 360, 60), 1440);
  if (input.inboxPollMinutes !== undefined) next.inboxPollMinutes = Math.min(Math.max(parseInt(input.inboxPollMinutes, 10) || 30, 15), 1440);
  // Automatic AI replies are not offered in this release; the flag stays off.
  next.autoReplyEnabled = false;

  await run(
    `INSERT INTO social_settings (workspace_id, timezone, require_approval, auto_reply_enabled, default_hashtags, analytics_poll_minutes, inbox_poll_minutes, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE timezone = VALUES(timezone), require_approval = VALUES(require_approval), auto_reply_enabled = 0,
       default_hashtags = VALUES(default_hashtags), analytics_poll_minutes = VALUES(analytics_poll_minutes),
       inbox_poll_minutes = VALUES(inbox_poll_minutes), updated_at = UTC_TIMESTAMP()`,
    [ctx.auth.workspaceId, next.timezone, next.requireApproval ? 1 : 0, next.defaultHashtags, next.analyticsPollMinutes, next.inboxPollMinutes]
  );
  await audit(ctx, 'social.settings.updated', { resourceType: 'social_settings', metadata: { before: current, after: next } });
  return next;
}

module.exports = { getSettings, updateSettings, DEFAULTS };
