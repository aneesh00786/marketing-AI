const { z } = require('zod');
const { get, withTransaction } = require('../../db/database');

/**
 * Business profile of the signed-in workspace (business_profiles). The workspace always comes from
 * the server-side session, never from the request. business_profiles has no unique key on
 * workspace_id, so the newest row is the profile (as the Social module reads it), and creating a
 * missing one is serialized by locking the workspace row.
 */
const ws = ctx => ctx.auth.workspaceId;

const updateSchema = z.object({
  businessName: z.string().trim().min(1, 'Enter the business name.').max(255).optional(),
  industry: z.string().trim().max(150).nullable().optional(),
  websiteUrl: z.string().trim().max(255).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  brandVoice: z.string().trim().max(255).nullable().optional(),
  products: z.array(z.any()).max(100).optional()
}).strict();

const COLUMNS = {
  businessName: 'business_name',
  industry: 'industry',
  websiteUrl: 'website_url',
  description: 'description',
  brandVoice: 'brand_voice',
  products: 'products_json'
};

function present(row) {
  if (!row) return null;
  let products = [];
  try { products = JSON.parse(row.products_json || '[]'); } catch (e) { products = []; }
  return { ...row, products };
}

const latestProfile = (db, workspaceId) =>
  db.get('SELECT * FROM business_profiles WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [workspaceId]);

async function getProfile(ctx) {
  const workspace = await get('SELECT id, name, slug, owner_email, plan, status, timezone, created_at FROM workspaces WHERE id = ?', [ws(ctx)]);
  const profile = await latestProfile({ get }, ws(ctx));
  return { workspace, businessProfile: present(profile) };
}

/** Updates the given fields; creates the profile when the workspace has none (name required then). */
async function updateProfile(ctx, input) {
  const v = updateSchema.parse(input || {});
  const fields = Object.keys(v);
  if (!fields.length) {
    throw Object.assign(new Error('Nothing to update.'), { status: 400, code: 'VALIDATION_ERROR' });
  }
  const value = k => (k === 'products' ? JSON.stringify(v.products) : (v[k] === '' ? null : v[k]));

  return withTransaction(async tx => {
    // Serializes concurrent create/update of this workspace's profile.
    await tx.get('SELECT id FROM workspaces WHERE id = ? FOR UPDATE', [ws(ctx)]);
    const existing = await latestProfile(tx, ws(ctx));
    if (existing) {
      await tx.run(
        `UPDATE business_profiles SET ${fields.map(k => `${COLUMNS[k]} = ?`).join(', ')} WHERE id = ? AND workspace_id = ?`,
        [...fields.map(value), existing.id, ws(ctx)]
      );
      return { created: false, fields, profile: present(await latestProfile(tx, ws(ctx))) };
    }
    if (!v.businessName) {
      throw Object.assign(new Error('Enter the business name to create the business profile.'), { status: 400, code: 'VALIDATION_ERROR' });
    }
    await tx.run(
      `INSERT INTO business_profiles (workspace_id, ${fields.map(k => COLUMNS[k]).join(', ')}, created_at)
       VALUES (?, ${fields.map(() => '?').join(', ')}, UTC_TIMESTAMP())`,
      [ws(ctx), ...fields.map(value)]
    );
    return { created: true, fields, profile: present(await latestProfile(tx, ws(ctx))) };
  });
}

module.exports = { getProfile, updateProfile };
