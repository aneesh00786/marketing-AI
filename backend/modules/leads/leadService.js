const { run, get, all } = require('../../db/database');
const leadAccess = require('../../lib/leadAccess');
const { audit } = require('../../lib/audit');
const automationEvents = require('../../lib/automationEvents');
const { generateText, untrusted, AiUnavailableError } = require('../../lib/aiStructured');

/**
 * Leads CRM service. Every query is scoped to the authenticated workspace, and every
 * product reference is validated against that same workspace. Nothing is invented:
 * missing values stay null, the lead score is a transparent rule-based score, and AI
 * advice is only ever stored when a real model produced it.
 */
const STATUSES = ['New', 'Imported', 'Contacted', 'Qualified', 'Demo Scheduled', 'Proposal', 'Won', 'Lost'];
const INTENT_WORDS = /\b(demo|quote|urgent|pricing|price|trial|pilot|buy|purchase|proposal|asap)\b/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_QUALIFY_BATCH = 50;
const MAX_IMPORT_ROWS = 2000;
// Leads AI (follow-up advice, AI Lead Discovery) never uses Telnyx; other providers serve it.
const LEADS_AI_EXCLUDE = ['telnyx'];

function httpError(status, message, code = 'BAD_REQUEST') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const clean = v => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const PLACEHOLDER_DOMAIN_RE = /@(example\.(com|org|net)|test\.com)$/i;

function isValidEmail(email) {
  return !!email && EMAIL_RE.test(email) && !PLACEHOLDER_DOMAIN_RE.test(email);
}

/** Why an email cannot receive mail: 'missing', 'invalid' or 'placeholder' (reserved demo domains), or null. */
function emailIssue(email) {
  const e = clean(email);
  if (!e) return 'missing';
  if (!EMAIL_RE.test(e)) return 'invalid';
  if (PLACEHOLDER_DOMAIN_RE.test(e)) return 'placeholder';
  return null;
}

/**
 * Parses budgets like "$15,000", "AED 12,500.50", "₹ 2,00,000", "15k", "1.2M", "15000".
 * Returns a number, or null when no amount can be read.
 */
