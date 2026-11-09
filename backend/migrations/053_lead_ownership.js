/**
 * Lead ownership and access (see lib/leadAccess.js):
 * - leads.created_by_user_id: who created the lead (never changes).
 * - leads.owner_user_id: who owns it now (changed only by a workspace Owner/Admin). NULL = unassigned.
 * - leads.lead_source: how it arrived (manual, import, discovery, social, phone, api).
 * - lead_user_access: leads shared with other members, 'view' or 'manage', one row per lead and user.
 *
 * Existing leads: ownership is filled in only from recorded evidence, never guessed:
 *   1. the audit log entry "leads.created" for that lead (who created it);
 *   2. AI Lead Discovery: the person who ran the search the lead was imported from;
 *   3. a social inbox enquiry turned into a lead (audit "social.inbox.lead_created").
 * Every other existing lead stays unassigned (owner NULL): Owners/Admins see it as "Unassigned"
 * and assign it; other members do not see it until then. No lead data is changed or removed.
 * Reversible: down() drops the table and the three columns.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '053_lead_ownership',
  async up(db) {
    await db.ensureColumn('leads', 'created_by_user_id', 'INT NULL');
    await db.ensureColumn('leads', 'owner_user_id', 'INT NULL');
    await db.ensureColumn('leads', 'lead_source', 'VARCHAR(30) NULL');
    await db.ensureIndex('leads', 'idx_leads_ws_owner', 'KEY idx_leads_ws_owner (workspace_id, owner_user_id)');
    await db.ensureIndex('leads', 'idx_leads_ws_creator', 'KEY idx_leads_ws_creator (workspace_id, created_by_user_id)');
    await db.ensureForeignKey('leads', 'fk_leads_owner_user', 'FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL');
    await db.ensureForeignKey('leads', 'fk_leads_creator_user', 'FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL');

    await db.ensureTable('lead_user_access', `CREATE TABLE lead_user_access (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      lead_id INT NOT NULL,
      user_id INT NOT NULL,
      access_level VARCHAR(10) NOT NULL,
      granted_by_user_id INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_lead_user_access (lead_id, user_id),
      KEY idx_lead_access_user (workspace_id, user_id),
      CONSTRAINT fk_lead_access_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_lead_access_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
      CONSTRAINT fk_lead_access_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_lead_access_granter FOREIGN KEY (granted_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT chk_lead_access_level CHECK (access_level IN ('view', 'manage'))
    ) ${TABLE_OPTS}`);

    // ---- Existing leads: creator from evidence only (each step fills only leads still without one).
    const member = 'EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = l.workspace_id AND m.user_id = %s)';
    // 1. Audit log: "leads.created" by a signed-in user.
    await db.query(`UPDATE leads l JOIN (
        SELECT a.workspace_id, CAST(a.resource_id AS UNSIGNED) AS lead_id, MIN(a.id) AS first_id FROM audit_logs a
        WHERE a.action = 'leads.created' AND a.resource_type = 'lead' AND a.actor_user_id IS NOT NULL GROUP BY a.workspace_id, a.resource_id
      ) f ON f.workspace_id = l.workspace_id AND f.lead_id = l.id
      JOIN audit_logs a ON a.id = f.first_id
      SET l.created_by_user_id = a.actor_user_id, l.lead_source = COALESCE(l.lead_source, 'manual')
      WHERE l.created_by_user_id IS NULL AND ${member.replace('%s', 'a.actor_user_id')}`).catch(() => null);
    // 2. AI Lead Discovery: who ran the search.
    if (await db.tableExists('lead_place_refs') && await db.tableExists('lead_discovery_runs')) {
      await db.query(`UPDATE leads l
        JOIN lead_place_refs r ON r.lead_id = l.id AND r.workspace_id = l.workspace_id
        JOIN lead_discovery_runs d ON d.id = r.run_id AND d.workspace_id = l.workspace_id
        SET l.created_by_user_id = COALESCE(l.created_by_user_id, d.created_by), l.lead_source = 'discovery'
        WHERE d.created_by IS NOT NULL AND (l.created_by_user_id IS NULL OR l.created_by_user_id = d.created_by)
          AND ${member.replace('%s', 'd.created_by')}`).catch(() => null);
      await db.query("UPDATE leads l SET l.lead_source = 'discovery' WHERE l.lead_source IS NULL AND EXISTS (SELECT 1 FROM lead_place_refs r WHERE r.lead_id = l.id)").catch(() => null);
    }
    // 3. Social inbox enquiries turned into leads.
    await db.query(`UPDATE leads l JOIN audit_logs a
        ON a.workspace_id = l.workspace_id AND a.action = 'social.inbox.lead_created' AND a.actor_user_id IS NOT NULL
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.leadId')) AS UNSIGNED) = l.id
      SET l.created_by_user_id = a.actor_user_id, l.lead_source = 'social'
      WHERE l.created_by_user_id IS NULL AND ${member.replace('%s', 'a.actor_user_id')}`).catch(() => null);
    await db.query("UPDATE leads l SET l.lead_source = 'social' WHERE l.lead_source IS NULL AND EXISTS (SELECT 1 FROM engagement_threads t WHERE t.lead_id = l.id AND t.workspace_id = l.workspace_id)").catch(() => null);

    // The creator found from evidence also becomes the owner; the rest stay unassigned for admin review.
    await db.query('UPDATE leads SET owner_user_id = created_by_user_id WHERE owner_user_id IS NULL AND created_by_user_id IS NOT NULL');
  },
  async down(db) {
    await db.query('DROP TABLE IF EXISTS lead_user_access');
    for (const fk of ['fk_leads_owner_user', 'fk_leads_creator_user']) await db.query(`ALTER TABLE leads DROP FOREIGN KEY ${fk}`).catch(() => null);
    for (const ix of ['idx_leads_ws_owner', 'idx_leads_ws_creator']) await db.query(`ALTER TABLE leads DROP INDEX ${ix}`).catch(() => null);
    for (const c of ['created_by_user_id', 'owner_user_id', 'lead_source']) await db.query(`ALTER TABLE leads DROP COLUMN IF EXISTS ${c}`).catch(() => null);
  }
};
