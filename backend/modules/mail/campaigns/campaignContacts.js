const crypto = require('crypto');
const { z } = require('zod');
const { run, all } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const emailService = require('../../../services/emailService');
const zoho = require('../zoho/zohoService');
const { withEligibility, LEAD_COLUMNS } = require('../productEmails/service');

/**
 * Contacts chosen one by one for a campaign, and their sync to Zoho when it is sent.
 *
 * Zoho only sends to mailing lists, so the selection becomes a new private list, one per campaign
 * version. Those lists are generated: they are hidden from the recipient lists and never reused.
 *
 * Nobody is uploaded on the browser's word. Leads must not have opted out (unsubscribed, bounced,
 * spam complaint, consent withdrawn) and need a valid address, when added and again at send time;
 * Zoho handles consent itself, so missing consent does not block a lead. A contact picked from a Zoho
 * list is accepted only if Zoho itself shows it as subscribed on that list. Before each upload,
 * unsubscribes and bounces are imported from the earlier generated lists: an unsubscribe applies to
 * one Zoho list, so without this the next campaign's new list would add the person back.
 */
const ws = ctx => ctx.auth.workspaceId;
const { httpError } = zoho;

const MAX_CONTACTS = 1000; // sent in one request: 100 Zoho calls at 10 addresses each
const BATCH = 10; // Zoho's limit per addlistandcontacts / addlistsubscribersinbulk call
const PAGE_SIZE = 50;
const LIST_PAGE = 100;
const MAX_LIST_PAGES = 50;
const OPT_OUT_LISTS = 50; // most recent generated lists read for opt-outs before each upload
const OPT_OUT_STATUS = { unsub: 'unsubscribed', bounce: 'bounced' };
const SYNC_LIST_RE = /^Marketech campaign \d+ v\d+ [a-f0-9]{6}$/;
const EMPTY_CODES = ['2203', '995']; // Zoho reports an empty result as an error code
// Names sent per campaign send: one Zoho call each, kept well inside Zoho's 500 calls/minute.
const NAME_SYNC_MAX = 300;
const NAME_SYNC_CONCURRENCY = 4;

const normalize = e => String(e || '').trim().toLowerCase();
const isSyncList = name => SYNC_LIST_RE.test(String(name || ''));
const placeholders = n => Array(n).fill('?').join(',');

const leadsSchema = z.object({ leadIds: z.array(z.number().int().positive()).max(MAX_CONTACTS) }).strict();
const zohoSchema = z.object({
  listKey: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  pages: z.array(z.object({ page: z.number().int().min(1).max(1000), emails: z.array(z.string().max(255)).min(1).max(PAGE_SIZE) }).strict()).min(1).max(20)
}).strict();
const removeSchema = z.union([z.object({ all: z.literal(true) }).strict(), z.object({ ids: z.array(z.number().int().positive()).min(1).max(MAX_CONTACTS) }).strict()]);

/** Every mailing list of the connected account. */
async function fetchLists(workspaceId) {
  const lists = [];
  for (let p = 0; p < MAX_LIST_PAGES; p++) {
    let d;
    try {
      d = await zoho.readCall(workspaceId, 'getmailinglists', { sort: 'asc', fromindex: String(p * LIST_PAGE + 1), range: String(LIST_PAGE) });
    } catch (err) {
      if (EMPTY_CODES.includes(err.providerCode)) return lists;
      throw err;
    }
    const page = d.list_of_details || [];
    lists.push(...page.map(l => ({ key: String(l.listkey), name: l.listname || null, contacts: l.noofcontacts != null ? Number(l.noofcontacts) : null })));
    if (page.length < LIST_PAGE) break;
  }
  return lists;
}

