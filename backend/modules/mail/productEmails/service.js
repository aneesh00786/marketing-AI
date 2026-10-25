const crypto = require('crypto');
const { z } = require('zod');
const { run, get, all } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const emailService = require('../../../services/emailService');
const aiEngine = require('../../../services/aiEngine');
const { resolveSelectedProduct } = require('../../../lib/productContext');
const { htmlToText } = require('../../../lib/emailHtml');
const { unresolvedPlaceholders } = require('../../../lib/mailContent');

/**
 * Product -> Leads -> Personalized emails -> Preview -> Send (Mail Center).
 *
 * A batch holds one personalized draft per selected lead (email_drafts.batch_id), so every email is
 * previewed, approved, sent and tracked exactly like a single draft: the same placeholder checks,
 * single-send claim, unknown-outcome review and audit log. Each recipient gets a separate email.
 *
 * Marketing consent is never assumed: a lead is eligible for these bulk sends only with a valid
 * email address, consent recorded as "granted", and no unsubscribe/bounce on record. Eligibility
 * is checked when the batch is created and again right before each email is sent.
 */
const ws = ctx => ctx.auth.workspaceId;
const MAX_LIST = 2000;
const maxBatch = () => Math.max(1, Math.min(500, parseInt(process.env.MAIL_BATCH_MAX_RECIPIENTS || '100', 10) || 100));
const STALE_SENDING_MS = 15 * 60 * 1000;

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
    else if (consent !== 'granted') {
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
      source: discovered.has(l.id) ? 'discovery' : 'crm',
      eligible: reasons.length === 0,
      reasons
    };
  });
}

const LEAD_COLUMNS = 'id, name, email, company_name, status, product_id, product_interest, marketing_consent, marketing_consent_source';

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

const consentSchema = z.object({
  leadIds: z.array(id).min(1).max(500),
  status: z.enum(['granted', 'withdrawn', 'unknown']),
  source: z.string().trim().max(255).optional()
}).strict().refine(v => v.status !== 'granted' || (v.source && v.source.length >= 3), { message: 'Say how consent was obtained (e.g. "Signed up on website form, 2026-09-12").', path: ['source'] });

/** Records marketing consent for leads (who, when, and how it was obtained). */
async function recordConsent(ctx, input) {
  const v = consentSchema.parse(input || {});
  const ids = [...new Set(v.leadIds)];
  const found = await all(`SELECT id FROM leads WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [ws(ctx), ...ids]);
  if (found.length !== ids.length) throw httpError(404, 'One or more leads were not found in this workspace.', 'NOT_FOUND');
  await run(
    `UPDATE leads SET marketing_consent = ?, marketing_consent_source = ?, marketing_consent_at = ${v.status === 'unknown' ? 'NULL' : 'UTC_TIMESTAMP()'}, marketing_consent_by = ?
     WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    [v.status, v.status === 'unknown' ? null : (v.source || null), v.status === 'unknown' ? null : ctx.auth.userId, ws(ctx), ...ids]
  );
  for (const leadId of ids) {
    await audit(ctx, 'leads.consent_recorded', { resourceType: 'lead', resourceId: leadId, metadata: { status: v.status, source: v.source || null } });
  }
  return { updated: ids.length, status: v.status };
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
      approvedAt: b.approved_at, sentAt: b.sent_at, counts: counts(drafts)
    },
    drafts: drafts.map(d => ({
      id: d.id, leadId: d.lead_id, recipientName: d.recipient_name, recipientEmail: d.recipient_email, subject: d.subject,
      status: d.status, placeholders: d.placeholders, bodyHtml: d.body_html, updatedAt: d.updated_at
    }))
  };
}

async function listBatches(ctx) {
  const rows = await all('SELECT id, product_name, status, recipients, created_at, sent_at FROM mail_draft_batches WHERE workspace_id = ? ORDER BY id DESC LIMIT 50', [ws(ctx)]);
  return rows.map(r => ({ id: r.id, productName: r.product_name, status: r.status, recipients: r.recipients, createdAt: r.created_at, sentAt: r.sent_at }));
}

