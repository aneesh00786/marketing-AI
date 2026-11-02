const { get } = require('../db/database');
const { LEGACY_WORKSPACE_ID } = require('../middleware/auth');

/**
 * The platform admin is the Owner of the platform's own workspace (LEGACY_WORKSPACE_ID,
 * admin@tradesage.ai). It is that one workspace and not an email address, because registering does
 * not prove an address is yours; a new account always gets a new workspace, so it can never become
 * this Owner. Other Workspace Owners have no platform rights.
 */
const isPlatformAdminSql = alias => `EXISTS (SELECT 1 FROM workspace_members m
  WHERE m.user_id = ${alias}.id AND m.workspace_id = ${Number(LEGACY_WORKSPACE_ID)} AND m.role = 'Workspace Owner' AND m.status = 'Active')`;

async function isPlatformAdmin(userId) {
  if (!userId) return false;
  return !!(await get(`SELECT 1 AS x FROM users u WHERE u.id = ? AND u.status = 'Active' AND ${isPlatformAdminSql('u')}`, [userId]));
}

module.exports = { isPlatformAdmin, isPlatformAdminSql };