/** Zoho's added_time (epoch milliseconds, as a number or string) as an ISO date, or null. */
function zohoTime(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** One page of a Zoho list's contacts in one state (active, unsub, bounce). */
async function readListPage(workspaceId, listKey, status, page) {
  let data;
  try {
    data = await zoho.readCall(workspaceId, 'getlistsubscribers', { listkey: listKey, sort: 'asc', status, fromindex: String((page - 1) * PAGE_SIZE + 1), range: String(PAGE_SIZE) });
  } catch (err) {
    if (EMPTY_CODES.includes(err.providerCode)) return { contacts: [], hasMore: false };
    throw err;
  }
  const clean = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
  const contacts = (Array.isArray(data.list_of_details) ? data.list_of_details : []).map(c => {
    const email = c?.contact_email || c?.contactemailaddress || null;
    if (!email || typeof email !== 'string') return null;
    return {
      email: email.slice(0, 255),
      name: `${c.firstname || ''} ${c.lastname || ''}`.trim().slice(0, 200) || null,
      company: clean(c.companyname),
      phone: clean(c.phone),
      addedAt: zohoTime(c.added_time)
    };
  }).filter(Boolean);
  return { contacts, hasMore: contacts.length === PAGE_SIZE };
}

/** Addresses no marketing email may reach: suppressed, or a lead who withdrew consent. */
async function blockedAddresses(workspaceId) {
  const rows = await all(
    `SELECT LOWER(TRIM(email)) AS email FROM email_suppressions WHERE workspace_id = ?
     UNION SELECT LOWER(TRIM(email)) FROM leads WHERE workspace_id = ? AND marketing_consent = 'withdrawn' AND email IS NOT NULL`,
    [workspaceId, workspaceId]
  );
  return new Set(rows.map(r => r.email));
}

/** The campaign's selection with today's eligibility. A lead's current email address is used. */
async function assess(workspaceId, campaignId) {
  const rows = await all('SELECT * FROM mail_campaign_contacts WHERE workspace_id = ? AND campaign_id = ? ORDER BY id', [workspaceId, campaignId]);
  if (!rows.length) return [];
  const leadIds = rows.filter(r => r.lead_id).map(r => r.lead_id);
  const leads = leadIds.length ? await all(`SELECT ${LEAD_COLUMNS} FROM leads WHERE workspace_id = ? AND id IN (${placeholders(leadIds.length)})`, [workspaceId, ...leadIds]) : [];
  const byLead = new Map((await withEligibility(workspaceId, leads, { requireConsent: false })).map(l => [l.id, l]));
  const blocked = rows.some(r => !r.lead_id) ? await blockedAddresses(workspaceId) : new Set();
  return rows.map(r => {
    const lead = r.lead_id ? byLead.get(r.lead_id) : null;
    const reasons = lead ? lead.reasons : [];
    if (r.lead_id && !lead) reasons.push('Lead no longer available');
    if (!r.lead_id && (blocked.has(r.email) || !emailService.isValidRecipient(r.email))) reasons.push('Unsubscribed, bounced or invalid');
    return {
      id: r.id,
      leadId: r.lead_id,
      email: lead?.email ? normalize(lead.email) : r.email,
      name: lead ? lead.name : r.name,
      company: lead ? lead.company : r.company,
      source: r.source,
      sourceListKey: r.source_list_key,
      syncedVersion: r.synced_version,
      eligible: reasons.length === 0,
      reasons
    };
  });
}

/** Contacts not already reached by a list the campaign sends to: they need no upload. */
const notOnLists = (contacts, listKeys) => contacts.filter(c => !listKeys.includes(c.sourceListKey));

function present(contacts) {
  return {
    contacts: contacts.map(({ syncedVersion, ...c }) => c),
    total: contacts.length,
    eligible: contacts.filter(c => c.eligible).length,
    max: MAX_CONTACTS
  };
}

async function selection(ctx, campaignId) {
  return present(await assess(ws(ctx), campaignId));
}

async function insertRows(workspaceId, campaignId, rows, conflict) {
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200);
    await run(
      `INSERT ${conflict === 'ignore' ? 'IGNORE ' : ''}INTO mail_campaign_contacts (workspace_id, campaign_id, lead_id, email, name, company, source, source_list_key, created_at)
       VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())').join(', ')}
       ${conflict === 'ignore' ? '' : "ON DUPLICATE KEY UPDATE lead_id = VALUES(lead_id), name = VALUES(name), company = VALUES(company), source = 'lead', source_list_key = NULL, synced_version = NULL"}`,
      part.flatMap(r => [workspaceId, campaignId, r.leadId || null, r.email, r.name || null, r.company || null, r.source, r.sourceListKey || null])
    );
  }
}

