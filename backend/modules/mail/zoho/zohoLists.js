const { z } = require('zod');
const { get, run } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const zoho = require('./zohoService');
const contacts = require('../campaigns/campaignContacts');

/**
 * What Marketech.ai still does with Zoho's own mailing lists (contact lists themselves are kept in
 * Marketech.ai, see ../contacts/listService.js):
 * - lists(): Zoho's lists with their counts, for the plan usage on Contact lists.
 * - setPlan(): the Zoho plan's contact limit, typed in by an admin.
 * - deleteList(): deletes a list in Zoho ("Delete in Zoho only" / "both" on a list copied from
 *   Zoho). Its contacts stay in the Zoho account; its unsubscribes are kept in the stop-list first.
 */
const { httpError } = zoho;
const ws = ctx => ctx.auth.workspaceId;
const LIST_KEY_RE = /^[A-Za-z0-9_-]{1,200}$/;

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

/** Every Zoho list (lists made for a campaign marked), the connection's permissions and the plan usage. */
async function lists(ctx) {
  await zoho.assertReady(ws(ctx));
  const found = await contacts.fetchLists(ws(ctx));
  const conn = await zoho.connectionRow(ws(ctx));
  return {
    lists: found.map(l => ({ ...l, campaignList: contacts.isSyncList(l.name) })),
    canDeleteInZoho: zoho.canDeleteLists(conn),
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
 * Deletes a list in Zoho Campaigns. Its contacts stay in the Zoho account
 * (deletecontacts=off; deleting contacts is never done from Marketech.ai). The list's unsubscribes
 * and bounces are copied to the stop-list first; if they cannot be read, nothing is deleted.
 */
async function deleteList(ctx, listKey, body) {
  if (!body || body.confirm !== true) throw httpError(400, 'Explicit confirmation (confirm: true) is required.', 'CONFIRMATION_REQUIRED');
  const list = await findList(ctx, listKey);
  if (!zoho.canDeleteLists(await zoho.connectionRow(ws(ctx)))) throw httpError(409, 'Reconnect Zoho Campaigns once to allow deleting lists.', 'ZOHO_SCOPES_MISSING');
  try {
    await contacts.importOptOutsFrom(ws(ctx), [list.key]);
  } catch (err) {
    throw httpError(502, `The list was not deleted: its unsubscribes could not be read from Zoho first (${err.message}). Try again later.`, 'OPT_OUTS_UNREADABLE');
  }
  await zoho.writeCall(ws(ctx), 'deletemailinglist', { listkey: list.key, deletecontacts: 'off' });
  await audit(ctx, 'mail.zoho_list_deleted', { resourceType: 'mail_provider', resourceId: 'zoho_campaigns', metadata: { listKey: list.key, contacts: list.contacts ?? null } });
  return { deleted: true, list: { key: list.key, name: list.name } };
}

module.exports = { lists, setPlan, deleteList, contactLimitOf: contactLimit };
