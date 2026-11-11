const express = require('express');
const { z } = require('zod');
const { run, get, all } = require('../../db/database');
const { requireCapability } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');
const crypto = require('crypto');
const { htmlToText, sanitizeEmailHtml } = require('../../lib/emailHtml');
const { unresolvedPlaceholders, assertNoPlaceholders, fillPlaceholders, isPlaceholderKey } = require('../../lib/mailContent');
const aiEngine = require('../../services/aiEngine');
const emailService = require('../../services/emailService');
const { resolveSelectedProduct } = require('../../lib/productContext');
const mailPurpose = require('../../lib/mailPurpose');
const mailActivity = require('./activity/routes');

/**
 * Workspace-scoped Mail Drafts, Mail Center and mail settings. The workspace always
 * comes from the session; a draft, email or mailbox of another workspace answers 404.
 * Sending needs mail.send, a valid recipient, an approved draft (for drafts) and an
 * explicit `confirm: true` from the user.
 */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ws = req => req.auth.workspaceId;
const nowSql = () => new Date().toISOString().replace('T', ' ').substring(0, 19);

function body(schema) {
  return (req, res, next) => {
    const r = schema.safeParse(req.body || {});
    if (!r.success) {
      return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', error: r.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    }
    req.valid = r.data;
    next();
  };
}

function httpError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function requireId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw httpError('Invalid id.', 400, 'VALIDATION_ERROR');
  return id;
}

// The draft's contact (lead of the same workspace), read fresh so the page shows current details.
const DRAFT_SELECT = `SELECT d.*, l.id AS contact_id, l.name AS contact_name, l.email AS contact_email, l.company_name AS contact_company, l.product_id AS contact_product_id
  FROM email_drafts d LEFT JOIN leads l ON l.id = d.lead_id AND l.workspace_id = d.workspace_id`;

async function requireDraft(workspaceId, rawId) {
  const draft = await get(`${DRAFT_SELECT} WHERE d.id = ? AND d.workspace_id = ?`, [requireId(rawId), workspaceId]);
  if (!draft) throw httpError('Draft not found', 404, 'NOT_FOUND');
  return draft;
}

// Drafts in these states are no longer edited: sent, being sent, or with an unknown outcome.
const LOCKED_DRAFT = ['Sent', 'Sending', 'Needs Review'];
// A send left "Sending" this long (worker or server stopped mid-send) can be resolved by a person.
const STALE_SENDING_MS = 10 * 60 * 1000;

const draftParts = d => ({ subject: d.subject, text: d.body_text || d.body, html: d.body_html || d.html_body });

/** Adds the unresolved [placeholders] the draft still contains (they block approval and sending). */
function presentDraft(d) {
  if (!d) return d;
  const { contact_id, contact_name, contact_email, contact_company, contact_product_id, ...rest } = d;
  return {
    ...rest,
    placeholders: unresolvedPlaceholders(draftParts(d)),
    // null = no contact linked; missing = the linked lead was deleted.
    contact: d.lead_id ? (contact_id ? { id: contact_id, name: contact_name, email: contact_email || null, company: contact_company || null, productId: contact_product_id ?? null } : { id: d.lead_id, missing: true }) : null
  };
}

/**
 * Email type of each Mail Center path for the suppression policy (lib/mailSuppression.js).
 * - Mail Drafts are marketing (written for a marketing goal): marketing suppression, sent only
 *   through an SMTP mailbox approved for marketing (never ZeptoMail), with an unsubscribe link.
 * - Compose & Send: per message, from the declared purpose as validated by lib/mailPurpose.js
 *   (missing, contradictory or marketing-looking content = marketing). Marketing Compose messages
 *   are sent through the marketing draft pipeline (sendComposeAsMarketing).
 */
const SUPPRESSION_POLICY = { draft: 'marketing' };

/**
 * Why this one-to-one email may not go to its recipient now: { reason, message } or null. Checked
 * when approving and again when sending: a linked contact must still exist with the same email
 * address; then the suppression policy for the path applies (unsubscribe, consent withdrawn, hard
 * bounce, spam complaint). (Product email batches have their own, stricter check.)
 */
async function recipientProblem(workspaceId, draft, policy) {
  const email = String(draft.recipient_email || '').trim().toLowerCase();
  if (draft.lead_id) {
    const lead = await get('SELECT id, name, email, marketing_consent FROM leads WHERE workspace_id = ? AND id = ?', [workspaceId, draft.lead_id]);
    if (!lead) return { reason: 'contact_deleted', message: 'The contact for this draft was deleted. Choose the contact again.' };
    if (String(lead.email || '').trim().toLowerCase() !== email) return { reason: 'contact_changed', message: `${lead.name || 'The contact'}'s email address changed in Leads. Choose the contact again so the draft uses the current address.` };
    if (policy === 'marketing' && lead.marketing_consent === 'withdrawn') return { reason: 'consent_withdrawn', message: `${lead.name || 'This contact'} has withdrawn marketing consent.` };
  }
  return require('../../lib/mailSuppression').suppressionBlock(workspaceId, email, policy);
}

/** Records a refused send without the address (reason and path only). */
const auditBlocked = (ctx, path, resourceType, resourceId, why) =>
  audit(ctx, 'mail.send_blocked', { resourceType, resourceId, metadata: { path, reason: why.reason } });

async function requireEmail(workspaceId, rawId) {
  const email = await get('SELECT * FROM emails WHERE id = ? AND workspace_id = ?', [requireId(rawId), workspaceId]);
  if (!email) throw httpError('Email not found', 404, 'NOT_FOUND');
  return email;
}

const isEmail = v => emailService.isValidRecipient(v);
const recipientEmail = z.string().trim().max(255).refine(v => v === '' || isEmail(v), 'must be a valid, non-placeholder email address');
const requiredRecipient = z.string().trim().max(255).refine(isEmail, 'must be a valid, non-placeholder email address');
const confirmed = z.literal(true, { errorMap: () => ({ message: 'explicit confirmation (confirm: true) is required to send' }) });
const productId = z.union([z.number(), z.string(), z.null()]).optional();

function presentEmail(e) {
  let replies = [];
  try { replies = e.ai_replies_json ? JSON.parse(e.ai_replies_json) : []; } catch (err) { replies = []; }
  return { ...e, ai_replies: replies };
}

// ==========================================
// Mail Drafts: /api/v1/drafts, /api/drafts
// ==========================================
const drafts = express.Router();

drafts.get('/', requireCapability('mail.view'), wrap(async (req, res) => {
  res.json({ success: true, drafts: (await all(`${DRAFT_SELECT} WHERE d.workspace_id = ? ORDER BY d.id DESC`, [ws(req)])).map(presentDraft) });
}));

