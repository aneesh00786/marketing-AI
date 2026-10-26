/**
 * STAGING ONLY. Switches off, locally, every outward-facing integration copied from production, so
 * a staging copy cannot post, email or sync for real:
 *
 *   node scripts/stagingNeutralize.js            (dry run: lists what would change)
 *   node scripts/stagingNeutralize.js --confirm  (applies it)
 *
 * No provider is contacted: production OAuth grants are NOT revoked (disconnecting through the app
 * would revoke them at Meta/Google/LinkedIn and break production). Changes, all in this database:
 *   social accounts   -> disconnected, credentials deleted; their queued/processing posts cancelled
 *   mailboxes         -> passwords cleared, marketing approval removed, status "Not Configured"
 *   Zoho connections  -> disconnected, refresh token cleared
 *   product email batches queued/sending -> approved (not sending); outreach running -> paused;
 *   automation active -> paused
 * Allowed test integrations (STAGING_ALLOWED_* settings) are left alone. Refuses unless the staging
 * guard's environment checks pass (DEPLOYMENT_ENV=staging, not the production database or host).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mysql = require('mysql2/promise');
const { stagingProblems, integrationFindings } = require('../lib/stagingGuard');

const NOTE = 'Staging copy: switched off locally by stagingNeutralize (provider not contacted).';

(async () => {
  const confirm = process.argv.includes('--confirm');
  // Environment checks before connecting: never open a connection to a production-named database.
  const early = (await stagingProblems({ env: process.env, query: null, includeIntegrations: false })).problems.filter(p => !/^ZEPTOMAIL_TOKEN/.test(p));
  if (early.length) {
    for (const p of early) console.log(`Problem: ${p}`);
    console.log('REFUSED: this script runs only on a staging database (not connected).');
    process.exitCode = 1;
    return;
  }
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'tradesage'
  });
  const query = async (sql, params = []) => (await conn.query(sql, params))[0];
  try {
    // Every staging check except the integration findings (those are what this script fixes):
    // marker, production database name (configured and actually open), production server and hosts.
    const env = await stagingProblems({ env: process.env, query, includeIntegrations: false });
    const blocking = env.problems.filter(p => !/^ZEPTOMAIL_TOKEN/.test(p));
    if (blocking.length) {
      for (const p of blocking) console.log(`Problem: ${p}`);
      console.log('REFUSED: this script runs only on a staging database.');
      process.exitCode = 1;
      return;
    }
    const findings = await integrationFindings(query, process.env);
    console.log(`Database ${process.env.DB_NAME}: ${findings.length ? findings.map(f => f.text).join('; ') : 'no live integrations to switch off'}.`);
    if (!findings.length) return;
    if (!confirm) {
      console.log('Dry run: nothing changed. Re-run with --confirm to apply.');
      return;
    }
    const ids = key => findings.find(f => f.key === key)?.ids || [];
    const inList = list => list.map(() => '?').join(',');
    await conn.beginTransaction();
    const done = [];
    const social = ids('social_accounts');
    if (social.length) {
      const jobs = await query(`UPDATE publishing_jobs SET status = 'cancelled', last_error = ?, locked_by = NULL WHERE social_account_id IN (${inList(social)}) AND status IN ('queued', 'running', 'processing')`, [NOTE, ...social]);
      await query(`UPDATE content_items SET status = 'approved', scheduled_at = NULL, last_error = ? WHERE social_account_id IN (${inList(social)}) AND status IN ('scheduled', 'publishing')`, [NOTE, ...social]);
      const creds = (await query(`SELECT DISTINCT credential_id AS id FROM social_accounts WHERE id IN (${inList(social)}) AND credential_id IS NOT NULL`, social)).map(r => r.id);
      await query(`UPDATE social_accounts SET status = 'disconnected', credential_id = NULL, status_detail = ? WHERE id IN (${inList(social)})`, [NOTE, ...social]);
      for (const c of creds) {
        const still = await query('SELECT id FROM social_accounts WHERE credential_id = ? LIMIT 1', [c]);
        if (!still.length) await query('DELETE FROM provider_credentials WHERE id = ?', [c]);
      }
      done.push(`${social.length} social account(s) disconnected, ${jobs.affectedRows} queued/processing post(s) cancelled`);
    }
    // Posts still queued for accounts that were already disconnected: the worker would refuse them,
    // but cancelling keeps the staging queue clean.
    const orphan = await query(
      `UPDATE publishing_jobs j JOIN social_accounts a ON a.id = j.social_account_id
       SET j.status = 'cancelled', j.last_error = ?, j.locked_by = NULL
       WHERE a.status = 'disconnected' AND j.status IN ('queued', 'running', 'processing')`, [NOTE]);
    if (orphan.affectedRows) done.push(`${orphan.affectedRows} post(s) queued for already-disconnected accounts cancelled`);
    const mb = ids('mailboxes');
    if (mb.length) {
      await query(`UPDATE mail_configurations SET smtp_pass = NULL, imap_pass = NULL, marketing_approved = 0, status = 'Not Configured' WHERE id IN (${inList(mb)})`, mb);
      done.push(`${mb.length} mailbox password(s) cleared`);
    }
    const z = ids('zoho');
    if (z.length) {
      await query(`UPDATE mail_provider_connections SET status = 'disconnected', refresh_token_ciphertext = NULL, last_error = ? WHERE id IN (${inList(z)})`, [NOTE, ...z]);
      done.push(`${z.length} Zoho connection(s) disconnected`);
    }
    const b = ids('batches');
    if (b.length) {
      await query(`UPDATE mail_draft_batches SET status = 'approved', last_error = ? WHERE id IN (${inList(b)})`, [NOTE, ...b]);
      done.push(`${b.length} product email batch(es) stopped`);
    }
    const o = ids('outreach');
    if (o.length) {
      await query(`UPDATE outreach_campaigns SET status = 'paused' WHERE id IN (${inList(o)})`, o);
      done.push(`${o.length} outreach campaign(s) paused`);
    }
    const a = ids('automation');
    if (a.length) {
      await query(`UPDATE automation_workflows SET status = 'paused' WHERE id IN (${inList(a)})`, a);
      done.push(`${a.length} automation workflow(s) paused`);
    }
    await conn.commit();
    console.log(`Applied: ${done.join('; ')}.`);
    const left = await integrationFindings(query, process.env);
    console.log(left.length ? `Still present: ${left.map(f => f.text).join('; ')}` : 'No live integrations remain.');
    process.exitCode = left.length ? 1 : 0;
  } catch (err) {
    try { await conn.rollback(); } catch (e) { /* not in a transaction */ }
    throw err;
  } finally {
    await conn.end();
  }
})().catch(err => { console.error(`FAILED: ${err.message}`); process.exit(1); });
