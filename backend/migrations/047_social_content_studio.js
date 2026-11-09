/**
 * AI Social Media Content Studio (extends the existing social module; no duplicate campaign or
 * media tables):
 * - social_brand_kits: per-workspace brand settings used by every AI generation (logo, colours,
 *   fonts, voice, guidelines, product and reference images: ids of the workspace's own assets).
 * - social_content_generations: one row per AI generation (text, image, video, voice, carousel,
 *   plan). It is the generation job (queued -> processing -> completed / failed), the record of
 *   the provider request and the AI usage / credit log: credits are charged once, when the
 *   generation completes. request_key makes a repeated click or retry the same generation.
 * - assets: generation_id, parent_asset_id (an edited version keeps the original), campaign_id.
 * - content_items: format (post, poster, carousel, reel, video, story), plan_day, media_prompt,
 *   carousel_json and brand_kit_id, for campaign plans and carousels.
 *
 * Reversible: down() drops the two tables and the added columns.
 */
const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci';

module.exports = {
  id: '047_social_content_studio',
  async up(db) {
    await db.ensureTable('social_brand_kits', `CREATE TABLE social_brand_kits (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      company_name VARCHAR(200) NULL,
      logo_asset_id INT NULL,
      website VARCHAR(500) NULL,
      contact_info VARCHAR(500) NULL,
      primary_color CHAR(7) NULL,
      secondary_color CHAR(7) NULL,
      fonts VARCHAR(200) NULL,
      description TEXT NULL,
      guidelines TEXT NULL,
      tone VARCHAR(200) NULL,
      product_asset_ids_json TEXT NULL,
      reference_asset_ids_json TEXT NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      deleted_at DATETIME NULL,
      KEY idx_brand_kits_ws (workspace_id, deleted_at),
      CONSTRAINT fk_brand_kits_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureTable('social_content_generations', `CREATE TABLE social_content_generations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      user_id INT NULL,
      kind VARCHAR(20) NOT NULL,
      purpose VARCHAR(30) NULL,
      provider VARCHAR(40) NULL,
      model VARCHAR(100) NULL,
      request_key VARCHAR(80) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'queued',
      input_json LONGTEXT NULL,
      output_json LONGTEXT NULL,
      error_code VARCHAR(64) NULL,
      error TEXT NULL,
      provider_job_id VARCHAR(255) NULL,
      estimated_credits DECIMAL(10,2) NULL,
      credits DECIMAL(10,2) NULL,
      estimated_cost_usd DECIMAL(10,4) NULL,
      cost_usd DECIMAL(10,4) NULL,
      attempts INT NOT NULL DEFAULT 0,
      campaign_id INT NULL,
      content_item_id INT NULL,
      brand_kit_id INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NULL,
      completed_at DATETIME NULL,
      UNIQUE KEY uq_generation_request (workspace_id, request_key),
      KEY idx_generations_ws_status (workspace_id, status),
      KEY idx_generations_ws_created (workspace_id, created_at),
      KEY idx_generations_campaign (workspace_id, campaign_id),
      CONSTRAINT fk_generations_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    ) ${TABLE_OPTS}`);

    await db.ensureColumn('assets', 'generation_id', 'INT NULL');
    await db.ensureColumn('assets', 'parent_asset_id', 'INT NULL');
    await db.ensureColumn('assets', 'campaign_id', 'INT NULL');
    await db.ensureIndex('assets', 'idx_assets_ws_campaign', 'KEY idx_assets_ws_campaign (workspace_id, campaign_id)');

    await db.ensureColumn('content_items', 'format', 'VARCHAR(20) NULL');
    await db.ensureColumn('content_items', 'plan_day', 'INT NULL');
    await db.ensureColumn('content_items', 'media_prompt', 'TEXT NULL');
    await db.ensureColumn('content_items', 'carousel_json', 'LONGTEXT NULL');
    await db.ensureColumn('content_items', 'brand_kit_id', 'INT NULL');
  },

  async down(db) {
    await db.query('DROP TABLE IF EXISTS social_content_generations');
    await db.query('DROP TABLE IF EXISTS social_brand_kits');
    for (const c of ['generation_id', 'parent_asset_id', 'campaign_id']) await db.query(`ALTER TABLE assets DROP COLUMN IF EXISTS ${c}`).catch(() => null);
    await db.query('ALTER TABLE assets DROP INDEX idx_assets_ws_campaign').catch(() => null);
    for (const c of ['format', 'plan_day', 'media_prompt', 'carousel_json', 'brand_kit_id']) await db.query(`ALTER TABLE content_items DROP COLUMN IF EXISTS ${c}`).catch(() => null);
  }
};