drafts.post('/generate', requireCapability('mail.compose'), body(z.object({
  productId,
  // Start from a saved template (its HTML is copied; the template itself is not changed).
  templateId: z.union([z.number().int().positive(), z.string().regex(/^\d{1,10}$/)]).optional().nullable(),
  // Recipient from a lead of this workspace: name and email come from the lead record, never the browser.
  leadId: z.union([z.number().int().positive(), z.string().regex(/^\d{1,10}$/)]).optional().nullable(),
  subject: z.string().trim().max(255).optional().nullable(),
  recipientName: z.string().max(255).optional().nullable(),
  recipientEmail: recipientEmail.optional().nullable(),
  goal: z.string().max(2000).optional().nullable(),
  tone: z.string().max(100).optional().nullable()
})), wrap(async (req, res) => {
  const v = req.valid;
  let leadId = null;
  if (v.leadId) {
    const lead = await require('../../lib/leadAccess').requireLeadAccess(req, v.leadId, 'view').catch(() => null);
    if (!lead) throw httpError('Lead not found.', 404, 'NOT_FOUND');
    if (!isEmail(lead.email)) throw httpError(`${lead.name || 'This lead'} has no valid email address. Add one to the lead first.`, 400, 'LEAD_NO_EMAIL');
    leadId = lead.id;
    v.recipientName = lead.name || '';
    v.recipientEmail = String(lead.email).trim();
  }
  // Only the explicitly selected product of this workspace; malformed or foreign ids are rejected.
  const product = await resolveSelectedProduct(ws(req), v.productId);
  const draftContent = await aiEngine.generateMailDraft(product, { name: v.recipientName, email: v.recipientEmail }, v.goal, v.tone || 'Professional');
  if (v.templateId) {
    const { template, html } = await require('./templates/templateService').htmlForUse(ws(req), v.templateId);
    draftContent.body_html = html;
    draftContent.body_text = htmlToText(html);
    draftContent.subject = v.subject || draftContent.subject || template.name;
    draftContent.missing_context = (draftContent.missing_context || []).filter(m => m !== 'product');
  } else if (v.subject) {
    draftContent.subject = v.subject;
  }
  const now = nowSql();
  const result = await run(
    `INSERT INTO email_drafts (workspace_id, product_id, product_name, lead_id, recipient_email, recipient_name, subject, body_html, body_text, tone, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?, ?)`,
    [ws(req), product ? product.id : null, product ? product.name : null, leadId, (v.recipientEmail || '').trim(), v.recipientName || '',
      draftContent.subject, draftContent.body_html, draftContent.body_text, draftContent.tone, now, now]
  );
  const missing = draftContent.missing_context || [];
  if (!isEmail(v.recipientEmail)) missing.push('recipient email');
  res.json({
    success: true,
    draft: presentDraft(await requireDraft(ws(req), result.lastID)),
    missing_context: missing,
    message: missing.includes('product')
      ? 'Draft created without product context: no product was selected, so it contains no product details or links. Review before sending.'
      : 'Email draft created. Awaiting your approval before sending.'
  });
}));

drafts.get('/:id', requireCapability('mail.view'), wrap(async (req, res) => {
  res.json({ success: true, draft: presentDraft(await requireDraft(ws(req), req.params.id)) });
}));

// Editing a draft sends it back to "Draft", so it must be approved again before sending.
// replacements: { "[Your name]": "Jane Doe" } fills placeholders in the subject and both bodies.
const placeholderKey = z.string().max(170).refine(isPlaceholderKey, 'must be a [placeholder] or {{token}} from the draft');
const placeholderValue = z.string().trim().min(1).max(500).refine(v => !unresolvedPlaceholders({ text: v }).length, 'must not contain another [placeholder]');

drafts.patch('/:id', requireCapability('mail.compose'), body(z.object({
  // Recipient from a lead of this workspace: name and email are read from the lead record.
  lead_id: z.union([z.number().int().positive(), z.string().regex(/^\d{1,10}$/)]).optional(),
  recipient_email: recipientEmail.optional(),
  recipient_name: z.string().max(255).optional(),
  subject: z.string().trim().min(1).max(255).optional(),
  // Edited body (HTML). Sanitized like every other email HTML; the plain-text part is regenerated from it.
  body_html: z.string().trim().min(1).max(200000).optional(),
  replacements: z.record(placeholderKey, placeholderValue).refine(r => Object.keys(r).length <= 20, 'at most 20 placeholders at once').optional()
})), wrap(async (req, res) => {
  const draft = await requireDraft(ws(req), req.params.id);
  if (LOCKED_DRAFT.includes(draft.status)) throw httpError(draft.status === 'Needs Review' ? 'Resolve this draft\'s unknown delivery first.' : 'A sent draft cannot be edited.', 409, 'DRAFT_SENT');
  const v = req.valid;
  // Product email drafts are addressed to their lead; the recipient comes from the lead record only.
  if (draft.batch_id && (v.recipient_email !== undefined || v.recipient_name !== undefined || v.lead_id !== undefined)) {
    throw httpError('The recipient of a product email comes from its lead. Update the lead, then prepare a new email.', 409, 'RECIPIENT_FROM_LEAD');
  }
  if (v.lead_id !== undefined && (v.recipient_email !== undefined || v.recipient_name !== undefined)) {
    throw httpError('Choose a contact or type an address, not both.', 400, 'VALIDATION_ERROR');
  }
  let leadId = draft.lead_id || null;
  if (v.lead_id !== undefined) {
    const lead = await require('../../lib/leadAccess').requireLeadAccess(req, v.lead_id, 'view').catch(() => null);
    if (!lead) throw httpError('Contact not found.', 404, 'NOT_FOUND');
    if (!isEmail(lead.email)) throw httpError(`${lead.name || 'This contact'} has no valid email address. Add one in Leads first.`, 400, 'LEAD_NO_EMAIL');
    leadId = lead.id;
    v.recipient_name = lead.name || '';
    v.recipient_email = String(lead.email).trim();
  } else if (v.recipient_email !== undefined) {
    // A typed address is not a contact: the draft is no longer linked to one.
    leadId = null;
  }
  let html = draft.body_html || draft.html_body || '';
  let text = draft.body_text || draft.body || '';
  if (v.body_html !== undefined) {
    html = sanitizeEmailHtml(v.body_html);
    if (!htmlToText(html).trim()) throw httpError('The email body cannot be empty.', 400, 'VALIDATION_ERROR');
    text = htmlToText(html);
  }
  const filled = fillPlaceholders({ subject: v.subject !== undefined ? v.subject : draft.subject, text, html }, v.replacements || {});
  await run(
    `UPDATE email_drafts SET lead_id = ?, recipient_email = ?, recipient_name = ?, subject = ?, body_text = ?, body_html = ?, status = 'Draft', updated_at = ? WHERE id = ? AND workspace_id = ?`,
    [leadId, v.recipient_email !== undefined ? v.recipient_email : draft.recipient_email, v.recipient_name !== undefined ? v.recipient_name : draft.recipient_name,
      filled.subject.slice(0, 255), filled.text, filled.html, nowSql(), draft.id, ws(req)]
  );
  res.json({ success: true, draft: presentDraft(await requireDraft(ws(req), draft.id)), message: 'Draft updated. Approve it again before sending.' });
}));

