/**
 * Leads get a country, to filter the Leads screen and the lead pickers by it.
 * Existing leads are filled in from what is already known: the AI Lead Discovery search that
 * found them, or the same address in a contact list. Others stay empty until edited.
 */
module.exports = {
  id: '036_lead_country',
  async up(db) {
    await db.ensureColumn('leads', 'country', 'VARCHAR(100) NULL');
    await db.ensureIndex('leads', 'idx_leads_ws_country', 'KEY idx_leads_ws_country (workspace_id, country)');
    const { countryName } = require('../modules/leadDiscovery/googlePlacesProvider');
    if (await db.tableExists('lead_place_refs')) {
      const rows = await db.query(`SELECT r.lead_id, MIN(d.country_code) AS code FROM lead_place_refs r
        JOIN lead_discovery_runs d ON d.id = r.run_id JOIN leads l ON l.id = r.lead_id
        WHERE l.country IS NULL GROUP BY r.lead_id`);
      for (const r of rows) {
        const name = countryName(r.code);
        if (name) await db.query('UPDATE leads SET country = ? WHERE id = ? AND country IS NULL', [name, r.lead_id]);
      }
    }
    if (await db.columnInfo('mail_contacts', 'country')) {
      await db.query(`UPDATE leads l JOIN mail_contacts c ON c.workspace_id = l.workspace_id AND c.email = LOWER(TRIM(l.email))
        SET l.country = LEFT(c.country, 100) WHERE l.country IS NULL AND c.country IS NOT NULL AND c.country <> ''`);
    }
  }
};
