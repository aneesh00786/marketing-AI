const express = require('express');
const { z } = require('zod');
const { run, get, all } = require('../../db/database');
const { requireCapability } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');
const aiEngine = require('../../services/aiEngine');
const emailService = require('../../services/emailService');
const { resolveSelectedProduct } = require('../../lib/productContext');

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

async function requireDraft(workspaceId, rawId) {
  const draft = await get('SELECT * FROM email_drafts WHERE id = ? AND workspace_id = ?', [requireId(rawId), workspaceId]);
  if (!draft) throw httpError('Draft not found', 404, 'NOT_FOUND');
  return draft;
}

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
  res.json({ success: true, drafts: await all('SELECT * FROM email_drafts WHERE workspace_id = ? ORDER BY id DESC', [ws(req)]) });
}));

drafts.post('/generate', requireCapability('mail.compose'), body(z.object({
  productId,
  recipientName: z.string().max(255).optional().nullable(),
  recipientEmail: recipientEmail.optional().nullable(),
  goal: z.string().max(2000).optional().nullable(),
  tone: z.string().max(100).optional().nullable()
})), wrap(async (req, res) => {
  const v = req.valid;
  // Only the explicitly selected product of this workspace; malformed or foreign ids are rejected.
  const product = await resolveSelectedProduct(ws(req), v.productId);
  const draftContent = await aiEngine.generateMailDraft(product, { name: v.recipientName, email: v.recipientEmail }, v.goal, v.tone || 'Professional');
  const now = nowSql();
  const result = await run(
    `INSERT INTO email_drafts (workspace_id, product_id, product_name, recipient_email, recipient_name, subject, body_html, body_text, tone, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?, ?)`,
    [ws(req), product ? product.id : null, product ? product.name : null, (v.recipientEmail || '').trim(), v.recipientName || '',
      draftContent.subject, draftContent.body_html, draftContent.body_text, draftContent.tone, now, now]
  );
  const missing = draftContent.missing_context || [];
  if (!isEmail(v.recipientEmail)) missing.push('recipient email');
  res.json({
    success: true,
    draft: await requireDraft(ws(req), result.lastID),
    missing_context: missing,
    message: missing.includes('product')
      ? 'Draft created without product context: no product was selected, so it contains no product details or links. Review before sending.'
      : 'Email draft created. Awaiting your approval before sending.'
  });
}));

drafts.get('/:id', requireCapability('mail.view'), wrap(async (req, res) => {
  res.json({ success: true, draft: await requireDraft(ws(req), req.params.id) });
}));

// Editing a draft sends it back to "Draft", so it must be approved again before sending.
drafts.patch('/:id', requireCapability('mail.compose'), body(z.object({
  recipient_email: recipientEmail.optional(),
  recipient_name: z.string().max(255).optional(),
  subject: z.string().trim().min(1).max(255).optional()
})), wrap(async (req, res) => {
  const draft = await requireDraft(ws(req), req.params.id);
  if (['Sent', 'Sending'].includes(draft.status)) throw httpError('A sent draft cannot be edited.', 409, 'DRAFT_SENT');
  const v = req.valid;
  await run(
    `UPDATE email_drafts SET recipient_email = ?, recipient_name = ?, subject = ?, status = 'Draft', updated_at = ? WHERE id = ? AND workspace_id = ?`,
    [v.recipient_email !== undefined ? v.recipient_email : draft.recipient_email, v.recipient_name !== undefined ? v.recipient_name : draft.recipient_name,
      v.subject !== undefined ? v.subject : draft.subject, nowSql(), draft.id, ws(req)]
  );
  res.json({ success: true, draft: await requireDraft(ws(req), draft.id), message: 'Draft updated. Approve it again before sending.' });
}));

drafts.post('/:id/rewrite', requireCapability('mail.compose'), body(z.object({ instruction: z.string().max(200).optional() })), wrap(async (req, res) => {
  const draft = await requireDraft(ws(req), req.params.id);
  if (['Sent', 'Sending'].includes(draft.status)) throw httpError('A sent draft cannot be rewritten.', 409, 'DRAFT_SENT');
  const instruction = req.valid.instruction || 'More Professional';
  const rewritten = await aiEngine.rewriteMailDraft(draft, instruction, ws(req));
  await run(
    `UPDATE email_drafts SET subject = ?, body_html = ?, body_text = ?, tone = ?, status = 'Draft', updated_at = ? WHERE id = ? AND workspace_id = ?`,
    [rewritten.subject, rewritten.body_html, rewritten.body_text, rewritten.tone, nowSql(), draft.id, ws(req)]
  );
  res.json({ success: true, draft: await requireDraft(ws(req), draft.id), message: `Draft rewritten to be "${instruction}". Approve it again before sending.` });
}));

