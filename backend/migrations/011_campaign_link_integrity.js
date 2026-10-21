/**
 * Referential integrity for AI Campaigns links.
 * - A campaign's budget (with its spend and revenue history) can no longer be removed by deleting
 *   the campaign: fk_campaign_budgets_program becomes ON DELETE RESTRICT (was CASCADE).
 * - Command Center campaigns keep valid links to their email sequence / social campaign
 *   (ON DELETE SET NULL), and A/B tests are removed with the sequence or campaign they test.
 * Refuses to run (changing nothing) if existing rows reference missing records, so the operator
 * can review them first. Data is never modified.
 */
const LINKS = [
  ['campaign_programs', 'fk_campaign_programs_outreach', 'outreach_campaign_id', 'outreach_campaigns', 'SET NULL'],
  ['campaign_programs', 'fk_campaign_programs_social', 'social_campaign_id', 'campaigns', 'SET NULL'],
  ['ab_tests', 'fk_ab_tests_outreach', 'outreach_campaign_id', 'outreach_campaigns', 'CASCADE'],
  ['ab_tests', 'fk_ab_tests_social', 'social_campaign_id', 'campaigns', 'CASCADE']
];

module.exports = {
  id: '011_campaign_link_integrity',

  async up(db) {
    const dangling = [];
    for (const [table, , column, target] of LINKS) {
      const [row] = await db.query(`SELECT COUNT(*) AS n FROM \`${table}\` x WHERE x.\`${column}\` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM \`${target}\` t WHERE t.id = x.\`${column}\`)`);
      if (Number(row.n)) dangling.push(`${table}.${column}: ${row.n}`);
    }
    if (dangling.length) throw new Error(`Rows reference missing records (${dangling.join(', ')}). Review them before applying this migration.`);

    const [rule] = await db.query(
      "SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = 'campaign_budgets' AND CONSTRAINT_NAME = 'fk_campaign_budgets_program'",
      [db.databaseName]
    );
    if (rule && rule.DELETE_RULE === 'CASCADE') {
      await db.query('ALTER TABLE campaign_budgets DROP FOREIGN KEY fk_campaign_budgets_program');
    }
    await db.ensureForeignKey('campaign_budgets', 'fk_campaign_budgets_program', 'FOREIGN KEY (program_id) REFERENCES campaign_programs(id) ON DELETE RESTRICT');

    for (const [table, name, column, target, onDelete] of LINKS) {
      await db.ensureForeignKey(table, name, `FOREIGN KEY (\`${column}\`) REFERENCES \`${target}\`(id) ON DELETE ${onDelete}`);
    }
  }
};
