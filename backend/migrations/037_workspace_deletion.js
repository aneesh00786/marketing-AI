/**
 * Deleting a workspace (platform admin): it is closed at once (status 'Deleted') and its data is
 * kept until purge_after (30 days) so it can be restored; then the worker erases the data and the
 * row stays as a record (status 'Purged').
 */
module.exports = {
  id: '037_workspace_deletion',
  async up(db) {
    await db.ensureColumn('workspaces', 'deleted_at', 'DATETIME NULL');
    await db.ensureColumn('workspaces', 'deleted_by', 'INT NULL');
    await db.ensureColumn('workspaces', 'delete_reason', 'VARCHAR(500) NULL');
    await db.ensureColumn('workspaces', 'purge_after', 'DATETIME NULL');
    await db.ensureColumn('workspaces', 'purged_at', 'DATETIME NULL');
  }
};