async function emailsFromOtherSources(workspaceId, campaignId, source) {
  const rows = await all('SELECT LOWER(email) AS email FROM mail_campaign_contacts WHERE workspace_id = ? AND campaign_id = ? AND source <> ?', [workspaceId, campaignId, source]);
  return new Set(rows.map(r => r.email));
}

/**
 * Replaces the leads chosen for a campaign. Leads that may not be emailed are refused here, with
 * the count returned; `touch` runs before anything changes (it clears the approval).
 */
async function setLeads(ctx, row, input, touch) {
  const { leadIds } = leadsSchema.parse(input || {});
  const ids = [...new Set(leadIds)];
  const leads = ids.length ? await all(`SELECT ${LEAD_COLUMNS} FROM leads WHERE workspace_id = ? AND id IN (${placeholders(ids.length)})`, [ws(ctx), ...ids]) : [];
  const assessed = await withEligibility(ws(ctx), leads, { requireConsent: false });
  const seen = new Set();
  const rows = [];
  for (const l of assessed) {
    const email = normalize(l.email);
    if (!l.eligible || seen.has(email)) continue;
    seen.add(email);
    rows.push({ leadId: l.id, email, name: l.name, company: l.company, source: 'lead' });
  }
  const others = await emailsFromOtherSources(ws(ctx), row.id, 'lead');
  if (new Set([...others, ...seen]).size > MAX_CONTACTS) throw httpError(400, `A campaign can have up to ${MAX_CONTACTS} selected contacts. Use a Zoho mailing list for larger audiences.`, 'TOO_MANY_CONTACTS');
  await touch();
  await run("DELETE FROM mail_campaign_contacts WHERE workspace_id = ? AND campaign_id = ? AND source = 'lead'", [ws(ctx), row.id]);
  await insertRows(ws(ctx), row.id, rows);
  await audit(ctx, 'mail.campaign_contacts_changed', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { source: 'lead', selected: rows.length, refused: ids.length - rows.length } });
  return { ...(await selection(ctx, row.id)), added: rows.length, refused: ids.length - rows.length };
}

/** Adds contacts picked from a Zoho list, after re-reading those pages: Zoho decides who is subscribed. */
async function addFromZoho(ctx, row, input, touch) {
  const { listKey, pages } = zohoSchema.parse(input || {});
  await zoho.assertReady(ws(ctx));
  const blocked = await blockedAddresses(ws(ctx));
  const found = new Map();
  let requested = 0;
  for (const { page, emails } of pages) {
    const wanted = new Set(emails.map(normalize));
    requested += wanted.size;
    const { contacts } = await readListPage(ws(ctx), listKey, 'active', page);
    for (const c of contacts) {
      const email = normalize(c.email);
      if (wanted.has(email) && !blocked.has(email) && emailService.isValidRecipient(email)) found.set(email, { email, name: c.name, company: c.company, source: 'zoho_list', sourceListKey: listKey });
    }
  }
  const existing = new Set((await all('SELECT LOWER(email) AS email FROM mail_campaign_contacts WHERE workspace_id = ? AND campaign_id = ?', [ws(ctx), row.id])).map(r => r.email));
  if (new Set([...existing, ...found.keys()]).size > MAX_CONTACTS) throw httpError(400, `A campaign can have up to ${MAX_CONTACTS} selected contacts. Use a Zoho mailing list for larger audiences.`, 'TOO_MANY_CONTACTS');
  if (found.size) {
    await touch();
    await insertRows(ws(ctx), row.id, [...found.values()], 'ignore');
    await audit(ctx, 'mail.campaign_contacts_changed', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { source: 'zoho_list', selected: found.size, refused: requested - found.size } });
  }
  return { ...(await selection(ctx, row.id)), added: found.size, refused: requested - found.size };
}