drafts.put('/:id/approve', requireCapability('mail.send'), wrap(async (req, res) => {
  const draft = await requireDraft(ws(req), req.params.id);
  if (['Sent', 'Sending'].includes(draft.status)) throw httpError('This draft has already been sent.', 409, 'DRAFT_SENT');
  if (!isEmail(draft.recipient_email)) throw httpError('Add a valid recipient email address before approving.', 400, 'INVALID_RECIPIENT');
  await run(`UPDATE email_drafts SET status = 'Approved', updated_at = ? WHERE id = ? AND workspace_id = ?`, [nowSql(), draft.id, ws(req)]);
  await audit(req, 'mail.draft_approved', { resourceType: 'email_draft', resourceId: draft.id });
  res.json({ success: true, draft: await requireDraft(ws(req), draft.id), message: 'Draft approved. Ready for dispatch.' });
}));

drafts.post('/:id/send', requireCapability('mail.send'), body(z.object({ confirm: confirmed })), wrap(async (req, res) => {
  const draft = await requireDraft(ws(req), req.params.id);
  if (draft.status !== 'Approved') {
    throw httpError(draft.status === 'Sent' ? 'This draft has already been sent.' : 'Approve the draft before sending it.', 409, draft.status === 'Sent' ? 'DRAFT_SENT' : 'NOT_APPROVED');
  }
  if (!isEmail(draft.recipient_email)) throw httpError('This draft has no valid recipient email address. Add one before sending.', 400, 'INVALID_RECIPIENT');

  // Claim the draft so a double click or a second tab cannot send it twice.
  const claim = await run(`UPDATE email_drafts SET status = 'Sending', updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'Approved'`, [nowSql(), draft.id, ws(req)]);
  if (!claim.changes) throw httpError('This draft is already being sent.', 409, 'DRAFT_SENT');

  let sendResult;
  try {
    sendResult = await emailService.sendRealEmail(ws(req), {
      to: draft.recipient_email,
      recipientName: draft.recipient_name || '',
      subject: draft.subject,
      html: draft.body_html || draft.html_body,
      text: draft.body_text || draft.body
    });
  } catch (err) {
    // Nothing was sent: the draft goes back to Approved and the error is reported as is.
    await run(`UPDATE email_drafts SET status = 'Approved', updated_at = ? WHERE id = ? AND workspace_id = ?`, [nowSql(), draft.id, ws(req)]);
    throw err;
  }
  await run(`UPDATE email_drafts SET status = 'Sent', updated_at = ? WHERE id = ? AND workspace_id = ?`, [nowSql(), draft.id, ws(req)]);
  await audit(req, 'mail.draft_sent', { resourceType: 'email_draft', resourceId: draft.id, metadata: { emailId: sendResult.emailId } });
  res.json({ success: true, sendResult, message: `Email sent to ${draft.recipient_email} (${sendResult.smtpStatus}).` });
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
  const rows = await all('SELECT * FROM emails WHERE workspace_id = ? ORDER BY is_urgent DESC, id DESC LIMIT 50', [ws(req)]);
  res.json({ success: true, emails: rows.map(presentEmail) });
}));

const sendSchema = z.object({
  recipient_email: requiredRecipient,
  recipient_name: z.string().max(255).optional().nullable(),
  subject: z.string().trim().min(1).max(255),
  body: z.string().max(100000).optional().nullable(),
  body_text: z.string().max(100000).optional().nullable(),
  html_body: z.string().max(500000).optional().nullable(),
  confirm: confirmed
}).passthrough();

async function sendDirect(req, res, { requireHtml }) {
  const v = req.valid;
  if (requireHtml && !v.html_body) throw httpError('html_body is required.', 400, 'VALIDATION_ERROR');
  const text = v.body_text || v.body || '';
  const sendRes = await emailService.sendRealEmail(ws(req), {
    to: v.recipient_email,
    recipientName: v.recipient_name || '',
    subject: v.subject,
    html: v.html_body || null,
    text
  });
  await audit(req, 'mail.sent', { resourceType: 'email', resourceId: sendRes.emailId });
  res.json({
    success: true,
    emailId: sendRes.emailId,
    messageId: sendRes.messageId,
    smtpStatus: sendRes.smtpStatus,
    message: `Email sent to ${v.recipient_email} regarding '${v.subject}' (${sendRes.smtpStatus}).`
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

settings.post('/sync', requireCapability('mail.compose'), wrap(async (req, res) => {
  res.json(await emailService.syncIncomingEmails(ws(req)));
}));

// Every route above starts with requireCapability, which also rejects unauthenticated calls (401).
module.exports = { drafts, emails, settings, tools };
