const { z } = require('zod');
const { run, get, all, withTransaction: transaction } = require('../../../db/database');
const { audit } = require('../../../lib/audit');

/**
 * Brand Kits: a workspace's brand (logo, colours, fonts, voice, guidelines, product and reference
 * images). The default kit is applied to every AI generation unless another of the workspace's
 * kits is chosen. Images are ids of the workspace's own media library assets, checked on save and
 * again on use, so another workspace's files can never be referenced.
 */
const ws = ctx => ctx.auth.workspaceId;
const httpError = (status, message, code) => Object.assign(new Error(message), { status, code, expose: true });
const parseIds = v => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.filter(Number.isInteger) : []; } catch { return []; } };
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colours are hex values like #1E40AF.').nullable().optional();

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  isDefault: z.boolean().optional(),
  companyName: z.string().trim().max(200).nullable().optional(),
  logoAssetId: z.number().int().positive().nullable().optional(),
  website: z.string().trim().max(500).nullable().optional(),
  contactInfo: z.string().trim().max(500).nullable().optional(),
  primaryColor: color,
  secondaryColor: color,
  fonts: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(3000).nullable().optional(),
  guidelines: z.string().trim().max(5000).nullable().optional(),
  tone: z.string().trim().max(200).nullable().optional(),
  productAssetIds: z.array(z.number().int().positive()).max(30).optional(),
  referenceAssetIds: z.array(z.number().int().positive()).max(30).optional()
}).strict();