drafts.post('/:id/rewrite', requireCapability('mail.compose'), body(z.object({ instruction: z.string().max(200).optional() })), wrap(async (req, res) => {
  const draft = await requireDraft(ws(req), req.params.id);
  if (LOCKED_DRAFT.includes(draft.status)) throw httpError('A sent draft cannot be rewritten.', 409, 'DRAFT_SENT');
  const instruction = req.valid.instruction || 'More Professional';
  const rewritten = await aiEngine.rewriteMailDraft(draft, instruction, ws(req));
  await run(
    `UPDATE email_drafts SET subject = ?, body_html = ?, body_text = ?, tone = ?, status = 'Draft', updated_at = ? WHERE id = ? AND workspace_id = ?`,
    [rewritten.subject, rewritten.body_html, rewritten.body_text, rewritten.tone, nowSql(), draft.id, ws(req)]
  );
  res.json({ success: true, draft: presentDraft(await requireDraft(ws(req), draft.id)), message: `Draft rewritten to be "${instruction}". Approve it again before sending.` });
}));

drafts.put('/:id/approve', requireCapability('mail.send'), wrap(async (req, res) => {
  const draft = await requireDraft(ws(req), req.params.id);
  if (draft.status === 'Needs Review') throw httpError('The last send of this draft has an unknown outcome. Resolve it first.', 409, 'NEEDS_REVIEW');
  if (['Sent', 'Sending'].includes(draft.status)) throw httpError('This draft has already been sent.', 409, 'DRAFT_SENT');
  if (!isEmail(draft.recipient_email)) throw httpError('Choose a contact with a valid email address before approving.', 400, 'INVALID_RECIPIENT');
  assertNoPlaceholders(draftParts(draft));
  if (!draft.batch_id) {
    const why = await recipientProblem(ws(req), draft, SUPPRESSION_POLICY.draft);
    if (why) throw httpError(why.message, 409, 'RECIPIENT_INELIGIBLE');
  }
  await run(`UPDATE email_drafts SET status = 'Approved', updated_at = ? WHERE id = ? AND workspace_id = ?`, [nowSql(), draft.id, ws(req)]);
  await audit(req, 'mail.draft_approved', { resourceType: 'email_draft', resourceId: draft.id });
  res.json({ success: true, draft: presentDraft(await requireDraft(ws(req), draft.id)), message: 'Draft approved. Ready for dispatch.' });
}));

/**
 * Sends one approved draft (also used for each recipient of a product email batch). The draft is
 * claimed first (Approved -> Sending), so a double click, a second tab or an overlapping batch
 * can never send it twice; an unknown delivery outcome leaves it in Needs Review.
 */
async function sendDraftCore(ctx, draft) {
  const workspaceId = ctx.auth.workspaceId;
  if (draft.status !== 'Approved') {
    if (draft.status === 'Needs Review') throw httpError('The last send of this draft has an unknown outcome. Check the recipient\'s mailbox, then resolve it.', 409, 'NEEDS_REVIEW');
    throw httpError(draft.status === 'Sent' ? 'This draft has already been sent.' : 'Approve the draft before sending it.', 409, draft.status === 'Sent' ? 'DRAFT_SENT' : 'NOT_APPROVED');
  }
  if (!isEmail(draft.recipient_email)) throw httpError('This draft has no valid recipient email address. Add one before sending.', 400, 'INVALID_RECIPIENT');
  assertNoPlaceholders(draftParts(draft));
  // Product email batch drafts are marketing email: the lead must still be eligible (consent, not unsubscribed).
  if (draft.batch_id) {
    const why = await require('./productEmails/service').recheckRecipient(workspaceId, draft);
    if (why) throw httpError(`Not sent: ${why}.`, 409, 'RECIPIENT_INELIGIBLE');
  } else {
    const why = await recipientProblem(workspaceId, draft, SUPPRESSION_POLICY.draft);
    if (why) {
      await auditBlocked(ctx, 'draft', 'email_draft', draft.id, why);
      throw httpError(`Not sent: ${why.message}`, 409, 'RECIPIENT_INELIGIBLE');
    }
  }

  // Claim the draft so a double click or a second tab cannot send it twice.
  const claim = await run(`UPDATE email_drafts SET status = 'Sending', updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'Approved'`, [nowSql(), draft.id, workspaceId]);
  if (!claim.changes) throw httpError('This draft is already being sent.', 409, 'DRAFT_SENT');

  // Drafts are marketing email: opens/clicks only for a linked lead whose consent is verified
  // ("granted" with a recorded method and evidence, as Product Emails define it); delivery outcomes
  // are always recorded. Workspace policy decides the rest (off by default).
  const lead = draft.lead_id ? await get('SELECT marketing_consent, marketing_consent_method, marketing_consent_evidence FROM leads WHERE id = ? AND workspace_id = ?', [draft.lead_id, workspaceId]) : null;
  const consentOk = lead?.marketing_consent === 'granted' && !!lead.marketing_consent_method && !!lead.marketing_consent_evidence;

  // One-to-one marketing drafts get the same one-click unsubscribe as Product Emails (header and a
  // visible footer); batch drafts already carry theirs in the body.
  let html = draft.body_html || draft.html_body;
  let text = draft.body_text || draft.body;
  let unsubscribeToken = draft.unsubscribe_token;
  if (!draft.batch_id) {
    if (!unsubscribeToken) {
      await run('UPDATE email_drafts SET unsubscribe_token = ? WHERE id = ? AND workspace_id = ? AND unsubscribe_token IS NULL', [crypto.randomBytes(20).toString('hex'), draft.id, workspaceId]);
      unsubscribeToken = (await get('SELECT unsubscribe_token FROM email_drafts WHERE id = ? AND workspace_id = ?', [draft.id, workspaceId])).unsubscribe_token;
    }
    const cfg = await emailService.getRawMailConfig(workspaceId);
    const f = require('./productEmails/service').footer(cfg.sender_email || cfg.smtp_user || 'us', unsubscribeToken);
    if (!String(html || '').includes(unsubscribeToken)) html = `${html || ''}${f.html}`;
    if (!String(text || '').includes(unsubscribeToken)) text = `${text || ''}\n\n${f.text}`;
  }

  let sendResult;
  try {
    sendResult = await emailService.sendRealEmail(workspaceId, {
      to: draft.recipient_email,
      recipientName: draft.recipient_name || '',
      subject: draft.subject,
      html,
      text,
      // Marketing email: List-Unsubscribe with the one-click link and a mailto: fallback, and only
      // through an SMTP mailbox approved for marketing (never ZeptoMail, no fallback).
      listUnsubscribe: { url: require('./productEmails/service').unsubscribeLink(unsubscribeToken), mailtoSelf: true },
      purpose: 'marketing',
      suppressionPolicy: 'marketing',
      track: { draftId: draft.id, consentOk }
    });
  } catch (err) {
    if (err.outcomeUnknown) {
      // Possibly delivered: held for a person to check; never resent automatically.
      await run(`UPDATE email_drafts SET status = 'Needs Review', updated_at = ? WHERE id = ? AND workspace_id = ?`, [nowSql(), draft.id, workspaceId]);
      await audit(ctx, 'mail.draft_outcome_unknown', { resourceType: 'email_draft', resourceId: draft.id, metadata: { code: err.code } });
      throw err;
    }
    // Nothing was sent: the draft goes back to Approved and the error is reported as is.
    await run(`UPDATE email_drafts SET status = 'Approved', updated_at = ? WHERE id = ? AND workspace_id = ?`, [nowSql(), draft.id, workspaceId]);
    throw err;
  }
  await run(`UPDATE email_drafts SET status = 'Sent', sent_at = UTC_TIMESTAMP(), email_id = ?, send_error = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`, [sendResult.emailId || null, nowSql(), draft.id, workspaceId]);
  // Who sent it: the person sending the draft, or (product emails) the person who queued the batch.
  if (sendResult.emailId && ctx.auth?.userId) await run('UPDATE emails SET sent_by_user_id = ? WHERE id = ? AND workspace_id = ?', [ctx.auth.userId, sendResult.emailId, workspaceId]).catch(() => null);
  await audit(ctx, 'mail.draft_sent', { resourceType: 'email_draft', resourceId: draft.id, metadata: { emailId: sendResult.emailId, batchId: draft.batch_id || null } });
  return sendResult;
}

