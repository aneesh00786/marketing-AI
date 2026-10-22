const { get } = require('../db/database');
const { capabilitiesForRole } = require('./permissions');

/**
 * Re-checks, immediately before a background job acts, that the work is still authorized:
 * the workspace is Active, and the person who scheduled/approved it is still an Active member
 * (with an Active account) who holds the capability the action needs. Jobs without a recorded
 * scheduler are refused, never run anonymously.
 *
 * Returns null when authorized, otherwise { code, message } safe to store and show.
 */
async function workerAuthorizationProblem(workspaceId, userId, capability) {
  const ws = await get('SELECT status FROM workspaces WHERE id = ?', [workspaceId]);
  if (!ws || ws.status !== 'Active') {
    return { code: 'WORKSPACE_INACTIVE', message: 'The workspace is not active.' };
  }
  if (!userId) {
    return { code: 'SCHEDULER_UNKNOWN', message: 'No scheduling user is recorded for this job; a current member must schedule or approve it again.' };
  }
  const m = await get(
    'SELECT m.role, m.status, u.status AS user_status FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ?',
    [workspaceId, userId]
  );
  if (!m || m.status !== 'Active' || (m.user_status && m.user_status !== 'Active')) {
    return { code: 'SCHEDULER_NOT_MEMBER', message: 'The person who scheduled this is no longer an active member of the workspace; a current member must schedule or approve it again.' };
  }
  if (capability && !capabilitiesForRole(m.role).has(capability)) {
    return { code: 'SCHEDULER_NOT_AUTHORIZED', message: `The person who scheduled this no longer has permission (${capability}); someone who does must schedule or approve it again.` };
  }
  return null;
}

module.exports = { workerAuthorizationProblem };
