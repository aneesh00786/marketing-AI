const { get, run } = require('../db/database');
const { isPlatformAdmin } = require('./platformAdmin');

/**
 * Who may make calls (the 📞 button) through the company's Telnyx account: the platform admin,
 * anyone given "Make calls" (Members → Permissions; platform admin only), and, as before, anyone
 * with CRM "manage" access. Read on every request, so removing it takes effect at once.
 */
async function hasCallingGrant(userId) {
  if (!userId) return false;
  return !!(await get('SELECT 1 AS x FROM user_calling_access WHERE user_id = ?', [userId]).catch(() => null));
}

async function canCall(userId) {
  if (!userId) return false;
  if (await isPlatformAdmin(userId)) return true;
  if (await hasCallingGrant(userId)) return true;
  const crm = await require('../modules/crm/crmAccess').accessFor(userId);
  return !!crm?.capabilities.includes('crm.manage');
}

async function setCalling(userId, enabled, grantedBy = null) {
  if (enabled) await run('INSERT IGNORE INTO user_calling_access (user_id, granted_by, created_at) VALUES (?, ?, UTC_TIMESTAMP())', [userId, grantedBy]);
  else await run('DELETE FROM user_calling_access WHERE user_id = ?', [userId]);
}

module.exports = { canCall, hasCallingGrant, setCalling };
