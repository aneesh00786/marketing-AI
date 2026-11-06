const { z } = require('zod');
const { run, get, all } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const emailService = require('../../../services/emailService');

/**
 * Contact lists kept in Marketech.ai (mail_lists, mail_contacts, mail_list_members). Lists are
 * created and changed here only. A person is stored once per workspace; their status is per list (subscribed, unsubscribed, bounced). The workspace
 * stop-list (email_suppressions) always wins: such people are shown as not reachable and never sent to.
 */
const ws = ctx => ctx.auth.workspaceId;
const MAX_ADD = 5000;
const PAGE_SIZE = 50;
const BATCH = 500;

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

const contactInput = z.object({
  name: z.string().trim().max(200).optional().default(''),
  company: z.string().trim().max(200).optional().default(''),
  email: z.string().trim().max(255),
  phone: z.string().trim().max(50).optional().default('')
}).strict();
const addSchema = z.object({
  leadIds: z.array(z.number().int().positive()).max(MAX_ADD).default([]),
  emails: z.array(z.string().trim().max(255)).max(MAX_ADD).default([]),
  contacts: z.array(contactInput).max(MAX_ADD).default([])
}).strict();
const createSchema = addSchema.extend({ name: z.string().trim().min(1, 'Enter a list name.').max(150) }).strict();
const removeSchema = z.object({ contactIds: z.array(z.number().int().positive()).min(1).max(MAX_ADD) }).strict();

function parse(schema, body) {
  const r = schema.safeParse(body || {});
  if (!r.success) throw httpError(400, r.error.issues[0]?.message || 'Invalid request.', 'VALIDATION_ERROR');
  return r.data;
}

const normalize = e => String(e || '').trim().toLowerCase();
const blank = v => (v && String(v).trim() ? String(v).trim() : null);
function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: null, last: null };
  return { first: parts[0].slice(0, 100), last: parts.slice(1).join(' ').slice(0, 100) || null };
}

async function requireList(ctx, id) {
  const row = await get('SELECT * FROM mail_lists WHERE id = ? AND workspace_id = ?', [Number(id) || 0, ws(ctx)]);
  if (!row) throw httpError(404, 'List not found.', 'NOT_FOUND');
  return row;
}

/** Every list with its counts: all members, and those that can be emailed (subscribed, not on the stop-list). */
async function lists(ctx) {
  const rows = await all(
    `SELECT l.id, l.name, l.source, l.created_at, l.updated_at,
       COUNT(m.contact_id) AS total,
       SUM(m.status = 'subscribed' AND s.email IS NULL AND ${require('./consent').eligibleSql('c')}) AS reachable,
       SUM(m.status = 'subscribed' AND s.email IS NULL AND NOT ${require('./consent').eligibleSql('c')}) AS no_consent
     FROM mail_lists l
     LEFT JOIN mail_list_members m ON m.list_id = l.id
     LEFT JOIN mail_contacts c ON c.id = m.contact_id
     LEFT JOIN email_suppressions s ON s.workspace_id = l.workspace_id AND s.email = c.email
     WHERE l.workspace_id = ?
     GROUP BY l.id ORDER BY l.name`, [ws(ctx)]);
  return {
    lists: rows.map(r => ({
      id: r.id, name: r.name, source: r.source,
      total: Number(r.total) || 0, reachable: Number(r.reachable) || 0, noConsent: Number(r.no_consent) || 0, createdAt: r.created_at, updatedAt: r.updated_at
    })),
    contacts: Number((await get('SELECT COUNT(*) AS n FROM mail_contacts WHERE workspace_id = ?', [ws(ctx)])).n) || 0,
  };
}

/** The people to add: chosen leads, typed addresses and typed contacts. Invalid addresses are skipped. */
async function resolvePeople(ctx, { leadIds, emails, contacts }) {
  const people = new Map();
  const skipped = [];
  const put = (p, label) => {
    const email = normalize(p.email);
    if (!email || !emailService.isValidRecipient(email)) { skipped.push({ email: email || label, reason: 'Not a valid email address' }); return; }
    const had = people.get(email);
    people.set(email, had ? { ...p, ...Object.fromEntries(Object.entries(had).filter(([, v]) => v)), email } : { ...p, email });
  };
  if (leadIds.length) {
    const leads = await all(`SELECT id, name, email, company_name, phone, marketing_consent FROM leads WHERE workspace_id = ? AND id IN (${leadIds.map(() => '?').join(',')})`, [ws(ctx), ...leadIds]);
    for (const l of leads) {
      if (l.marketing_consent === 'withdrawn') { skipped.push({ email: normalize(l.email) || l.name || `Lead ${l.id}`, reason: 'Withdrew consent' }); continue; }
      const { first, last } = splitName(l.name);
      put({ email: l.email, first, last, company: blank(l.company_name), phone: blank(l.phone) }, l.name || `Lead ${l.id}`);
    }
  }
  for (const c of contacts) {
    const { first, last } = splitName(c.name);
    put({ email: c.email, first, last, company: blank(c.company), phone: blank(c.phone) }, c.name || c.company);
  }
  for (const e of emails) if (normalize(e)) put({ email: e }, e);
  if (people.size > MAX_ADD) throw httpError(400, `Add up to ${MAX_ADD} contacts at a time.`, 'TOO_MANY_CONTACTS');
  return { people: [...people.values()], skipped };
}

