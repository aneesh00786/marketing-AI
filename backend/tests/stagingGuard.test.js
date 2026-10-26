const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { stagingProblems, enforceStaging } = require('../lib/stagingGuard');

// Staging-only operations must refuse anything that could be production.
const STAGING = { DEPLOYMENT_ENV: 'staging', DB_NAME: 'tradesage_staging', PRODUCTION_DB_NAME: 'tradesage', PRODUCTION_APP_HOST: 'app.marketech.example', PRODUCTION_DB_HOSTNAME: 'prod-db-1', APP_BASE_URL: 'https://staging.marketech.example', FRONTEND_URL: 'https://staging.marketech.example' };

/** Fake database answering the guard's three queries. */
function fakeDb({ host = 'staging-db', openDb = 'tradesage_staging', accounts = [], overdue = [], tables = 0, mailboxes = [], zoho = [], batches = [], outreach = [], automation = [] } = {}) {
  return async (sql) => {
    if (sql.includes('@@hostname')) return [{ host, db: openDb }];
    if (sql.includes('information_schema.TABLES')) return [{ n: tables }];
    if (sql.includes('FROM social_accounts')) return accounts;
    if (sql.includes('FROM publishing_jobs')) return overdue;
    if (sql.includes('FROM mail_configurations')) return mailboxes;
    if (sql.includes('FROM mail_provider_connections')) return zoho;
    if (sql.includes('FROM mail_draft_batches')) return batches;
    if (sql.includes('FROM outreach_campaigns')) return outreach;
    if (sql.includes('FROM automation_workflows')) return automation;
    throw new Error(`unexpected query ${sql}`);
  };
}

test.before(async () => { await h.prepareDatabase(); });
test.after(() => h.shutdown());

test('a correctly isolated staging environment passes', async () => {
  const r = await stagingProblems({ env: STAGING, query: fakeDb({ accounts: [{ id: 1, provider_key: 'meta', account_type: 'facebook_page', external_account_id: 'demo_page' }] }) });
  assert.deepEqual(r.problems, []);
});

test('the staging marker, the production database name and production hosts are refused', async () => {
  const p = async (env, db = fakeDb()) => (await stagingProblems({ env: { ...STAGING, ...env }, query: db })).problems.join(' | ');
  assert.match(await p({ DEPLOYMENT_ENV: '' }), /staging-only operation/);
  assert.match(await p({ DEPLOYMENT_ENV: 'production' }), /staging-only operation/);
  assert.match(await p({ DB_NAME: 'tradesage' }), /production database name/);
  assert.match(await p({ DB_NAME: '' }), /production database name/, 'an unset DB_NAME defaults to the production name');
  assert.match(await p({ APP_BASE_URL: 'https://app.marketech.example' }), /APP_BASE_URL points at the production host/);
  assert.match(await p({ FRONTEND_URL: 'https://APP.marketech.example/x' }), /FRONTEND_URL points at the production host/);
  assert.match(await p({}, fakeDb({ host: 'PROD-DB-1' })), /production server/);
  const unknown = await stagingProblems({ env: { ...STAGING, PRODUCTION_APP_HOST: '', PRODUCTION_DB_HOSTNAME: '' }, query: fakeDb() });
  assert.equal(unknown.problems.filter(p => /PRODUCTION_(APP_HOST|DB_HOSTNAME) is not set/.test(p)).length, 2, 'without production identifiers the guard fails closed');
});