drafts.post('/:id/send', requireCapability('mail.send'), body(z.object({ confirm: confirmed })), wrap(async (req, res) => {
  const draft = await requireDraft(ws(req), req.params.id);
  const sendResult = await sendDraftCore(req, draft);
  res.json({ success: true, sendResult, message: `Email sent to ${draft.recipient_email} (${sendResult.smtpStatus}).` });
}));

/**
 * Resolves a send with an unknown outcome (or one stuck "Sending" after a crash) once a person has
 * checked the recipient's mailbox: "sent" marks it Sent; "not_sent" returns it to Approved so it
 * can be sent again deliberately.
 */
drafts.post('/:id/resolve', requireCapability('mail.send'), body(z.object({ outcome: z.enum(['sent', 'not_sent']), confirm: confirmed })), wrap(async (req, res) => {
  const draft = await requireDraft(ws(req), req.params.id);
  // DATETIME values are read as UTC Date objects (pool timezone 'Z').
  const stuck = draft.status === 'Sending' && Date.now() - new Date(draft.updated_at).getTime() > STALE_SENDING_MS;
  if (draft.status !== 'Needs Review' && !stuck) {
    throw httpError(draft.status === 'Sending' ? 'This draft is being sent right now.' : 'Only a draft whose delivery is unknown can be resolved.', 409, 'NOT_NEEDS_REVIEW');
  }
  const next = req.valid.outcome === 'sent' ? 'Sent' : 'Approved';
  const r = await run(`UPDATE email_drafts SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = ?`, [next, nowSql(), draft.id, ws(req), draft.status]);
  if (!r.changes) throw httpError('This draft changed meanwhile. Reload and try again.', 409, 'CONFLICT');
  await audit(req, 'mail.draft_resolved', { resourceType: 'email_draft', resourceId: draft.id, metadata: { outcome: req.valid.outcome, from: draft.status } });
  res.json({ success: true, draft: presentDraft(await requireDraft(ws(req), draft.id)), message: next === 'Sent' ? 'Marked as sent.' : 'Marked as not sent. You can send it again.' });
}));

drafts.delete('/:id', requireCapability('mail.compose'), wrap(async (req, res) => {
  const draft = await requireDraft(ws(req), req.params.id);
  if (draft.status === 'Sending') throw httpError('This draft is being sent.', 409, 'DRAFT_SENDING');
  await run('DELETE FROM email_drafts WHERE id = ? AND workspace_id = ?', [draft.id, ws(req)]);
  await audit(req, 'mail.draft_deleted', { resourceType: 'email_draft', resourceId: draft.id });
  res.json({ success: true, message: 'Email draft deleted.' });
}));

// ==========================================
// Mail Center: /api/v1/emails, /api/emails
// ==========================================
const emails = express.Router();

emails.get('/', requireCapability('mail.view'), wrap(async (req, res) => {
  // Each sent email carries its delivery status (delivered / opened / clicked / bounced …) for the mailbox.
  const { deliveryOf, TRACKING_COLUMNS, TRACKING_JOIN } = mailActivity;
  const rows = await all(`SELECT e.*, ${TRACKING_COLUMNS}, t.last_open_at AS t_last_open_at, t.open_events AS t_open_events FROM emails e ${TRACKING_JOIN} WHERE e.workspace_id = ? ORDER BY e.is_urgent DESC, e.id DESC LIMIT 50`, [ws(req)]);
  res.json({
    success: true,
    emails: rows.map(r => {
      const { t_delivery_status, t_delivered_at, t_bounced_at, t_first_open_at, t_first_click_at, t_failure_reason, t_track_opens, t_last_open_at, t_open_events, ...e } = r;
      return {
        ...presentEmail(e),
        delivery: deliveryOf(r),
        delivery_detail: r.status === 'Sent'
          ? { tracked: !!t_delivery_status, opensTracked: !!t_track_opens, deliveredAt: t_delivered_at || null, firstOpenAt: t_first_open_at || null, lastOpenAt: t_last_open_at || null, opens: Number(t_open_events) || 0, firstClickAt: t_first_click_at || null, bouncedAt: t_bounced_at || null, failureReason: t_failure_reason || null }
          : null
      };
    })
  });
}));