/** Inserts or fills in contacts; returns email → id. Details already stored are kept. */
async function upsertContacts(workspaceId, people) {
  const ids = new Map();
  for (let i = 0; i < people.length; i += BATCH) {
    const part = people.slice(i, i + BATCH);
    await run(
      `INSERT INTO mail_contacts (workspace_id, email, first_name, last_name, company, phone, source, created_at, updated_at)
       VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, 'local', UTC_TIMESTAMP(), UTC_TIMESTAMP())").join(',')}
       ON DUPLICATE KEY UPDATE first_name = COALESCE(first_name, VALUES(first_name)), last_name = COALESCE(last_name, VALUES(last_name)),
         company = COALESCE(company, VALUES(company)), phone = COALESCE(phone, VALUES(phone)), updated_at = UTC_TIMESTAMP()`,
      part.flatMap(p => [workspaceId, p.email, p.first || null, p.last || null, p.company || null, p.phone || null])
    );
    for (const r of await all(`SELECT id, email FROM mail_contacts WHERE workspace_id = ? AND email IN (${part.map(() => '?').join(',')})`, [workspaceId, ...part.map(p => p.email)])) {
      ids.set(normalize(r.email), r.id);
    }
  }
  return ids;
}

async function addTo(ctx, list, input) {
  const { people, skipped } = await resolvePeople(ctx, input);
  if (!people.length) return { added: 0, alreadyIn: 0, skipped };
  const ids = await upsertContacts(ws(ctx), people);
  const contactIds = people.map(p => ids.get(p.email)).filter(Boolean);
  let added = 0;
  for (let i = 0; i < contactIds.length; i += BATCH) {
    const part = contactIds.slice(i, i + BATCH);
    // A person who unsubscribed from or bounced in this list keeps that status.
    const r = await run(`INSERT IGNORE INTO mail_list_members (list_id, contact_id, status, added_at) VALUES ${part.map(() => "(?, ?, 'subscribed', UTC_TIMESTAMP())").join(',')}`, part.flatMap(id => [list.id, id]));
    added += r.changes || 0;
  }
  await run('UPDATE mail_lists SET updated_at = UTC_TIMESTAMP() WHERE id = ?', [list.id]);
  return { added, alreadyIn: contactIds.length - added, skipped };
}

async function create(ctx, body) {
  const input = parse(createSchema, body);
  if (await get('SELECT 1 AS x FROM mail_lists WHERE workspace_id = ? AND name = ?', [ws(ctx), input.name])) {
    throw httpError(409, 'A list with this name already exists.', 'NAME_TAKEN');
  }
  const ins = await run("INSERT INTO mail_lists (workspace_id, name, source, created_by, created_at, updated_at) VALUES (?, ?, 'local', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())", [ws(ctx), input.name, ctx.auth.userId]);
  const list = await requireList(ctx, ins.lastID);
  const result = await addTo(ctx, list, input);
  await audit(ctx, 'mail.list_created', { resourceType: 'mail_list', resourceId: list.id, metadata: { added: result.added } });
  return { list: { id: list.id, name: list.name }, ...result };
}

async function addContacts(ctx, id, body) {
  const list = await requireList(ctx, id);
  const result = await addTo(ctx, list, parse(addSchema, body));
  await audit(ctx, 'mail.list_contacts_added', { resourceType: 'mail_list', resourceId: list.id, metadata: { added: result.added, skipped: result.skipped.length } });
  return { list: { id: list.id, name: list.name }, ...result };
}

const STATUS_FILTER = {
  subscribed: "m.status = 'subscribed' AND s.email IS NULL",
  unsubscribed: "(m.status = 'unsubscribed' OR s.reason = 'unsubscribed')",
  bounced: "(m.status = 'bounced' OR s.reason IN ('bounced', 'complaint'))",
  all: '1 = 1'
};

