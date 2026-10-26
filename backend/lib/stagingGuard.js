/**
 * Staging-only operations (restore drills, starting the API or worker on staging, live platform
 * tests) must never act on production. The guard refuses unless all of the following hold:
 *
 *   - DEPLOYMENT_ENV=staging is set (staging still runs with NODE_ENV=production, so every
 *     production safeguard stays active; this marker only adds checks).
 *   - DB_NAME is not the production database name (PRODUCTION_DB_NAME, default "tradesage").
 *   - The database server is not the production server (PRODUCTION_DB_HOSTNAME vs @@hostname) and
 *     APP_BASE_URL/FRONTEND_URL are not the production host (PRODUCTION_APP_HOST). When these are
 *     not configured the guard warns that it cannot tell.
 *   - The database holds no live outward-facing integration that is not explicitly allowed. A copy
 *     of production data still holds production social accounts, mailbox passwords, Zoho
 *     connections and queued sends; from staging they would post or email for real:
 *       social accounts      demo or listed in STAGING_ALLOWED_SOCIAL_ACCOUNTS (external ids)
 *       mailboxes            no stored password, or sender in STAGING_ALLOWED_MAILBOXES
 *       Zoho connections     none connected, unless STAGING_ALLOW_ZOHO=1
 *       product email batches, outreach campaigns, automation workflows: none sending/running/active
 *       ZEPTOMAIL_TOKEN      not set, unless STAGING_ALLOW_ZEPTOMAIL=1 (e.g. a sandbox token)
 *     scripts/stagingNeutralize.js switches these off locally, without calling any provider.
 *   - A restore target (when given) is not the production name and is empty.
 *
 * Only names, counts and ids are reported — never credentials or setting values beyond host names.
 */
function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return null; }
}