/** Copies a selection to a new campaign: only contacts that can still be emailed, checked now. */
async function copySelection(workspaceId, fromId, toId) {
  const contacts = await assess(workspaceId, fromId);
  const seen = new Set();
  const rows = contacts.filter(c => {
    if (!c.eligible || seen.has(c.email)) return false;
    seen.add(c.email);
    return true;
  });
  await insertRows(workspaceId, toId, rows, 'ignore');
  return { copied: rows.length, dropped: contacts.length - rows.length };
}

async function removeContacts(ctx, row, input, touch) {
  const v = removeSchema.parse(input || {});
  await touch();
  const r = v.all
    ? await run('DELETE FROM mail_campaign_contacts WHERE workspace_id = ? AND campaign_id = ?', [ws(ctx), row.id])
    : await run(`DELETE FROM mail_campaign_contacts WHERE workspace_id = ? AND campaign_id = ? AND id IN (${placeholders(v.ids.length)})`, [ws(ctx), row.id, ...v.ids]);
  await audit(ctx, 'mail.campaign_contacts_changed', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { removed: r.changes } });
  return selection(ctx, row.id);
}

/**
 * Copies unsubscribes and bounces from Zoho into the suppression list. Reads the generated lists
 * of campaigns already sent and the lists this selection was picked from. A failure stops the
 * send: contacts are not uploaded without knowing who opted out.
 */
async function importOptOuts(workspaceId, contacts) {
  const sent = await all(
    `SELECT contact_list_key AS k FROM mail_campaigns WHERE workspace_id = ? AND contact_list_key IS NOT NULL AND status IN ('submitted', 'needs_review') ORDER BY id DESC LIMIT ${OPT_OUT_LISTS}`,
    [workspaceId]
  );
  const wanted = new Set([...sent.map(r => r.k), ...contacts.map(c => c.sourceListKey).filter(Boolean)]);
  if (!wanted.size) return 0;
  const existing = new Set((await fetchLists(workspaceId)).map(l => l.key));
  let imported = 0;
  for (const listKey of [...wanted].filter(k => existing.has(k))) {
    for (const [status, reason] of Object.entries(OPT_OUT_STATUS)) {
      for (let page = 1, more = true; more; page++) {
        const res = await readListPage(workspaceId, listKey, status, page);
        for (const c of res.contacts) {
          const r = await run('INSERT IGNORE INTO email_suppressions (workspace_id, email, reason, source, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())', [workspaceId, normalize(c.email), reason, 'zoho_campaigns']);
          imported += r.changes || 0;
        }
        more = res.hasMore;
      }
    }
  }
  return imported;
}

async function markSynced(ids, version) {
  if (ids.length) await run(`UPDATE mail_campaign_contacts SET synced_version = ? WHERE id IN (${placeholders(ids.length)})`, [version, ...ids]);
}

/** Words that show a "name" is really a business (Google often puts the business in the name). */
const BUSINESS_WORD_RE = /\b(pty|ltd|limited|llc|llp|inc|corp|corporation|company|group|holdings|packaging|foods?|bakery|distribut\w*|wholesale|supplies|supply|services?|solutions|trading|traders|enterprises?|industries|international|australia|restaurant|cafe|store|shop|studio|agency|clinic|hotel|team|sales|support|office|enquiries|reception|admin)\b/i;
/** The stand-in name lead discovery gives a place Google returned without a name ("Prospect 3: Packaging supplier (Sydney)"). */
const PROSPECT_RE = /^prospect\s+\d+\s*:/i;
/** Legal endings dropped from a business name in a greeting ("Khushboo Foods Pty Ltd" → "Khushboo Foods"). */
const LEGAL_SUFFIX_RE = /[\s,]+(pty\.?\s*ltd\.?|proprietary\s+limited|pvt\.?\s*ltd\.?|private\s+limited|ltd\.?|limited|llc|llp|plc|inc\.?|incorporated|corp\.?|corporation|co\.|gmbh)\s*$/i;

