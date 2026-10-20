const express = require('express');
const { z } = require('zod');
const { run, get, all } = require('../../db/database');
const { requireCapability } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');
const websiteExtractor = require('../../services/websiteExtractor');

/**
 * Workspace-scoped Digital Products API. Mounted at /api/v1/products and /api/products.
 * The workspace always comes from the authenticated session; single-product operations
 * verify ownership first and return 404 for products in other workspaces.
 */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ws = req => req.auth.workspaceId;

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

function parseJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}

/** Same shape the Products screen already uses. */
function present(p) {
  return { ...p, features: parseJson(p.features_json, []), pricing: parseJson(p.pricing_tiers_json, []) };
}

async function requireProduct(workspaceId, id) {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) {
    const err = new Error('Invalid product id.');
    err.status = 400;
    throw err;
  }
  const p = await get('SELECT * FROM digital_products WHERE workspace_id = ? AND id = ?', [workspaceId, pid]);
  if (!p) {
    const err = new Error('Product not found.');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  return p;
}

// Over-long values (e.g. from AI website extraction) are trimmed to the column limits, not rejected.
const text = max => z.string().transform(v => v.slice(0, max)).nullable().optional();
const fields = {
  name: z.string().trim().min(1).transform(v => v.slice(0, 255)),
  url: text(255),
  tagline: text(255),
  description: text(5000),
  features: z.array(z.union([z.string(), z.number()]).transform(v => String(v).slice(0, 500))).transform(a => a.slice(0, 50)).optional(),
  target_audience: text(2000),
  pricing: z.array(z.any()).transform(a => a.slice(0, 20)).optional(),
  status: z.enum(['Active', 'Inactive']).optional()
};

router.use((req, res, next) => {
  if (!req.auth) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
  next();
});

// Website feature extraction (reads a public page through the SSRF-safe fetcher; stores nothing).
router.post('/extract-url', requireCapability('campaigns.manage'), body(z.object({ url: z.string().min(4).max(500) })), wrap(async (req, res) => {
  try {
    const { product } = await websiteExtractor.extractFromUrl(req.valid.url);
    res.json({ success: true, product });
  } catch (err) {
    if (err.code === 'UNSAFE_URL') return res.status(400).json({ success: false, error: err.message, code: err.code });
    throw err;
  }
}));

router.get('/', wrap(async (req, res) => {
  const list = await all('SELECT * FROM digital_products WHERE workspace_id = ? ORDER BY id ASC', [ws(req)]);
  res.json({ success: true, products: list.map(present) });
}));

router.get('/:id', wrap(async (req, res) => {
  res.json({ success: true, product: present(await requireProduct(ws(req), req.params.id)) });
}));

router.post('/', requireCapability('campaigns.manage'), body(z.object(fields)), wrap(async (req, res) => {
  const v = req.valid;
  const result = await run(
    `INSERT INTO digital_products (workspace_id, name, url, tagline, description, features_json, target_audience, pricing_tiers_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [ws(req), v.name.trim(), v.url || '', v.tagline || null, v.description || null, JSON.stringify(v.features || []),
      v.target_audience || null, JSON.stringify(v.pricing || []), v.status || 'Active']
  );
  await audit(req, 'products.created', { resourceType: 'product', resourceId: result.lastID, metadata: { name: v.name } });
  res.json({ success: true, productId: result.lastID, message: `Digital product "${v.name}" successfully registered.` });
}));

router.patch('/:id', requireCapability('campaigns.manage'), body(z.object(Object.fromEntries(Object.entries(fields).map(([k, s]) => [k, s.optional()])))), wrap(async (req, res) => {
  const p = await requireProduct(ws(req), req.params.id);
  const v = req.valid;
  const map = { name: 'name', url: 'url', tagline: 'tagline', description: 'description', target_audience: 'target_audience', status: 'status' };
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(map)) if (v[k] !== undefined) { sets.push(`${col} = ?`); params.push(v[k]); }
  if (v.features !== undefined) { sets.push('features_json = ?'); params.push(JSON.stringify(v.features)); }
  if (v.pricing !== undefined) { sets.push('pricing_tiers_json = ?'); params.push(JSON.stringify(v.pricing)); }
  if (sets.length) {
    await run(`UPDATE digital_products SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`, [...params, ws(req), p.id]);
    await audit(req, 'products.updated', { resourceType: 'product', resourceId: p.id, metadata: { fields: Object.keys(v) } });
  }
  res.json({ success: true, product: present(await requireProduct(ws(req), p.id)) });
}));

router.delete('/:id', requireCapability('campaigns.manage'), wrap(async (req, res) => {
  const p = await requireProduct(ws(req), req.params.id);
  const leads = await get('SELECT COUNT(*) AS c FROM leads WHERE workspace_id = ? AND product_id = ?', [ws(req), p.id]);
  const campaigns = await get('SELECT COUNT(*) AS c FROM campaigns WHERE workspace_id = ? AND product_id = ?', [ws(req), p.id]);
  await run('DELETE FROM digital_products WHERE workspace_id = ? AND id = ?', [ws(req), p.id]);
  // Linked leads keep their history and show "Product removed" until a new product is chosen.
  await audit(req, 'products.deleted', { resourceType: 'product', resourceId: p.id, metadata: { name: p.name, linkedLeads: Number(leads.c), linkedCampaigns: Number(campaigns.c) } });
  res.json({
    success: true,
    message: 'Digital product deleted',
    linkedLeads: Number(leads.c),
    linkedCampaigns: Number(campaigns.c)
  });
}));

module.exports = router;
