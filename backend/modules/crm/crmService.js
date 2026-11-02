const { z } = require('zod');
const { run, get, all } = require('../../db/database');
const { httpError, crmAudit, assertCrm, requireAssignable } = require('./crmAccess');

/**
 * Global CRM: contacts, companies, deals and activities, shared by everyone with CRM access.
 * Separate from the workspace platform: nothing here reads leads, emails or any workspace table,
 * and req.auth.workspaceId is never used. Support tickets are in supportService.js.
 */
const STAGES = ['New', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost'];
const CLOSED_STAGES = ['Won', 'Lost'];
const CONTACT_STATUSES = ['Prospect', 'Customer', 'Inactive'];
const CLOSED_TICKETS = ['Resolved', 'Closed'];
const MAX_LIST = 500;
const RECENT_ACTIVITIES = 8;
const MIN_PHONE_DIGITS = 7;
const NAME_SQL = alias => `COALESCE(NULLIF(${alias}.display_name, ''), ${alias}.email)`;

const id = z.number().int().positive();
const text = max => z.string().trim().max(max);
const isRealDate = v => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31.').refine(isRealDate, 'Enter a real date.');
const blankToNull = schema => z.preprocess(v => (v === '' ? null : v), schema.nullable());
const email = blankToNull(text(255).email('Enter a valid email address.'));
const website = z.string().trim().max(500).transform(v => (/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`))
  .refine(v => /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(v), 'Enter a website like example.com.');

/** Saved with its country code, so a number means the same thing in every country. */
const phone = z.string().trim().max(50)
  .regex(/^\+[1-9][\d\s().-]*$/, 'Enter the number with its country code, like +91 98765 43210.')
  .refine(v => { const n = v.replace(/\D/g, '').length; return n >= MIN_PHONE_DIGITS && n <= 15; }, 'Enter a complete phone number with its country code.');

const contactSchema = z.object({
  fullName: text(255).min(1, 'Enter a name.'),
  email,
  phone: blankToNull(phone),
  companyId: id.nullable(),
  status: z.enum(CONTACT_STATUSES),
  assignedTo: id.nullable(),
  notes: blankToNull(text(5000)),
  allowDuplicate: z.boolean()
}).partial().strict();

const companySchema = z.object({
  name: text(255).min(1, 'Enter a company name.'),
  website: blankToNull(website),
  industry: blankToNull(text(100)),
  email,
  phone: blankToNull(phone),
  notes: blankToNull(text(5000))
}).partial().strict();

const dealSchema = z.object({
  name: text(200).min(1, 'Enter a deal name.'),
  contactId: id.nullable(),
  companyId: id.nullable(),
  value: blankToNull(z.number().min(0, 'The value cannot be negative.').max(999999999999.99)),
  stage: z.enum(STAGES),
  assignedTo: id.nullable(),
  expectedCloseDate: blankToNull(day),
  notes: blankToNull(text(5000))
}).partial().strict();

const activitySchema = z.object({
  type: z.enum(['note', 'task']),
  body: text(5000).min(1, 'Enter the details.'),
  dueDate: blankToNull(day).optional()
}).strict();

const requireId = (raw, label) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, `Invalid ${label} id.`, 'VALIDATION_ERROR');
  return n;
};
const likeOf = q => `%${String(q).slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`;

async function assertContact(contactId) {
  if (contactId && !(await get('SELECT 1 AS x FROM crm_contacts WHERE id = ?', [contactId]))) throw httpError(400, 'Choose an existing contact.', 'INVALID_CONTACT');
}
async function assertCompany(companyId) {
  if (companyId && !(await get('SELECT 1 AS x FROM crm_companies WHERE id = ?', [companyId]))) throw httpError(400, 'Choose an existing company.', 'INVALID_COMPANY');
}
/** The company to use when a contact is linked and no company was chosen. */
async function companyOfContact(contactId) {
  if (!contactId) return null;
  const c = await get('SELECT company_id FROM crm_contacts WHERE id = ?', [contactId]);
  return c ? c.company_id : null;
}

// ------------------------------------------------------------------ dashboard

async function overview() {
  const closed = CLOSED_STAGES.map(() => '?').join(',');
  const [contacts, companies, deals, tickets, recent] = await Promise.all([
    get('SELECT COUNT(*) AS n FROM crm_contacts'),
    get('SELECT COUNT(*) AS n FROM crm_companies'),
    get(`SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS pipeline FROM crm_deals WHERE stage NOT IN (${closed})`, CLOSED_STAGES),
    get(`SELECT COUNT(*) AS n FROM crm_support_tickets WHERE status NOT IN (${CLOSED_TICKETS.map(() => '?').join(',')})`, CLOSED_TICKETS),
    all(`${ACTIVITY_SELECT} ORDER BY a.created_at DESC, a.id DESC LIMIT ${RECENT_ACTIVITIES}`)
  ]);
  return {
    totalContacts: Number(contacts.n),
    totalCompanies: Number(companies.n),
    activeDeals: Number(deals.n),
    pipelineValue: Number(deals.pipeline),
    openTickets: Number(tickets.n),
    recentActivities: recent.map(presentActivity)
  };
}

// ------------------------------------------------------------------ contacts

const CONTACT_SELECT = `SELECT p.*, c.name AS company_name, ${NAME_SQL('u')} AS assignee_name
  FROM crm_contacts p LEFT JOIN crm_companies c ON c.id = p.company_id LEFT JOIN users u ON u.id = p.assigned_to`;

function presentContact(r) {
  return {
    id: r.id,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    companyId: r.company_id,
    companyName: r.company_name || null,
    status: r.status,
    assignedTo: r.assigned_to,
    assigneeName: r.assignee_name || null,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

async function listContacts(query = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (query.q) {
    where.push('(p.full_name LIKE ? OR p.email LIKE ? OR p.phone LIKE ? OR c.name LIKE ?)');
    params.push(...Array(4).fill(likeOf(query.q)));
  }
  if (CONTACT_STATUSES.includes(query.status)) { where.push('p.status = ?'); params.push(query.status); }
  if (query.assignedTo === 'none') where.push('p.assigned_to IS NULL');
  else if (query.assignedTo) { where.push('p.assigned_to = ?'); params.push(requireId(query.assignedTo, 'user')); }
  if (query.companyId) { where.push('p.company_id = ?'); params.push(requireId(query.companyId, 'company')); }
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const rows = await all(`${CONTACT_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
  const total = await get(`SELECT COUNT(*) AS n FROM crm_contacts p LEFT JOIN crm_companies c ON c.id = p.company_id WHERE ${where.join(' AND ')}`, params);
  return { contacts: rows.map(presentContact), total: Number(total.n), page, limit, statuses: CONTACT_STATUSES };
}

async function requireContact(rawId) {
  const row = await get(`${CONTACT_SELECT} WHERE p.id = ?`, [requireId(rawId, 'contact')]);
  if (!row) throw httpError(404, 'Contact not found.', 'NOT_FOUND');
  return row;
}

async function getContact(rawId) {
  const row = await requireContact(rawId);
  const [{ deals }, { tickets }, { calls }] = await Promise.all([
    listDeals({ contactId: row.id }), require('./supportService').listTickets({ contactId: row.id }), require('../calling/callLogService').listCalls({ contactId: row.id })
  ]);
  return { contact: presentContact(row), deals, tickets, calls };
}

const phoneDigits = phone => {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= MIN_PHONE_DIGITS ? d.slice(0, 50) : null;
};

/**
 * Possible duplicates by email or phone. Many people have neither, so a name alone never matches.
 * The person saving decides: a shared address can be real, and nothing is ever merged.
 */
async function assertNoDuplicate({ email: address, phone }, exceptId = 0) {
  const digits = phoneDigits(phone);
  const checks = [];
  const params = [];
  if (address) { checks.push('email = ?'); params.push(address); }
  if (digits) { checks.push('phone_digits = ?'); params.push(digits); }
  if (!checks.length) return;
  const matches = await all(`SELECT id, full_name AS fullName, email, phone FROM crm_contacts WHERE id <> ? AND (${checks.join(' OR ')}) ORDER BY id LIMIT 5`, [exceptId, ...params]);
  if (matches.length) throw httpError(409, `${matches[0].fullName} may be the same person (same email or phone).`, 'DUPLICATE_CONTACT', { matches });
}

async function createContact(ctx, input) {
  const { allowDuplicate, ...v } = contactSchema.parse(input || {});
  if (!v.fullName) throw httpError(400, 'Enter a name.', 'VALIDATION_ERROR');
  await assertCompany(v.companyId);
  await requireAssignable(v.assignedTo);
  if (!allowDuplicate) await assertNoDuplicate(v);
  const ins = await run(
    `INSERT INTO crm_contacts (full_name, email, phone, phone_digits, company_id, status, assigned_to, notes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [v.fullName, v.email ?? null, v.phone ?? null, phoneDigits(v.phone), v.companyId ?? null, v.status || CONTACT_STATUSES[0], v.assignedTo ?? null, v.notes ?? null, ctx.auth.userId]
  );
  await crmAudit(ctx, 'crm.contact_created', { resourceType: 'crm_contact', resourceId: ins.lastID });
  return getContact(ins.lastID);
}

const CONTACT_COLUMN = { fullName: 'full_name', email: 'email', phone: 'phone', companyId: 'company_id', status: 'status', assignedTo: 'assigned_to', notes: 'notes' };

async function updateContact(ctx, rawId, input) {
  const row = await requireContact(rawId);
  const { allowDuplicate, ...v } = contactSchema.parse(input || {});
  await assertCompany(v.companyId);
  // Only a change is checked: a former team member or a known duplicate must not block other edits.
  if (v.assignedTo !== undefined && v.assignedTo !== row.assigned_to) await requireAssignable(v.assignedTo);
  const sameEmail = v.email === undefined || String(v.email || '').toLowerCase() === String(row.email || '').toLowerCase();
  const samePhone = v.phone === undefined || phoneDigits(v.phone) === row.phone_digits;
  if (!allowDuplicate && !(sameEmail && samePhone)) await assertNoDuplicate({ email: sameEmail ? null : v.email, phone: samePhone ? null : v.phone }, row.id);
  const keys = Object.keys(v);
  if (!keys.length) return getContact(row.id);
  const sets = keys.map(k => `${CONTACT_COLUMN[k]} = ?`);
  const params = keys.map(k => v[k]);
  if (v.phone !== undefined) { sets.push('phone_digits = ?'); params.push(phoneDigits(v.phone)); }
  await run(`UPDATE crm_contacts SET ${sets.join(', ')}, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [...params, row.id]);
  await crmAudit(ctx, 'crm.contact_updated', { resourceType: 'crm_contact', resourceId: row.id, metadata: { fields: keys } });
  return getContact(row.id);
}

// ------------------------------------------------------------------ companies

const COMPANY_SELECT = 'SELECT c.*, (SELECT COUNT(*) FROM crm_contacts p WHERE p.company_id = c.id) AS contact_count FROM crm_companies c';

function presentCompany(r) {
  return { id: r.id, name: r.name, website: r.website, industry: r.industry, email: r.email, phone: r.phone, notes: r.notes, contactCount: Number(r.contact_count || 0), createdAt: r.created_at, updatedAt: r.updated_at };
}

async function listCompanies(query = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (query.q) { where.push('(c.name LIKE ? OR c.industry LIKE ? OR c.website LIKE ?)'); params.push(...Array(3).fill(likeOf(query.q))); }
  const rows = await all(`${COMPANY_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.name LIMIT ${MAX_LIST + 1}`, params);
  return { companies: rows.slice(0, MAX_LIST).map(presentCompany), truncated: rows.length > MAX_LIST };
}

async function requireCompany(rawId) {
  const row = await get(`${COMPANY_SELECT} WHERE c.id = ?`, [requireId(rawId, 'company')]);
  if (!row) throw httpError(404, 'Company not found.', 'NOT_FOUND');
  return row;
}

async function getCompany(rawId) {
  const row = await requireCompany(rawId);
  const [{ contacts }, { deals }, { tickets }] = await Promise.all([listContacts({ companyId: row.id, limit: 100 }), listDeals({ companyId: row.id }), require('./supportService').listTickets({ companyId: row.id })]);
  return { company: presentCompany(row), contacts, deals, tickets };
}

const duplicateName = err => (err.code === 'ER_DUP_ENTRY' ? httpError(409, 'A company with this name already exists.', 'DUPLICATE_COMPANY') : err);

async function createCompany(ctx, input) {
  const v = companySchema.parse(input || {});
  if (!v.name) throw httpError(400, 'Enter a company name.', 'VALIDATION_ERROR');
  const ins = await run(
    'INSERT INTO crm_companies (name, website, industry, email, phone, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())',
    [v.name, v.website ?? null, v.industry ?? null, v.email ?? null, v.phone ?? null, v.notes ?? null, ctx.auth.userId]
  ).catch(err => { throw duplicateName(err); });
  await crmAudit(ctx, 'crm.company_created', { resourceType: 'crm_company', resourceId: ins.lastID });
  return getCompany(ins.lastID);
}

async function updateCompany(ctx, rawId, input) {
  const row = await requireCompany(rawId);
  const v = companySchema.parse(input || {});
  const keys = Object.keys(v);
  if (!keys.length) return getCompany(row.id);
  await run(`UPDATE crm_companies SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [...keys.map(k => v[k]), row.id]).catch(err => { throw duplicateName(err); });
  await crmAudit(ctx, 'crm.company_updated', { resourceType: 'crm_company', resourceId: row.id, metadata: { fields: keys } });
  return getCompany(row.id);
}

// ------------------------------------------------------------------ deals

const DEAL_SELECT = `SELECT d.*, DATE_FORMAT(d.expected_close_date, '%Y-%m-%d') AS close_on, p.full_name AS contact_name, c.name AS company_name, ${NAME_SQL('u')} AS assignee_name
  FROM crm_deals d
  LEFT JOIN crm_contacts p ON p.id = d.contact_id
  LEFT JOIN crm_companies c ON c.id = d.company_id
  LEFT JOIN users u ON u.id = d.assigned_to`;

function presentDeal(r) {
  return {
    id: r.id,
    name: r.name,
    contactId: r.contact_id,
    contactName: r.contact_name || null,
    companyId: r.company_id,
    companyName: r.company_name || null,
    value: r.value === null ? null : Number(r.value),
    stage: r.stage,
    assignedTo: r.assigned_to,
    assigneeName: r.assignee_name || null,
    expectedCloseDate: r.close_on || null,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

async function listDeals(query = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (query.q) { where.push('(d.name LIKE ? OR p.full_name LIKE ? OR c.name LIKE ?)'); params.push(...Array(3).fill(likeOf(query.q))); }
  if (STAGES.includes(query.stage)) { where.push('d.stage = ?'); params.push(query.stage); }
  for (const [key, col] of [['assignedTo', 'd.assigned_to'], ['contactId', 'd.contact_id'], ['companyId', 'd.company_id']]) {
    if (query[key]) { where.push(`${col} = ?`); params.push(requireId(query[key], key)); }
  }
  const rows = await all(`${DEAL_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.id DESC LIMIT ${MAX_LIST + 1}`, params);
  return { deals: rows.slice(0, MAX_LIST).map(presentDeal), truncated: rows.length > MAX_LIST, stages: STAGES };
}

async function requireDeal(rawId) {
  const row = await get(`${DEAL_SELECT} WHERE d.id = ?`, [requireId(rawId, 'deal')]);
  if (!row) throw httpError(404, 'Deal not found.', 'NOT_FOUND');
  return row;
}

const getDeal = async rawId => ({ deal: presentDeal(await requireDeal(rawId)) });

async function createDeal(ctx, input) {
  const v = dealSchema.parse(input || {});
  if (!v.name) throw httpError(400, 'Enter a deal name.', 'VALIDATION_ERROR');
  await assertContact(v.contactId);
  await assertCompany(v.companyId);
  await requireAssignable(v.assignedTo);
  const companyId = v.companyId === undefined ? await companyOfContact(v.contactId) : v.companyId;
  const ins = await run(
    `INSERT INTO crm_deals (name, contact_id, company_id, value, stage, assigned_to, expected_close_date, notes, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [v.name, v.contactId ?? null, companyId, v.value ?? null, v.stage || STAGES[0], v.assignedTo ?? null, v.expectedCloseDate ?? null, v.notes ?? null, ctx.auth.userId]
  );
  await crmAudit(ctx, 'crm.deal_created', { resourceType: 'crm_deal', resourceId: ins.lastID, metadata: { stage: v.stage || STAGES[0] } });
  return getDeal(ins.lastID);
}

const DEAL_COLUMN = { name: 'name', contactId: 'contact_id', companyId: 'company_id', value: 'value', stage: 'stage', assignedTo: 'assigned_to', expectedCloseDate: 'expected_close_date', notes: 'notes' };

async function updateDeal(ctx, rawId, input) {
  const row = await requireDeal(rawId);
  const v = dealSchema.parse(input || {});
  await assertContact(v.contactId);
  await assertCompany(v.companyId);
  if (v.assignedTo !== undefined && v.assignedTo !== row.assigned_to) await requireAssignable(v.assignedTo);
  const keys = Object.keys(v);
  if (!keys.length) return getDeal(row.id);
  await run(`UPDATE crm_deals SET ${keys.map(k => `${DEAL_COLUMN[k]} = ?`).join(', ')}, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [...keys.map(k => v[k]), row.id]);
  const moved = v.stage && v.stage !== row.stage;
  if (moved) await recordChange(ctx, 'deal_id', row.id, `Stage changed from ${row.stage} to ${v.stage}.`);
  await crmAudit(ctx, moved ? 'crm.deal_stage_changed' : 'crm.deal_updated', { resourceType: 'crm_deal', resourceId: row.id, metadata: { fields: keys, from: row.stage, to: v.stage || row.stage } });
  return getDeal(row.id);
}

async function removeDeal(ctx, rawId) {
  const row = await requireDeal(rawId);
  await run('DELETE FROM crm_deals WHERE id = ?', [row.id]);
  await crmAudit(ctx, 'crm.deal_deleted', { resourceType: 'crm_deal', resourceId: row.id });
  return { deleted: true };
}

// ------------------------------------------------------------------ activities

/** What an activity can belong to, and the permission needed to add to it. */
const PARENTS = {
  contacts: { column: 'contact_id', capability: 'crm.manage', find: requireContact },
  companies: { column: 'company_id', capability: 'crm.manage', find: requireCompany },
  deals: { column: 'deal_id', capability: 'crm.deals', find: requireDeal },
  tickets: { column: 'ticket_id', capability: 'crm.support', find: rawId => require('./supportService').requireTicket(rawId) }
};
const PARENT_COLUMNS = Object.values(PARENTS).map(p => p.column);

const ACTIVITY_SELECT = `SELECT a.*, DATE_FORMAT(a.due_date, '%Y-%m-%d') AS due_on, ${NAME_SQL('u')} AS author,
    p.full_name AS contact_name, c.name AS company_name, d.name AS deal_name, t.subject AS ticket_subject
  FROM crm_activities a
  LEFT JOIN users u ON u.id = a.created_by
  LEFT JOIN crm_contacts p ON p.id = a.contact_id
  LEFT JOIN crm_companies c ON c.id = a.company_id
  LEFT JOIN crm_deals d ON d.id = a.deal_id
  LEFT JOIN crm_support_tickets t ON t.id = a.ticket_id`;

function presentActivity(r) {
  return {
    id: r.id,
    type: r.type,
    body: r.body,
    dueDate: r.due_on || null,
    done: !!r.done_at,
    contactId: r.contact_id,
    companyId: r.company_id,
    dealId: r.deal_id,
    ticketId: r.ticket_id,
    subject: r.contact_name || r.company_name || r.deal_name || r.ticket_subject || null,
    createdBy: r.author || null,
    createdAt: r.created_at
  };
}

/** Oldest first, so a record reads as a timeline. */
async function listActivities(parentKey, rawId) {
  const parent = PARENTS[parentKey];
  const row = await parent.find(rawId);
  const rows = await all(`${ACTIVITY_SELECT} WHERE a.${parent.column} = ? ORDER BY a.created_at, a.id`, [row.id]);
  return { activities: rows.map(presentActivity) };
}

async function addActivity(ctx, parentKey, rawId, input) {
  const parent = PARENTS[parentKey];
  assertCrm(ctx, parent.capability);
  const row = await parent.find(rawId);
  const v = activitySchema.parse(input || {});
  if (v.type === 'note' && v.dueDate) throw httpError(400, 'Only follow-up tasks have a follow-up date.', 'VALIDATION_ERROR');
  const ins = await run(
    `INSERT INTO crm_activities (${parent.column}, type, body, due_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [row.id, v.type, v.body, v.dueDate ?? null, ctx.auth.userId]
  );
  await crmAudit(ctx, 'crm.activity_added', { resourceType: 'crm_activity', resourceId: ins.lastID, metadata: { type: v.type, on: parentKey } });
  return { activity: presentActivity(await get(`${ACTIVITY_SELECT} WHERE a.id = ?`, [ins.lastID])) };
}

/** History written by the system (a stage or status change), never typed by a user. */
function recordChange(ctx, column, parentId, body) {
  if (!PARENT_COLUMNS.includes(column)) throw new Error('Unknown activity parent.');
  return run(`INSERT INTO crm_activities (${column}, type, body, created_by, created_at) VALUES (?, 'change', ?, ?, UTC_TIMESTAMP())`, [parentId, body, ctx.auth.userId]);
}

/** Completing a task needs the same permission as adding to the record it is on. */
async function setTaskDone(ctx, rawId, input) {
  const { done } = z.object({ done: z.boolean() }).strict().parse(input || {});
  const row = await get('SELECT * FROM crm_activities WHERE id = ?', [requireId(rawId, 'activity')]);
  if (!row) throw httpError(404, 'Activity not found.', 'NOT_FOUND');
  const parent = Object.values(PARENTS).find(p => row[p.column]);
  if (parent) assertCrm(ctx, parent.capability);
  if (row.type !== 'task') throw httpError(400, 'Only follow-up tasks can be completed.', 'VALIDATION_ERROR');
  await run(`UPDATE crm_activities SET done_at = ${done ? 'UTC_TIMESTAMP()' : 'NULL'} WHERE id = ?`, [row.id]);
  await crmAudit(ctx, 'crm.task_updated', { resourceType: 'crm_activity', resourceId: row.id, metadata: { done } });
  return { activity: presentActivity(await get(`${ACTIVITY_SELECT} WHERE a.id = ?`, [row.id])) };
}

module.exports = {
  STAGES, CONTACT_STATUSES, PARENTS, overview,
  listContacts, getContact, createContact, updateContact,
  listCompanies, getCompany, createCompany, updateCompany,
  listDeals, getDeal, createDeal, updateDeal, removeDeal,
  listActivities, addActivity, setTaskDone, recordChange,
  assertContact, assertCompany, companyOfContact, requireId, likeOf, text
};
