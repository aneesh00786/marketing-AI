/** The legacy email_campaigns.product_key no longer defaults to one company's product. */
module.exports = {
  id: '038_neutral_defaults',
  async up(db) {
    if (await db.columnInfo('email_campaigns', 'product_key')) {
      await db.query('ALTER TABLE `email_campaigns` ALTER COLUMN `product_key` SET DEFAULT NULL');
    }
  }
};