/**
 * The person's first and last name for Zoho's name merge tags, or null when the lead has no
 * person name: no name, the name is the business or the email (Google leads without a contact
 * person), or the name is clearly a business ("Nimbin Bakery").
 */
function personName(c) {
  const name = String(c?.name || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 100) return null;
  const same = v => v && name.toLowerCase() === String(v).trim().toLowerCase();
  if (same(c.company) || same(c.email) || /@/.test(name) || PROSPECT_RE.test(name) || BUSINESS_WORD_RE.test(name)) return null;
  const [first, ...rest] = name.split(' ');
  return { first: first.slice(0, 50), last: rest.join(' ').slice(0, 50) };
}

/**
 * A business name tidied for a greeting: Google's extras after "|", " - " or "(" and legal endings
 * are dropped ("Pacific Packaging Australia | Melbourne" → "Pacific Packaging Australia",
 * "A & J Australia Pty Ltd - Packaging Supplies Sydney" → "A & J Australia"). Null when nothing
 * usable is left or it is too long for a greeting.
 */
function businessName(raw) {
  let n = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!n || /@|https?:|www\./i.test(n) || PROSPECT_RE.test(n)) return null;
  n = n.split(/\s+[|–—-]\s+|\s*\(|\s*\|\s*/)[0].trim();
  for (let i = 0; i < 3 && LEGAL_SUFFIX_RE.test(n); i++) n = n.replace(LEGAL_SUFFIX_RE, '').trim();
  n = n.replace(/[\s,.;:&-]+$/, '').replace(/^THE\b/, 'The');
  if (n.length < 2 || n.length > 40) return null;
  return n;
}

/**
 * The name Zoho's First name tag shows for a lead: the person's name, or for a business lead
 * without a contact person, the business ("Big Red Packaging team"). Null: the tag's default is used.
 */
function greetingName(c) {
  const person = personName(c);
  if (person) return person;
  const biz = businessName(c?.company) || businessName(c?.name);
  if (!biz) return null;
  return { first: /\bteam$/i.test(biz) ? biz : `${biz} team`, last: '', business: true };
}

/**
 * Sends the names of contacts just added from leads to Zoho, so $[FNAME]$ / $[LNAME]$ are filled.
 * Best effort: a failure never stops the send (the merge tag's default is used for that person).
 * Contacts picked from a Zoho list are skipped: Zoho already has their details.
 */
async function syncNames(workspaceId, listKey, contacts) {
  const row = await zoho.connectionRow(workspaceId);
  const named = contacts.filter(c => c.leadId).map(c => ({ c, n: greetingName(c) })).filter(x => x.n);
  if (!named.length) return { sent: 0, failed: 0, skipped: 0, allowed: true };
  if (!zoho.canSyncNames(row)) return { sent: 0, failed: 0, skipped: named.length, allowed: false };
  const todo = named.slice(0, NAME_SYNC_MAX);
  let sent = 0, failed = 0, next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { c, n } = todo[next++];
      const info = { 'Contact Email': c.email, 'First Name': n.first, ...(n.last ? { 'Last Name': n.last } : {}) };
      try {
        await zoho.writeCall(workspaceId, 'json/listsubscribe', { listkey: listKey, contactinfo: JSON.stringify(info), source: 'Marketech.ai' });
        sent++;
      } catch { failed++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(NAME_SYNC_CONCURRENCY, todo.length) }, worker));
  return { sent, failed, skipped: named.length - todo.length, allowed: true };
}

