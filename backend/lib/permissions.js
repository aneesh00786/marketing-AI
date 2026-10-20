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
  'settings.manage',
  'billing.manage',
  'usage.view'
];

const ROLE_CAPABILITIES = {
  'Workspace Owner': CAPABILITIES,
  'Workspace Admin': CAPABILITIES.filter(c => c !== 'billing.manage'),
  'Marketing Manager': [
    'agents.use', 'content.create', 'content.approve', 'content.publish', 'campaigns.manage',
    'analytics.view', 'inbox.view', 'inbox.reply', 'usage.view'
  ],
  'Approver': ['agents.use', 'content.approve', 'analytics.view', 'inbox.view'],
  'Member': ['agents.use', 'content.create', 'analytics.view', 'inbox.view']
};

function capabilitiesForRole(role) {
  return new Set(ROLE_CAPABILITIES[role] || []);
}

module.exports = {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  capabilitiesForRole
};
