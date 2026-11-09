/**
 * Per-member capability grants on top of the member's role (workspace_member_capability_grants).
 *
 * Only capabilities listed in GRANTABLE are honoured, and only while the member's current role
 * includes the prerequisite capability. Everything fails closed: an unknown capability, an
 * ineligible role, or an error reading grants (e.g. before migration 025) gives the role's
 * capabilities and nothing more.
 */
const { all } = require('../db/database');
const { capabilitiesForRole } = require('./permissions');

const GRANTABLE = {
  // A Member writes email but does not send it; this lets one member send as well.
  'mail.send': { requires: 'mail.compose', label: 'Send email' },
  'mail.send_transactional': { requires: 'mail.send', label: 'Send transactional email (Compose)' }
};

/** 'role' (already included), 'eligible' (may be granted) or 'not_eligible' for this role. */
function eligibility(role, capability) {
  const g = GRANTABLE[capability];
  if (!g) return 'not_eligible';
  const caps = capabilitiesForRole(role);
  if (caps.has(capability)) return 'role';
  return caps.has(g.requires) ? 'eligible' : 'not_eligible';
}

/** The member's capabilities: role capabilities plus grants the role currently qualifies for. */
async function effectiveCapabilities(workspaceId, userId, role) {
  const caps = capabilitiesForRole(role);
  let rows = [];
  try {
    rows = await all('SELECT capability FROM workspace_member_capability_grants WHERE workspace_id = ? AND user_id = ?', [workspaceId, userId]);
  } catch {
    return capabilitiesForRole(role); // fail closed: role only
  }
  for (const r of rows) {
    if (eligibility(role, r.capability) === 'eligible') caps.add(r.capability);
  }
  return caps;
}

module.exports = { GRANTABLE, eligibility, effectiveCapabilities };
