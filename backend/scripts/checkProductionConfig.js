/**
 * Runs the API/worker startup checks without starting anything, so an operator can confirm the
 * configuration and folder permissions under each service account:
 *
 *   sudo -u <api-user>    node scripts/checkProductionConfig.js     (from backend/)
 *   sudo -u <worker-user> node scripts/checkProductionConfig.js
 *
 * Checks APP_BASE_URL, JWT_SECRET, SOCIAL_TOKEN_ENCRYPTION_KEY (format only), both media folders
 * (absolute and writable by this account) and pending migrations. Prints problems, never values.
 * Exit status 1 when the API/worker would refuse to start with NODE_ENV=production.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { checkConfig, enforceMigrated } = require('../lib/productionConfig');

(async () => {
  const { problems, warnings, storageRoot } = checkConfig(process.env);
  console.log(`NODE_ENV: ${process.env.NODE_ENV || '(not set)'}; account: ${require('os').userInfo().username}`);
  console.log(`Social media storage: ${storageRoot}`);
  for (const w of warnings) console.log(`Warning: ${w}`);
  for (const p of problems) console.log(`Problem: ${p}`);
  const m = await enforceMigrated('check', { NODE_ENV: 'check' }, { log: { warn: s => console.log(s.replace('[check] ', 'Problem: ')), error: console.log } });
  const bad = problems.length + (m.ok ? 0 : 1);
  console.log(bad ? `NOT READY: ${bad} problem(s).` : 'OK: the API and worker would start with this configuration.');
  try { await require('../db/database').closeDatabase(); } catch (e) { /* not opened */ }
  process.exit(bad ? 1 : 0);
})().catch(err => { console.error(err.message); process.exit(1); });
