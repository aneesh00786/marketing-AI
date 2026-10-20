/**
 * Capability-based permissions. Routes check capabilities, never role names,
 * so roles can be re-shaped without touching business code.
 */
const CAPABILITIES = [
  'workspace.manage',
  'members.manage',
  'agents.use',
  'content.create',
  'content.approve',
  'content.publish',
  'campaigns.manage',
  'integrations.manage',
  'analytics.view',
  'inbox.view',
  'inbox.reply',
  'leads.view',
  'leads.manage',
  'mail.view',
  'mail.compose',
  'mail.send',
  'mail.configure',
  'settings.manage',
  'billing.manage',
  'usage.view'
];

const ROLE_CAPABILITIES = {
  'Workspace Owner': CAPABILITIES,
  'Workspace Admin': CAPABILITIES.filter(c => c !== 'billing.manage'),
  'Marketing Manager': [
    'agents.use', 'content.create', 'content.approve', 'content.publish', 'campaigns.manage',
    'analytics.view', 'inbox.view', 'inbox.reply', 'usage.view', 'leads.view', 'leads.manage',
    'mail.view', 'mail.compose', 'mail.send'
  ],
  // Mail: Members write drafts, Approvers approve and send them, only Owners/Admins see mail settings.
  'Approver': ['agents.use', 'content.approve', 'analytics.view', 'inbox.view', 'leads.view', 'mail.view', 'mail.send'],
  'Member': ['agents.use', 'content.create', 'analytics.view', 'inbox.view', 'leads.view', 'leads.manage', 'mail.view', 'mail.compose']
};

function capabilitiesForRole(role) {
  return new Set(ROLE_CAPABILITIES[role] || []);
}

module.exports = {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  capabilitiesForRole
};
