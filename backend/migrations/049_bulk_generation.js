/**
 * Generate All Content (bulk campaign generation):
 * - social_content_generations.batch_key: the "Generate All Content" run a generation belongs to,
 *   so its progress, counts and cancellations are read from the database (also after leaving the page).
 *   A generation can now also be 'canceled' (a queued one the user stopped; never charged).
 * Reversible: down() drops the column and its index.
 */
module.exports = {
  id: '049_bulk_generation',
  async up(db) {
    await db.ensureColumn('social_content_generations', 'batch_key', 'VARCHAR(80) NULL');
    await db.ensureIndex('social_content_generations', 'idx_generations_batch', 'KEY idx_generations_batch (workspace_id, campaign_id, batch_key)');
  },
  async down(db) {
    await db.query('ALTER TABLE social_content_generations DROP INDEX idx_generations_batch').catch(() => null);
    await db.query('ALTER TABLE social_content_generations DROP COLUMN IF EXISTS batch_key').catch(() => null);
  }
};