async function assetsOf(workspaceId, ids) {
  if (!ids.length) return [];
  return all(`SELECT id, public_id, asset_type, mime_type, title, width, height FROM assets
    WHERE workspace_id = ? AND status = 'ready' AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, [workspaceId, ...ids]);
}

async function assertImages(workspaceId, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const found = await assetsOf(workspaceId, unique);
  if (found.length !== unique.length || found.some(a => a.asset_type !== 'image')) throw httpError(400, 'Brand images must be images from this workspace\'s media library.', 'VALIDATION_ERROR');
}

function present(r, assets = new Map()) {
  const media = require('../mediaStore');
  const a = id => (assets.get(id) ? { id, url: media.publicUrlFor(assets.get(id).public_id), title: assets.get(id).title } : null);
  return {
    id: r.id, name: r.name, isDefault: !!r.is_default, companyName: r.company_name, logoAssetId: r.logo_asset_id, logo: a(r.logo_asset_id),
    website: r.website, contactInfo: r.contact_info, primaryColor: r.primary_color, secondaryColor: r.secondary_color, fonts: r.fonts,
    description: r.description, guidelines: r.guidelines, tone: r.tone,
    productAssetIds: parseIds(r.product_asset_ids_json), referenceAssetIds: parseIds(r.reference_asset_ids_json),
    productImages: parseIds(r.product_asset_ids_json).map(a).filter(Boolean), referenceImages: parseIds(r.reference_asset_ids_json).map(a).filter(Boolean),
    updatedAt: r.updated_at || r.created_at
  };
}

async function withAssets(workspaceId, rows) {
  const ids = rows.flatMap(r => [r.logo_asset_id, ...parseIds(r.product_asset_ids_json), ...parseIds(r.reference_asset_ids_json)]).filter(Boolean);
  const assets = new Map((await assetsOf(workspaceId, [...new Set(ids)])).map(a => [a.id, a]));
  return rows.map(r => present(r, assets));
}

async function list(ctx) {
  const rows = await all('SELECT * FROM social_brand_kits WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, name', [ws(ctx)]);
  return withAssets(ws(ctx), rows);
}

async function requireRow(workspaceId, id) {
  const r = await get('SELECT * FROM social_brand_kits WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL', [workspaceId, id]);
  if (!r) throw httpError(404, 'Brand kit not found.', 'NOT_FOUND');
  return r;
}

function columns(v) {
  const c = {};
  const map = { companyName: 'company_name', logoAssetId: 'logo_asset_id', website: 'website', contactInfo: 'contact_info', primaryColor: 'primary_color', secondaryColor: 'secondary_color', fonts: 'fonts', description: 'description', guidelines: 'guidelines', tone: 'tone', name: 'name' };
  for (const [k, col] of Object.entries(map)) if (v[k] !== undefined) c[col] = v[k] === '' ? null : v[k];
  if (v.productAssetIds !== undefined) c.product_asset_ids_json = JSON.stringify(v.productAssetIds);
  if (v.referenceAssetIds !== undefined) c.reference_asset_ids_json = JSON.stringify(v.referenceAssetIds);
  if (c.website && !/^https?:\/\//i.test(c.website)) c.website = `https://${c.website}`;
  return c;
}

async function save(ctx, id, input) {
  const v = (id ? schema.partial() : schema).parse(input || {});
  await assertImages(ws(ctx), [v.logoAssetId, ...(v.productAssetIds || []), ...(v.referenceAssetIds || [])]);
  const c = columns(v);
  const dupe = c.name ? await get('SELECT id FROM social_brand_kits WHERE workspace_id = ? AND name = ? AND deleted_at IS NULL AND id <> ?', [ws(ctx), c.name, id || 0]) : null;
  if (dupe) throw httpError(409, 'A brand kit with this name already exists.', 'DUPLICATE');
  let kitId = id;
  await transaction(async tx => {
    const first = !(await tx.get('SELECT id FROM social_brand_kits WHERE workspace_id = ? AND deleted_at IS NULL LIMIT 1', [ws(ctx)]));
    if (id) {
      await requireRow(ws(ctx), id);
      const keys = Object.keys(c);
      if (keys.length) await tx.run(`UPDATE social_brand_kits SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?`, [...keys.map(k => c[k]), ws(ctx), id]);
    } else {
      const keys = Object.keys(c);
      const ins = await tx.run(`INSERT INTO social_brand_kits (workspace_id, ${keys.join(', ')}, is_default, created_by, created_at, updated_at)
        VALUES (?, ${keys.map(() => '?').join(', ')}, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [ws(ctx), ...keys.map(k => c[k]), first ? 1 : 0, ctx.auth.userId || null]);
      kitId = ins.lastID;
    }
    if (v.isDefault) {
      await tx.run('UPDATE social_brand_kits SET is_default = (id = ?) WHERE workspace_id = ? AND deleted_at IS NULL', [kitId, ws(ctx)]);
    }
  });
  await audit(ctx, id ? 'social.brand_kit.updated' : 'social.brand_kit.created', { resourceType: 'social_brand_kit', resourceId: kitId });
  return (await withAssets(ws(ctx), [await requireRow(ws(ctx), kitId)]))[0];
}

async function remove(ctx, id) {
  const r = await requireRow(ws(ctx), id);
  await run('UPDATE social_brand_kits SET deleted_at = UTC_TIMESTAMP(), is_default = 0 WHERE workspace_id = ? AND id = ?', [ws(ctx), id]);
  if (r.is_default) await run('UPDATE social_brand_kits SET is_default = 1 WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [ws(ctx)]);
  await audit(ctx, 'social.brand_kit.deleted', { resourceType: 'social_brand_kit', resourceId: id });
  return { deleted: true };
}

/** The kit for a generation: the chosen one (this workspace's), else the default, else none. */
async function resolve(workspaceId, brandKitId = null) {
  const r = brandKitId
    ? await get('SELECT * FROM social_brand_kits WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL', [workspaceId, brandKitId])
    : await get('SELECT * FROM social_brand_kits WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, id LIMIT 1', [workspaceId]);
  if (brandKitId && !r) throw httpError(404, 'Brand kit not found.', 'NOT_FOUND');
  return r ? (await withAssets(workspaceId, [r]))[0] : null;
}

/** The brand as text for AI prompts (data, not instructions). */
function promptText(kit) {
  if (!kit) return 'No brand kit is set up: use a clean, professional style.';
  return [
    kit.companyName && `Company: ${kit.companyName}`, kit.website && `Website: ${kit.website}`, kit.contactInfo && `Contact: ${kit.contactInfo}`,
    kit.primaryColor && `Primary colour: ${kit.primaryColor}`, kit.secondaryColor && `Secondary colour: ${kit.secondaryColor}`,
    kit.fonts && `Fonts: ${kit.fonts}`, kit.tone && `Tone of voice: ${kit.tone}`,
    kit.description && `About the brand: ${kit.description}`, kit.guidelines && `Brand guidelines: ${kit.guidelines}`
  ].filter(Boolean).join('\n');
}

module.exports = { list, save, remove, resolve, promptText };
