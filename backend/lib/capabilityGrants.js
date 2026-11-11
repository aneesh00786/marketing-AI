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
  'mail.send_transactional': { requires: 'mail.send', label: 'Send transactional email (Compose)' },
  // Team Performance for everyone (Owners/Admins always have it): e.g. a Marketing Manager leading the team.
  'performance.view_team': { requires: 'analytics.view', label: 'View team performance' },
  // Set and change staff targets (Owners/Admins always can).
  'performance.manage_targets': { requires: 'analytics.view', label: 'Manage staff targets' },
  // Each needs "View team performance" to matter (except scoring); Owners/Admins always have them.
  'performance.compare': { requires: 'analytics.view', label: 'Compare staff' },
  'performance.export': { requires: 'analytics.view', label: 'Export team reports' },
  'performance.view_transcripts': { requires: 'analytics.view', label: 'View call transcripts of others' },
  'performance.configure_scoring': { requires: 'analytics.view', label: 'Configure performance scoring' },
  'performance.schedule_reports': { requires: 'analytics.view', label: 'Schedule performance reports' }
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
