/**
 * Section ("module") access per workspace member, on top of their role.
 *
 * The role decides WHAT someone may do (create, approve, publish, send…); module access decides
 * WHICH parts of Marketech.ai they can open. Owners and Admins always have every module.
 * For other roles, workspace_members.module_access_json lists the modules they may use;
 * NULL means all modules (so existing members keep exactly the access they had).
 *
 * Enforced on the server: requests to a module's API are refused (403 MODULE_ACCESS_REQUIRED)
 * when the member does not have it. The app also hides those sections.
 *
 * The CRM is not here: it holds platform-wide data and keeps its own per-user grant (crmAccess.js),
 * which only the platform admin can assign.
 */
const MODULES = [
  { key: 'products', label: 'Digital Products', description: 'Add and edit products. (Everyone can still pick a product in a campaign.)',
    paths: [/^\/api\/(v1\/)?products(\/|$)/], writeOnly: true },
  { key: 'leads', label: 'Leads', description: 'Leads, lead discovery and import.',
    paths: [/^\/api\/(v1\/)?leads(\/|$)/, /^\/api\/v1\/crm\/leads(\/|$)/] },
  { key: 'mail', label: 'Mail Center & email campaigns', description: 'Inbox, compose, drafts, templates and email campaigns.',
    paths: [/^\/api\/(v1\/)?(mail|drafts|emails)(\/|$)/] },
  { key: 'social', label: 'Social media & social campaigns', description: 'Social accounts, content, AI content studio, social campaigns and publishing.',
    paths: [/^\/api\/v1\/social(\/|$)/], except: [/^\/api\/v1\/social\/dashboard$/] },
  { key: 'campaigns', label: 'AI Campaigns', description: 'Campaign Command Center, playbooks, outreach, A/B tests, automations and budgets.',
    paths: [/^\/api\/v1\/(command|outreach|ab-tests|automations|campaign-analytics|budgets|b2b)(\/|$)/, /^\/api\/(v1\/)?(marketing|businesses)(\/|$)/] },
  { key: 'appointments', label: 'Demos', description: 'Booked demos and appointments.',
    paths: [/^\/api\/(v1\/)?appointments(\/|$)/, /^\/api\/v1\/crm\/appointments(\/|$)/] },
  { key: 'voice', label: 'Mark Voice Center', description: 'Voice conversations and call records.',
    paths: [/^\/api\/v1\/voice(\/|$)/, /^\/api\/v1\/telnyx\/(call-records|simulate|config)(\/|$)/] }
];
const KEYS = MODULES.map(m => m.key);
const FULL_ACCESS_ROLES = ['Workspace Owner', 'Workspace Admin'];
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The member's modules as a Set. Owners/Admins and members with no list: every module. */
function modulesFor(role, json) {
  if (FULL_ACCESS_ROLES.includes(role) || json === null || json === undefined || json === '') return new Set(KEYS);
  let list = [];
  try { list = JSON.parse(json); } catch (e) { list = []; } // unreadable: fails closed
  return new Set((Array.isArray(list) ? list : []).filter(k => KEYS.includes(k)));
}

/** Validates a list from a client: known keys only, de-duplicated, in registry order. */
function cleanList(list) {
  if (!Array.isArray(list)) return null;
  const set = new Set(list.map(String));
  return KEYS.filter(k => set.has(k));
}

function moduleForRequest(method, path) {
  for (const m of MODULES) {
    if (!m.paths.some(re => re.test(path))) continue;
    if (m.except && m.except.some(re => re.test(path))) return null;
    if (m.writeOnly && !WRITE.has(method)) return null;
    return m;
  }
  return null;
}

/** Express middleware (after sign-in): refuses API calls to modules the member cannot use. */
function moduleGate() {
  return function moduleGateMiddleware(req, res, next) {
    const mods = req.auth?.modules;
    if (!mods) return next(); // public routes and tool calls carry no member modules
    const m = moduleForRequest(req.method, req.originalUrl.split('?')[0]);
    if (!m || mods.has(m.key)) return next();
    return res.status(403).json({ success: false, error: `You do not have access to ${m.label}. Ask a workspace Owner or Admin.`, code: 'MODULE_ACCESS_REQUIRED', module: m.key });
  };
}

const registry = () => MODULES.map(({ key, label, description }) => ({ key, label, description }));

module.exports = { MODULES, KEYS, FULL_ACCESS_ROLES, modulesFor, cleanList, moduleForRequest, moduleGate, registry };
