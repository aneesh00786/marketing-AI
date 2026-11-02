const { z } = require('zod');
const { run, get, all } = require('../../db/database');
const { httpError, crmAudit, requireAssignable } = require('./crmAccess');
const crm = require('./crmService');

/**
 * Basic internal support tickets in the global CRM. Staff enter them; customers see nothing, and
 * nothing is emailed. Internal notes and the change history are CRM activities on the ticket.
 */
const TICKET_STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
const PRIORITIES = ['Low', 'Medium', 'High'];
const MAX_LIST = 500;
const id = z.number().int().positive();

const ticketSchema = z.object({
  subject: z.string().trim().min(1, 'Enter a subject.').max(255),
  description: z.string().trim().min(1, 'Describe the issue.').max(10000),
  contactId: id.nullable(),
  companyId: id.nullable(),
  priority: z.enum(PRIORITIES),
  status: z.enum(TICKET_STATUSES),
  assignedTo: id.nullable()
}).partial().strict();

const TICKET_SELECT = `SELECT t.*, p.full_name AS contact_name, p.email AS contact_email, p.phone AS contact_phone, c.name AS company_name,
    COALESCE(NULLIF(u.display_name, ''), u.email) AS assignee_name, COALESCE(NULLIF(b.display_name, ''), b.email) AS creator_name
  FROM crm_support_tickets t
  LEFT JOIN crm_contacts p ON p.id = t.contact_id
  LEFT JOIN crm_companies c ON c.id = t.company_id
  LEFT JOIN users u ON u.id = t.assigned_to
  LEFT JOIN users b ON b.id = t.created_by`;

function present(r) {
  return {
    id: r.id,
    subject: r.subject,
    description: r.description,
    contactId: r.contact_id,
    contactName: r.contact_name || null,
    contactEmail: r.contact_email || null,
    contactPhone: r.contact_phone || null,
    companyId: r.company_id,
    companyName: r.company_name || null,
    priority: r.priority,
    status: r.status,
    assignedTo: r.assigned_to,
    assigneeName: r.assignee_name || null,
    createdBy: r.creator_name || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

async function listTickets(query = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (query.q) { where.push('(t.subject LIKE ? OR p.full_name LIKE ? OR c.name LIKE ?)'); params.push(...Array(3).fill(crm.likeOf(query.q))); }
  if (TICKET_STATUSES.includes(query.status)) { where.push('t.status = ?'); params.push(query.status); }
  if (PRIORITIES.includes(query.priority)) { where.push('t.priority = ?'); params.push(query.priority); }
  if (query.assignedTo === 'none') where.push('t.assigned_to IS NULL');
  else if (query.assignedTo) { where.push('t.assigned_to = ?'); params.push(crm.requireId(query.assignedTo, 'user')); }
  for (const [key, col] of [['contactId', 't.contact_id'], ['companyId', 't.company_id']]) {
    if (query[key]) { where.push(`${col} = ?`); params.push(crm.requireId(query[key], key)); }
  }
  const rows = await all(`${TICKET_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT ${MAX_LIST + 1}`, params);
  return { tickets: rows.slice(0, MAX_LIST).map(present), truncated: rows.length > MAX_LIST, statuses: TICKET_STATUSES, priorities: PRIORITIES };
}

async function requireTicket(rawId) {
  const row = await get(`${TICKET_SELECT} WHERE t.id = ?`, [crm.requireId(rawId, 'ticket')]);
  if (!row) throw httpError(404, 'Ticket not found.', 'NOT_FOUND');
  return row;
}

const getTicket = async rawId => ({ ticket: present(await requireTicket(rawId)) });

async function createTicket(ctx, input) {
  const v = ticketSchema.parse(input || {});
  if (!v.subject) throw httpError(400, 'Enter a subject.', 'VALIDATION_ERROR');
  if (!v.description) throw httpError(400, 'Describe the issue.', 'VALIDATION_ERROR');
  await crm.assertContact(v.contactId);
  await crm.assertCompany(v.companyId);
  await requireAssignable(v.assignedTo);
  const companyId = v.companyId === undefined ? await crm.companyOfContact(v.contactId) : v.companyId;
  const ins = await run(
    `INSERT INTO crm_support_tickets (subject, description, contact_id, company_id, priority, status, assigned_to, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [v.subject, v.description, v.contactId ?? null, companyId, v.priority || 'Medium', v.status || TICKET_STATUSES[0], v.assignedTo ?? null, ctx.auth.userId]
  );
  await crmAudit(ctx, 'crm.ticket_created', { resourceType: 'crm_ticket', resourceId: ins.lastID, metadata: { priority: v.priority || 'Medium' } });
  return getTicket(ins.lastID);
}

const COLUMN = { subject: 'subject', description: 'description', contactId: 'contact_id', companyId: 'company_id', priority: 'priority', status: 'status', assignedTo: 'assigned_to' };

async function updateTicket(ctx, rawId, input) {
  const row = await requireTicket(rawId);
  const v = ticketSchema.parse(input || {});
  await crm.assertContact(v.contactId);
  await crm.assertCompany(v.companyId);
  const reassigned = v.assignedTo !== undefined && v.assignedTo !== row.assigned_to;
  if (reassigned) await requireAssignable(v.assignedTo);
  const keys = Object.keys(v);
  if (!keys.length) return getTicket(row.id);
  await run(`UPDATE crm_support_tickets SET ${keys.map(k => `${COLUMN[k]} = ?`).join(', ')}, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [...keys.map(k => v[k]), row.id]);
  const fresh = await requireTicket(row.id);
  if (v.status && v.status !== row.status) await crm.recordChange(ctx, 'ticket_id', row.id, `Status changed from ${row.status} to ${v.status}.`);
  if (v.priority && v.priority !== row.priority) await crm.recordChange(ctx, 'ticket_id', row.id, `Priority changed from ${row.priority} to ${v.priority}.`);
  if (reassigned) await crm.recordChange(ctx, 'ticket_id', row.id, fresh.assignee_name ? `Assigned to ${fresh.assignee_name}.` : 'Unassigned.');
  await crmAudit(ctx, 'crm.ticket_updated', { resourceType: 'crm_ticket', resourceId: row.id, metadata: { fields: keys, status: fresh.status, priority: fresh.priority } });
  return { ticket: present(fresh) };
}

module.exports = { TICKET_STATUSES, PRIORITIES, listTickets, requireTicket, getTicket, createTicket, updateTicket };