/** One page of a list's people with their details, the stop-list status and the matching lead. */
async function listContacts(ctx, id, { status = 'all', q = '', page = 1 } = {}) {
  const list = await requireList(ctx, id);
  const where = STATUS_FILTER[status];
  if (!where) throw httpError(400, 'Unknown status.', 'VALIDATION_ERROR');
  const p = Math.max(1, Math.min(10000, parseInt(page, 10) || 1));
  const params = [ws(ctx), list.id];
  let search = '';
  const term = String(q || '').trim().slice(0, 100);
  if (term) {
    const like = `%${term.replace(/[%_\\]/g, '\\$&')}%`;
    search = 'AND (c.email LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR c.company LIKE ? OR c.phone LIKE ?)';
    params.push(like, like, like, like, like);
  }
  const rows = await all(
    `SELECT c.id, c.email, c.first_name, c.last_name, c.company, c.phone, c.city, c.state, c.country, c.source, m.status, m.added_at, s.reason AS stop
     FROM mail_list_members m
     JOIN mail_contacts c ON c.id = m.contact_id
     LEFT JOIN email_suppressions s ON s.workspace_id = ? AND s.email = c.email
     WHERE m.list_id = ? AND ${where} ${search}
     ORDER BY c.email LIMIT ${PAGE_SIZE + 1} OFFSET ${(p - 1) * PAGE_SIZE}`, params);
  const pageRows = rows.slice(0, PAGE_SIZE);
  const emails = pageRows.map(r => r.email);
  const leads = emails.length ? await all(
    `SELECT LOWER(TRIM(email)) AS email, id, status, marketing_consent, marketing_consent_method, marketing_consent_evidence FROM leads WHERE workspace_id = ? AND LOWER(TRIM(email)) IN (${emails.map(() => '?').join(',')}) ORDER BY id DESC`, [ws(ctx), ...emails]) : [];
  const byEmail = new Map();
  for (const l of leads) if (!byEmail.has(l.email)) byEmail.set(l.email, l);
  // Marketing consent, by the same rule as campaign uploads (contacts/consent.js): withdrawn on any lead wins.
  const withdrawn = new Set(leads.filter(l => l.marketing_consent === 'withdrawn').map(l => l.email));
  const granted = new Set(leads.filter(l => l.marketing_consent === 'granted' && l.marketing_consent_method && l.marketing_consent_evidence).map(l => l.email));
  const consentOf = r => (withdrawn.has(r.email) ? 'withdrawn' : r.source === 'zoho' ? 'imported' : granted.has(r.email) ? 'granted' : 'none');
  return {
    contacts: pageRows.map(r => ({
      id: r.id, email: r.email,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
      company: r.company, phone: r.phone,
      location: [r.city, r.state, r.country].filter(Boolean).join(', ') || null,
      status: r.stop === 'unsubscribed' ? 'unsubscribed' : r.stop ? 'bounced' : r.status,
      addedAt: r.added_at,
      consent: consentOf(r),
      leadId: byEmail.get(r.email)?.id || null, leadStatus: byEmail.get(r.email)?.status || null
    })),
    page: p, pageSize: PAGE_SIZE, hasMore: rows.length > PAGE_SIZE
  };
}

async function removeContacts(ctx, id, body) {
  const list = await requireList(ctx, id);
  const { contactIds } = parse(removeSchema, body);
  const r = await run(`DELETE FROM mail_list_members WHERE list_id = ? AND contact_id IN (${contactIds.map(() => '?').join(',')})`, [list.id, ...contactIds]);
  await audit(ctx, 'mail.list_contacts_removed', { resourceType: 'mail_list', resourceId: list.id, metadata: { removed: r.changes || 0 } });
  return { removed: r.changes || 0 };
}

/**
 * Deletes a list. People stay in the workspace's contacts and the stop-list keeps every opt-out.
 */
async function deleteList(ctx, id, body) {
  const list = await requireList(ctx, id);
  if (body?.confirm !== true) throw httpError(400, 'Explicit confirmation (confirm: true) is required.', 'CONFIRMATION_REQUIRED');
  await run('DELETE FROM mail_lists WHERE id = ? AND workspace_id = ?', [list.id, ws(ctx)]);
  await audit(ctx, 'mail.list_deleted', { resourceType: 'mail_list', resourceId: list.id });
  return { deleted: true };
}

module.exports = { lists, create, addContacts, listContacts, removeContacts, deleteList, upsertContacts, requireList, PAGE_SIZE };
