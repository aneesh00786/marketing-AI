const { run, get, all } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const zoho = require('../zoho/zohoService');
const campaignContacts = require('../campaigns/campaignContacts');

/**
 * One-time copy of the Zoho Campaigns lists and contacts into Marketech.ai, run when Zoho is
 * connected (Settings → Connect, or Reconnect). Nothing syncs after that: lists are managed here.
 *
 * - Every Zoho list becomes (or updates) a Marketech.ai list of the same name, linked to its Zoho
 *   list. Lists Marketech.ai made for sending ("Marketech campaign …") are skipped.
 * - Each person is stored once per workspace (by email). Details already here are kept; empty ones
 *   are filled from Zoho.
 * - Status per list: subscribed, unsubscribed or bounced. Unsubscribed and bounced addresses are
 *   also added to the stop-list, so no email from Marketech.ai reaches them.
 * Safe to run again (it only adds and updates).
 */
const PAGE = 500;                 // Zoho returns up to ~650 per call
const MAX_PAGES_PER_STATUS = 200; // 100,000 contacts per list and status
const STATUSES = { active: 'subscribed', unsub: 'unsubscribed', bounce: 'bounced' };
const SUPPRESS = { unsubscribed: 'unsubscribed', bounced: 'bounced' };
const BATCH = 500;

const clean = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

async function readAll(workspaceId, listKey, status) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES_PER_STATUS; page++) {
    let data;
    try {
      data = await zoho.readCall(workspaceId, 'getlistsubscribers', { listkey: listKey, sort: 'asc', status, fromindex: String(page * PAGE + 1), range: String(PAGE) });
    } catch (err) {
      if (['2203', '995', '2502'].includes(err.providerCode)) break; // nothing (more) in this state
      throw err;
    }
    const got = Array.isArray(data.list_of_details) ? data.list_of_details : [];
    for (const c of got) {
      const email = String(c.contact_email || c.contactemailaddress || '').trim().toLowerCase();
      if (!email || email.length > 255 || !email.includes('@')) continue;
      rows.push({
        email,
        first: clean(c.firstname || c.contactfn, 100), last: clean(c.lastname || c.contactln, 100),
        company: clean(c.companyname, 200), phone: clean(c.phone, 50) || clean(c.mobile, 50),
        city: clean(c.city, 100), state: clean(c.state, 100), country: clean(c.country, 100)
      });
    }
    if (got.length < PAGE) break;
  }
  return rows;
}

/** Inserts or fills in contacts; returns email → id. */
async function upsertContacts(workspaceId, people) {
  const ids = new Map();
  for (let i = 0; i < people.length; i += BATCH) {
    const part = people.slice(i, i + BATCH);
    await run(
      `INSERT INTO mail_contacts (workspace_id, email, first_name, last_name, company, phone, city, state, country, source, in_zoho, created_at, updated_at)
       VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, 'zoho', 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())").join(',')}
       ON DUPLICATE KEY UPDATE first_name = COALESCE(first_name, VALUES(first_name)), last_name = COALESCE(last_name, VALUES(last_name)),
         company = COALESCE(company, VALUES(company)), phone = COALESCE(phone, VALUES(phone)), city = COALESCE(city, VALUES(city)),
         state = COALESCE(state, VALUES(state)), country = COALESCE(country, VALUES(country)), in_zoho = 1, updated_at = UTC_TIMESTAMP()`,
      part.flatMap(p => [workspaceId, p.email, p.first, p.last, p.company, p.phone, p.city, p.state, p.country])
    );
    const found = await all(`SELECT id, email FROM mail_contacts WHERE workspace_id = ? AND email IN (${part.map(() => '?').join(',')})`, [workspaceId, ...part.map(p => p.email)]);
    for (const r of found) ids.set(String(r.email).toLowerCase(), r.id);
  }
  return ids;
}

