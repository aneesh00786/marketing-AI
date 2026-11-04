const { z } = require('zod');
const { all, get, run } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const emailService = require('../../../services/emailService');
const zoho = require('./zohoService');
const contacts = require('../campaigns/campaignContacts');
const { withEligibility, LEAD_COLUMNS } = require('../productEmails/service');

/**
 * Zoho Campaigns mailing lists, managed from Marketech.ai the way Zoho's "Manage Lists" works:
 * see every list with its contact count, create a list, add contacts (leads or typed addresses)
 * and remove contacts. Everything is done in Zoho through its API; nothing about the lists is
 * stored here.
 *
 * Not offered: deleting or renaming a list. Zoho's delete call needs a permission this connection
 * does not request, and its rename call also resets the list's sign-up form setting, which
 * cannot be read first. Both stay in Zoho (Contacts > Manage Lists).
 *
 * Addresses that may not be emailed (suppressed, invalid, or a lead who withdrew consent) are
 * never added.
 */
const { httpError } = zoho;
const ws = ctx => ctx.auth.workspaceId;
const normalize = e => String(e || '').trim().toLowerCase();
const MAX_ADD = 500;          // addresses per request: 50 Zoho calls at 10 addresses each
const BULK = 10;              // Zoho's addlistsubscribersinbulk takes up to 10 addresses
const LIST_KEY_RE = /^[A-Za-z0-9_-]{1,200}$/;

const addSchema = z.object({
  leadIds: z.array(z.number().int().positive()).max(MAX_ADD).default([]),
  emails: z.array(z.string().trim().max(255)).max(MAX_ADD).default([])
}).strict();
const createSchema = addSchema.extend({ name: z.string().trim().min(1, 'Enter a list name.').max(100) }).strict();

function parse(schema, body) {
  const r = schema.safeParse(body || {});
  if (!r.success) throw httpError(400, r.error.issues[0]?.message || 'Invalid request.', 'VALIDATION_ERROR');
  return r.data;
}

/**
 * The plan's contact limit (typed in by an admin; Zoho's API does not report it) and how many
 * contacts the lists hold. Zoho counts a contact once even when it is in several lists, and the
 * API gives only per-list counts, so the usage is an upper bound ("up to"). Lists made for a
 * campaign hold copies of contacts already in other lists, so they are not counted.
 */
async function contactLimit(workspaceId) {
  const row = await get('SELECT contact_limit FROM mail_provider_settings WHERE workspace_id = ? AND provider = ?', [workspaceId, 'zoho_campaigns']).catch(() => null);
  return row && row.contact_limit > 0 ? Number(row.contact_limit) : null;
}

function usageOf(found) {
  const own = found.filter(l => !contacts.isSyncList(l.name) && l.contacts !== null);
  return { upTo: own.reduce((n, l) => n + l.contacts, 0), atLeast: own.reduce((n, l) => Math.max(n, l.contacts), 0) };
}

const planSchema = z.object({ contactLimit: z.union([z.null(), z.number().int().min(1).max(10000000)]) }).strict();

async function setPlan(ctx, body) {
  const { contactLimit: limit } = parse(planSchema, body);
  await run(`INSERT INTO mail_provider_settings (workspace_id, provider, contact_limit, updated_by, updated_at) VALUES (?, 'zoho_campaigns', ?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE contact_limit = VALUES(contact_limit), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`, [ws(ctx), limit, ctx.auth.userId]);
  await audit(ctx, 'mail.zoho_plan_updated', { resourceType: 'mail_provider', resourceId: 'zoho_campaigns', metadata: { contactLimit: limit } });
  return { contactLimit: limit };
}

/** Every Zoho list, with the lists Marketech.ai made for a campaign marked, and the plan usage. */
async function lists(ctx) {
  await zoho.assertReady(ws(ctx));
  const found = await contacts.fetchLists(ws(ctx));
  return {
    lists: found.map(l => ({ ...l, campaignList: contacts.isSyncList(l.name) })),
    canAdd: zoho.canSyncContacts(await zoho.connectionRow(ws(ctx))),
    canRemove: zoho.canSyncNames(await zoho.connectionRow(ws(ctx))),
    plan: { contactLimit: await contactLimit(ws(ctx)), usage: usageOf(found) }
  };
}

async function findList(ctx, listKey) {
  if (!LIST_KEY_RE.test(String(listKey || ''))) throw httpError(400, 'Unknown list.', 'VALIDATION_ERROR');
  const list = (await contacts.fetchLists(ws(ctx))).find(l => l.key === listKey);
  if (!list) throw httpError(404, 'This list no longer exists in Zoho.', 'NOT_FOUND');
  return list;
}

/**
 * The addresses to add: chosen leads (with their names for Zoho) and typed addresses. Anything
 * that may not be emailed is skipped with the reason.
 */
