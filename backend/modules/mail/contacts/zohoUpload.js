const { run, get, all } = require('../../../db/database');
const zoho = require('../zoho/zohoService');
const campaignContacts = require('../campaigns/campaignContacts');
const consent = require('./consent');

/**
 * Sending a campaign to Marketech.ai lists (worker job "zoho_campaign_upload"):
 * 1. Each chosen list becomes a Zoho list with the same name (or "<name> - Marketech <id>-<version>"
 *    when Zoho already has a list of that name, which is never touched), holding everyone in it who
 *    can be emailed: subscribed and not on the stop-list. Zoho takes 10 addresses per call.
 * 2. People not in Zoho yet get their names sent too, so Zoho's name merge tags work.
 * 3. The campaign is delivered (created in Zoho with these lists, then sent).
 * 4. Once Zoho reports the campaign Sent, cleanupTempLists() saves the lists' unsubscribes and
 *    bounces in the stop-list and deletes the temporary Zoho lists. The contacts stay in Zoho.
 * A failure before step 3 leaves the campaign "not sent"; sending again reuses what was uploaded.
 */
const BULK = 10;
const PROGRESS_EVERY = 20;   // batches between progress updates
const NAME_CONCURRENCY = 4;
const EMPTY = ['2203', '995', '2502'];

const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

/**
 * Everyone in a list who may get the campaign, once each: subscribed, not on the stop-list, and with
 * marketing consent (see consent.js). consent_info: how and when consent was given, for Zoho's source.
 */
async function reachable(workspaceId, listId) {
  return all(
    `SELECT DISTINCT c.id, c.email, c.first_name, c.last_name, c.company, c.in_zoho, c.source, ${consent.consentInfoSql('c')} AS consent_info
     FROM mail_list_members m JOIN mail_contacts c ON c.id = m.contact_id
     LEFT JOIN email_suppressions s ON s.workspace_id = c.workspace_id AND s.email = c.email
     WHERE m.list_id = ? AND c.workspace_id = ? AND m.status = 'subscribed' AND s.email IS NULL AND ${consent.eligibleSql('c')}
     ORDER BY c.id`, [listId, workspaceId]);
}

/** How many subscribed, not stopped people in a list are left out for lack of marketing consent. */
async function withoutConsent(workspaceId, listId) {
  const r = await get(
    `SELECT COUNT(DISTINCT c.id) AS n FROM mail_list_members m JOIN mail_contacts c ON c.id = m.contact_id
     LEFT JOIN email_suppressions s ON s.workspace_id = c.workspace_id AND s.email = c.email
     WHERE m.list_id = ? AND c.workspace_id = ? AND m.status = 'subscribed' AND s.email IS NULL AND NOT ${consent.eligibleSql('c')}`, [listId, workspaceId]);
  return Number(r?.n) || 0;
}

/** Creates the temporary Zoho list with its first addresses (or finds the one an earlier try made). */
async function createZohoList(workspaceId, name, first, ownKeys) {
  try {
    const res = await zoho.writeCall(workspaceId, 'addlistandcontacts', { listname: name, emailids: first.map(c => c.email).join(','), signupform: 'private', mode: 'newlist' });
    const key = String(res.listkey || '');
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(key)) throw Object.assign(new Error('Zoho did not return the new list.'), { status: 502, code: 'ZOHO_BAD_RESPONSE' });
    return key;
  } catch (err) {
    if (err.providerCode !== '2205') throw err;
    const hit = (await campaignContacts.fetchLists(workspaceId)).find(l => l.name === name);
    if (hit && ownKeys.includes(hit.key)) return hit.key; // made by an earlier try of this send
    throw err;
  }
}

/**
 * Sends names for people Zoho does not know yet (best effort: the merge tag default is used otherwise).
 * Stops at the first reply saying Zoho emailed a confirmation (see campaignContacts.subscribeName).
 */
