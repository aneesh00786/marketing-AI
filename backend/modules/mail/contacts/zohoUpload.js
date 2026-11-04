const { run, get, all } = require('../../../db/database');
const zoho = require('../zoho/zohoService');
const campaignContacts = require('../campaigns/campaignContacts');

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

/** Everyone in a list who can be emailed, once each. */
async function reachable(workspaceId, listId) {
  return all(
    `SELECT DISTINCT c.id, c.email, c.first_name, c.last_name, c.company, c.in_zoho
     FROM mail_list_members m JOIN mail_contacts c ON c.id = m.contact_id
     LEFT JOIN email_suppressions s ON s.workspace_id = c.workspace_id AND s.email = c.email
     WHERE m.list_id = ? AND c.workspace_id = ? AND m.status = 'subscribed' AND s.email IS NULL
     ORDER BY c.id`, [listId, workspaceId]);
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

/** Sends names for people Zoho does not know yet (best effort: the merge tag default is used otherwise). */
async function sendNames(workspaceId, listKey, people) {
  if (!zoho.canSyncNames(await zoho.connectionRow(workspaceId))) return 0;
  const todo = people.map(p => ({ p, n: campaignContacts.greetingName({ name: [p.first_name, p.last_name].filter(Boolean).join(' '), company: p.company }) })).filter(x => x.n);
  let next = 0, sent = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { p, n } = todo[next++];
      const info = { 'Contact Email': p.email, 'First Name': n.first, ...(n.last ? { 'Last Name': n.last } : {}) };
      try { await zoho.writeCall(workspaceId, 'json/listsubscribe', { listkey: listKey, contactinfo: JSON.stringify(info), source: 'Marketech.ai' }); sent++; } catch { /* default used */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(NAME_CONCURRENCY, todo.length) }, worker));
  return sent;
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
  let done = 0;
  for (const l of lists) {
    const list = people.get(l.id);
    if (!list.length) continue;
    const already = temp.find(t => t.listId === l.id);
    const name = already ? already.name : (existing.has(l.name) ? `${l.name} - Marketech ${row.id}-${row.version}` : l.name).slice(0, 100);
    const key = await createZohoList(workspaceId, name, list.slice(0, BULK), temp.map(t => t.key));
    if (!already) {
      temp.push({ listId: l.id, name, key });
      await run('UPDATE mail_campaigns SET temp_lists_json = ?, temp_lists_deleted_at = NULL WHERE id = ?', [JSON.stringify(temp), row.id]);
    }
    done += Math.min(BULK, list.length);
    for (let i = BULK, b = 0; i < list.length; i += BULK, b++) {
      const part = list.slice(i, i + BULK);
      await zoho.writeCall(workspaceId, 'addlistsubscribersinbulk', { listkey: key, emailids: part.map(c => c.email).join(',') });
      done += part.length;
      if (b % PROGRESS_EVERY === 0) await run('UPDATE mail_campaigns SET upload_done = ? WHERE id = ?', [done, row.id]);
    }
    await sendNames(workspaceId, key, list.filter(c => !c.in_zoho));
    const ids = list.map(c => c.id);
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      await run(`UPDATE mail_contacts SET in_zoho = 1 WHERE id IN (${part.map(() => '?').join(',')})`, part);
    }
  }
  await run('UPDATE mail_campaigns SET upload_done = ? WHERE id = ?', [done, row.id]);
  return temp.map(t => t.key);
}

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
 * After Zoho reports the campaign Sent: keeps the temporary lists' unsubscribes and bounces in the
 * stop-list, then deletes those lists in Zoho (contacts stay). Needs the list-delete permission;
 * without it the lists stay and the campaign says so. Returns true when done.
 */
async function cleanupTempLists(row) {
  const temp = parse(row.temp_lists_json, []);
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

module.exports = { runUploadJob, cleanupTempLists, uploadLists };
