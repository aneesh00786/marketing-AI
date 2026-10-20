const express = require('express');
const { z } = require('zod');
const { run, get, all } = require('../../db/database');
const { requireCapability } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');
const { generateStructured, untrusted } = require('../../lib/aiStructured');
const { resolveSelectedProduct } = require('../../lib/productContext');
const { unverified } = require('../../lib/claims');
const { isValidRecipient } = require('../../services/emailService');

/**
 * Business Playbooks ("AI Campaigns"), workspace-scoped.
 * - Playbooks come from a real AI model, grounded in the selected business (and optional
 *   product) record. No canned campaigns: when the model is unavailable the API says so.
 * - "Dispatch" never sends: it creates Mail Drafts for explicitly selected leads, which a
 *   person approves and confirms in Mail Drafts.
 */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ws = req => req.auth.workspaceId;
const nowSql = () => new Date().toISOString().replace('T', ' ').substring(0, 19);
const MAX_LEADS = 50;

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

function parseList(v) {
  try { const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

function present(b) {
  return { ...b, products: parseList(b.products_json) };
}

const positiveId = z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)]);

async function requireBusiness(workspaceId, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw httpError('Select a business.', 400, 'VALIDATION_ERROR');
  const biz = await get('SELECT * FROM connected_businesses WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
  if (!biz) throw httpError('Business not found in this workspace.', 404, 'NOT_FOUND');
  return biz;
}

// ---------------------------------------------------------------------------
// Businesses
// ---------------------------------------------------------------------------
router.get(['/api/v1/businesses/connected', '/api/businesses/connected'], requireCapability('analytics.view'), wrap(async (req, res) => {
  const list = await all("SELECT * FROM connected_businesses WHERE workspace_id = ? ORDER BY CASE WHEN business_type = 'owner' THEN 0 ELSE 1 END, id ASC", [ws(req)]);
  res.json({ success: true, businesses: list.map(present) });
}));

const text = max => z.string().trim().max(max).optional().nullable();
router.post(['/api/v1/businesses/connected', '/api/businesses/connected'], requireCapability('campaigns.manage'), body(z.object({
  name: z.string().trim().min(1).max(255),
  industry: z.string().trim().min(1).max(255),
  website: z.string().trim().max(500).refine(v => v === '' || /^https?:\/\/[^\s]+$/i.test(v), 'must be an http(s) URL').optional().nullable(),
  description: text(5000),
  products: z.array(z.string().trim().max(300)).max(50).optional(),
  target_audience: text(2000)
}).strip()), wrap(async (req, res) => {
  const v = req.valid;
  // New entries are always client businesses; the owner business is set up once by an admin.
  const result = await run(
    `INSERT INTO connected_businesses (workspace_id, business_type, name, industry, website, description, products_json, target_audience, status, created_at)
     VALUES (?, 'client', ?, ?, ?, ?, ?, ?, 'Connected', ?)`,
    [ws(req), v.name, v.industry, v.website || '', v.description || '', JSON.stringify((v.products || []).filter(Boolean)), v.target_audience || '', nowSql()]
  );
  await audit(req, 'playbooks.business_created', { resourceType: 'connected_business', resourceId: result.lastID, metadata: { name: v.name } });
  res.json({ success: true, businessId: result.lastID, message: `Connected business "${v.name}" registered.` });
}));

// ---------------------------------------------------------------------------
// Playbook generation (real AI only)
// ---------------------------------------------------------------------------
const ideaSchema = z.object({
  ideas: z.array(z.object({
    channel: z.string().min(1).max(200),
    angle: z.string().min(1).max(300),
    subject: z.string().max(200).optional().default(''),
    email_body: z.string().max(4000).optional().default(''),
    summary: z.string().max(2000).optional().default(''),
    internal_tip: z.string().max(1000).optional().default('')
  })).min(1).max(6)
});

router.post(['/api/v1/marketing/generate-ideas', '/api/marketing/generate-ideas'], requireCapability('campaigns.manage'), body(z.object({
  businessId: positiveId,
  productId: z.union([z.number(), z.string(), z.null()]).optional(),
  goal: z.string().trim().max(500).optional().nullable()
}).passthrough()), wrap(async (req, res) => {
  const biz = await requireBusiness(ws(req), req.valid.businessId);
  const product = await resolveSelectedProduct(ws(req), req.valid.productId);
  const productFeatures = product ? parseList(product.features_json) : [];

  const facts = {
    business: {
      name: biz.name,
      type: biz.business_type === 'owner' ? 'our own business' : 'client business',
      industry: biz.industry || null,
      website: biz.website || null,
      description: biz.description || null,
      target_audience: biz.target_audience || null,
      offerings: parseList(biz.products_json)
    },
    product: product ? {
      name: product.name,
      tagline: product.tagline || null,
      description: product.description || null,
      features: productFeatures,
      target_audience: product.target_audience || null,
      url: product.url || null
    } : null
  };
  const factsText = JSON.stringify(facts);
  const missing = [];
  if (!biz.description) missing.push('business description');
  if (!biz.target_audience) missing.push('target audience');
  if (!parseList(biz.products_json).length && !product) missing.push('offerings or a selected product');

  const prompt = `Create 3 marketing campaign playbooks for the business below${product ? ' and the selected product' : ''}.
Use ONLY the facts provided. Do not invent statistics, percentages, prices, discounts, free trials or pilots, grants, guarantees, customer names, results or features.
If a fact is needed but missing, write a placeholder in square brackets, e.g. [customer result].
${req.valid.goal ? `Campaign goal from the user: ${untrusted('goal', req.valid.goal, 500)}` : ''}
${untrusted('business_and_product_facts', factsText, 6000)}

Return JSON: {"ideas":[{
  "channel": "channel or tactic, e.g. Cold email to operations managers",
  "angle": "the message angle in one line",
  "subject": "email subject line (customer-facing)",
  "email_body": "short customer-facing email body (no greeting line, no signature), only verified facts",
  "summary": "what the campaign does and who it targets (internal)",
  "internal_tip": "an internal execution tip for the team; never shown to customers"
}]}`;

  const { data, provider } = await generateStructured({
    workspaceId: ws(req),
    prompt,
    system: 'You are a careful B2B marketing strategist. You never invent facts, numbers or offers.',
    schema: ideaSchema,
    referenceType: 'connected_business',
    referenceId: biz.id,
    maxTokens: 1800
  });

  const ideas = data.ideas.map(i => {
    const customerText = `${i.subject} ${i.email_body}`;
    return { ...i, needs_verification: unverified(`${customerText} ${i.summary}`, factsText) };
  });

  res.json({ success: true, business: present(biz), product: product ? { id: product.id, name: product.name } : null, ideas, missing_context: missing, provider });
}));

// ---------------------------------------------------------------------------
// Dispatch = create Mail Drafts for explicitly selected leads (never sends)
// ---------------------------------------------------------------------------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

router.post(['/api/v1/marketing/dispatch-campaign', '/api/marketing/dispatch-campaign'], requireCapability('mail.compose'), body(z.object({
  businessId: positiveId.optional(),
  productId: z.union([z.number(), z.string(), z.null()]).optional(),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
  leadIds: z.array(positiveId).min(1, 'select at least one lead').max(MAX_LEADS)
}).strict()), wrap(async (req, res) => {
  const v = req.valid;
  if (v.businessId) await requireBusiness(ws(req), v.businessId);
  const product = await resolveSelectedProduct(ws(req), v.productId);

  const ids = [...new Set(v.leadIds.map(Number))];
  const leads = await all(`SELECT id, name, email FROM leads WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [ws(req), ...ids]);
  if (leads.length !== ids.length) throw httpError('One or more selected leads were not found in this workspace.', 404, 'NOT_FOUND');

  const created = [];
  const skipped = [];
  const now = nowSql();
  for (const lead of leads) {
    const email = String(lead.email || '').trim();
    if (!isValidRecipient(email)) {
      skipped.push({ leadId: lead.id, name: lead.name, reason: email ? 'invalid or placeholder email address' : 'no email address' });
      continue;
    }
    const firstName = String(lead.name || '').trim().split(/\s+/)[0];
    const greeting = firstName ? `Hi ${firstName},` : 'Hi there,';
    const text = `${greeting}\n\n${v.body}\n\nBest regards,\n[Your name]`;
    const html = `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">${esc(text).replace(/\n/g, '<br>')}</div>`;
    const r = await run(
      `INSERT INTO email_drafts (workspace_id, product_id, product_name, lead_id, recipient_email, recipient_name, subject, body_html, body_text, tone, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Professional', 'Draft', ?, ?)`,
      [ws(req), product ? product.id : null, product ? product.name : null, lead.id, email, lead.name || '', v.subject, html, text, now, now]
    );
    created.push({ draftId: r.lastID, leadId: lead.id });
  }
  await audit(req, 'playbooks.drafts_created', { resourceType: 'email_draft', metadata: { drafts: created.length, skipped: skipped.length } });
  res.json({
    success: true,
    sent: false,
    draftsCreated: created.length,
    drafts: created,
    skipped,
    message: created.length
      ? `Created ${created.length} draft${created.length === 1 ? '' : 's'} in Mail Drafts. Nothing was sent: review, approve and confirm each one there.${skipped.length ? ` Skipped ${skipped.length} lead${skipped.length === 1 ? '' : 's'} without a valid email.` : ''}`
      : 'No drafts created: none of the selected leads has a valid email address.'
  });
}));

module.exports = router;
