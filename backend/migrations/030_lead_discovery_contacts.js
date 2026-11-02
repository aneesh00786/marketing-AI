/**
 * AI Lead Discovery: contact details read from a business's own website, and the fields a search
 * collected. Additive only: new nullable columns.
 *
 * Google Places provides no email or contact person. When a search asks for them, they are read
 * from the business's public website (never from Google), so they may be kept for import:
 * - lead_discovery_places.email / contact_name / contact_role: what the site published;
 *   contact_source: the page they were found on.
 * - lead_discovery_runs.fields_json: the fields the user chose, e.g. ["phone","website","email"].
 * Rollback: older code ignores these columns. To remove them, drop the five columns and delete the
 * 030_lead_discovery_contacts row from schema_migrations.
 */
module.exports = {
  id: '030_lead_discovery_contacts',

  async up(db) {
    await db.ensureColumn('lead_discovery_places', 'email', 'VARCHAR(254) NULL');
    await db.ensureColumn('lead_discovery_places', 'contact_name', 'VARCHAR(80) NULL');
    await db.ensureColumn('lead_discovery_places', 'contact_role', 'VARCHAR(60) NULL');
    await db.ensureColumn('lead_discovery_places', 'contact_source', 'VARCHAR(500) NULL');
    await db.ensureColumn('lead_discovery_runs', 'fields_json', 'VARCHAR(200) NULL');
  }
};