// ---------- Inbox and Sent Mail (Mail Center tabs) ----------
// Received = anything not sent by this workspace ('Sent' / 'Not Sent' rows are outgoing).
const RECEIVED_SQL = "e.status NOT IN ('Sent', 'Not Sent')";
// Read when flagged read or given the 'Read' status (older rows set only one of the two).
const UNREAD_SQL = "(COALESCE(e.is_read, 0) = 0 AND e.status <> 'Read')";
const MAILBOX_PAGE = 25;
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const likeOf = q => `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
const dayRange = (col, q, where, params) => {
  if (q.from) { where.push(`${col} >= ?`); params.push(`${q.from} 00:00:00`); }
  if (q.to) { where.push(`${col} < DATE_ADD(?, INTERVAL 1 DAY)`); params.push(`${q.to} 00:00:00`); }
};
function query(schema, req) {
  const r = schema.safeParse(req.query || {});
  if (!r.success) throw httpError(r.error.issues.map(i => `${i.path.join('.') || 'query'}: ${i.message}`).join('; '), 400, 'VALIDATION_ERROR');
  return r.data;
}
const preview = e => String(e.snippet || e.body || '').replace(/\s+/g, ' ').trim().slice(0, 180);
const listPage = (rows, page) => ({ page, hasMore: rows.length > MAILBOX_PAGE, rows: rows.slice(0, MAILBOX_PAGE) });

const inboxQuery = z.object({
  q: z.string().trim().max(120).optional(),
  read: z.enum(['read', 'unread']).optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
  page: z.coerce.number().int().min(1).max(1000).optional()
}).strict();

/** Inbox: messages received by the workspace mailbox (synced over IMAP), newest first. */
emails.get('/inbox', requireCapability('mail.view'), wrap(async (req, res) => {
  const q = query(inboxQuery, req);
  const page = q.page || 1;
  const where = ['e.workspace_id = ?', RECEIVED_SQL];
  const params = [ws(req)];
  if (q.read === 'unread') where.push(UNREAD_SQL);
  else if (q.read === 'read') where.push(`NOT ${UNREAD_SQL}`);
  if (q.q) {
    const like = likeOf(q.q);
    where.push('(e.subject LIKE ? OR e.sender LIKE ? OR e.sender_email LIKE ? OR e.recipient_email LIKE ? OR e.body LIKE ?)');
    params.push(like, like, like, like, like);
  }
  dayRange('e.received_at', q, where, params);
  const rows = await all(
    `SELECT e.id, e.sender, e.sender_email, e.recipient_email, e.recipient_name, e.subject, e.snippet, LEFT(e.body, 400) AS body,
            e.received_at, e.is_read, e.status, e.is_urgent, e.ai_priority, e.ai_summary, (e.html_body IS NOT NULL AND e.html_body <> '') AS has_html
     FROM emails e WHERE ${where.join(' AND ')}
     ORDER BY e.received_at DESC, e.id DESC LIMIT ${MAILBOX_PAGE + 1} OFFSET ${(page - 1) * MAILBOX_PAGE}`, params);
  const unread = await get(`SELECT COUNT(*) AS n FROM emails e WHERE e.workspace_id = ? AND ${RECEIVED_SQL} AND ${UNREAD_SQL}`, [ws(req)]);
  const p = listPage(rows, page);
  res.json({
    success: true, page, hasMore: p.hasMore, unread: Number(unread?.n) || 0,
    emails: p.rows.map(e => ({
      id: e.id, from: e.sender_email || null, fromName: e.sender || null, to: e.recipient_email || null,
      subject: e.subject, preview: preview(e), receivedAt: e.received_at, read: Number(e.is_read) === 1 || e.status === 'Read',
      urgent: Number(e.is_urgent) === 1 || e.ai_priority === 'Urgent', priority: e.ai_priority || null, hasHtml: !!Number(e.has_html)
    }))
  });
}));

const SENT_STATUSES = ['sent', 'accepted', 'delivered', 'opened', 'clicked', 'bounced', 'not_sent'];
const sentQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(SENT_STATUSES).optional(),
  /** Only emails that went out (no failed attempts): the Logs "Sent emails" view. */
  sentOnly: z.enum(['1']).optional(),
  purpose: z.enum(['transactional', 'marketing', 'not_recorded']).optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
  page: z.coerce.number().int().min(1).max(1000).optional()
}).strict();

/** Sent Mail: emails this workspace sent (or tried to send), with delivery status and purpose as recorded. */
emails.get('/sent', requireCapability('mail.view'), wrap(async (req, res) => {
  const q = query(sentQuery, req);
  const page = q.page || 1;
  const A = mailActivity;
  const where = ['e.workspace_id = ?', q.sentOnly ? "e.status = 'Sent'" : "e.status IN ('Sent', 'Not Sent')"];
  const params = [ws(req), ws(req), ws(req), ws(req)]; // three for LINKS_JOIN, one for the WHERE
  if (q.q) {
    const like = likeOf(q.q);
    where.push('(e.subject LIKE ? OR e.recipient_email LIKE ? OR e.recipient_name LIKE ? OR e.body LIKE ?)');
    params.push(like, like, like, like);
  }
  dayRange('COALESCE(e.sent_at, e.received_at)', q, where, params);
  if (q.status) { where.push(`(${A.DELIVERY_SQL}) = ?`); params.push(q.status); }
  if (q.purpose === 'not_recorded') where.push(`(${A.PURPOSE_SQL}) IS NULL`);
  else if (q.purpose) { where.push(`(${A.PURPOSE_SQL}) = ?`); params.push(q.purpose); }
  const rows = await all(
    `SELECT e.id, e.recipient_email, e.recipient_name, e.sender_email, e.subject, e.snippet, LEFT(e.body, 400) AS body,
            COALESCE(e.sent_at, e.received_at) AS sent_at, e.status, e.smtp_status,
            ${A.DELIVERY_SQL} AS delivery, ${A.PURPOSE_SQL} AS purpose, ${A.SOURCE_SQL} AS source,
            t.provider AS provider, t.failure_reason AS failure_reason
     FROM emails e ${A.TRACKING_JOIN} ${A.LINKS_JOIN}
     WHERE ${where.join(' AND ')}
     ORDER BY sent_at DESC, e.id DESC LIMIT ${MAILBOX_PAGE + 1} OFFSET ${(page - 1) * MAILBOX_PAGE}`, params);
  const p = listPage(rows, page);
  res.json({
    success: true, page, hasMore: p.hasMore,
    emails: p.rows.map(e => ({
      id: e.id, to: e.recipient_email || null, toName: e.recipient_name || null, from: e.sender_email || null,
      subject: e.subject, preview: preview(e), sentAt: e.sent_at,
      delivery: e.delivery, purpose: e.purpose || null, source: e.source || null, provider: e.provider || null,
      failure: e.delivery === 'not_sent' ? (e.smtp_status || null) : (e.failure_reason || null)
    }))
  });
}));

/** One message of this workspace (received or sent) with its content; 404 for another workspace's. */
emails.get('/:id(\\d+)', requireCapability('mail.view'), wrap(async (req, res) => {
  const e = await get(
    `SELECT e.*, ${mailActivity.DELIVERY_SQL} AS delivery, ${mailActivity.PURPOSE_SQL} AS purpose, ${mailActivity.SOURCE_SQL} AS source,
            t.provider AS t_provider, t.failure_reason AS t_failure_reason
     FROM emails e ${mailActivity.TRACKING_JOIN} ${mailActivity.LINKS_JOIN} WHERE e.id = ? AND e.workspace_id = ?`, [ws(req), ws(req), ws(req), req.params.id, ws(req)]);
  if (!e) throw httpError('Email not found.', 404, 'NOT_FOUND');
  const direction = e.status === 'Sent' ? 'sent' : e.status === 'Not Sent' ? 'not_sent' : 'received';
  const { t_provider, t_failure_reason, ai_replies_json, ...rest } = e;
  res.json({
    success: true,
    email: {
      ...presentEmail({ ...rest, ai_replies_json }),
      direction,
      read: Number(e.is_read) === 1 || e.status === 'Read',
      delivery: e.delivery || null,
      purpose: direction === 'received' ? null : (e.purpose || null),
      source: e.source || null,
      provider: t_provider || null,
      failure: direction === 'not_sent' ? (e.smtp_status || null) : (t_failure_reason || null)
    }
  });
}));

/** Mark a received message read or unread (the workspace's shared mailbox state). Sent mail has no read state. */
emails.put('/:id(\\d+)/read', requireCapability('mail.view'), body(z.object({ read: z.boolean() }).strict()), wrap(async (req, res) => {
  const e = await get(`SELECT e.id, e.status FROM emails e WHERE e.id = ? AND e.workspace_id = ?`, [req.params.id, ws(req)]);
  if (!e) throw httpError('Email not found.', 404, 'NOT_FOUND');
  if (['Sent', 'Not Sent'].includes(e.status)) throw httpError('Only received emails can be marked read or unread.', 409, 'NOT_RECEIVED');
  const read = req.valid.read;
  await run('UPDATE emails SET is_read = ?, status = ? WHERE id = ? AND workspace_id = ?', [read ? 1 : 0, read ? 'Read' : 'Unread', e.id, ws(req)]);
  res.json({ success: true, id: e.id, read });
}));

const sendSchema = z.object({
  recipient_email: requiredRecipient,
  recipient_name: z.string().max(255).optional().nullable(),
  subject: z.string().trim().min(1).max(255),
  body: z.string().max(100000).optional().nullable(),
  body_text: z.string().max(100000).optional().nullable(),
  html_body: z.string().max(500000).optional().nullable(),
  // Declared purpose (validated by the server; missing = marketing) and the template used, if any.
  purpose: z.enum(['transactional', 'marketing']).optional().nullable(),
  templateId: z.coerce.number().int().positive().optional().nullable(),
  confirm: confirmed
}).passthrough();

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,100}$/;

/**
 * Direct sends need an Idempotency-Key header (one per compose action, reused on retry). The first
 * request with a key claims it; a repeat returns the earlier result (sent), or is refused while the
 * first is in progress or its outcome is unknown. Reusing a key for different content is refused.
 */
/**
 * Claims the Idempotency-Key for one Compose send. The purpose record (declared, applied, reason
 * codes) is written in the same INSERT and never updated afterwards: a repeat, a duplicate or a
 * retry of a failed attempt reuses the row as it is. A retry whose purpose would now be applied
 * differently is refused (send it as a new email), so the record always describes what was sent.
 */
async function claimSendKey(req, { requireHtml, cls }) {
  const key = String(req.get('Idempotency-Key') || '').trim();
  if (!IDEMPOTENCY_KEY_RE.test(key)) throw httpError('An Idempotency-Key header (16-100 letters, digits, - or _) is required to send.', 400, 'IDEMPOTENCY_KEY_REQUIRED');
  const v = req.valid;
  const hash = crypto.createHash('sha256').update(JSON.stringify([requireHtml, v.recipient_email, v.recipient_name || '', v.subject, v.body_text || v.body || '', v.html_body || '', v.purpose || null, v.templateId || null])).digest('hex');
  try {
    const ins = await run(
      `INSERT INTO mail_send_requests (workspace_id, idempotency_key, request_hash, status, requested_by, declared_purpose, applied_purpose, purpose_reasons, created_at, updated_at)
       VALUES (?, ?, ?, 'sending', ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [ws(req), key, hash, req.auth.userId || null, cls.declared, cls.purpose, cls.reasons.join(',').slice(0, 255) || null]
    );
    return { id: ins.lastID };
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
  }
  const prior = await get('SELECT * FROM mail_send_requests WHERE workspace_id = ? AND idempotency_key = ?', [ws(req), key]);
  if (prior.request_hash !== hash) throw httpError('This Idempotency-Key was already used for a different email.', 422, 'IDEMPOTENCY_KEY_REUSED');
  if (prior.status === 'sent') return { duplicateOf: prior };
  if (prior.status === 'sending') throw httpError('This email is already being sent.', 409, 'SEND_IN_PROGRESS');
  if (prior.status === 'needs_review') throw httpError('An earlier attempt to send this email has an unknown outcome. Check the recipient\'s mailbox before sending it again as a new email.', 409, 'MAIL_OUTCOME_UNKNOWN');
  if (prior.applied_purpose && prior.applied_purpose !== cls.purpose) {
    throw httpError(`This email was first recorded as ${prior.applied_purpose} and would now be sent as ${cls.purpose}. Send it as a new email.`, 409, 'PURPOSE_CHANGED');
  }
  // failed (nothing was sent): the same request may try again.
  const again = await run("UPDATE mail_send_requests SET status = 'sending', error = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'failed'", [prior.id]);
  if (!again.changes) throw httpError('This email is already being sent.', 409, 'SEND_IN_PROGRESS');
  return { id: prior.id };
}