/** Creates the generated list with its first addresses, or finds it if an earlier try made it. */
async function createList(workspaceId, name, first) {
  try {
    const res = await zoho.writeCall(workspaceId, 'addlistandcontacts', { listname: name, emailids: first.map(c => c.email).join(','), signupform: 'private', mode: 'newlist' });
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(res.listkey || ''))) throw httpError(502, 'Zoho did not return the new list.', 'ZOHO_BAD_RESPONSE');
    return { key: String(res.listkey), added: first };
  } catch (err) {
    if (err.providerCode !== '2205') throw err;
    const hit = (await fetchLists(workspaceId)).find(l => l.name === name);
    if (!hit) throw err;
    return { key: hit.key, added: [] };
  }
}

/**
 * Puts the selection into this version's Zoho list and returns its key, or null when there is
 * nothing to upload. Safe to run again: only contacts not yet added are sent. Nothing has been
 * emailed at this point, so any error here leaves the campaign "not sent" and it can be retried.
 */
async function syncForSend(ctx, row, { listKeys }) {
  const workspaceId = ws(ctx);
  const selected = notOnLists(await assess(workspaceId, row.id), listKeys);
  if (!selected.length) return null;
  await zoho.assertContactSync(workspaceId);
  const imported = await importOptOuts(workspaceId, selected);
  const contacts = imported ? notOnLists(await assess(workspaceId, row.id), listKeys) : selected;

  const sameVersion = row.contact_list_version === row.version;
  const inList = sameVersion ? contacts.filter(c => c.syncedVersion === row.version) : [];
  const stale = inList.filter(c => !c.eligible).length;
  if (stale) throw httpError(409, `${stale} selected contact(s) already added to Zoho can no longer be emailed. Remove them from this campaign and approve it again.`, 'CONTACTS_CHANGED');

  const seen = new Set(inList.map(c => c.email));
  const todo = contacts.filter(c => {
    if (!c.eligible || seen.has(c.email)) return false;
    seen.add(c.email);
    return true;
  });
  if (!todo.length && !inList.length) {
    if (listKeys.length) return null;
    throw httpError(400, 'None of the selected contacts can be emailed any more.', 'NO_RECIPIENTS');
  }

  let listKey = sameVersion ? row.contact_list_key : null;
  let remaining = todo;
  if (!listKey) {
    const name = (sameVersion && row.contact_list_name) || `Marketech campaign ${row.id} v${row.version} ${crypto.randomBytes(3).toString('hex')}`;
    await run('UPDATE mail_campaigns SET contact_list_name = ?, contact_list_version = ?, contact_list_key = NULL WHERE id = ?', [name, row.version, row.id]);
    const created = await createList(workspaceId, name, todo.slice(0, BATCH));
    listKey = created.key;
    await run('UPDATE mail_campaigns SET contact_list_key = ? WHERE id = ?', [listKey, row.id]);
    await markSynced(created.added.map(c => c.id), row.version);
    remaining = todo.slice(created.added.length);
  }
  for (let i = 0; i < remaining.length; i += BATCH) {
    const part = remaining.slice(i, i + BATCH);
    await zoho.writeCall(workspaceId, 'addlistsubscribersinbulk', { listkey: listKey, emailids: part.map(c => c.email).join(',') });
    await markSynced(part.map(c => c.id), row.version);
  }
  const names = todo.length ? await syncNames(workspaceId, listKey, todo) : { sent: 0, failed: 0, skipped: 0 };
  await audit(ctx, 'mail.campaign_contacts_synced', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { added: todo.length, skipped: contacts.length - inList.length - todo.length, optOutsImported: imported, namesSent: names.sent, namesFailed: names.failed, namesSkipped: names.skipped } });
  return listKey;
}

module.exports = { MAX_CONTACTS, personName, businessName, greetingName, syncNames, assess, notOnLists, selection, setLeads, addFromZoho, copySelection, removeContacts, syncForSend, fetchLists, readListPage, isSyncList, PAGE_SIZE };