async function sendNames(workspaceId, listKey, people, { topicId = null } = {}) {
  const state = { sent: 0, failed: 0, confirmations: 0, stopped: false, skipped: 0 };
  if (!zoho.canSyncNames(await zoho.connectionRow(workspaceId))) return state;
  const todo = people.map(p => ({ p, n: campaignContacts.greetingName({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), company: p.company }) })).filter(x => x.n);
  const info = ({ p, n }) => ({ 'Contact Email': p.email, 'First Name': n.first, ...(n.last ? { 'Last Name': n.last } : {}) });
  // Zoho's documented contact source carries how and when consent was given; topic_id the campaign's topic.
  const extra = ({ p }) => ({ source: consent.zohoSource(p.consent_info), ...(topicId ? { topic_id: String(topicId) } : {}) });
  let next = 0;
  // One at a time until Zoho shows whether it asks for confirmations, then in parallel.
  if (todo.length) { const x = todo[next++]; await campaignContacts.subscribeName(workspaceId, listKey, info(x), state, extra(x)); }
  const worker = async () => {
    while (next < todo.length) { const x = todo[next++]; await campaignContacts.subscribeName(workspaceId, listKey, info(x), state, extra(x)); }
  };
  await Promise.all(Array.from({ length: Math.min(NAME_CONCURRENCY, todo.length) }, worker));
  if (process.env.ZOHO_LOG !== 'off' && (state.sent || state.failed)) {
    console.log(`[zoho] ${new Date().toISOString()} listsubscribe names listkey="${listKey}" sent=${state.sent} failed=${state.failed} confirmationsAsked=${state.confirmations} stoppedAfterConfirmation=${state.stopped}`);
  }
  return state;
}

/**
 * What Zoho reports for the lists of a send: it emails only contacts it shows as "active"; the others
 * are unsubscribed, bounced, or not active yet (new contacts it is still reviewing, or waiting for
 * them to confirm). Counts per state are read up to COUNT_CAP each. No addresses are kept.
 */
const COUNT_CAP = 500;
async function countInState(workspaceId, key, status) {
  let n = 0;
  for (let page = 1; ; page++) {
    const r = await campaignContacts.readListPage(workspaceId, key, status, page);
    n += r.contacts.length;
    if (!r.hasMore) return { n, capped: false };
    if (n >= COUNT_CAP) return { n, capped: true };
  }
}
async function listReadiness(workspaceId, keys) {
  const byKey = new Map((await campaignContacts.fetchLists(workspaceId)).map(l => [l.key, l]));
  const lists = [];
  for (const key of [...new Set(keys)]) {
    const l = byKey.get(key);
    const [active, unsubscribed, bounced] = [await countInState(workspaceId, key, 'active'), await countInState(workspaceId, key, 'unsub'), await countInState(workspaceId, key, 'bounce')];
    lists.push({ name: l?.name || null, total: l ? l.contacts : null, active: active.n, unsubscribed: unsubscribed.n, bounced: bounced.n, capped: active.capped || unsubscribed.capped || bounced.capped });
  }
  const sum = f => lists.reduce((n, x) => n + (x[f] || 0), 0);
  const total = lists.length && lists.every(x => x.total != null) ? sum('total') : null;
  const r = { checkedAt: new Date().toISOString(), lists, total, active: sum('active'), unsubscribed: sum('unsubscribed'), bounced: sum('bounced'), capped: lists.some(x => x.capped) };
  r.notActive = total != null ? Math.max(0, total - r.active - r.unsubscribed - r.bounced) : null;
  if (process.env.ZOHO_LOG !== 'off') console.log(`[zoho] ${r.checkedAt} readiness lists=${lists.length} total=${total ?? 'unknown'} active=${r.active} notActive=${r.notActive ?? 'unknown'} unsubscribed=${r.unsubscribed} bounced=${r.bounced}`);
  return r;
}

/** Saves the readiness (and name-update outcome) on the campaign. */
async function saveReadiness(campaignId, readiness, names = null) {
  const prev = await get('SELECT zoho_readiness_json FROM mail_campaigns WHERE id = ?', [campaignId]);
  const keep = parse(prev?.zoho_readiness_json, {});
  const value = { ...readiness, names: names || keep.names || null, consent: keep.consent || null };
  await run('UPDATE mail_campaigns SET zoho_readiness_json = ? WHERE id = ?', [JSON.stringify(value), campaignId]);
  return value;
}