const PURPOSE_REASON_TEXT = {
  purpose_missing: 'no purpose was given',
  declared_marketing: 'it was marked as marketing',
  template_unknown: 'the template is not one of this workspace\'s templates',
  template_marketing_category: 'it uses a marketing template',
  matches_marketing_template: 'it contains a marketing template',
  merge_tags: 'it contains campaign merge tags',
  unsubscribe_wording: 'it contains unsubscribe wording',
  promotional_phrases: 'it contains promotional wording'
};
const purposeExplanation = cls => cls.reasons.map(r => PURPOSE_REASON_TEXT[r] || r).join('; ');

/**
 * A marketing Compose message goes through the marketing draft pipeline: a one-to-one draft is
 * recorded (approved by the sender, who has mail.send and confirmed the send) and sent like any
 * draft, so it gets the unsubscribe link and reply handling, marketing suppression, marketing
 * delivery (approved SMTP only, never ZeptoMail), Needs Review on an unknown outcome and tracking.
 * If nothing was sent, the recorded draft is removed again.
 */
async function sendComposeAsMarketing(req, v, html, text) {
  const workspaceId = ws(req);
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const bodyHtml = html || `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;
  const now = nowSql();
  const ins = await run(
    `INSERT INTO email_drafts (workspace_id, recipient_email, recipient_name, subject, body_html, body_text, tone, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Direct (Compose)', 'Approved', ?, ?)`,
    [workspaceId, v.recipient_email, v.recipient_name || '', v.subject, bodyHtml, text || htmlToText(bodyHtml), now, now]
  );
  await audit(req, 'mail.draft_approved', { resourceType: 'email_draft', resourceId: ins.lastID, metadata: { source: 'compose' } });
  const draft = await requireDraft(workspaceId, ins.lastID);
  try {
    const r = await sendDraftCore(req, draft);
    return { ...r, draftId: draft.id };
  } catch (err) {
    if (!err.outcomeUnknown) await run("DELETE FROM email_drafts WHERE id = ? AND workspace_id = ? AND status = 'Approved'", [draft.id, workspaceId]);
    throw err;
  }
}

