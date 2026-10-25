const crypto = require('crypto');
const { z } = require('zod');
const { run, get, all } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const emailService = require('../../../services/emailService');
const aiEngine = require('../../../services/aiEngine');
const { resolveSelectedProduct } = require('../../../lib/productContext');
const { htmlToText } = require('../../../lib/emailHtml');
const { unresolvedPlaceholders } = require('../../../lib/mailContent');
const { workerAuthorizationProblem } = require('../../../lib/workerAuthorization');

/**
 * Product -> Leads -> Personalized emails -> Preview -> Send (Mail Center).
 *
 * A batch holds one personalized draft per selected lead (email_drafts.batch_id), so every email is
 * previewed, approved, sent and tracked exactly like a single draft: the same placeholder checks,
 * single-send claim, unknown-outcome review and audit log. Each recipient gets a separate email.
 *
 * Marketing consent is never assumed: a lead is eligible for these bulk sends only with a valid
 * email address, consent recorded as "granted" WITH evidence (method, date given, evidence
 * reference), and no unsubscribe/bounce on record. Eligibility is checked when the batch is
 * created and again right before each email is sent.
 *
 * Sending is done by the background worker (processBatches): a batch is queued, then each email is
 * sent separately with its state stored per recipient, so an interrupted batch resumes without
 * resending anything sent or uncertain. Unsubscribes arrive by link (incl. RFC 8058 one-click) or
 * by reply (detectUnsubscribeReplies, using the outreach inbox sync).
 */
const ws = ctx => ctx.auth.workspaceId;
const MAX_LIST = 2000;
const maxBatch = () => Math.max(1, Math.min(500, parseInt(process.env.MAIL_BATCH_MAX_RECIPIENTS || '100', 10) || 100));
const STALE_LOCK_MS = 10 * 60 * 1000;
const EMAILS_PER_TICK = () => Math.max(1, Math.min(100, parseInt(process.env.MAIL_BATCH_EMAILS_PER_TICK || '10', 10) || 10));
const REPLY_MONITOR_DAYS = 60;
const CONSENT_METHODS = ['web_form', 'double_opt_in', 'checkbox_at_signup', 'written', 'event_signup', 'customer_request', 'imported_with_proof'];

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.expose = true;
  return err;
}

const escapeHtml = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstName = name => String(name || '').trim().split(/\s+/)[0] || '';
const id = z.union([z.number().int().positive(), z.string().regex(/^\d{1,10}$/).transform(Number)]);

// ------------------------------------------------------------------ eligibility