async function uploadLists(row) {
  const workspaceId = row.workspace_id;
  const listIds = parse(row.mail_list_ids_json, []);
  const lists = listIds.length ? await all(`SELECT id, name FROM mail_lists WHERE workspace_id = ? AND id IN (${listIds.map(() => '?').join(',')})`, [workspaceId, ...listIds]) : [];
  lists.sort((x, y) => listIds.indexOf(x.id) - listIds.indexOf(y.id)); // in the order chosen
  const people = new Map();
  for (const l of lists) people.set(l.id, await reachable(workspaceId, l.id));
  const total = [...people.values()].reduce((n, p) => n + p.length, 0);
  await run('UPDATE mail_campaigns SET upload_total = ?, upload_done = 0 WHERE id = ?', [total, row.id]);

  const temp = parse(row.temp_lists_json, []);
  const existing = new Set((await campaignContacts.fetchLists(workspaceId)).map(l => l.name));
  const names = { sent: 0, failed: 0, confirmations: 0 };
  const consentCount = { uploaded: total, noConsent: 0 };
  for (const l of lists) consentCount.noConsent += await withoutConsent(workspaceId, l.id);
  let done = 0;
  for (const l of lists) {
    const list = people.get(l.id);
    if (!list.length) continue;
    const already = temp.find(t => t.listId === l.id);
    const name = already ? already.name : (existing.has(l.name) ? `${l.name} - Marketech ${row.id}-${row.version}` : l.name).slice(0, 100);
    const key = await createZohoList(workspaceId, name, list.slice(0, BULK), temp.map(t => t.key));
    if (!already || already.key !== key) {
      // New, or made again because the earlier one was deleted in Zoho: always send to the current list.
      if (already) already.key = key; else temp.push({ listId: l.id, name, key });
      await run('UPDATE mail_campaigns SET temp_lists_json = ?, temp_lists_deleted_at = NULL WHERE id = ?', [JSON.stringify(temp), row.id]);
    }
    done += Math.min(BULK, list.length);
    for (let i = BULK, b = 0; i < list.length; i += BULK, b++) {
      const part = list.slice(i, i + BULK);
      await zoho.writeCall(workspaceId, 'addlistsubscribersinbulk', { listkey: key, emailids: part.map(c => c.email).join(',') });
      done += part.length;
      if (b % PROGRESS_EVERY === 0) await run('UPDATE mail_campaigns SET upload_done = ? WHERE id = ?', [done, row.id]);
    }
    const n = await sendNames(workspaceId, key, list.filter(c => !c.in_zoho), { topicId: row.topic_id || null });
    names.sent += n.sent; names.failed += n.failed; names.confirmations += n.confirmations;
    const ids = list.map(c => c.id);
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      await run(`UPDATE mail_contacts SET in_zoho = 1 WHERE id IN (${part.map(() => '?').join(',')})`, part);
    }
  }
  await run('UPDATE mail_campaigns SET upload_done = ? WHERE id = ?', [done, row.id]);
  await run('UPDATE mail_campaigns SET zoho_readiness_json = ? WHERE id = ?', [JSON.stringify({ names, consent: consentCount }), row.id]);
  return temp.map(t => t.key);
}

/**
 * Zoho adds contacts in the background, and may hold contacts that are new to it (review, or waiting
 * for them to confirm by email). A campaign whose lists have nobody Zoho can email is refused by Zoho
 * ("No lists selected"), so after the upload this waits until at least one uploaded list has
 * contacts in Zoho, up to ZOHO_LIST_WAIT_MS. Lists whose count Zoho does not report are not waited for.
 */
async function waitForZohoContacts(workspaceId, keys) {
  const limit = Math.max(0, Number(process.env.ZOHO_LIST_WAIT_MS ?? 60000));
  const step = Math.min(5000, Math.max(250, limit / 6));
  const started = Date.now();
  for (;;) {
    const byKey = new Map((await campaignContacts.fetchLists(workspaceId)).map(l => [l.key, l]));
    const counts = keys.map(k => byKey.get(k)).filter(Boolean);
    if (!counts.length || counts.some(l => l.contacts === null || l.contacts > 0)) return { ok: true };
    if (Date.now() - started >= limit) return { ok: false, lists: counts.map(l => l.name).filter(Boolean) };
    await new Promise(r => setTimeout(r, step));
  }
}

const listsEmptyError = names => Object.assign(new Error(
  `Zoho has not accepted any of the uploaded contacts yet (${names.length ? `Zoho list ${names.map(n => `"${n}"`).join(', ')}` : 'the uploaded list'} has 0 contacts), so nothing was sent. `
  + 'Zoho may hold contacts that are new to it for review, or until they confirm by email. Check Zoho Campaigns → Contacts, then send again; what was uploaded is reused.'),
{ status: 409, code: 'ZOHO_LISTS_EMPTY' });