function parseBudget(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim().toLowerCase();
  const m = s.match(/(\d[\d,\s]*(?:\.\d+)?)\s*(k|m|mn|million|thousand|lakh|lac|cr|crore)?\b/);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/[,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = m[2] || '';
  if (unit === 'k' || unit === 'thousand') n *= 1e3;
  else if (unit === 'm' || unit === 'mn' || unit === 'million') n *= 1e6;
  else if (unit === 'lakh' || unit === 'lac') n *= 1e5;
  else if (unit === 'cr' || unit === 'crore') n *= 1e7;
  return n;
}

/** Transparent rule-based lead score (not AI). Returns the score and the factors behind it. */
function scoreLead(lead) {
  const factors = [{ label: 'Base score', points: 50 }];
  if (isValidEmail(clean(lead.email))) factors.push({ label: 'Valid email', points: 15 });
  if ((clean(lead.phone) || '').replace(/\D/g, '').length >= 7) factors.push({ label: 'Phone number', points: 10 });
  if (clean(lead.company_name)) factors.push({ label: 'Company name', points: 10 });
  const budget = parseBudget(lead.estimated_budget);
  if (budget !== null && budget >= 1000) factors.push({ label: 'Budget of 1,000 or more', points: 15 });
  if (INTENT_WORDS.test(`${lead.notes || ''} ${lead.product_interest || ''}`)) factors.push({ label: 'Buying-intent words in notes', points: 15 });
  const raw = factors.reduce((a, f) => a + f.points, 0);
  const score = Math.min(Math.max(raw, 15), 98);
  const category = score >= 75 ? 'Hot' : (score >= 45 ? 'Warm' : 'Cold');
  return { score, category, factors, budgetValue: budget };
}

// ---------- Products (always workspace-scoped) ----------
async function listProducts(workspaceId) {
  const rows = await all('SELECT id, name, url, tagline, description, features_json, target_audience, status FROM digital_products WHERE workspace_id = ? ORDER BY name', [workspaceId]);
  return rows.map(presentProduct);
}

function presentProduct(p) {
  if (!p) return null;
  let features = [];
  try { features = JSON.parse(p.features_json || '[]'); } catch (e) { features = []; }
  return { id: p.id, name: p.name, url: p.url, tagline: p.tagline, description: p.description, features: Array.isArray(features) ? features : [], targetAudience: p.target_audience, status: p.status };
}

/** Returns the product if it belongs to the workspace; throws 400 for foreign/unknown ids. */
async function requireWorkspaceProduct(workspaceId, productId) {
  if (productId === null || productId === undefined || productId === '') return null;
  const id = Number(productId);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid product id.', 'INVALID_PRODUCT');
  const p = await get('SELECT * FROM digital_products WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
  if (!p) throw httpError(400, 'That product does not exist in this workspace.', 'INVALID_PRODUCT');
  return p;
}

// ---------- Leads ----------
function present(row) {
  const scoring = scoreLead(row);
  return {
    id: row.id,
    name: row.name,
    email: row.email || null,
    hasValidEmail: isValidEmail(row.email),
    emailIssue: emailIssue(row.email),
    phone: row.phone || null,
    companyName: row.company_name || null,
    country: row.country || null,
    address: row.address || null,
    estimatedBudget: row.estimated_budget || null,
    notes: row.notes || null,
    status: row.status || null,
    productId: row.product_id ?? null,
    productName: row.product_name ?? null,
    productMissing: row.product_id !== null && row.product_id !== undefined && !row.product_name,
    productInterest: row.product_interest || null,
    productReviewNote: row.product_review_note || null,
    // Stored score (0 is preserved); scoreFactors explains the current rule-based score.
    score: row.ai_score === null || row.ai_score === undefined ? null : Number(row.ai_score),
    category: row.ai_category || null,
    scoreFactors: scoring.factors,
    aiSuggestion: row.ai_suggestion || null,
    aiStatus: row.ai_status || null,
    aiSuggestedAt: row.ai_suggested_at || null,
    // Found through AI Lead Discovery: business details are shown live from Google, not stored.
    googlePlace: !!row.google_place,
    // Marketing email consent (never assumed; recorded on the Leads screen or in Product Emails).
    marketingConsent: row.marketing_consent || 'unknown',
    marketingConsentSource: row.marketing_consent_source || null,
    marketingConsentMethod: row.marketing_consent_method || null,
    marketingConsentObtainedAt: row.marketing_consent_obtained_at || null,
    // Granted with how, when and evidence: the standard email campaigns and Product Emails require.
    marketingConsentProven: row.marketing_consent === 'granted' && !!(row.marketing_consent_method && row.marketing_consent_evidence),
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
    // Ownership and access (lib/leadAccess.js).
    ownerUserId: row.owner_user_id ?? null,
    ownerName: row.owner_name || null,
    createdByUserId: row.created_by_user_id ?? null,
    createdByName: row.created_by_name || null,
    createdByAdmin: row.created_by_admin === undefined ? null : !!Number(row.created_by_admin),
    sharedCount: row.shared_count === undefined ? null : Number(row.shared_count),
    leadSource: row.lead_source || (row.google_place ? 'discovery' : null),
    accessLevel: row.accessLevel || row.access_level || null
  };
}

const ADMIN_ROLES_SQL = "'Workspace Owner', 'Workspace Admin'";
/** Ownership views of the Leads list (admins: all of them; others: mine / shared with me). */
const OWNERSHIP_VIEWS = ['all', 'mine', 'shared_with_me', 'user_created', 'admin_created', 'assigned', 'shared', 'unassigned'];

// lead_place_refs arrives with migration 013; until then leads are listed without the flag.
let placeRefs = { exists: false, checkedAt: 0 };
async function selectLead() {
  if (!placeRefs.exists && Date.now() - placeRefs.checkedAt > 60000) {
    placeRefs = { exists: !!(await get("SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lead_place_refs'")), checkedAt: Date.now() };
  }
  return `SELECT l.*, p.name AS product_name${placeRefs.exists ? ', (SELECT 1 FROM lead_place_refs r WHERE r.lead_id = l.id LIMIT 1) AS google_place' : ''},
    COALESCE(NULLIF(ou.display_name, ''), ou.email) AS owner_name, COALESCE(NULLIF(cu.display_name, ''), cu.email) AS created_by_name,
    (SELECT COUNT(*) FROM workspace_members am WHERE am.workspace_id = l.workspace_id AND am.user_id = l.created_by_user_id AND am.role IN (${ADMIN_ROLES_SQL})) AS created_by_admin,
    (SELECT COUNT(*) FROM lead_user_access sa WHERE sa.lead_id = l.id) AS shared_count
  FROM leads l
  LEFT JOIN digital_products p ON p.workspace_id = l.workspace_id AND p.id = l.product_id
  LEFT JOIN users ou ON ou.id = l.owner_user_id
  LEFT JOIN users cu ON cu.id = l.created_by_user_id`;
}

/** The WHERE clause for the Leads list filters (also used by the export). */
async function leadWhere(ctx, { productId, status, q, source, country, view } = {}) {
  const workspaceId = ctx.auth.workspaceId;
  // Only the leads this person may see (Owners/Admins: all of the workspace's).
  const vis = leadAccess.visibleSql(ctx, 'l');
  const where = ['l.workspace_id = ?', vis.sql];
  const params = [workspaceId, ...vis.params];
  const me = Number(ctx.auth.userId) || 0;
  const adminCreator = `EXISTS (SELECT 1 FROM workspace_members vm WHERE vm.workspace_id = l.workspace_id AND vm.user_id = l.created_by_user_id AND vm.role IN (${ADMIN_ROLES_SQL}))`;
  switch (OWNERSHIP_VIEWS.includes(view) ? view : 'all') {
    case 'mine': where.push('l.owner_user_id = ?'); params.push(me); break;
    case 'shared_with_me': where.push('EXISTS (SELECT 1 FROM lead_user_access w WHERE w.lead_id = l.id AND w.user_id = ?)'); params.push(me); break;
    case 'user_created': where.push(`l.created_by_user_id IS NOT NULL AND NOT ${adminCreator}`); break;
    case 'admin_created': where.push(adminCreator); break;
    case 'assigned': where.push('l.owner_user_id IS NOT NULL AND (l.created_by_user_id IS NULL OR l.owner_user_id <> l.created_by_user_id)'); break;
    case 'shared': where.push('EXISTS (SELECT 1 FROM lead_user_access w WHERE w.lead_id = l.id)'); break;
    case 'unassigned': where.push('l.owner_user_id IS NULL'); break;
    default: break;
  }
  // source: 'discovery' = found with AI Lead Discovery (Google Places), 'crm' = all other leads.
  if (source === 'discovery' || source === 'crm') {
    await selectLead();
    if (placeRefs.exists) where.push(`${source === 'crm' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM lead_place_refs r WHERE r.lead_id = l.id)`);
    else if (source === 'discovery') where.push('1 = 0');
  }
  if (productId === 'none') where.push('l.product_id IS NULL');
  else if (productId) {
    await requireWorkspaceProduct(workspaceId, productId);
    where.push('l.product_id = ?');
    params.push(Number(productId));
  }
  if (status && STATUSES.includes(status)) { where.push('l.status = ?'); params.push(status); }
  // country: a country name, or 'none' for leads without one.
  if (country === 'none') where.push("(l.country IS NULL OR l.country = '')");
  else if (country) { where.push('l.country = ?'); params.push(String(country).slice(0, 100)); }
  if (q) {
    // Address too: a street, area, city or PIN code finds the leads there.
    where.push('(l.name LIKE ? OR l.email LIKE ? OR l.company_name LIKE ? OR l.phone LIKE ? OR l.address LIKE ?)');
    const like = `%${String(q).slice(0, 100)}%`;
    params.push(like, like, like, like, like);
  }
  return { where, params };
}

/** The countries of the leads this person can see, with how many each, for the country filter (most first). */
async function leadCountries(ctx) {
  const vis = leadAccess.visibleSql(ctx, 'l');
  const rows = await all(`SELECT NULLIF(TRIM(l.country), '') AS country, COUNT(*) AS n FROM leads l WHERE l.workspace_id = ? AND ${vis.sql} GROUP BY NULLIF(TRIM(l.country), '') ORDER BY n DESC, country`, [ctx.auth.workspaceId, ...vis.params]);
  return rows.map(r => ({ country: r.country || null, count: Number(r.n) }));
}

async function listLeads(ctx, { productId, status, q, source, country, view, page = 1, limit = 50 } = {}) {
  const { where, params } = await leadWhere(ctx, { productId, status, q, source, country, view });
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const rows = await all(`${await selectLead()} WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ${lim} OFFSET ${(pg - 1) * lim}`, params);
  const total = await get(`SELECT COUNT(*) AS c FROM leads l WHERE ${where.join(' AND ')}`, params);
  const admin = leadAccess.isLeadAdmin(ctx);
  // This person's level on each listed lead (owner / manage / view), so the screen shows only allowed actions.
  const me = Number(ctx.auth.userId) || 0;
  const shared = !admin && rows.length
    ? new Map((await all(`SELECT lead_id, access_level FROM lead_user_access WHERE user_id = ? AND lead_id IN (${rows.map(() => '?').join(',')})`, [me, ...rows.map(r => r.id)])).map(g => [g.lead_id, g.access_level]))
    : new Map();
  const levelOf = r => (admin ? 'admin' : Number(r.owner_user_id) === me ? 'owner' : shared.get(r.id) || 'view');
  return {
    leads: rows.map(r => present({ ...r, accessLevel: levelOf(r) })),
    total: Number(total?.c || 0), page: pg, limit: lim, countries: await leadCountries(ctx),
    // Which ownership views this person can use.
    // Leads are assigned (no sharing in the app): admins also see who created and assigned them.
    views: admin ? ['all', 'mine', 'user_created', 'admin_created', 'assigned', 'unassigned'] : ['all', 'mine'],
    canManageAccess: admin
  };
}

const EXPORT_MAX = 10000;
/** Every lead matching the Leads list filters (no paging), newest first, for export. */
async function exportLeads(ctx, filters = {}) {
  const { where, params } = await leadWhere(ctx, filters);
  const rows = await all(`${await selectLead()} WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ${EXPORT_MAX + 1}`, params);
  return { leads: rows.slice(0, EXPORT_MAX).map(present), truncated: rows.length > EXPORT_MAX, max: EXPORT_MAX };
}

/** A lead this person may use at `need` level (view / manage / owner / admin), with names and flags. */
async function requireLeadFor(ctx, id, need = 'view') {
  return leadAccess.requireLeadAccess(ctx, id, need, { select: await selectLead() });
}

/** Internal (background jobs only): any lead of the workspace, no per-person check. */
async function requireLead(workspaceId, id) {
  const leadId = Number(id);
  if (!Number.isInteger(leadId) || leadId <= 0) throw httpError(400, 'Invalid lead id.');
  const row = await get(`${await selectLead()} WHERE l.workspace_id = ? AND l.id = ?`, [workspaceId, leadId]);
  if (!row) throw httpError(404, 'Lead not found.', 'NOT_FOUND');
  return row;
}

function normalizeInput(input) {
  const email = clean(input.email);
  if (email && !EMAIL_RE.test(email)) throw httpError(400, 'Email address is not valid.', 'INVALID_EMAIL');
  const status = clean(input.status);
  if (status && !STATUSES.includes(status)) throw httpError(400, `Status must be one of: ${STATUSES.join(', ')}.`);
  return {
    name: clean(input.name),
    email,
    phone: clean(input.phone),
    company_name: clean(input.companyName ?? input.company_name),
    country: clean(input.country ?? input.Country)?.slice(0, 100) || null,
    address: clean(input.address ?? input.Address)?.slice(0, 500) || null,
    estimated_budget: clean(input.estimatedBudget ?? input.estimated_budget),
    notes: clean(input.notes),
    status,
    product_interest: clean(input.productInterest ?? input.interest)
  };
}

/** Resolves a product for free-text interest: exact same-workspace name match only. */
async function matchProductByName(workspaceId, name) {
  if (!name) return null;
  return get('SELECT * FROM digital_products WHERE workspace_id = ? AND LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1', [workspaceId, name]);
}

async function createLead(ctx, input, { withAi = true, source = 'manual' } = {}) {
  const workspaceId = ctx.auth.workspaceId;
  const data = normalizeInput(input);
  if (!data.name) throw httpError(400, 'Lead name is required.');
  let product = null;
  let reviewNote = null;
  if (input.productId !== undefined && input.productId !== null && input.productId !== '') {
    product = await requireWorkspaceProduct(workspaceId, input.productId);
  } else if (data.product_interest) {
    product = await matchProductByName(workspaceId, data.product_interest);
    if (!product) reviewNote = `Interest "${data.product_interest.slice(0, 200)}" is not linked to a product. Choose one from Products.`;
  }
  const { score, category } = scoreLead(data);
  // The person creating it is its creator and owner; ownership is never taken from the request.
  const own = leadAccess.newLeadOwnership(ctx, source);
  const ins = await run(
    `INSERT INTO leads (workspace_id, name, email, phone, company_name, country, address, estimated_budget, notes, status, product_id, product_interest,
       product_review_note, ai_score, ai_category, created_by_user_id, owner_user_id, lead_source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [workspaceId, data.name, data.email, data.phone, data.company_name, data.country, data.address, data.estimated_budget, data.notes, data.status || 'New',
      product?.id || null, data.product_interest || product?.name || null, reviewNote, score, category, own.created_by_user_id, own.owner_user_id, own.lead_source]
  );
  await audit(ctx, 'leads.created', { resourceType: 'lead', resourceId: ins.lastID, metadata: { productId: product?.id || null, ownerUserId: own.owner_user_id, source } });
  await automationEvents.emit(workspaceId, 'lead.created', { subjectType: 'lead', subjectId: ins.lastID, payload: { productId: product?.id || null, status: data.status || 'New' }, key: `lead.created:${ins.lastID}` });
  let ai = null;
  if (withAi) ai = await generateAdvice(ctx, ins.lastID);
  return { lead: present(await requireLeadFor(ctx, ins.lastID)), ai };
}

async function updateLead(ctx, id, input) {
  const workspaceId = ctx.auth.workspaceId;
  const existing = await requireLeadFor(ctx, id, 'manage');
  const data = normalizeInput(input);
  const sets = [];
  const params = [];
  const map = { name: 'name', email: 'email', phone: 'phone', country: 'country', address: 'address', companyName: 'company_name', company_name: 'company_name', estimatedBudget: 'estimated_budget', estimated_budget: 'estimated_budget', notes: 'notes', status: 'status' };
  const seen = new Set();
  for (const [k, col] of Object.entries(map)) {
    if (input[k] === undefined || seen.has(col)) continue;
    seen.add(col);
    if (col === 'name' && !data.name) throw httpError(400, 'Lead name cannot be empty.');
    sets.push(`${col} = ?`);
    params.push(data[col]);
  }
  if (input.productId !== undefined) {
    const product = input.productId === null || input.productId === '' ? null : await requireWorkspaceProduct(workspaceId, input.productId);
    sets.push('product_id = ?', 'product_review_note = NULL');
    params.push(product?.id || null);
    if (product) { sets.push('product_interest = ?'); params.push(product.name); }
  }
  if (!sets.length) return { lead: present(existing) };
  // Ownership fields are never changed here (only through changeOwner by an Owner/Admin).
  await run(`UPDATE leads SET ${sets.join(', ')}, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?`, [...params, workspaceId, existing.id]);
  // Keep the stored rule-based score in step with the edited fields.
  const fresh = await requireLead(workspaceId, existing.id);
  const { score, category } = scoreLead(fresh);
  await run('UPDATE leads SET ai_score = ?, ai_category = ? WHERE workspace_id = ? AND id = ?', [score, category, workspaceId, existing.id]);
  await audit(ctx, 'leads.updated', { resourceType: 'lead', resourceId: existing.id, metadata: { fields: sets.map(s => s.split(' ')[0]) } });
  if (fresh.status !== existing.status) {
    await automationEvents.emit(workspaceId, 'lead.status_changed', { subjectType: 'lead', subjectId: existing.id, payload: { from: existing.status, to: fresh.status, cause: ctx.auth?.automation ? { workflowIds: ctx.auth.automation.workflowIds } : null }, key: `lead.status:${existing.id}:${fresh.status}:${Date.now()}` });
  }
  return { lead: present(await requireLeadFor(ctx, existing.id)) };
}

/** Deleting: the owner or an Owner/Admin (shared access never allows it). */
async function deleteLead(ctx, id) {
  const workspaceId = ctx.auth.workspaceId;
  const existing = await requireLeadFor(ctx, id, 'owner');
  await run('UPDATE engagement_threads SET lead_id = NULL WHERE workspace_id = ? AND lead_id = ?', [workspaceId, existing.id]).catch(() => {});
  await run('DELETE FROM leads WHERE workspace_id = ? AND id = ?', [workspaceId, existing.id]);
  await audit(ctx, 'leads.deleted', { resourceType: 'lead', resourceId: existing.id, metadata: { name: existing.name, ownerUserId: existing.owner_user_id ?? null } });
  return { deleted: true };
}

/**
 * Imports spreadsheet rows. Products are matched by id or exact name within this
 * workspace; unmatched products are flagged for review, never invented. Rows without a
 * name are skipped and reported. AI advice is not generated per row (cost/time);
 * use "Generate AI advice" afterwards.
 */
async function importLeads(ctx, rows) {
  const workspaceId = ctx.auth.workspaceId;
  if (!Array.isArray(rows) || rows.length === 0) throw httpError(400, 'No rows to import.');
  if (rows.length > MAX_IMPORT_ROWS) throw httpError(400, `Import at most ${MAX_IMPORT_ROWS} rows at a time.`);
  const products = await all('SELECT id, name FROM digital_products WHERE workspace_id = ?', [workspaceId]);
  const byId = new Map(products.map(p => [p.id, p]));
  const byName = new Map(products.map(p => [p.name.trim().toLowerCase(), p]));
  // email → id of the first lead with it: a duplicate row reports which lead it matched. Leads are
  // never duplicated, also when the existing one belongs to someone else; then its id is not shown.
  const existingEmails = new Map();
  for (const r of await all("SELECT id, LOWER(email) AS e FROM leads WHERE workspace_id = ? AND email IS NOT NULL AND email <> '' ORDER BY id", [workspaceId])) if (!existingEmails.has(r.e)) existingEmails.set(r.e, r.id);
  const visibleExisting = new Set(await leadAccess.allowedLeadIds(ctx, [...existingEmails.values()]));
  // Imported leads belong to the person importing them (admins included; others get no access by default).
  const own = leadAccess.newLeadOwnership(ctx, 'import');

  const result = { imported: 0, skipped: [], flagged: [], duplicates: [], leadIds: [] };
  for (const [i, raw] of rows.entries()) {
    const rowNo = i + 1;
    const data = (() => {
      try { return normalizeInput(raw); } catch (e) { return { error: e.message }; }
    })();
    if (data.error) { result.skipped.push({ row: rowNo, reason: data.error }); continue; }
    if (!data.name) { result.skipped.push({ row: rowNo, reason: 'Missing name' }); continue; }
    if (data.email && existingEmails.has(data.email.toLowerCase())) {
      const dupId = existingEmails.get(data.email.toLowerCase());
      result.duplicates.push(visibleExisting.has(dupId) || result.leadIds.includes(dupId)
        ? { row: rowNo, email: data.email, leadId: dupId }
        : { row: rowNo, email: data.email, leadId: null, reason: 'Already a lead in this workspace, owned by someone else' });
      continue;
    }

    let product = null;
    let reviewNote = null;
    const rawId = clean(raw.productId ?? raw.product_id);
    const rawName = clean(raw.product ?? raw.productName ?? raw.product_name);
    if (rawId) {
      product = byId.get(Number(rawId)) || null;
      if (!product) reviewNote = `Spreadsheet product id "${rawId.slice(0, 50)}" does not exist in this workspace.`;
    } else if (rawName) {
      product = byName.get(rawName.toLowerCase()) || null;
      if (!product) reviewNote = `Spreadsheet product "${rawName.slice(0, 200)}" was not found in Products.`;
    }
    if (reviewNote) result.flagged.push({ row: rowNo, name: data.name, reason: reviewNote });

    const { score, category } = scoreLead(data);
    const ins = await run(
      `INSERT INTO leads (workspace_id, name, email, phone, company_name, country, address, estimated_budget, notes, status, product_id, product_interest,
         product_review_note, ai_score, ai_category, created_by_user_id, owner_user_id, lead_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [workspaceId, data.name, data.email, data.phone, data.company_name, data.country, data.address, data.estimated_budget, data.notes, data.status || 'Imported',
        product?.id || null, product?.name || rawName || data.product_interest || null, reviewNote, score, category, own.created_by_user_id, own.owner_user_id, own.lead_source]
    );
    if (data.email && !existingEmails.has(data.email.toLowerCase())) existingEmails.set(data.email.toLowerCase(), ins.lastID);
    result.imported += 1;
    result.leadIds.push(ins.lastID);
    await automationEvents.emit(workspaceId, 'lead.created', { subjectType: 'lead', subjectId: ins.lastID, payload: { source: 'import', status: data.status || 'Imported' }, key: `lead.created:${ins.lastID}` });
  }
  await audit(ctx, 'leads.imported', { resourceType: 'lead', metadata: { imported: result.imported, ownerUserId: own.owner_user_id, leadIds: result.leadIds.slice(0, 1000), skipped: result.skipped.length, flagged: result.flagged.length, duplicates: result.duplicates.length } });
  return result;
}

// ---------- AI advice (never canned) ----------
function productFacts(product) {
  if (!product) return null;
  const p = presentProduct(product);
  return { name: p.name, url: p.url, tagline: p.tagline, description: p.description, features: p.features.slice(0, 8), target_audience: p.targetAudience };
}

/** Recomputes the rule-based score and asks a real AI model for advice; never stores canned text. */
async function generateAdvice(ctx, id) {
  const workspaceId = ctx.auth.workspaceId;
  const row = await requireLeadFor(ctx, id, 'manage');
  const { score, category } = scoreLead(row);
  await run('UPDATE leads SET ai_score = ?, ai_category = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?', [score, category, workspaceId, row.id]);
  const product = row.product_id ? await get('SELECT * FROM digital_products WHERE workspace_id = ? AND id = ?', [workspaceId, row.product_id]) : null;
  const facts = productFacts(product);
  const prompt = `Lead (rule-based score ${score}/100, ${category}):
${untrusted('lead_record', JSON.stringify({ name: row.name, company: row.company_name, has_email: isValidEmail(row.email), has_phone: !!row.phone, budget: row.estimated_budget, status: row.status, notes: row.notes }), 2000)}
${facts
    ? `Product the lead is interested in (use only these facts):\n${untrusted('product_facts', JSON.stringify(facts), 3000)}`
    : 'No product is selected for this lead. Do not recommend or name any specific product; give general next steps to qualify their need.'}
Give 1–2 concrete next actions to advance this lead. Do not invent prices, discounts, statistics or customer results.`;
  try {
    const { text } = await generateText({
      workspaceId,
      prompt,
      system: 'You are a B2B sales coach. Be concise and practical.',
      referenceType: 'lead',
      referenceId: row.id,
      maxTokens: 220,
      excludeProviders: LEADS_AI_EXCLUDE
    });
    if (!text) throw new AiUnavailableError('Empty AI response.');
    await run("UPDATE leads SET ai_suggestion = ?, ai_status = 'ok', ai_suggested_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?", [text.slice(0, 2000), workspaceId, row.id]);
    return { available: true };
  } catch (err) {
    if (!(err instanceof AiUnavailableError) && err.code !== 'QUOTA_EXCEEDED') throw err;
    // Keep any earlier genuine advice; just record that this attempt had no AI.
    await run("UPDATE leads SET ai_status = 'unavailable' WHERE workspace_id = ? AND id = ?", [workspaceId, row.id]);
    return { available: false, reason: err.code === 'QUOTA_EXCEEDED' ? 'Monthly AI limit reached.' : 'AI unavailable' };
  }
}

async function qualifyAll(ctx, { productId } = {}) {
  const workspaceId = ctx.auth.workspaceId;
  const params = [workspaceId];
  let filter = '';
  if (productId) {
    await requireWorkspaceProduct(workspaceId, productId);
    filter = ' AND l.product_id = ?';
    params.push(Number(productId));
  }
  // Only leads this person may manage (Owners/Admins: all; others: owned or shared to manage).
  if (!leadAccess.isLeadAdmin(ctx)) {
    filter += " AND (l.owner_user_id = ? OR EXISTS (SELECT 1 FROM lead_user_access a WHERE a.lead_id = l.id AND a.user_id = ? AND a.access_level = 'manage'))";
    params.push(Number(ctx.auth.userId) || 0, Number(ctx.auth.userId) || 0);
  }
  const rows = await all(`SELECT l.id FROM leads l WHERE l.workspace_id = ?${filter} ORDER BY COALESCE(l.ai_suggested_at, '1970-01-01') ASC, l.id DESC LIMIT ${MAX_QUALIFY_BATCH}`, params);
  let advised = 0;
  let unavailable = 0;
  for (const r of rows) {
    const res = await generateAdvice(ctx, r.id);
    if (res.available) advised += 1;
    else {
      unavailable += 1;
      // Without AI there is no point trying the rest; scores are still refreshed below.
      break;
    }
  }
  // Rule-based scores are refreshed for every lead in scope (cheap, no AI).
  const all_ = await all(`SELECT l.* FROM leads l WHERE l.workspace_id = ?${filter}`, params);
  for (const l of all_) {
    const { score, category } = scoreLead(l);
    await run('UPDATE leads SET ai_score = ?, ai_category = ? WHERE workspace_id = ? AND id = ?', [score, category, workspaceId, l.id]);
  }
  return { scored: all_.length, advised, aiAvailable: unavailable === 0, batchLimit: MAX_QUALIFY_BATCH };
}

// ---------- Email draft from real product facts ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function emailDraft(ctx, id) {
  const workspaceId = ctx.auth.workspaceId;
  const row = await requireLeadFor(ctx, id, 'view');
  if (!isValidEmail(row.email)) throw httpError(400, 'This lead has no valid email address. Add one before drafting an email.', 'NO_VALID_EMAIL');
  const product = row.product_id ? presentProduct(await get('SELECT * FROM digital_products WHERE workspace_id = ? AND id = ?', [workspaceId, row.product_id])) : null;
  const firstName = String(row.name).split(/\s+/)[0];
  const who = row.company_name ? ` at ${row.company_name}` : '';
  let subject;
  let lines;
  if (product) {
    subject = `${product.name}${row.company_name ? ` for ${row.company_name}` : ''}`;
    lines = [
      `Hi ${firstName},`,
      `Thank you for your interest in ${product.name}.${product.tagline ? ` ${product.tagline}.` : ''}`,
      product.description ? product.description : null,
      product.features.length ? `A few things it does:\n${product.features.slice(0, 3).map(f => `• ${f}`).join('\n')}` : null,
      `Would you have 15 minutes this week to see whether it fits your team${who}?`,
      product.url ? `More details: ${product.url}` : null,
      'Best regards,'
    ].filter(Boolean);
  } else {
    subject = `Following up${row.company_name ? ` — ${row.company_name}` : ''}`;
    lines = [
      `Hi ${firstName},`,
      `Thank you for getting in touch. I'd like to understand what you are looking for${who} so I can point you to the right solution.`,
      'Would you have 15 minutes this week for a short call?',
      'Best regards,'
    ];
  }
  const body = lines.join('\n\n').replace(/\.\./g, '.');
  const html = `<div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b; line-height: 1.6; font-size: 15px;">
${lines.map(l => (l.startsWith('A few things it does:')
    ? `<p style="margin: 0 0 12px;">A few things it does:</p><ul style="margin: 0 0 14px; padding-left: 20px;">${product.features.slice(0, 3).map(f => `<li>${esc(f)}</li>`).join('')}</ul>`
    : `<p style="margin: 0 0 14px;">${esc(l).replace(/\n/g, '<br>')}</p>`)).join('\n')}
</div>`;
  return { to: row.email, recipientName: row.name, subject, body, html, productId: product?.id || null, productName: product?.name || null };
}

module.exports = {
  leadCountries,
  STATUSES,
  exportLeads,
  LEADS_AI_EXCLUDE,
  parseBudget,
  scoreLead,
  isValidEmail,
  listProducts,
  requireWorkspaceProduct,
  listLeads,
  requireLead,
  requireLeadFor,
  OWNERSHIP_VIEWS,
  createLead,
  updateLead,
  deleteLead,
  importLeads,
  generateAdvice,
  qualifyAll,
  emailDraft,
  present
};