async function hasTable(name) {
  return !!(await get('SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [name]));
}

/** Marks each lead eligible or not, with the reasons (only from information actually stored). */
async function withEligibility(workspaceId, leads) {
  const suppressed = new Map((await all('SELECT email, reason FROM email_suppressions WHERE workspace_id = ?', [workspaceId])).map(r => [String(r.email).toLowerCase(), r.reason]));
  const ids = leads.map(l => l.id);
  const discovered = new Set(ids.length && (await hasTable('lead_place_refs'))
    ? (await all(`SELECT lead_id FROM lead_place_refs WHERE lead_id IN (${ids.map(() => '?').join(',')})`, ids)).map(r => r.lead_id)
    : []);
  return leads.map(l => {
    const email = String(l.email || '').trim();
    const reasons = [];
    if (!email) reasons.push('No email address');
    else if (!emailService.isValidRecipient(email)) reasons.push('Invalid or placeholder email address');
    else if (suppressed.has(email.toLowerCase())) reasons.push(suppressed.get(email.toLowerCase()) === 'bounced' ? 'Email bounced earlier' : 'Unsubscribed');
    const consent = l.marketing_consent || 'unknown';
    if (consent === 'withdrawn') reasons.push('Marketing consent withdrawn');
    else if (consent === 'granted' && !(l.marketing_consent_method && l.marketing_consent_evidence)) {
      // Recorded before evidence was required (a note only): not trusted as consent.
      reasons.push('Consent recorded without evidence; record how and when it was given');
    } else if (consent !== 'granted') {
      reasons.push(discovered.has(l.id)
        ? 'Found with AI Lead Discovery (public business listing); no marketing consent recorded'
        : 'Marketing consent not recorded');
    }
    return {
      id: l.id,
      name: l.name,
      email: email || null,
      company: l.company_name || null,
      status: l.status,
      productId: l.product_id || null,
      productInterest: l.product_interest || null,
      consent,
      consentSource: l.marketing_consent_source || null,
      consentMethod: l.marketing_consent_method || null,
      consentObtainedAt: l.marketing_consent_obtained_at || null,
      source: discovered.has(l.id) ? 'discovery' : 'crm',
      eligible: reasons.length === 0,
      reasons
    };
  });
}

const LEAD_COLUMNS = 'id, name, email, company_name, status, product_id, product_interest, marketing_consent, marketing_consent_source, marketing_consent_method, marketing_consent_obtained_at, marketing_consent_evidence';

/**
 * Leads of the workspace for the recipient picker: searchable and filterable, each with its
 * eligibility. Nothing is selected server-side; eligibleIds supports "Select all eligible".
 */
async function listRecipients(ctx, query = {}) {
  const where = ['workspace_id = ?'];
  const params = [ws(ctx)];
  const q = String(query.q || '').trim().slice(0, 100);
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    where.push('(name LIKE ? OR email LIKE ? OR company_name LIKE ?)');
    params.push(like, like, like);
  }
  if (query.status) { where.push('status = ?'); params.push(String(query.status).slice(0, 50)); }
  let product = null;
  if (query.productId) {
    product = await resolveSelectedProduct(ws(ctx), query.productId);
    if (query.productLeadsOnly === '1') { where.push('product_id = ?'); params.push(product.id); }
  }
  const rows = await all(`SELECT ${LEAD_COLUMNS} FROM leads WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${MAX_LIST + 1}`, params);
  const truncated = rows.length > MAX_LIST;
  let leads = await withEligibility(ws(ctx), rows.slice(0, MAX_LIST));
  if (query.eligibility === 'eligible') leads = leads.filter(l => l.eligible);
  if (query.eligibility === 'ineligible') leads = leads.filter(l => !l.eligible);
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 25));
  return {
    product: product ? presentProduct(product) : null,
    leads: leads.slice((page - 1) * pageSize, page * pageSize),
    total: leads.length,
    page,
    pageSize,
    truncated,
    // Distinct addresses only; capped at the batch size.
    eligibleIds: dedupeByEmail(leads.filter(l => l.eligible)).slice(0, maxBatch()).map(l => l.id),
    eligibleCount: leads.filter(l => l.eligible).length,
    maxBatch: maxBatch()
  };
}

