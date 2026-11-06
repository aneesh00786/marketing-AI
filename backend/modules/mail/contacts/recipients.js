const { get, all } = require('../../../db/database');
const consent = require('./consent');

/**
 * Who in a contact list may get a campaign, once each: subscribed in the list, not on the
 * stop-list (unsubscribed, bounced, complaint), and with marketing consent (consent.js).
 */
async function reachable(workspaceId, listId) {
  return all(
    `SELECT DISTINCT c.id, c.email, c.first_name, c.last_name, c.company, c.source
     FROM mail_list_members m JOIN mail_contacts c ON c.id = m.contact_id
     LEFT JOIN email_suppressions s ON s.workspace_id = c.workspace_id AND s.email = c.email
     WHERE m.list_id = ? AND c.workspace_id = ? AND m.status = 'subscribed' AND s.email IS NULL AND ${consent.eligibleSql('c')}
     ORDER BY c.id`, [listId, workspaceId]);
}

/** How many subscribed, not stopped people in a list are left out for lack of marketing consent. */
async function withoutConsent(workspaceId, listId) {
  const r = await get(
    `SELECT COUNT(DISTINCT c.id) AS n FROM mail_list_members m JOIN mail_contacts c ON c.id = m.contact_id
     LEFT JOIN email_suppressions s ON s.workspace_id = c.workspace_id AND s.email = c.email
     WHERE m.list_id = ? AND c.workspace_id = ? AND m.status = 'subscribed' AND s.email IS NULL AND NOT ${consent.eligibleSql('c')}`, [listId, workspaceId]);
  return Number(r?.n) || 0;
}

module.exports = { reachable, withoutConsent };
