/**
 * Grants or removes access to the global CRM. Run on the server by an administrator.
 *
 *   npm run crm-access -- grant someone@company.com manager
 *   npm run crm-access -- revoke someone@company.com
 *   npm run crm-access -- list
 *
 * Roles: viewer (read only), sales (contacts, companies, deals), support (contacts, companies,
 * tickets), manager (everything). A workspace role never grants CRM access, with one exception:
 * the Owner of workspace 1 is the platform admin and always has full access, with no grant.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { get, all, closeDatabase } = require('../db/database');
const { audit } = require('../lib/audit');
const { CRM_ROLES, grant, revoke } = require('../modules/crm/crmAccess');

const USAGE = `Usage: npm run crm-access -- grant <email> <${Object.keys(CRM_ROLES).join('|')}> | revoke <email> | list`;

async function findUser(raw) {
  const email = String(raw || '').toLowerCase().trim();
  if (!email) throw new Error(USAGE);
  const user = await get('SELECT id, email FROM users WHERE email = ?', [email]);
  if (!user) throw new Error(`No user with the email ${email}.`);
  return user;
}

const systemActor = { workspaceId: null, userId: null, actorType: 'system' };

async function main() {
  const [command, email, role] = process.argv.slice(2);
  if (command === 'list') {
    const rows = await all('SELECT u.email, a.role FROM crm_user_access a JOIN users u ON u.id = a.user_id ORDER BY u.email');
    console.log(rows.length ? rows.map(r => `${r.email}  ${r.role}`).join('\n') : 'No grants yet. The platform admin (Owner of workspace 1) has access without one.');
  } else if (command === 'grant') {
    const user = await findUser(email);
    await grant(user.id, role);
    await audit(systemActor, 'crm.access_granted', { resourceType: 'user', resourceId: user.id, metadata: { role } });
    console.log(`${user.email} now has CRM access as ${role}.`);
  } else if (command === 'revoke') {
    const user = await findUser(email);
    const removed = await revoke(user.id);
    if (removed) await audit(systemActor, 'crm.access_revoked', { resourceType: 'user', resourceId: user.id });
    console.log(removed ? `${user.email} no longer has CRM access.` : `${user.email} had no CRM access.`);
  } else {
    throw new Error(USAGE);
  }
}

main()
  .catch(err => { console.error(err.message); process.exitCode = 1; })
  .finally(() => closeDatabase());
