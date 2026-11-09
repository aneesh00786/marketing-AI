/**
 * Product-based social campaigns (extends existing tables; no new product or campaign tables):
 * - digital_products.category, image_asset_ids_json: product cards and the product's images
 *   (this workspace's media library assets) used as AI references.
 * - campaigns.description, strategy_json (the AI strategy and its editable ideas until accepted),
 *   wizard_step (where the campaign wizard was left), image_asset_ids_json (the product images chosen
 *   for the campaign in the wizard; AI uses them as references).
 * - content_items.product_id and social_content_generations.product_id: every post and every AI
 *   generation is linked to its product (set server side from the campaign).
 * Reversible: down() drops the added columns.
 */
module.exports = {
  id: '048_product_campaigns',
  async up(db) {
    await db.ensureColumn('digital_products', 'category', 'VARCHAR(100) NULL');
    await db.ensureColumn('digital_products', 'image_asset_ids_json', 'TEXT NULL');
    await db.ensureColumn('campaigns', 'description', 'TEXT NULL');
    await db.ensureColumn('campaigns', 'strategy_json', 'LONGTEXT NULL');
    await db.ensureColumn('campaigns', 'wizard_step', 'VARCHAR(20) NULL');
    // The product's images for this campaign (chosen in the campaign wizard; this workspace's media library).
    await db.ensureColumn('campaigns', 'image_asset_ids_json', 'TEXT NULL');
    await db.ensureColumn('content_items', 'product_id', 'INT NULL');
    await db.ensureIndex('content_items', 'idx_content_ws_product', 'KEY idx_content_ws_product (workspace_id, product_id)');
    await db.ensureColumn('social_content_generations', 'product_id', 'INT NULL');
    await db.ensureIndex('social_content_generations', 'idx_generations_product', 'KEY idx_generations_product (workspace_id, product_id)');
  },
  async down(db) {
    for (const [t, c] of [['digital_products', 'category'], ['digital_products', 'image_asset_ids_json'], ['campaigns', 'description'], ['campaigns', 'strategy_json'], ['campaigns', 'wizard_step'], ['campaigns', 'image_asset_ids_json'], ['content_items', 'product_id'], ['social_content_generations', 'product_id']]) {
      await db.query(`ALTER TABLE ${t} DROP COLUMN IF EXISTS ${c}`).catch(() => null);
    }
  }
};