function dedupeByEmail(leads) {
  const seen = new Set();
  return leads.filter(l => { const k = String(l.email || '').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

function presentProduct(p) {
  let features = [];
  try { features = Array.isArray(p.features) ? p.features : JSON.parse(p.features_json || '[]'); } catch (e) { features = []; }
  return { id: p.id, name: p.name, tagline: p.tagline || null, description: p.description || null, url: p.url || null, targetAudience: p.target_audience || p.targetAudience || null, features };
}

const consentSchema = z.discriminatedUnion('status', [
  // Granting needs evidence of genuine consent, not just a note.
  z.object({
    status: z.literal('granted'),
    leadIds: z.array(id).min(1).max(500),
    method: z.enum(CONSENT_METHODS),
    obtainedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the date consent was given (YYYY-MM-DD).'),
    evidence: z.string().trim().min(3, 'Give the evidence reference (form submission id, document, URL...).').max(500),
    note: z.string().trim().max(255).optional(),
    attest: z.literal(true, { errorMap: () => ({ message: 'Confirm that you hold this evidence for each selected lead.' }) })
  }).strict(),
  z.object({ status: z.literal('withdrawn'), leadIds: z.array(id).min(1).max(500), note: z.string().trim().max(255).optional() }).strict(),
  z.object({ status: z.literal('unknown'), leadIds: z.array(id).min(1).max(500), note: z.string().trim().max(255).optional() }).strict()
]);

async function consentEvent(workspaceId, leadId, { status, method = null, obtainedAt = null, evidence = null, note = null, actorType = 'user', actorUserId = null, reference = null }) {
  await run(
    `INSERT INTO lead_consent_events (workspace_id, lead_id, status, method, obtained_at, evidence, note, actor_type, actor_user_id, reference, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [workspaceId, leadId, status, method, obtainedAt, evidence, note ? String(note).slice(0, 255) : null, actorType, actorUserId, reference ? String(reference).slice(0, 100) : null]
  );
}

/**
 * Records marketing consent with its evidence: how it was obtained, when it was given, and a
 * reference to the proof (plus the recorder's confirmation that they hold it). Every change is
 * kept in lead_consent_events and the audit log.
 */
async function recordConsent(ctx, input) {
  const v = consentSchema.parse(input || {});
  const ids = [...new Set(v.leadIds)];
  const found = await all(`SELECT id FROM leads WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [ws(ctx), ...ids]);
  if (found.length !== ids.length) throw httpError(404, 'One or more leads were not found in this workspace.', 'NOT_FOUND');
  if (v.status === 'granted') {
    const given = new Date(`${v.obtainedAt}T00:00:00Z`);
    if (Number.isNaN(given.getTime()) || given.getTime() > Date.now() + 86400000) throw httpError(400, 'The consent date cannot be in the future.', 'VALIDATION_ERROR');
  }
  const source = v.status === 'granted' ? `${v.method}: ${v.evidence}`.slice(0, 255) : (v.note || null);
  await run(
    `UPDATE leads SET marketing_consent = ?, marketing_consent_source = ?, marketing_consent_method = ?, marketing_consent_obtained_at = ?, marketing_consent_evidence = ?,
       marketing_consent_at = ${v.status === 'unknown' ? 'NULL' : 'UTC_TIMESTAMP()'}, marketing_consent_by = ?
     WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    [v.status, source, v.status === 'granted' ? v.method : null, v.status === 'granted' ? `${v.obtainedAt} 00:00:00` : null, v.status === 'granted' ? v.evidence : null,
      v.status === 'unknown' ? null : ctx.auth.userId, ws(ctx), ...ids]
  );
  for (const leadId of ids) {
    await consentEvent(ws(ctx), leadId, { status: v.status, method: v.method || null, obtainedAt: v.obtainedAt ? `${v.obtainedAt} 00:00:00` : null, evidence: v.evidence || null, note: v.note || null, actorUserId: ctx.auth.userId });
    await audit(ctx, 'leads.consent_recorded', { resourceType: 'lead', resourceId: leadId, metadata: { status: v.status, method: v.method || null, obtainedAt: v.obtainedAt || null } });
  }
  return { updated: ids.length, status: v.status };
}

/**
 * Applies an unsubscribe for one address in one workspace (idempotent): the address is suppressed
 * and consent is withdrawn on the lead the email was sent to; other leads are not touched.
 * Returns true when something changed.
 */
async function applyUnsubscribe(workspaceId, { email, leadId, source, reference }) {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr) return false;
  const existing = await get('SELECT reason FROM email_suppressions WHERE workspace_id = ? AND email = ?', [workspaceId, addr]);
  if (!existing) await require('../../outreach/outreachService').suppress(workspaceId, addr, 'unsubscribed', source);
  let withdrew = false;
  if (leadId) {
    const r = await run(
      `UPDATE leads SET marketing_consent = 'withdrawn', marketing_consent_source = ?, marketing_consent_method = NULL, marketing_consent_evidence = NULL,
         marketing_consent_obtained_at = NULL, marketing_consent_at = UTC_TIMESTAMP(), marketing_consent_by = NULL
       WHERE workspace_id = ? AND id = ? AND LOWER(email) = ? AND marketing_consent <> 'withdrawn'`,
      [source === 'reply' ? 'Unsubscribe reply' : 'Unsubscribe link', workspaceId, leadId, addr]
    );
    withdrew = r.changes > 0;
    if (withdrew) await consentEvent(workspaceId, leadId, { status: 'withdrawn', note: source === 'reply' ? 'Unsubscribe reply' : 'Unsubscribe link', actorType: 'recipient', reference });
  }
  if (!existing || withdrew) {
    await audit({ workspaceId, actorType: 'recipient' }, 'mail.unsubscribed', { resourceType: 'lead', resourceId: leadId || null, metadata: { source, reference: reference || null } });
  }
  return !existing || withdrew;
}

/**
 * Unsubscribe requests sent as replies to product emails (the inbox sync stores replies in
 * emails). A reply counts only from the exact recipient address, in the same workspace, received
 * after that email was sent and within REPLY_MONITOR_DAYS. Safe to run repeatedly.
 */
async function detectUnsubscribeReplies({ workspaceId = null, limit = 200 } = {}) {
  const { isUnsubscribeRequest } = require('../../outreach/outreachSender');
  const rows = await all(
    `SELECT d.id, d.workspace_id, d.lead_id, d.recipient_email, d.sent_at FROM email_drafts d
     WHERE d.batch_id IS NOT NULL AND d.status = 'Sent' AND d.sent_at IS NOT NULL AND d.sent_at >= UTC_TIMESTAMP() - INTERVAL ${REPLY_MONITOR_DAYS} DAY
       ${workspaceId ? 'AND d.workspace_id = ?' : ''}
       AND EXISTS (SELECT 1 FROM emails e WHERE e.workspace_id = d.workspace_id AND LOWER(e.sender_email) = LOWER(d.recipient_email)
                   AND e.smtp_status LIKE 'Received%' AND e.received_at > d.sent_at)
     ORDER BY d.id LIMIT ${Math.max(1, Math.min(1000, limit))}`,
    workspaceId ? [workspaceId] : []
  );
  let applied = 0;
  for (const d of rows) {
    const replies = await all(
      "SELECT id, subject, body FROM emails WHERE workspace_id = ? AND LOWER(sender_email) = LOWER(?) AND smtp_status LIKE 'Received%' AND received_at > ? ORDER BY id",
      [d.workspace_id, d.recipient_email, d.sent_at]
    );
    const hit = replies.find(r => isUnsubscribeRequest(r.subject, r.body));
    if (hit && await applyUnsubscribe(d.workspace_id, { email: d.recipient_email, leadId: d.lead_id, source: 'reply', reference: `email:${hit.id}` })) applied++;
  }
  return applied;
}

/** Workspaces whose product emails may still get replies (for the inbox sync). */
async function monitoredWorkspaces() {
  return (await all(`SELECT DISTINCT workspace_id FROM email_drafts WHERE batch_id IS NOT NULL AND status = 'Sent' AND sent_at >= UTC_TIMESTAMP() - INTERVAL ${REPLY_MONITOR_DAYS} DAY`)).map(r => r.workspace_id);
}

// ------------------------------------------------------------------ batches

const batchSchema = z.object({
  productId: id,
  leadIds: z.array(id).min(1, 'Select at least one lead.'),
  templateId: id.nullable().optional(),
  goal: z.string().trim().max(2000).optional().nullable(),
  tone: z.string().trim().max(100).optional().nullable(),
  subject: z.string().trim().max(255).optional().nullable(),
  senderName: z.string().trim().min(1, 'Enter the sender name used to sign the emails.').max(150)
}).strict();

/** Fills {{first_name}}, {{company}}, {{product_name}} for one lead (escaped in HTML). */
function fillLeadTokens(text, values, { html }) {
  return String(text || '').replace(/\{\{\s*(first_name|company|product_name)\s*\}\}/g, (m, k) => {
    const v = String(values[k] || '').trim();
    if (!v) return m; // left for the person to fill (shown as a placeholder in the preview)
    return html ? escapeHtml(v) : v;
  });
}

function unsubscribeLink(token) {
  if (!token) return null;
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const isPublic = /^https:\/\//i.test(base) && !/localhost|127\.0\.0\.1|\.local\b/i.test(base);
  return isPublic ? `${base}/api/v1/mail/unsubscribe/${token}` : null;
}

function footer(senderEmail, token) {
  const link = unsubscribeLink(token);
  const text = `You are receiving this email from ${senderEmail}. To stop these emails, reply "unsubscribe"${link ? ` or open ${link}` : ''}.`;
  const html = `<p style="font-size:12px;color:#64748b;margin-top:24px;">You are receiving this email from ${escapeHtml(senderEmail)}. To stop these emails, reply &quot;unsubscribe&quot;${link ? ` or <a href="${escapeHtml(link)}">unsubscribe here</a>` : ''}.</p>`;
  return { text, html };
}

/** One lead's email: the product (and template, if chosen) personalized with the lead's details. */
async function personalize({ product, lead, template, goal, tone, subject, senderName, senderEmail, token }) {
  const values = { first_name: firstName(lead.name), company: lead.company_name || '', product_name: product.name };
  let html;
  let text;
  let subj;
  if (template) {
    html = fillLeadTokens(template, values, { html: true });
    text = htmlToText(html);
    subj = fillLeadTokens(subject || product.name, values, { html: false });
  } else {
    const d = await aiEngine.generateMailDraft(product, { name: values.first_name }, fillLeadTokens(goal || '', values, { html: false }), tone || 'Professional');
    html = d.body_html;
    text = d.body_text;
    subj = subject ? fillLeadTokens(subject, values, { html: false }) : (values.company ? `${d.subject} for ${values.company}`.slice(0, 255) : d.subject);
  }
  html = html.split('[Your name]').join(escapeHtml(senderName));
  text = text.split('[Your name]').join(senderName);
  const f = footer(senderEmail, token);
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${f.html}</body>`) : `${html}${f.html}`;
  text = `${text}\n\n--\n${f.text}`;
  return { subject: String(subj).slice(0, 255), html, text };
}

async function createBatch(ctx, input) {
  const v = batchSchema.parse(input || {});
  const ids = [...new Set(v.leadIds)];
  if (ids.length > maxBatch()) throw httpError(400, `Select at most ${maxBatch()} leads per batch.`, 'TOO_MANY_RECIPIENTS');
  const product = await resolveSelectedProduct(ws(ctx), v.productId);
  const rows = await all(`SELECT ${LEAD_COLUMNS} FROM leads WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [ws(ctx), ...ids]);
  if (rows.length !== ids.length) throw httpError(404, 'One or more selected leads were not found in this workspace.', 'NOT_FOUND');

  let template = null;
  if (v.templateId) template = (await require('../templates/templateService').htmlForUse(ws(ctx), v.templateId)).html;
  else if (!v.goal) throw httpError(400, 'Describe the purpose of the email (goal), or choose a template.', 'VALIDATION_ERROR');

  const config = await emailService.getRawMailConfig(ws(ctx));
  const senderEmail = config.sender_email || config.smtp_user;
  if (!senderEmail) throw httpError(409, 'Mail is not configured for this workspace. Add a sender address in Mail Settings.', 'MAIL_NOT_CONFIGURED');

  const assessed = await withEligibility(ws(ctx), rows);
  const skipped = assessed.filter(l => !l.eligible).map(l => ({ leadId: l.id, name: l.name, email: l.email, reasons: l.reasons }));
  const seen = new Set();
  const eligible = [];
  for (const l of assessed.filter(x => x.eligible)) {
    const key = l.email.toLowerCase();
    if (seen.has(key)) { skipped.push({ leadId: l.id, name: l.name, email: l.email, reasons: ['Same email address as another selected lead'] }); continue; }
    seen.add(key);
    eligible.push(l);
  }
  if (!eligible.length) throw Object.assign(httpError(400, 'None of the selected leads can receive marketing email.', 'NO_ELIGIBLE_RECIPIENTS'), { details: { skipped } });

  const batch = await run(
    `INSERT INTO mail_draft_batches (workspace_id, product_id, product_name, template_id, goal, tone, subject, sender_name, status, recipients, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ws(ctx), product.id, product.name, v.templateId || null, v.goal || null, v.tone || null, v.subject || null, v.senderName, eligible.length, ctx.auth.userId]
  );
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  for (const l of eligible) {
    const lead = rows.find(r => r.id === l.id);
    const token = crypto.randomBytes(20).toString('hex');
    const p = await personalize({ product, lead, template, goal: v.goal, tone: v.tone, subject: v.subject, senderName: v.senderName, senderEmail, token });
    await run(
      `INSERT INTO email_drafts (workspace_id, product_id, product_name, lead_id, recipient_email, recipient_name, subject, body_html, body_text, tone, status, batch_id, unsubscribe_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?, ?, ?, ?)`,
      [ws(ctx), product.id, product.name, lead.id, l.email, lead.name || '', p.subject, p.html, p.text, v.tone || 'Professional', batch.lastID, token, now, now]
    );
  }
  await audit(ctx, 'mail.batch_created', { resourceType: 'mail_draft_batch', resourceId: batch.lastID, metadata: { productId: product.id, recipients: eligible.length, skipped: skipped.length, templateId: v.templateId || null } });
  return { ...(await getBatch(ctx, batch.lastID)), skipped };
}

async function requireBatch(ctx, rawId) {
  const bid = Number(rawId);
  if (!Number.isInteger(bid) || bid <= 0) throw httpError(400, 'Invalid id.', 'VALIDATION_ERROR');
  const b = await get('SELECT * FROM mail_draft_batches WHERE id = ? AND workspace_id = ?', [bid, ws(ctx)]);
  if (!b) throw httpError(404, 'Batch not found.', 'NOT_FOUND');
  return b;
}

async function batchDrafts(ctx, batchId) {
  return all('SELECT * FROM email_drafts WHERE workspace_id = ? AND batch_id = ? ORDER BY id', [ws(ctx), batchId]);
}

function counts(drafts) {
  const c = { total: drafts.length };
  for (const d of drafts) c[d.status] = (c[d.status] || 0) + 1;
  return c;
}


async function getBatch(ctx, rawId) {
  const b = await requireBatch(ctx, rawId);
  const { presentDraft } = require('../routes');
  const drafts = (await batchDrafts(ctx, b.id)).map(d => presentDraft(d));
  return {
    batch: {
      id: b.id, productId: b.product_id, productName: b.product_name, templateId: b.template_id, goal: b.goal, tone: b.tone,
      subject: b.subject, senderName: b.sender_name, status: b.status, recipients: b.recipients, createdAt: b.created_at,
      approvedAt: b.approved_at, queuedAt: b.queued_at, sentAt: b.sent_at, lastError: b.last_error, counts: counts(drafts),
      outcomes: drafts.reduce((o, d) => (d.batch_outcome ? { ...o, [d.batch_outcome]: (o[d.batch_outcome] || 0) + 1 } : o), {})
    },
    drafts: drafts.map(d => ({
      id: d.id, leadId: d.lead_id, recipientName: d.recipient_name, recipientEmail: d.recipient_email, subject: d.subject,
      status: d.status, outcome: d.batch_outcome || null, error: d.send_error || null, sentAt: d.sent_at || null,
      placeholders: d.placeholders, bodyHtml: d.body_html, updatedAt: d.updated_at
    })),
    // Product emails are marketing email: blocked through ZeptoMail; SMTP only when approved.
    marketingDelivery: await emailService.marketingDeliveryStatus(ws(ctx))
  };
}

async function listBatches(ctx) {
  const rows = await all('SELECT id, product_name, status, recipients, created_at, sent_at FROM mail_draft_batches WHERE workspace_id = ? ORDER BY id DESC LIMIT 50', [ws(ctx)]);
  return rows.map(r => ({ id: r.id, productName: r.product_name, status: r.status, recipients: r.recipients, createdAt: r.created_at, sentAt: r.sent_at }));
}

/** Approves every draft of the batch that is ready (valid recipient, no placeholders); reports the rest. */
async function approveBatch(ctx, rawId) {
  const b = await requireBatch(ctx, rawId);
  if (['queued', 'sending'].includes(b.status)) throw httpError(409, 'This batch is being sent.', 'BATCH_SENDING');
  const { draftParts } = require('../routes');
  const problems = [];
  let approved = 0;
  for (const d of await batchDrafts(ctx, b.id)) {
    if (d.status !== 'Draft') continue;
    const missing = unresolvedPlaceholders(draftParts(d));
    if (!emailService.isValidRecipient(d.recipient_email)) { problems.push({ draftId: d.id, email: d.recipient_email, problem: 'Invalid recipient email address' }); continue; }
    if (missing.length) { problems.push({ draftId: d.id, email: d.recipient_email, problem: `Fill the placeholders: ${missing.join(', ')}` }); continue; }
    const r = await run("UPDATE email_drafts SET status = 'Approved', updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ? AND status = 'Draft'", [d.id, ws(ctx)]);
    approved += r.changes;
  }
  if (approved) {
    await run("UPDATE mail_draft_batches SET status = 'approved', approved_by = ?, approved_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ? AND status NOT IN ('queued', 'sending')", [ctx.auth.userId, b.id]);
  }
  await audit(ctx, 'mail.batch_approved', { resourceType: 'mail_draft_batch', resourceId: b.id, metadata: { approved, problems: problems.length } });
  return { approved, problems, ...(await getBatch(ctx, b.id)) };
}

/** Right before sending: the lead must still exist, be eligible and still have this address. */
async function recheckRecipient(workspaceId, draft) {
  if (!draft.lead_id) return 'Lead no longer linked';
  const lead = await get(`SELECT ${LEAD_COLUMNS} FROM leads WHERE workspace_id = ? AND id = ?`, [workspaceId, draft.lead_id]);
  if (!lead) return 'Lead was deleted';
  const [e] = await withEligibility(workspaceId, [lead]);
  if (!e.eligible) return e.reasons.join('; ');
  if (String(e.email).toLowerCase() !== String(draft.recipient_email).toLowerCase()) return 'The lead\'s email address changed; create a new email for it';
  return null;
}

/**
 * Queues the batch for the background worker, which sends each approved email separately. The
 * request returns at once; progress and per-recipient results are in the batch. Queuing again
 * (e.g. after a pause) resumes it: only emails not yet attempted are sent.
 */
async function sendBatch(ctx, rawId, { confirm } = {}) {
  if (confirm !== true) throw httpError(400, 'Explicit confirmation (confirm: true) is required to send.', 'CONFIRMATION_REQUIRED');
  const b = await requireBatch(ctx, rawId);
  const pending = await get("SELECT COUNT(*) AS n FROM email_drafts WHERE workspace_id = ? AND batch_id = ? AND status = 'Approved' AND batch_outcome IS NULL", [ws(ctx), b.id]);
  if (!Number(pending.n)) throw httpError(409, 'There are no approved emails waiting to be sent in this batch.', 'NOTHING_TO_SEND');
  const delivery = await emailService.marketingDeliveryStatus(ws(ctx));
  if (!delivery.allowed) throw httpError(409, delivery.reason, delivery.code);
  const q = await run(
    "UPDATE mail_draft_batches SET status = 'queued', sent_by = ?, queued_at = UTC_TIMESTAMP(), last_error = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ? AND status NOT IN ('queued', 'sending')",
    [ctx.auth.userId, b.id, ws(ctx)]
  );
  if (!q.changes) throw httpError(409, 'This batch is already queued or being sent.', 'BATCH_SENDING');
  await audit(ctx, 'mail.batch_queued', { resourceType: 'mail_draft_batch', resourceId: b.id, metadata: { pending: Number(pending.n) } });
  return { queued: true, ...(await getBatch(ctx, b.id)) };
}

/** Explicitly retries emails that failed with a clear (not-sent) error. Never touches uncertain ones. */
async function retryFailed(ctx, rawId, { confirm } = {}) {
  if (confirm !== true) throw httpError(400, 'Explicit confirmation (confirm: true) is required.', 'CONFIRMATION_REQUIRED');
  const b = await requireBatch(ctx, rawId);
  if (['queued', 'sending'].includes(b.status)) throw httpError(409, 'This batch is being sent.', 'BATCH_SENDING');
  const delivery = await emailService.marketingDeliveryStatus(ws(ctx));
  if (!delivery.allowed) throw httpError(409, delivery.reason, delivery.code);
  const r = await run("UPDATE email_drafts SET batch_outcome = NULL, send_error = NULL WHERE workspace_id = ? AND batch_id = ? AND batch_outcome = 'failed' AND status = 'Approved'", [ws(ctx), b.id]);
  await audit(ctx, 'mail.batch_retry_failed', { resourceType: 'mail_draft_batch', resourceId: b.id, metadata: { reset: r.changes } });
  return sendBatch(ctx, b.id, { confirm: true });
}

async function markOutcome(draftId, outcome, error) {
  await run('UPDATE email_drafts SET batch_outcome = ?, send_error = ? WHERE id = ?', [outcome, error ? String(error).slice(0, 500) : null, draftId]);
}

/**
 * A worker that stopped mid-send: emails left "Sending" may or may not have been delivered, so
 * they go to Needs Review (never resent); the batch lock is released so the rest can resume.
 */
async function recoverStaleBatches() {
  const cutoff = new Date(Date.now() - STALE_LOCK_MS).toISOString().replace('T', ' ').substring(0, 19);
  const stuck = await all("SELECT id FROM email_drafts WHERE batch_id IS NOT NULL AND status = 'Sending' AND updated_at < ?", [cutoff]);
  for (const d of stuck) {
    const r = await run("UPDATE email_drafts SET status = 'Needs Review', batch_outcome = 'needs_review', send_error = 'The sender stopped during this email; it may or may not have been delivered.', updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'Sending'", [d.id]);
    if (r.changes) await audit({ actorType: 'worker' }, 'mail.batch_email_outcome_unknown', { resourceType: 'email_draft', resourceId: d.id });
  }
  await run("UPDATE mail_draft_batches SET status = 'queued', locked_by = NULL, locked_at = NULL WHERE status = 'sending' AND locked_at < ?", [cutoff]);
  return stuck.length;
}

/**
 * Worker tick: claims one queued batch at a time and sends up to EMAILS_PER_TICK emails. Before
 * each email: active workspace, the person who queued it is still an active member allowed to
 * send, and the recipient is still eligible (consent with evidence, not unsubscribed/bounced).
 */
async function processBatches(workerId, { maxEmails = EMAILS_PER_TICK() } = {}) {
  await recoverStaleBatches();
  const cutoff = new Date(Date.now() - STALE_LOCK_MS).toISOString().replace('T', ' ').substring(0, 19);
  const candidates = await all("SELECT id FROM mail_draft_batches WHERE status IN ('queued', 'sending') AND (locked_by IS NULL OR locked_at < ?) ORDER BY queued_at, id LIMIT 5", [cutoff]);
  let sent = 0;
  for (const { id: batchId } of candidates) {
    const claim = await run(
      "UPDATE mail_draft_batches SET status = 'sending', locked_by = ?, locked_at = UTC_TIMESTAMP() WHERE id = ? AND status IN ('queued', 'sending') AND (locked_by IS NULL OR locked_at < ?)",
      [workerId, batchId, cutoff]
    );
    if (!claim.changes) continue;
    const b = await get('SELECT * FROM mail_draft_batches WHERE id = ?', [batchId]);
    const ctx = { auth: { workspaceId: b.workspace_id, userId: b.sent_by, actorType: 'worker' } };
    let pause = null;
    try {
      const auth = await workerAuthorizationProblem(b.workspace_id, b.sent_by, 'mail.send');
      if (auth) { pause = auth.message; continue; }
      // Re-checked by the worker too: the provider or its approval may have changed since queuing.
      const delivery = await emailService.marketingDeliveryStatus(b.workspace_id);
      if (!delivery.allowed) { pause = delivery.reason; continue; }
      const drafts = await all(`SELECT * FROM email_drafts WHERE workspace_id = ? AND batch_id = ? AND status = 'Approved' AND batch_outcome IS NULL ORDER BY id LIMIT ${Math.max(1, maxEmails - sent)}`, [b.workspace_id, b.id]);
      const { sendDraftCore } = require('../routes');
      for (const d of drafts) {
        if (sent >= maxEmails) break;
        await run('UPDATE mail_draft_batches SET locked_at = UTC_TIMESTAMP() WHERE id = ?', [b.id]);
        const why = await recheckRecipient(b.workspace_id, d);
        if (why) { await markOutcome(d.id, 'skipped', why); continue; }
        try {
          await sendDraftCore(ctx, d);
          await markOutcome(d.id, 'sent', null);
          sent++;
        } catch (err) {
          if (err.outcomeUnknown) await markOutcome(d.id, 'needs_review', err.message);
          else if (err.code === 'MAIL_NOT_CONFIGURED' || err.marketingBlocked) { pause = err.message; break; }
          else if (err.code === 'RECIPIENT_INELIGIBLE') await markOutcome(d.id, 'skipped', err.message);
          else if (['DRAFT_SENT', 'NEEDS_REVIEW'].includes(err.code)) {
            const cur = await get('SELECT status FROM email_drafts WHERE id = ?', [d.id]);
            await markOutcome(d.id, cur.status === 'Sent' ? 'sent' : 'needs_review', err.message);
          } else await markOutcome(d.id, 'failed', err.message);
        }
      }
    } finally {
      const left = await get("SELECT COUNT(*) AS n FROM email_drafts WHERE workspace_id = ? AND batch_id = ? AND status = 'Approved' AND batch_outcome IS NULL", [b.workspace_id, b.id]);
      const status = pause ? 'paused' : (Number(left.n) ? 'queued' : 'done');
      await run(`UPDATE mail_draft_batches SET status = ?, locked_by = NULL, locked_at = NULL, last_error = ?, ${status === 'done' ? 'sent_at = UTC_TIMESTAMP(),' : ''} updated_at = UTC_TIMESTAMP() WHERE id = ? AND locked_by = ?`,
        [status, pause ? String(pause).slice(0, 500) : null, b.id, workerId]);
      if (status !== 'queued') await audit(ctx, status === 'done' ? 'mail.batch_sent' : 'mail.batch_paused', { resourceType: 'mail_draft_batch', resourceId: b.id, metadata: { reason: pause || null } });
    }
    if (sent >= maxEmails) break;
  }
  return sent;
}

/** Public unsubscribe (token from the email): suppresses the address and withdraws that lead's consent. */
async function unsubscribeByToken(token, { apply }) {
  if (!/^[a-f0-9]{40}$/.test(String(token || ''))) return null;
  const d = await get('SELECT id, workspace_id, lead_id, recipient_email FROM email_drafts WHERE unsubscribe_token = ?', [token]);
  if (!d) return null;
  const email = String(d.recipient_email).trim().toLowerCase();
  if (apply) await applyUnsubscribe(d.workspace_id, { email, leadId: d.lead_id, source: 'link', reference: `draft:${d.id}` });
  const s = await get('SELECT 1 AS x FROM email_suppressions WHERE workspace_id = ? AND email = ?', [d.workspace_id, email]);
  return { unsubscribed: !!s };
}

module.exports = {
  CONSENT_METHODS, listRecipients, recordConsent, createBatch, getBatch, listBatches, approveBatch, sendBatch, retryFailed,
  processBatches, recoverStaleBatches, recheckRecipient, unsubscribeByToken, unsubscribeLink, applyUnsubscribe,
  detectUnsubscribeReplies, monitoredWorkspaces, personalize, withEligibility
};
