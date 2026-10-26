/**
 * Read-only check that every encrypted credential in the database (social OAuth tokens, provider app
 * secrets, OAuth state, Zoho tokens, mailbox passwords — any "enc:v1:" value) can be decrypted with
 * the configured SOCIAL_TOKEN_ENCRYPTION_KEY. Run after a restore or before a deployment:
 *
 *   node scripts/verifyEncryptedSecrets.js       (from backend/)
 *
 * Columns are discovered from the schema (text columns whose name suggests a secret), so new
 * encrypted columns are covered. Only counts are printed — never values. Exit status 1 when any
 * value cannot be decrypted (wrong or missing key) or the key is not configured.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const NAME_HINT = /(secret|token|pass|cipher|credential|verifier)/i;

async function verify({ all, databaseName, decrypt }) {
  const cols = await all(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND DATA_TYPE IN ('text', 'mediumtext', 'longtext', 'varchar', 'tinytext')`,
    [databaseName]
  );
  const results = [];
  for (const { t, c } of cols.filter(x => NAME_HINT.test(x.c))) {
    const rows = await all(`SELECT \`${c}\` AS v FROM \`${t}\` WHERE \`${c}\` LIKE 'enc:v1:%'`);
    if (!rows.length) continue;
    let ok = 0;
    let failed = 0;
    for (const r of rows) {
      try { decrypt(r.v); ok += 1; } catch (e) { failed += 1; }
    }
    results.push({ column: `${t}.${c}`, ok, failed });
  }
  return results;
}

if (require.main === module) {
  const secretBox = require('../lib/secretBox');
  const { all, closeDatabase } = require('../db/database');
  const databaseName = process.env.DB_NAME || 'tradesage';
  (async () => {
    if (!secretBox.isConfigured()) {
      console.error('SOCIAL_TOKEN_ENCRYPTION_KEY is missing or not 32 bytes; stored credentials cannot be read.');
      process.exit(1);
    }
    const results = await verify({ all, databaseName, decrypt: v => secretBox.decrypt(v) });
    let failed = 0;
    for (const r of results) {
      console.log(`${r.column}: ${r.ok} readable, ${r.failed} unreadable`);
      failed += r.failed;
    }
    if (!results.length) console.log('No encrypted values found.');
    console.log(failed ? `FAILED: ${failed} value(s) cannot be decrypted with the configured key.` : 'OK: every encrypted value is readable with the configured key.');
    await closeDatabase();
    process.exit(failed ? 1 : 0);
  })().catch(async err => { console.error(err.message); await closeDatabase().catch(() => {}); process.exit(1); });
}

module.exports = { verify, NAME_HINT };
