/**
 * Mail Center tabs a member may open, on top of Mail Center section access (lib/moduleAccess.js).
 *
 * Only these tabs can be limited: Inbox, Campaigns, Deliverability, Email Templates and Logs. Owners and
 * Admins always have all of them; for others workspace_members.mail_tabs_json lists the allowed tabs
 * (NULL = all, so existing members keep their access).
 *
 * Enforced on the server: each tab's API is refused (403 MAIL_TAB_REQUIRED) without the tab. Email
 * templates stay usable everywhere (Compose and Campaigns pick them); only managing them needs the tab.
 */
const TABS = [
  { key: 'inbox', label: 'Inbox', description: 'Email received by the company mailbox.',
    paths: [/^\/api\/(v1\/)?emails\/inbox(\/unread)?$/, /^\/api\/(v1\/)?emails\/\d+\/read$/, /^\/api\/(v1\/)?mail\/sync$/] },
  { key: 'campaigns', label: 'Campaigns', description: 'Email campaigns and contact lists (Amazon SES).',
    paths: [/^\/api\/v1\/mail\/campaigns(\/|$)/] },
  { key: 'deliverability', label: 'Deliverability', description: 'Delivery, bounce and complaint rates of campaigns.',
    paths: [/^\/api\/v1\/mail\/ses\/(deliverability|domains)$/] },
  { key: 'templates', label: 'Email Templates', description: 'Create, edit and delete templates. (Everyone can still use them.)',
    paths: [/^\/api\/v1\/mail\/templates(\/|$)/], writeOnly: true },
  { key: 'logs', label: 'Logs', description: 'What was sent: the campaign log.',
    paths: [/^\/api\/v1\/mail\/activity\/campaigns$/] }
];
const KEYS = TABS.map(t => t.key);
const FULL_ACCESS_ROLES = ['Workspace Owner', 'Workspace Admin'];
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The member's tabs as a Set. Owners/Admins and members with no list: every tab. */
function tabsFor(role, json) {
  if (FULL_ACCESS_ROLES.includes(role) || json === null || json === undefined || json === '') return new Set(KEYS);
  let list = [];
  try { list = JSON.parse(json); } catch (e) { list = []; } // unreadable: fails closed
  return new Set((Array.isArray(list) ? list : []).filter(k => KEYS.includes(k)));
}

/** Known keys only, de-duplicated, in registry order (null stays null = all tabs). */
function cleanList(list) {
  if (list === null) return null;
  if (!Array.isArray(list)) return null;
  const set = new Set(list.map(String));
  return KEYS.filter(k => set.has(k));
}

function tabForRequest(method, path) {
  for (const t of TABS) {
    if (!t.paths.some(re => re.test(path))) continue;
    if (t.writeOnly && !WRITE.has(method)) return null;
    return t;
  }
  return null;
}

/** The tab a request needs and does not have (null when allowed). */
function missingTab(auth, method, path) {
  const tabs = auth?.mailTabs;
  if (!tabs) return null;
  const t = tabForRequest(method, path);
  return t && !tabs.has(t.key) ? t : null;
}

const registry = () => TABS.map(({ key, label, description }) => ({ key, label, description }));

module.exports = { TABS, KEYS, tabsFor, cleanList, tabForRequest, missingTab, registry };