async function resolveAdditions(ctx, { leadIds, emails }) {
  const add = new Map();
  const skipped = [];
  if (leadIds.length) {
    const rows = await all(`SELECT ${LEAD_COLUMNS} FROM leads WHERE workspace_id = ? AND id IN (${leadIds.map(() => '?').join(',')})`, [ws(ctx), ...leadIds]);
    for (const l of await withEligibility(ws(ctx), rows, { requireConsent: false })) {
      const email = normalize(l.email);
      if (!l.eligible || !email) { skipped.push({ email: email || l.name || `Lead ${l.id}`, reason: (l.reasons || []).join('; ') || 'No email address' }); continue; }
      if (!add.has(email)) add.set(email, { email, leadId: l.id, name: l.name, company: l.company });
    }
  }
  const typed = emails.map(normalize).filter(Boolean);
  if (typed.length) {
    const blocked = new Set((await all(
      `SELECT LOWER(TRIM(email)) AS email FROM email_suppressions WHERE workspace_id = ?
       UNION SELECT LOWER(TRIM(email)) FROM leads WHERE workspace_id = ? AND marketing_consent = 'withdrawn' AND email IS NOT NULL`,
      [ws(ctx), ws(ctx)])).map(r => r.email));
    for (const email of typed) {
      if (add.has(email)) continue;
      if (!emailService.isValidRecipient(email)) { skipped.push({ email, reason: 'Not a valid email address' }); continue; }
      if (blocked.has(email)) { skipped.push({ email, reason: 'Unsubscribed, bounced or withdrew consent' }); continue; }
      add.set(email, { email });
    }
  }
  if (add.size > MAX_ADD) throw httpError(400, `Add up to ${MAX_ADD} contacts at a time.`, 'TOO_MANY_CONTACTS');
  return { add: [...add.values()], skipped };
}

/** Adds addresses in Zoho's batches of 10; a failed batch is reported, the rest still go in. */
async function addInBatches(workspaceId, listKey, rows) {
  let added = 0;
  const failed = [];
  for (let i = 0; i < rows.length; i += BULK) {
    const part = rows.slice(i, i + BULK);
    try {
      await zoho.writeCall(workspaceId, 'addlistsubscribersinbulk', { listkey: listKey, emailids: part.map(r => r.email).join(',') });
      added += part.length;
    } catch (err) {
      if (err.reauth) throw err;
      failed.push(...part.map(r => ({ email: r.email, reason: err.message })));
    }
  }
  return { added, failed };
}

/** Create a list with its first contacts (Zoho needs at least one address to create a list). */
async function create(ctx, body) {
  const input = parse(createSchema, body);
  await zoho.assertContactSync(ws(ctx));
  const { add, skipped } = await resolveAdditions(ctx, input);
  if (!add.length) throw httpError(400, skipped.length ? 'None of these contacts can be emailed, so the list was not created.' : 'Add at least one contact: Zoho creates a list together with its first contacts.', 'NO_CONTACTS');
  const existing = (await contacts.fetchLists(ws(ctx))).find(l => String(l.name || '').toLowerCase() === input.name.toLowerCase());
  if (existing) throw httpError(409, 'A list with this name already exists in Zoho. Choose another name, or add the contacts to that list.', 'LIST_EXISTS');
  const first = add.slice(0, BULK);
  const res = await zoho.writeCall(ws(ctx), 'addlistandcontacts', { listname: input.name, emailids: first.map(r => r.email).join(','), signupform: 'private', mode: 'newlist' });
  const listKey = String(res.listkey || '');
  if (!LIST_KEY_RE.test(listKey)) throw httpError(502, 'Zoho did not return the new list.', 'ZOHO_BAD_RESPONSE');
  const rest = await addInBatches(ws(ctx), listKey, add.slice(BULK));
  const names = await contacts.syncNames(ws(ctx), listKey, add);
  await audit(ctx, 'mail.zoho_list_created', { resourceType: 'zoho_list', resourceId: listKey, metadata: { added: first.length + rest.added, failed: rest.failed.length, skipped: skipped.length, names: names.sent } });
  return { list: { key: listKey, name: input.name }, added: first.length + rest.added, skipped: [...skipped, ...rest.failed], namesSent: names.sent };
}

/** Add contacts to an existing list. */
async function addContacts(ctx, listKey, body) {
  const input = parse(addSchema, body);
  await zoho.assertContactSync(ws(ctx));
  const list = await findList(ctx, listKey);
  const { add, skipped } = await resolveAdditions(ctx, input);
  if (!add.length) throw httpError(400, skipped.length ? 'None of these contacts can be emailed.' : 'Choose leads or enter email addresses to add.', 'NO_CONTACTS');
  const { added, failed } = await addInBatches(ws(ctx), list.key, add);
  const names = added ? await contacts.syncNames(ws(ctx), list.key, add.filter(r => !failed.some(f => f.email === r.email))) : { sent: 0 };
  await audit(ctx, 'mail.zoho_list_contacts_added', { resourceType: 'zoho_list', resourceId: list.key, metadata: { added, failed: failed.length, skipped: skipped.length, names: names.sent } });
  return { list: { key: list.key, name: list.name }, added, skipped: [...skipped, ...failed], namesSent: names.sent };
}

/**
 * Remove a contact from one list, as Zoho does: the contact is unsubscribed from that list only
 * (still in Zoho and on other lists).
 */
async function removeContact(ctx, listKey, body) {
  const email = normalize(parse(z.object({ email: z.string().trim().email('Enter a valid email.').max(255) }).strict(), body).email);
  const row = await zoho.assertReady(ws(ctx));
  if (!zoho.canSyncNames(row)) throw httpError(409, 'Reconnect Zoho Campaigns to allow removing contacts from lists.', 'ZOHO_SCOPES_MISSING');
  const list = await findList(ctx, listKey);
  await zoho.writeCall(ws(ctx), 'json/listunsubscribe', { listkey: list.key, contactinfo: JSON.stringify({ 'Contact Email': email }) });
  await audit(ctx, 'mail.zoho_list_contact_removed', { resourceType: 'zoho_list', resourceId: list.key, metadata: { domain: email.split('@')[1] || null } });
  return { removed: email };
}

module.exports = { lists, create, addContacts, removeContact, setPlan, MAX_ADD };