/** The Marketech.ai list for a Zoho list: matched by Zoho key, then by name; created if missing. */
async function localListFor(workspaceId, zl) {
  const name = String(zl.name || zl.key).slice(0, 150);
  let row = await get('SELECT id FROM mail_lists WHERE workspace_id = ? AND zoho_list_key = ?', [workspaceId, zl.key])
    || await get('SELECT id FROM mail_lists WHERE workspace_id = ? AND name = ?', [workspaceId, name]);
  if (row) {
    await run('UPDATE mail_lists SET zoho_list_key = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [zl.key, row.id]);
    return row.id;
  }
  const ins = await run("INSERT INTO mail_lists (workspace_id, name, source, zoho_list_key, created_at, updated_at) VALUES (?, ?, 'zoho', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())", [workspaceId, name, zl.key]);
  return ins.lastID;
}

async function importFromZoho(workspaceId) {
  const lists = (await campaignContacts.fetchLists(workspaceId)).filter(l => !campaignContacts.isSyncList(l.name));
  let contacts = 0, members = 0, optOuts = 0;
  for (const zl of lists) {
    const listId = await localListFor(workspaceId, zl);
    for (const [zohoStatus, status] of Object.entries(STATUSES)) {
      const people = await readAll(workspaceId, zl.key, zohoStatus);
      if (!people.length) continue;
      const ids = await upsertContacts(workspaceId, people);
      const pairs = people.map(p => ids.get(p.email)).filter(Boolean);
      for (let i = 0; i < pairs.length; i += BATCH) {
        const part = pairs.slice(i, i + BATCH);
        // An opt-out always wins over "subscribed"; a later "subscribed" never undoes it.
        await run(
          `INSERT INTO mail_list_members (list_id, contact_id, status, added_at) VALUES ${part.map(() => '(?, ?, ?, UTC_TIMESTAMP())').join(',')}
           ON DUPLICATE KEY UPDATE status = IF(VALUES(status) = 'subscribed', status, VALUES(status))`,
          part.flatMap(id => [listId, id, status])
        );
      }
      members += pairs.length;
      if (status === 'subscribed') contacts += pairs.length;
      if (SUPPRESS[status]) {
        for (const p of people) {
          const r = await run("INSERT IGNORE INTO email_suppressions (workspace_id, email, reason, source, created_at) VALUES (?, ?, ?, 'zoho_campaigns', UTC_TIMESTAMP())", [workspaceId, p.email, SUPPRESS[status]]);
          optOuts += r.changes || 0;
        }
      }
    }
  }
  const total = await get('SELECT COUNT(*) AS n FROM mail_contacts WHERE workspace_id = ?', [workspaceId]);
  return { lists: lists.length, contacts: Number(total.n), memberships: members, subscribed: contacts, optOutsAdded: optOuts };
}

/** Background job handler (worker). */
async function runImportJob(job) {
  const result = await importFromZoho(job.workspace_id);
  await audit({ auth: { workspaceId: job.workspace_id, actorType: 'worker' } }, 'mail.zoho_contacts_imported', { resourceType: 'mail_provider', resourceId: 'zoho_campaigns', metadata: result });
  return result;
}

/** Queues the one-time import (on connect). */
async function queueImport(workspaceId, userId) {
  const jobs = require('../../social/jobsService');
  return jobs.enqueue(workspaceId, 'zoho_contact_sync', {}, { idempotencyKey: `zoho_contact_sync:${Date.now()}`, createdBy: userId || null, maxAttempts: 3 });
}

/** The latest import, for the status line on Contact lists. */
async function importStatus(workspaceId) {
  const job = await get("SELECT id, status, last_error, result_json, created_at, completed_at FROM background_jobs WHERE workspace_id = ? AND job_type = 'zoho_contact_sync' ORDER BY id DESC LIMIT 1", [workspaceId]);
  if (!job) return { status: 'never' };
  let result = null;
  try { result = job.result_json ? JSON.parse(job.result_json) : null; } catch { result = null; }
  return { status: job.status, startedAt: job.created_at, finishedAt: job.completed_at, error: job.status === 'failed' ? String(job.last_error || '').slice(0, 300) : null, result };
}

module.exports = { importFromZoho, runImportJob, queueImport, importStatus };
