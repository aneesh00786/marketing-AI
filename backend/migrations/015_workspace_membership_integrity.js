/**
 * Multi-workspace support: a user may belong to several workspaces, so memberships must be
 * unique per (workspace_id, user_id) and quick to look up by user.
 * - Refuses to run (changing nothing) if duplicate or orphaned memberships exist, so they can be
 *   reviewed first. No membership, user or workspace is modified or deleted.
 * - Foreign keys are added only when the key columns are type-compatible InnoDB tables.
 * Additive and re-runnable.
 */
module.exports = {
  id: '015_workspace_membership_integrity',

  async up(db) {
    const [dups] = await db.query('SELECT COUNT(*) AS n FROM (SELECT workspace_id, user_id FROM workspace_members GROUP BY workspace_id, user_id HAVING COUNT(*) > 1) d');
    const [noUser] = await db.query('SELECT COUNT(*) AS n FROM workspace_members m WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.user_id)');
    const [noWs] = await db.query('SELECT COUNT(*) AS n FROM workspace_members m WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = m.workspace_id)');
    const problems = [];
    if (Number(dups.n)) problems.push(`${dups.n} duplicate (workspace_id, user_id) membership pair(s)`);
    if (Number(noUser.n)) problems.push(`${noUser.n} membership(s) for missing users`);
    if (Number(noWs.n)) problems.push(`${noWs.n} membership(s) for missing workspaces`);
    if (problems.length) throw new Error(`workspace_members needs review before this migration: ${problems.join('; ')}. Nothing was changed.`);

    await db.ensureIndex('workspace_members', 'uq_workspace_members_ws_user', 'UNIQUE KEY uq_workspace_members_ws_user (workspace_id, user_id)');
    await db.ensureIndex('workspace_members', 'idx_workspace_members_user', 'KEY idx_workspace_members_user (user_id, status)');

    // Foreign keys only when both sides are InnoDB with identical key column types.
    const info = await db.query(
      `SELECT t.TABLE_NAME AS t, t.ENGINE AS engine, c.COLUMN_NAME AS col, c.COLUMN_TYPE AS type FROM information_schema.TABLES t
       JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
       WHERE t.TABLE_SCHEMA = ? AND ((t.TABLE_NAME = 'workspace_members' AND c.COLUMN_NAME IN ('workspace_id', 'user_id')) OR (t.TABLE_NAME IN ('users', 'workspaces') AND c.COLUMN_NAME = 'id'))`,
      [db.databaseName]
    );
    const of = (t, col) => info.find(r => r.t === t && r.col === col) || {};
    const compatible = (col, target) => {
      const a = of('workspace_members', col);
      const b = of(target, 'id');
      return a.engine === 'InnoDB' && b.engine === 'InnoDB' && a.type && a.type === b.type;
    };
    if (compatible('user_id', 'users')) {
      await db.ensureForeignKey('workspace_members', 'fk_workspace_members_user', 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');
    }
    if (compatible('workspace_id', 'workspaces')) {
      await db.ensureForeignKey('workspace_members', 'fk_workspace_members_ws', 'FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE');
    }
  }
};