/** Approves every draft of the batch that is ready (valid recipient, no placeholders); reports the rest. */
async function approveBatch(ctx, rawId) {
  const b = await requireBatch(ctx, rawId);
  if (b.status === 'sending') throw httpError(409, 'This batch is being sent.', 'BATCH_SENDING');
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
    await run("UPDATE mail_draft_batches SET status = 'approved', approved_by = ?, approved_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ? AND status <> 'sending'", [ctx.auth.userId, b.id]);
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
 * Sends each approved email of the batch separately, one at a time. The batch is claimed first so
 * a second click or tab cannot run it twice; each email is claimed again by the draft sender.
 * Recipients that became ineligible are skipped; an unknown outcome goes to Needs Review and is
 * never retried; a mail configuration error stops the batch (the rest stay Approved).
 */
async function sendBatch(ctx, rawId, { confirm } = {}) {
  if (confirm !== true) throw httpError(400, 'Explicit confirmation (confirm: true) is required to send.', 'CONFIRMATION_REQUIRED');
  const b = await requireBatch(ctx, rawId);
  const claim = await run(
    `UPDATE mail_draft_batches SET status = 'sending', sent_by = ?, updated_at = UTC_TIMESTAMP()
     WHERE id = ? AND workspace_id = ? AND (status <> 'sending' OR updated_at < UTC_TIMESTAMP() - INTERVAL ${STALE_SENDING_MS / 60000} MINUTE)`,
    [ctx.auth.userId, b.id, ws(ctx)]
  );
  if (!claim.changes) throw httpError(409, 'This batch is already being sent.', 'BATCH_SENDING');
  const { sendDraftCore } = require('../routes');
  const results = [];
  let stopped = null;
  try {
    for (const d of await batchDrafts(ctx, b.id)) {
      if (d.status !== 'Approved') continue;
      if (stopped) { results.push({ draftId: d.id, email: d.recipient_email, outcome: 'not_sent', reason: stopped }); continue; }
      const why = await recheckRecipient(ws(ctx), d);
      if (why) { results.push({ draftId: d.id, email: d.recipient_email, outcome: 'skipped', reason: why }); continue; }
      try {
        await sendDraftCore(ctx, d);
        results.push({ draftId: d.id, email: d.recipient_email, outcome: 'sent' });
      } catch (err) {
        if (err.outcomeUnknown) results.push({ draftId: d.id, email: d.recipient_email, outcome: 'needs_review', reason: err.message });
        else results.push({ draftId: d.id, email: d.recipient_email, outcome: 'failed', reason: err.message });
        if (err.code === 'MAIL_NOT_CONFIGURED') stopped = 'Stopped: mail is not configured for this workspace.';
      }
    }
  } finally {
    const left = await get("SELECT COUNT(*) AS n FROM email_drafts WHERE workspace_id = ? AND batch_id = ? AND status IN ('Draft', 'Approved')", [ws(ctx), b.id]);
    await run(`UPDATE mail_draft_batches SET status = ?, sent_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?`, [Number(left.n) ? 'partial' : 'done', b.id]);
  }
  const summary = results.reduce((s, r) => ({ ...s, [r.outcome]: (s[r.outcome] || 0) + 1 }), {});
  await audit(ctx, 'mail.batch_sent', { resourceType: 'mail_draft_batch', resourceId: b.id, metadata: summary });
  return { results, summary, ...(await getBatch(ctx, b.id)) };
}

/** Public unsubscribe (token from the email): suppresses the address and records withdrawn consent. */
async function unsubscribeByToken(token, { apply }) {
  if (!/^[a-f0-9]{40}$/.test(String(token || ''))) return null;
  const d = await get('SELECT workspace_id, recipient_email FROM email_drafts WHERE unsubscribe_token = ?', [token]);
  if (!d) return null;
  const email = String(d.recipient_email).trim().toLowerCase();
  if (apply) {
    await require('../../outreach/outreachService').suppress(d.workspace_id, email, 'unsubscribed', 'mail_link');
    await run("UPDATE leads SET marketing_consent = 'withdrawn', marketing_consent_source = 'Unsubscribe link', marketing_consent_at = UTC_TIMESTAMP(), marketing_consent_by = NULL WHERE workspace_id = ? AND LOWER(email) = ?", [d.workspace_id, email]);
    await audit({ workspaceId: d.workspace_id, actorType: 'recipient' }, 'mail.unsubscribed', { resourceType: 'email_suppression', metadata: { source: 'mail_link' } });
  }
  const s = await get('SELECT 1 AS x FROM email_suppressions WHERE workspace_id = ? AND email = ?', [d.workspace_id, email]);
  return { unsubscribed: !!s };
}

module.exports = { listRecipients, recordConsent, createBatch, getBatch, listBatches, approveBatch, sendBatch, recheckRecipient, unsubscribeByToken, personalize, withEligibility };
