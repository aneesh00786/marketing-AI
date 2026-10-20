/**
 * Leads CRM: link leads to the workspace's products and support honest AI status.
 * Additive only. Existing lead data is preserved:
 *  - product_id is set only when product_interest exactly matches (case-insensitive)
 *    the name of a product in the SAME workspace;
 *  - unmatched leads keep their free-text interest and get a review note instead of a guessed product.
 * No foreign key on product_id: deleting a product must keep working in the Products module;
 * the API validates workspace ownership on every read/write instead.
 */
module.exports = {
  id: '004_leads_products_workspace',

  async up(db) {
    await db.ensureColumn('leads', 'product_id', 'INT NULL');
    await db.ensureColumn('leads', 'product_review_note', 'VARCHAR(500) NULL');
    await db.ensureColumn('leads', 'ai_status', 'VARCHAR(20) NULL');
    await db.ensureColumn('leads', 'ai_suggested_at', 'DATETIME NULL');
    await db.ensureColumn('leads', 'updated_at', 'DATETIME NULL');
    await db.ensureIndex('leads', 'idx_leads_ws_id', 'KEY idx_leads_ws_id (workspace_id, id)');
    await db.ensureIndex('leads', 'idx_leads_ws_product', 'KEY idx_leads_ws_product (workspace_id, product_id)');
    await db.ensureIndex('leads', 'idx_leads_ws_email', 'KEY idx_leads_ws_email (workspace_id, email(191))');
    await db.ensureIndex('digital_products', 'idx_products_ws_id', 'KEY idx_products_ws_id (workspace_id, id)');

    // Exact same-workspace name matches only; never guess.
    await db.query(
      `UPDATE leads l
       JOIN digital_products p ON p.workspace_id = l.workspace_id AND LOWER(TRIM(p.name)) = LOWER(TRIM(l.product_interest))
       SET l.product_id = p.id
       WHERE l.product_id IS NULL AND l.product_interest IS NOT NULL AND l.product_interest <> ''`
    );
    await db.query(
      `UPDATE leads
       SET product_review_note = CONCAT('Interest "', LEFT(product_interest, 200), '" is not linked to a product. Choose one from Products.')
       WHERE product_id IS NULL AND product_review_note IS NULL AND product_interest IS NOT NULL AND product_interest <> ''`
    );
  }
};