async function sendDirect(req, res, { requireHtml }) {
  const v = req.valid;
  if (requireHtml && !v.html_body) throw httpError('html_body is required.', 400, 'VALIDATION_ERROR');
  const text = v.body_text || v.body || '';
  const html = v.html_body || null;
  assertNoPlaceholders({ subject: v.subject, text, html: html || '' });

  // Purpose: declared by the sender, validated here against the message and the template. Missing,
  // contradictory or marketing-looking content gets the stricter marketing rule.
  const cls = await mailPurpose.classify(ws(req), { declared: v.purpose, subject: v.subject, html, text, templateId: v.templateId });
  const purposeMeta = { declared: cls.declared, applied: cls.purpose, reasons: cls.reasons };

  // Authorization, separate from classification: sending as transactional (which may reach contacts
  // who opted out of marketing) needs mail.send_transactional. Content the server treats as
  // marketing follows the marketing safeguards instead and needs no extra permission.
  if (cls.purpose === 'transactional' && !req.auth.capabilities.has('mail.send_transactional')) {
    await audit(req, 'mail.send_blocked', { resourceType: 'email', resourceId: null, metadata: { path: 'compose', reason: 'transactional_not_permitted', purpose: purposeMeta } });
    throw httpError('Your role cannot send transactional email. Send it as marketing, or ask a workspace Owner or Admin.', 403, 'TRANSACTIONAL_NOT_PERMITTED');
  }

  // Suppression for that purpose; then, for marketing, an SMTP mailbox approved for marketing.
  // Checked before claiming, so nothing is held, recorded or sent.
  const why = await recipientProblem(ws(req), { recipient_email: v.recipient_email }, cls.purpose);
  if (why) {
    await audit(req, 'mail.send_blocked', { resourceType: 'email', resourceId: null, metadata: { path: 'compose', reason: why.reason, purpose: purposeMeta } });
    throw httpError(`Not sent: ${why.message}${cls.purpose === 'marketing' && cls.reasons.length ? ` (treated as marketing: ${purposeExplanation(cls)})` : ''}`, 409, 'RECIPIENT_SUPPRESSED');
  }
  if (cls.purpose === 'marketing') {
    const m = await emailService.marketingDeliveryStatus(ws(req));
    if (!m.allowed) {
      await audit(req, 'mail.send_blocked', { resourceType: 'email', resourceId: null, metadata: { path: 'compose', reason: m.code, purpose: purposeMeta } });
      throw httpError(`Not sent: this email is treated as marketing (${purposeExplanation(cls)}). ${m.reason}`, 409, m.code);
    }
  }

  const claim = await claimSendKey(req, { requireHtml, cls });
  if (claim.duplicateOf) {
    return res.json({ success: true, duplicate: true, emailId: claim.duplicateOf.email_id, message: 'This email was already sent; it was not sent again.' });
  }
  let sendRes;
  try {
    sendRes = cls.purpose === 'marketing'
      ? await sendComposeAsMarketing(req, v, html, text)
      : await emailService.sendRealEmail(ws(req), {
        to: v.recipient_email,
        recipientName: v.recipient_name || '',
        subject: v.subject,
        html,
        text,
        purpose: 'transactional',
        suppressionPolicy: 'transactional',
        track: {}
      });
  } catch (err) {
    await run('UPDATE mail_send_requests SET status = ?, error = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [err.outcomeUnknown ? 'needs_review' : 'failed', String(err.message || '').slice(0, 500), claim.id]);
    throw err;
  }
  await run("UPDATE mail_send_requests SET status = 'sent', email_id = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?", [sendRes.emailId, claim.id]);
  // Who sent it (staff performance and lead contact history); Compose, including the lead panel's "Send email".
  if (sendRes.emailId) await run('UPDATE emails SET sent_by_user_id = ? WHERE id = ? AND workspace_id = ?', [req.auth.userId || null, sendRes.emailId, ws(req)]).catch(() => null);
  await audit(req, 'mail.sent', { resourceType: 'email', resourceId: sendRes.emailId, metadata: { purpose: purposeMeta } });
  if (cls.reclassified) await audit(req, 'mail.purpose_reclassified', { resourceType: 'email', resourceId: sendRes.emailId, metadata: purposeMeta });
  res.json({
    success: true,
    emailId: sendRes.emailId,
    messageId: sendRes.messageId,
    smtpStatus: sendRes.smtpStatus,
    purpose: cls.purpose,
    purposeReasons: cls.reasons,
    reclassified: cls.reclassified,
    message: `Email sent to ${v.recipient_email} regarding '${v.subject}' (${sendRes.smtpStatus})${cls.reclassified ? `. It was sent as marketing because ${purposeExplanation(cls)}` : ''}.`
  });
}

emails.post('/send', requireCapability('mail.send'), body(sendSchema), wrap((req, res) => sendDirect(req, res, { requireHtml: false })));
emails.post('/send-html', requireCapability('mail.send'), body(sendSchema), wrap((req, res) => sendDirect(req, res, { requireHtml: true })));

emails.post('/:id/ai-analyze', requireCapability('mail.compose'), wrap(async (req, res) => {
  const email = await requireEmail(ws(req), req.params.id);
  // No product is assumed for inbox replies; replies stay generic unless the email itself says more.
  const analysis = await aiEngine.analyzeEmail(email, null, { workspaceId: ws(req), referenceType: 'email', referenceId: email.id });
  await run('UPDATE emails SET ai_summary = ?, ai_priority = ?, ai_replies_json = ? WHERE id = ? AND workspace_id = ?',
    [analysis.ai_summary, analysis.ai_priority, JSON.stringify(analysis.ai_replies), email.id, ws(req)]);
  res.json({ success: true, emailId: email.id, summary: analysis.ai_summary, priority: analysis.ai_priority, smartReplies: analysis.ai_replies });
}));

// ==========================================
// Voice-agent / Mark tools
// ==========================================
const tools = express.Router();

// A tool "send" never sends: it saves a draft that a person approves and sends from Mail Drafts.
tools.post(['/api/tools/send_email', '/api/send_email'], requireCapability('mail.compose'), body(z.object({
  recipient_email: requiredRecipient,
  recipient_name: z.string().max(255).optional().nullable(),
  subject: z.string().trim().min(1).max(255),
  body: z.string().trim().min(1).max(20000)
}).passthrough()), wrap(async (req, res) => {
  const v = req.valid;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = nowSql();
  const result = await run(
    `INSERT INTO email_drafts (workspace_id, product_id, product_name, recipient_email, recipient_name, subject, body_html, body_text, tone, status, created_at, updated_at)
     VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, 'Professional', 'Draft', ?, ?)`,
    [ws(req), v.recipient_email, v.recipient_name || '', v.subject,
      `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">${esc(v.body).replace(/\n/g, '<br>')}</div>`, v.body, now, now]
  );
  res.json({
    success: true,
    sent: false,
    draftId: result.lastID,
    message: `Saved a draft to ${v.recipient_email} for review. It will only be sent after someone approves and sends it from Mail Drafts.`
  });
}));

tools.all(['/api/tools/get_emails', '/api/get_emails'], requireCapability('mail.view'), wrap(async (req, res) => {
  const rows = await all('SELECT * FROM emails WHERE workspace_id = ? ORDER BY is_urgent DESC, id DESC LIMIT 20', [ws(req)]);
  const urgent = rows.filter(e => Number(e.is_urgent) === 1 && (Number(e.is_read) === 0 || e.status === 'Unread'));
  const spoken = urgent.length
    ? `Sir, you have ${urgent.length} urgent emails requiring your attention: ${urgent.map(e => `${e.sender || e.recipient_name} regarding '${e.subject}'`).join('; ')}.`
    : `Sir, you have ${rows.length} total emails in your records, and none are marked urgent.`;
  res.json({ success: true, total_emails: rows.length, urgent_count: urgent.length, emails: rows, spoken_summary: spoken });
}));

// ==========================================
// Mail settings: /api/v1/mail, /api/mail
// ==========================================
const settings = express.Router();
const port = z.union([z.number().int(), z.string().regex(/^\d+$/)]).optional().nullable();
const host = z.string().trim().max(255).regex(/^[A-Za-z0-9.-]*$/, 'must be a host name').optional().nullable();
const configSchema = z.object({
  provider: z.enum(['zeptomail', 'custom_smtp', 'gmail', 'office365', 'outlook', 'zoho', 'smtp']).optional().nullable(),
  smtp_host: host,
  smtp_port: port,
  smtp_secure: z.union([z.boolean(), z.number()]).optional().nullable(),
  smtp_user: z.string().max(255).optional().nullable(),
  smtp_pass: z.string().max(2000).optional().nullable(),
  imap_host: host,
  imap_port: port,
  imap_tls: z.union([z.boolean(), z.number()]).optional().nullable(),
  imap_user: z.string().max(255).optional().nullable(),
  imap_pass: z.string().max(2000).optional().nullable(),
  sender_name: z.string().max(255).optional().nullable(),
  sender_email: recipientEmail.optional().nullable()
}).strip();

settings.get('/config', requireCapability('mail.configure'), wrap(async (req, res) => {
  res.json({ success: true, config: await emailService.getSafeMailConfig(ws(req)) });
}));

settings.post('/config', requireCapability('mail.configure'), body(configSchema), wrap(async (req, res) => {
  const config = await emailService.saveMailConfig(ws(req), req.valid);
  await audit(req, 'mail.settings_updated', { resourceType: 'mail_configuration', metadata: { fields: Object.keys(req.valid).filter(k => !/pass/.test(k)) } });
  res.json({ success: true, config, message: 'Mail settings saved.' });
}));

settings.post('/test-smtp', requireCapability('mail.configure'), body(z.object({ config: configSchema.optional().nullable() })), wrap(async (req, res) => {
  res.json(await emailService.verifySmtpConnection(ws(req), req.valid.config || null));
}));

// Marketing email (Product Emails) delivery: status for everyone who reads mail; approving an SMTP
// mailbox for marketing is an Owner/Admin decision, recorded and audited.
settings.get('/marketing', requireCapability('mail.view'), wrap(async (req, res) => {
  res.json({ success: true, marketing: await emailService.marketingDeliveryStatus(ws(req)) });
}));

settings.post('/marketing', requireCapability('mail.configure'), body(z.object({
  approved: z.boolean(),
  confirm: confirmed,
  note: z.string().trim().max(255).optional()
})), wrap(async (req, res) => {
  const marketing = await emailService.setMarketingApproval(ws(req), { approved: req.valid.approved, userId: req.auth.userId, note: req.valid.note });
  await audit(req, req.valid.approved ? 'mail.marketing_approved' : 'mail.marketing_approval_withdrawn', { resourceType: 'mail_configuration', metadata: { provider: marketing.provider, note: req.valid.note || null } });
  res.json({ success: true, marketing });
}));

/** k***@client.io — enough to recognise a recipient, not to copy their address. */
function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return null;
  return `${local[0]}***@${domain}`;
}