/** Worker job: upload, then deliver. Errors leave the campaign "not sent" with the reason. */
async function runUploadJob(job) {
  const svc = require('../campaigns/campaignService');
  const { campaignId, version } = JSON.parse(job.payload_json || '{}');
  const row = await get('SELECT * FROM mail_campaigns WHERE id = ? AND workspace_id = ?', [campaignId, job.workspace_id]);
  if (!row || row.status !== 'submitting' || row.submit_stage !== 'upload' || row.version !== version) return { skipped: true };
  const ctx = { auth: { workspaceId: row.workspace_id, userId: row.submitted_by, actorType: 'worker', capabilities: new Set(['mail.send']) } };
  let keys;
  try {
    keys = await uploadLists(row);
    const ready = keys.length ? await waitForZohoContacts(row.workspace_id, keys) : { ok: false, lists: [] };
    // What Zoho shows for these contacts (active = emailable now), kept and shown with the campaign.
    // A failed count (e.g. a missing permission) never stops the send: it is just not shown.
    if (ready.ok && keys.length) {
      try { await saveReadiness(row.id, await listReadiness(row.workspace_id, keys)); } catch (err) {
        if (process.env.ZOHO_LOG !== 'off') console.log(`[zoho] ${new Date().toISOString()} readiness not read: ${String(err.message).slice(0, 200)}`);
      }
    }
    if (!ready.ok) {
      if (keys.length) throw listsEmptyError(ready.lists);
      // Nobody to upload: say whether that is missing consent or opt-outs.
      let noConsent = 0;
      for (const id of parse(row.mail_list_ids_json, [])) noConsent += await withoutConsent(row.workspace_id, id);
      throw Object.assign(new Error(noConsent
        ? `Nobody in the chosen lists can get marketing email, so nothing was sent: ${noConsent} contact(s) have no recorded marketing consent, and any others unsubscribed or bounced. Record consent (how and when each person agreed) on their leads, or choose other lists (Recipients).`
        : 'Nobody in the chosen lists can be emailed (all unsubscribed or bounced), so nothing was sent. Choose other lists (Recipients).'), { status: 400, code: noConsent ? 'NO_CONSENT' : 'NO_RECIPIENTS' });
    }
  } catch (err) {
    await svc.failSubmission(ctx, row, 'upload', err).catch(() => null);
    return { failed: true, error: String(err.message).slice(0, 300) };
  }
  try {
    await svc.deliver(ctx, await get('SELECT * FROM mail_campaigns WHERE id = ?', [row.id]), keys);
    return { delivered: true, lists: keys.length };
  } catch (err) {
    return { failed: true, error: String(err.message).slice(0, 300) };
  }
}

/**
 * After Zoho reports the campaign Sent: keeps the temporary lists' (and the picked-contacts list's) unsubscribes and bounces in the
 * stop-list, then deletes those lists in Zoho (contacts stay). Needs the list-delete permission;
 * without it the lists stay and the campaign says so. Returns true when done.
 */
async function cleanupTempLists(row) {
  const temp = parse(row.temp_lists_json, []);
  // The private list made for contacts picked one by one (earlier way of sending) goes too.
  if (row.contact_list_key && !temp.some(t => t.key === row.contact_list_key)) temp.push({ key: row.contact_list_key, name: row.contact_list_name || null });
  if (!temp.length || row.temp_lists_deleted_at) return true;
  const workspaceId = row.workspace_id;
  await campaignContacts.importOptOutsFrom(workspaceId, temp.map(t => t.key));
  if (!zoho.canDeleteLists(await zoho.connectionRow(workspaceId))) return false;
  for (const t of temp) {
    try {
      await zoho.writeCall(workspaceId, 'deletemailinglist', { listkey: t.key, deletecontacts: 'off' });
    } catch (err) {
      if (!EMPTY.includes(err.providerCode) && !/not exist|invalid list/i.test(err.message)) throw err;
    }
  }
  await run('UPDATE mail_campaigns SET temp_lists_deleted_at = UTC_TIMESTAMP() WHERE id = ?', [row.id]);
  return true;
}

/**
 * Starts this campaign's waiting upload job in this process (send, and each status check while it
 * waits), so sending never depends on the worker running. The job is claimed first, so it runs once;
 * the worker remains a fallback. Returns true when it was started here.
 */
async function kickUpload(workspaceId, campaignId) {
  if (process.env.ZOHO_UPLOAD_INLINE === '0') return false; // tests: run explicitly
  const job = await get(`SELECT * FROM background_jobs WHERE workspace_id = ? AND job_type = 'zoho_campaign_upload' AND status = 'queued'
    AND JSON_EXTRACT(payload_json, '$.campaignId') = ? ORDER BY id DESC LIMIT 1`, [workspaceId, Number(campaignId)]);
  if (!job) return false;
  const claim = await run("UPDATE background_jobs SET status = 'running', locked_by = 'api', locked_at = UTC_TIMESTAMP(), attempt_count = attempt_count + 1 WHERE id = ? AND status = 'queued'", [job.id]);
  if (!claim.changes) return false;
  const jobs = require('../../social/jobsService');
  setImmediate(async () => {
    try { await jobs.complete(job.id, await runUploadJob(job)); } catch (err) { await jobs.fail({ ...job, max_attempts: 0 }, err).catch(() => null); }
  });
  return true;
}

module.exports = { listReadiness, saveReadiness, runUploadJob, cleanupTempLists, uploadLists, kickUpload, waitForZohoContacts };