test('non-test social accounts block the staging worker; demo and allowlisted accounts do not', async () => {
  const accounts = [
    { id: 1, provider_key: 'meta', account_type: 'facebook_page', external_account_id: 'demo_page_1' },
    { id: 2, provider_key: 'linkedin', account_type: 'linkedin_organization', external_account_id: '111' },
    { id: 3, provider_key: 'meta', account_type: 'instagram_business', external_account_id: '999' }
  ];
  const refused = await stagingProblems({ env: STAGING, query: fakeDb({ accounts }) });
  assert.match(refused.problems.join(' '), /2 connected social account\(s\).*#2 linkedin.*#3 meta/);
  const allowed = await stagingProblems({ env: { ...STAGING, STAGING_ALLOWED_SOCIAL_ACCOUNTS: '111, 999' }, query: fakeDb({ accounts }) });
  assert.deepEqual(allowed.problems, []);
  const overdue = await stagingProblems({ env: { ...STAGING, STAGING_ALLOWED_SOCIAL_ACCOUNTS: '111,999' }, query: fakeDb({ accounts, overdue: [{ ext: 'demo_page_1', n: 2 }, { ext: '111', n: 1 }] }) });
  assert.ok(overdue.warnings.some(w => /2 overdue queued post\(s\) on demo accounts.*DEMO_ACCOUNT/.test(w)));
  assert.ok(overdue.warnings.some(w => /1 overdue queued post\(s\) on allowed test accounts will publish/.test(w)));
});

test('a restore may only target a new, empty, non-production database', async () => {
  const p = async (target, tables = 0) => (await stagingProblems({ env: STAGING, query: fakeDb({ tables }), restoreTarget: target })).problems.join(' | ');
  assert.equal(await p('tradesage_restore_staging'), '');
  assert.match(await p('tradesage'), /production database name/);
  assert.match(await p(''), /production database name/);
  assert.match(await p('tradesage_restore_staging', 12), /already contains tables/);
});

test('against a real database holding non-demo accounts, the staging worker refuses to start', async () => {
  const W = await h.createWorkspace({ name: 'Staging guard' });
  await h.createAccount(W.workspaceId, { accountType: 'facebook_page', externalId: `realpage${Date.now()}` });
  const exits = [];
  const quiet = { log() {}, warn() {}, error() {} };
  const r = await enforceStaging('social-worker', { env: { ...STAGING, DB_NAME: 'tradesage_test' }, query: (sql, params) => h.db().all(sql, params), exit: c => exits.push(c), log: quiet });
  assert.equal(r.ok, false);
  assert.deepEqual(exits, [1]);
  const skipped = await enforceStaging('social-worker', { env: { NODE_ENV: 'production' }, query: () => { throw new Error('must not query'); }, exit: c => exits.push(c), log: quiet });
  assert.equal(skipped.skipped, true, 'production startup is unchanged by the staging guard');
  assert.deepEqual(exits, [1]);
});

test('copied production mailboxes, Zoho, queued sends and active automations block staging; allowed ones do not', async () => {
  const db = fakeDb({ mailboxes: [{ id: 1, sender_email: 'sales@customer.com' }, { id: 2, sender_email: 'qa@staging.test' }], zoho: [{ id: 4 }], batches: [{ id: 7 }], outreach: [{ id: 8 }], automation: [{ id: 9 }] });
  const r = await stagingProblems({ env: STAGING, query: db });
  const text = r.problems.join(' | ');
  assert.match(text, /2 mailbox\(es\) with stored passwords/);
  assert.match(text, /1 connected Zoho Campaigns account/);
  assert.match(text, /1 product email batch\(es\) queued or sending/);
  assert.match(text, /1 outreach campaign\(s\) running/);
  assert.match(text, /1 automation workflow\(s\) active/);
  assert.match(text, /stagingNeutralize/);
  const allowed = await stagingProblems({ env: { ...STAGING, STAGING_ALLOWED_MAILBOXES: 'QA@staging.test', STAGING_ALLOW_ZOHO: '1' }, query: db });
  assert.match(allowed.problems.join(' | '), /1 mailbox\(es\)/, 'only the non-allowlisted mailbox remains');
  assert.doesNotMatch(allowed.problems.join(' | '), /Zoho/);
});

test('a production ZeptoMail token on staging is refused unless explicitly allowed', async () => {
  const r = await stagingProblems({ env: { ...STAGING, ZEPTOMAIL_TOKEN: 'x' }, query: fakeDb() });
  assert.match(r.problems.join(' '), /ZEPTOMAIL_TOKEN is set/);
  const ok = await stagingProblems({ env: { ...STAGING, ZEPTOMAIL_TOKEN: 'x', STAGING_ALLOW_ZEPTOMAIL: '1' }, query: fakeDb() });
  assert.deepEqual(ok.problems, []);
});

test('database names compare case-insensitively, and the database actually open is checked', async () => {
  const p = async (env, db = fakeDb()) => (await stagingProblems({ env: { ...STAGING, ...env }, query: db })).problems.join(' | ');
  assert.match(await p({ DB_NAME: 'TRADESAGE' }), /production database name/, 'MariaDB on macOS/Windows opens tradesage for TRADESAGE');
  assert.match(await p({ DB_NAME: ' Tradesage ' }), /production database name/);
  assert.match(await p({}, fakeDb({ openDb: 'TradeSage' })), /open database is "TradeSage", the production database/);
  const restore = async (t) => (await stagingProblems({ env: STAGING, query: fakeDb(), restoreTarget: t })).problems.join(' | ');
  assert.match(await restore('TRADESAGE'), /production database name/);
});

test('an unexpected schema fails closed instead of being treated as "no integrations"', async () => {
  const broken = async (sql) => {
    if (sql.includes('@@hostname')) return [{ host: 'staging-db', db: 'tradesage_staging' }];
    if (sql.includes('FROM mail_configurations')) throw Object.assign(new Error('Unknown column smtp_pass'), { code: 'ER_BAD_FIELD_ERROR' });
    if (sql.includes('FROM social_accounts')) throw Object.assign(new Error("Table doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
    return [];
  };
  await assert.rejects(stagingProblems({ env: STAGING, query: broken }), /Unknown column/);
});

test('preflight and neutralize refuse a production-named database without connecting to it', () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  // Port 1 has nothing listening: any connection attempt would surface as a connection error instead.
  const env = { ...process.env, ...STAGING, DB_NAME: 'TRADESAGE', DB_HOST: '127.0.0.1', DB_PORT: '1' };
  for (const [script, args] of [['stagingPreflight.js', []], ['stagingPreflight.js', ['--restore-target', 'TradeSage']], ['stagingNeutralize.js', ['--confirm']]]) {
    const r = spawnSync(process.execPath, [path.join(__dirname, '../scripts', script), ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 1, `${script} must refuse`);
    assert.match(r.stdout, /production database name/, `${script} refuses on the name`);
    assert.match(r.stdout, /not connected/, `${script} refuses before connecting`);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /ECONNREFUSED/, `${script} did not try to connect`);
  }
});
