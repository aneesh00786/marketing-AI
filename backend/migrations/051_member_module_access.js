/**
 * Per-member section access (see lib/moduleAccess.js):
 * - workspace_members.module_access_json: JSON list of modules the member may use; NULL = all
 *   (existing members keep full access). Ignored for Owners and Admins, who always have all.
 * - workspace_invitations.module_access_json: the modules chosen when inviting, applied on accept.
 * Reversible: down() drops both columns.
 */
module.exports = {
  id: '051_member_module_access',
  async up(db) {
    await db.ensureColumn('workspace_members', 'module_access_json', 'TEXT NULL');
    await db.ensureColumn('workspace_invitations', 'module_access_json', 'TEXT NULL');
  },
  async down(db) {
    await db.query('ALTER TABLE workspace_members DROP COLUMN IF EXISTS module_access_json').catch(() => null);
    await db.query('ALTER TABLE workspace_invitations DROP COLUMN IF EXISTS module_access_json').catch(() => null);
  }
};
