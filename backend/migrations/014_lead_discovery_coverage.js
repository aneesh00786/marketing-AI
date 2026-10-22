/**
 * AI Lead Discovery coverage: a search now runs several Google Text Search queries (related
 * categories, then states/cities seen in Google's own results) within a request budget.
 * Records the user's choices and the counts only; still no Google business content. Additive only.
 */
module.exports = {
  id: '014_lead_discovery_coverage',

  async up(db) {
    await db.ensureColumn('lead_discovery_runs', 'scope', "VARCHAR(10) NULL");
    await db.ensureColumn('lead_discovery_runs', 'expand_categories', 'TINYINT(1) NOT NULL DEFAULT 0');
    await db.ensureColumn('lead_discovery_runs', 'categories_json', 'TEXT NULL');
    await db.ensureColumn('lead_discovery_runs', 'max_requests', 'INT NULL');
    await db.ensureColumn('lead_discovery_runs', 'requests', 'INT NOT NULL DEFAULT 0');
    await db.ensureColumn('lead_discovery_runs', 'queries_run', 'INT NOT NULL DEFAULT 0');
    await db.ensureColumn('lead_discovery_runs', 'raw_results', 'INT NOT NULL DEFAULT 0');
    await db.ensureColumn('lead_discovery_runs', 'stop_reason', 'VARCHAR(30) NULL');
  }
};