/**
 * Compose send report (Owners/Admins: mail.configure), this workspace only. Send records with the
 * sender, a masked recipient, status and the declared/applied purpose with reason codes; plus
 * refused attempts from the audit log. No message content. Rows before migration 025 show
 * purpose "not recorded".
 */
const reportQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  purpose: z.enum(['transactional', 'marketing', 'not_recorded']).optional(),
  page: z.coerce.number().int().min(1).max(1000).optional()
}).strict();

settings.get('/compose-report', requireCapability('mail.configure'), wrap(async (req, res) => {
  const parsed = reportQuery.safeParse(req.query || {});
  if (!parsed.success) throw httpError(parsed.error.issues.map(i => `${i.path.join('.') || 'query'}: ${i.message}`).join('; '), 400, 'VALIDATION_ERROR');
  const q = parsed.data;
  const to = q.to ? new Date(`${q.to}T00:00:00Z`) : new Date();
  const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(to.getTime() - 30 * 86400000);
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1));
  if (isNaN(from) || isNaN(to) || from >= end) throw httpError('Choose a valid date range.', 400, 'VALIDATION_ERROR');
  if (end - from > 367 * 86400000) throw httpError('Choose a range of at most one year.', 400, 'VALIDATION_ERROR');
  const page = q.page || 1;
  const PAGE = 50;
  const sqlDate = d => d.toISOString().slice(0, 19).replace('T', ' ');
  const where = ['r.workspace_id = ?', 'r.created_at >= ?', 'r.created_at < ?'];
  const params = [ws(req), sqlDate(from), sqlDate(end)];
  if (q.purpose === 'not_recorded') where.push('r.applied_purpose IS NULL');
  else if (q.purpose) { where.push('r.applied_purpose = ?'); params.push(q.purpose); }
  const rows = await all(
    `SELECT r.id, r.status, r.created_at, r.updated_at, r.declared_purpose, r.applied_purpose, r.purpose_reasons, r.requested_by, r.email_id,
            u.display_name AS sender_name, e.recipient_email
     FROM mail_send_requests r
     LEFT JOIN users u ON u.id = r.requested_by
     LEFT JOIN emails e ON e.id = r.email_id AND e.workspace_id = r.workspace_id
     WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT ${PAGE + 1} OFFSET ${(page - 1) * PAGE}`, params);
  // Refused Compose attempts (audit log): filtered in SQL so other refusals cannot crowd them out;
  // the latest 50 in the range, with refusedTruncated when there are more.
  const REFUSED = 50;
  const blocked = page === 1 && q.purpose !== 'not_recorded' ? await all(
    `SELECT a.created_at, a.actor_user_id, a.metadata_json, u.display_name AS sender_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.workspace_id = ? AND a.action = 'mail.send_blocked' AND a.created_at >= ? AND a.created_at < ?
       AND JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.path')) = 'compose'
       ${q.purpose ? "AND JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.purpose.applied')) = ?" : ''}
     ORDER BY a.id DESC LIMIT ${REFUSED + 1}`,
    [ws(req), sqlDate(from), sqlDate(end), ...(q.purpose ? [q.purpose] : [])]) : [];
  const meta = r => { try { return JSON.parse(r.metadata_json || '{}'); } catch { return {}; } };
  res.json({
    success: true,
    range: { from: sqlDate(from).slice(0, 10), to: sqlDate(new Date(end - 86400000)).slice(0, 10) },
    page,
    hasMore: rows.length > PAGE,
    sends: rows.slice(0, PAGE).map(r => ({
      id: r.id,
      at: r.created_at,
      status: r.status,
      sender: r.requested_by ? { userId: r.requested_by, name: r.sender_name || null } : null,
      recipient: maskEmail(r.recipient_email),
      emailId: r.email_id,
      declaredPurpose: r.applied_purpose ? r.declared_purpose : null,
      appliedPurpose: r.applied_purpose || 'not_recorded',
      reasons: r.purpose_reasons ? r.purpose_reasons.split(',') : []
    })),
    refusedTruncated: blocked.length > REFUSED,
    refused: blocked.slice(0, REFUSED)
      .map(b => ({ b, m: meta(b) }))
      .map(({ b, m }) => ({ at: b.created_at, sender: b.actor_user_id ? { userId: b.actor_user_id, name: b.sender_name || null } : null, reason: m.reason || null, declaredPurpose: m.purpose?.declared ?? null, appliedPurpose: m.purpose?.applied || null, reasons: m.purpose?.reasons || [] }))
  });
}));

settings.post('/sync', requireCapability('mail.compose'), wrap(async (req, res) => {
  const result = await emailService.syncIncomingEmails(ws(req));
  // Unsubscribe replies to marketing email (product emails, drafts, marketing Compose) take effect as soon as they are synced.
  await require('./productEmails/service').detectUnsubscribeReplies({ workspaceId: ws(req) }).catch(err => console.warn('Unsubscribe reply check failed:', err.message));
  res.json(result);
}));

// Every route above starts with requireCapability, which also rejects unauthenticated calls (401).
module.exports = { drafts, emails, settings, tools, sendDraftCore, presentDraft, draftParts, SUPPRESSION_POLICY };
