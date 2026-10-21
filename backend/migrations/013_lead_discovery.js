/**
 * AI Lead Discovery (Google Places API (New)).
 *
 * Google Maps Platform terms allow storing Places `place_id` values indefinitely, but not
 * business names, addresses, phone numbers, websites or other Places content ("No Scraping",
 * "No Caching"). So these tables hold only:
 * - lead_discovery_runs: the user's own search criteria, counts and errors (no Google content).
 * - lead_discovery_places: place IDs found by a run plus our own duplicate flags, so an import
 *   can only use places that run actually returned.
 * - lead_place_refs: the place ID behind an imported lead (unique per workspace), used for
 *   de-duplication and to show the business details live from Google, never from storage.
 * Additive only.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '013_lead_discovery',

  async up(db) {
    await db.ensureTable('lead_discovery_runs', `CREATE TABLE lead_discovery_runs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      created_by INT NULL,
      business_type VARCHAR(120) NOT NULL,
      country_code CHAR(2) NOT NULL,
      region VARCHAR(80) NULL,
      city VARCHAR(80) NULL,
      keywords VARCHAR(200) NULL,
      product_id INT NULL,
      max_results INT NOT NULL,
      include_contacts TINYINT(1) NOT NULL DEFAULT 1,
      text_query VARCHAR(400) NOT NULL,
      criteria_hash CHAR(40) NOT NULL,
      status VARCHAR(20) NOT NULL,
      found INT NOT NULL DEFAULT 0,
      duplicates INT NOT NULL DEFAULT 0,
      possible_duplicates INT NOT NULL DEFAULT 0,
      eligible INT NOT NULL DEFAULT 0,
      missing_contact INT NOT NULL DEFAULT 0,
      pages INT NOT NULL DEFAULT 0,
      error_code VARCHAR(40) NULL,
      error_message VARCHAR(500) NULL,
      imported INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_lead_discovery_runs_ws (workspace_id, created_at),
      KEY idx_lead_discovery_runs_hash (workspace_id, criteria_hash, created_at),
      CONSTRAINT fk_lead_discovery_runs_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('lead_discovery_places', `CREATE TABLE lead_discovery_places (
      id INT AUTO_INCREMENT PRIMARY KEY,
      run_id INT NOT NULL,
      workspace_id INT NOT NULL,
      place_id VARCHAR(255) CHARACTER SET ascii NOT NULL,
      eligible TINYINT(1) NOT NULL DEFAULT 1,
      duplicate_lead_id INT NULL,
      match_reason VARCHAR(40) NULL,
      imported_lead_id INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_lead_discovery_place (run_id, place_id),
      KEY idx_lead_discovery_places_ws (workspace_id, run_id),
      CONSTRAINT fk_lead_discovery_places_run FOREIGN KEY (run_id) REFERENCES lead_discovery_runs(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('lead_place_refs', `CREATE TABLE lead_place_refs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      lead_id INT NOT NULL,
      place_id VARCHAR(255) CHARACTER SET ascii NOT NULL,
      run_id INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_lead_place_ref_place (workspace_id, place_id),
      UNIQUE KEY uq_lead_place_ref_lead (lead_id),
      CONSTRAINT fk_lead_place_refs_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CONSTRAINT fk_lead_place_refs_lead FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);
  }
};