function listEnv(value) {
  return new Set(String(value || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

/** Rows for a query, or [] when the table does not exist in this (older) schema. */
async function rows(query, sql, params) {
  try {
    return await query(sql, params);
  } catch (e) {
    // A missing table means the feature does not exist in this schema. Anything else (e.g. an
    // unexpected column) means the state is unknown: fail closed by rethrowing.
    if (e.code === 'ER_NO_SUCH_TABLE') return [];
    throw e;
  }
}

/** Database names compare case-insensitively: MariaDB on macOS/Windows resolves "TRADESAGE" to "tradesage". */
const sameDb = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** Live outward-facing integrations in the database that staging is not allowed to use. */
async function integrationFindings(query, env = process.env) {
  const allowedAccounts = listEnv(env.STAGING_ALLOWED_SOCIAL_ACCOUNTS);
  const allowedMailboxes = listEnv(env.STAGING_ALLOWED_MAILBOXES);
  const out = [];

  const accounts = (await rows(query, "SELECT id, provider_key, account_type, external_account_id FROM social_accounts WHERE status <> 'disconnected'"))
    .filter(a => !/^demo_/.test(String(a.external_account_id)) && !allowedAccounts.has(String(a.external_account_id).toLowerCase()));
  if (accounts.length) out.push({ key: 'social_accounts', ids: accounts.map(a => a.id), text: `${accounts.length} connected social account(s) that are not demo accounts and not in STAGING_ALLOWED_SOCIAL_ACCOUNTS: ${accounts.slice(0, 10).map(a => `#${a.id} ${a.provider_key}/${a.account_type}`).join(', ')}` });

  const mailboxes = (await rows(query, "SELECT id, sender_email FROM mail_configurations WHERE (smtp_pass IS NOT NULL AND smtp_pass <> '') OR (imap_pass IS NOT NULL AND imap_pass <> '')"))
    .filter(m => !allowedMailboxes.has(String(m.sender_email || '').toLowerCase()));
  if (mailboxes.length) out.push({ key: 'mailboxes', ids: mailboxes.map(m => m.id), text: `${mailboxes.length} mailbox(es) with stored passwords not in STAGING_ALLOWED_MAILBOXES (ids ${mailboxes.slice(0, 10).map(m => `#${m.id}`).join(', ')})` });

  if (env.STAGING_ALLOW_ZOHO !== '1') {
    const zoho = await rows(query, "SELECT id FROM mail_provider_connections WHERE status = 'connected'");
    if (zoho.length) out.push({ key: 'zoho', ids: zoho.map(z => z.id), text: `${zoho.length} connected Zoho Campaigns account(s)` });
  }
  const batches = await rows(query, "SELECT id FROM mail_draft_batches WHERE status IN ('queued', 'sending')");
  if (batches.length) out.push({ key: 'batches', ids: batches.map(b => b.id), text: `${batches.length} product email batch(es) queued or sending` });
  const campaigns = await rows(query, "SELECT id FROM outreach_campaigns WHERE status = 'running'");
  if (campaigns.length) out.push({ key: 'outreach', ids: campaigns.map(c => c.id), text: `${campaigns.length} outreach campaign(s) running` });
  const workflows = await rows(query, "SELECT id FROM automation_workflows WHERE status = 'active'");
  if (workflows.length) out.push({ key: 'automation', ids: workflows.map(w => w.id), text: `${workflows.length} automation workflow(s) active` });
  return out;
}

async function stagingProblems({ env = process.env, query, restoreTarget = null, includeIntegrations = true } = {}) {
  const problems = [];
  const warnings = [];
  const prodDb = (env.PRODUCTION_DB_NAME || 'tradesage').trim();
  const dbName = (env.DB_NAME || 'tradesage').trim();

  if (env.DEPLOYMENT_ENV !== 'staging') {
    problems.push('This is a staging-only operation: set DEPLOYMENT_ENV=staging in the staging backend/.env (never in production).');
  }
  if (sameDb(dbName, prodDb)) problems.push(`DB_NAME is "${dbName}", the production database name. Staging must use its own database (e.g. ${prodDb}_staging).`);

  // Fail closed: without the production identifiers the guard cannot tell staging from production.
  const prodApp = (env.PRODUCTION_APP_HOST || '').trim().toLowerCase();
  if (!prodApp) problems.push('PRODUCTION_APP_HOST is not set: set it to the production app hostname so the guard can prove APP_BASE_URL/FRONTEND_URL are not production.');
  for (const k of ['APP_BASE_URL', 'FRONTEND_URL']) {
    const h = hostOf(env[k] || '');
    if (prodApp && h === prodApp) problems.push(`${k} points at the production host (${h}).`);
  }
  if (restoreTarget === null && (env.ZEPTOMAIL_TOKEN || '').trim() && env.STAGING_ALLOW_ZEPTOMAIL !== '1') {
    problems.push('ZEPTOMAIL_TOKEN is set: staging would send real transactional email (invitations, drafts). Remove it, or set STAGING_ALLOW_ZEPTOMAIL=1 for a sandbox token.');
  }

  if (restoreTarget !== null) {
    if (!restoreTarget || sameDb(restoreTarget, prodDb)) problems.push(`Restore target "${restoreTarget}" is the production database name; restore into a separate staging database.`);
  }

  if (query) {
    const [server] = await query('SELECT @@hostname AS host, DATABASE() AS db');
    const prodHost = (env.PRODUCTION_DB_HOSTNAME || '').trim().toLowerCase();
    if (!prodHost) problems.push('PRODUCTION_DB_HOSTNAME is not set: set it to the production database server\'s @@hostname so the guard can prove this is not the production server.');
    else if (String(server?.host || '').toLowerCase() === prodHost) problems.push(`The database server (${server.host}) is the production server.`);
    // The database actually opened, not just the configured name, must not be production.
    if (server?.db && sameDb(server.db, prodDb)) problems.push(`The open database is "${server.db}", the production database.`);

    if (restoreTarget) {
      const tables = await query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [restoreTarget]);
      if (Number(tables[0]?.n || 0) > 0) problems.push(`Restore target "${restoreTarget}" already contains tables; restore only into a new, empty database.`);
    } else if (includeIntegrations) {
      for (const f of await integrationFindings(query, env)) {
        problems.push(`${f.text}. Run "node scripts/stagingNeutralize.js --confirm" to switch them off locally (no provider is contacted), or allow dedicated test integrations explicitly.`);
      }
      const overdue = await rows(query,
        `SELECT a.external_account_id AS ext, COUNT(*) AS n FROM publishing_jobs j JOIN social_accounts a ON a.id = j.social_account_id
         WHERE j.status = 'queued' AND j.next_attempt_at <= UTC_TIMESTAMP() GROUP BY a.external_account_id`);
      const demoOverdue = overdue.filter(o => /^demo_/.test(String(o.ext))).reduce((n, o) => n + Number(o.n), 0);
      const liveOverdue = overdue.filter(o => !/^demo_/.test(String(o.ext))).reduce((n, o) => n + Number(o.n), 0);
      if (demoOverdue) warnings.push(`${demoOverdue} overdue queued post(s) on demo accounts: the worker refuses them (DEMO_ACCOUNT) without contacting any platform.`);
      if (liveOverdue) warnings.push(`${liveOverdue} overdue queued post(s) on allowed test accounts will publish as soon as the worker starts. Cancel any that should not.`);
    }
  }
  return { problems, warnings, prodDb, dbName };
}

/** API and worker startup on staging: refuse to run while the guard finds a problem. */
async function enforceStaging(processName, { env = process.env, query, exit = (code) => process.exit(code), log = console } = {}) {
  if (env.DEPLOYMENT_ENV !== 'staging') return { ok: true, skipped: true };
  const r = await stagingProblems({ env, query });
  for (const w of r.warnings) log.warn(`[${processName}] Staging warning: ${w}`);
  if (!r.problems.length) return { ok: true };
  for (const p of r.problems) log.error(`[${processName}] Staging guard: ${p}`);
  log.error(`[${processName}] Refusing to start on staging.`);
  exit(1);
  return { ok: false, problems: r.problems };
}

module.exports = { stagingProblems, enforceStaging, integrationFindings };
