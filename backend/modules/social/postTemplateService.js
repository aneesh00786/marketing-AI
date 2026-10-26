const { run, get, all } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { httpError, splitHashtags } = require('./contentService');

/** Reusable captions / post templates for the composer. Workspace-scoped; never published directly. */
function present(r) {
  return {
    id: r.id,
    name: r.name,
    caption: r.caption || '',
    hashtags: splitHashtags(r.hashtags),
    callToAction: r.call_to_action || '',
    linkUrl: r.link_url || '',
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function columns(input) {
  const cols = {};
  if (input.name !== undefined) cols.name = String(input.name).trim().slice(0, 150);
  if (input.caption !== undefined) cols.caption = input.caption || null;
  if (input.hashtags !== undefined) cols.hashtags = splitHashtags(input.hashtags).join(' ') || null;
  if (input.callToAction !== undefined) cols.call_to_action = input.callToAction || null;
  if (input.linkUrl !== undefined) {
    if (input.linkUrl && !/^https?:\/\//i.test(input.linkUrl)) throw httpError(400, 'Link URL must be a valid http(s) URL.');
    cols.link_url = input.linkUrl || null;
  }
  return cols;
}

async function requireRow(workspaceId, id) {
  const r = await get('SELECT * FROM social_post_templates WHERE workspace_id = ? AND id = ?', [workspaceId, id]);
  if (!r) throw httpError(404, 'Template not found.', 'NOT_FOUND');
  return r;
}

async function list(workspaceId) {
  return (await all('SELECT * FROM social_post_templates WHERE workspace_id = ? ORDER BY name LIMIT 300', [workspaceId])).map(present);
}

async function create(ctx, input) {
  const cols = columns(input);
  if (!cols.name) throw httpError(400, 'Give the template a name.');
  const names = Object.keys(cols);
  const ins = await run(
    `INSERT INTO social_post_templates (workspace_id, ${names.join(', ')}, created_by, updated_by, created_at, updated_at)
     VALUES (?, ${names.map(() => '?').join(', ')}, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ctx.auth.workspaceId, ...Object.values(cols), ctx.auth.userId || null, ctx.auth.userId || null]
  );
  await audit(ctx, 'social.template.created', { resourceType: 'social_template', resourceId: ins.lastID, metadata: { name: cols.name } });
  return present(await requireRow(ctx.auth.workspaceId, ins.lastID));
}

async function update(ctx, id, input) {
  await requireRow(ctx.auth.workspaceId, id);
  const cols = columns(input);
  if (cols.name === '') throw httpError(400, 'Give the template a name.');
  const names = Object.keys(cols);
  if (names.length) {
    await run(
      `UPDATE social_post_templates SET ${names.map(n => `${n} = ?`).join(', ')}, updated_by = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?`,
      [...Object.values(cols), ctx.auth.userId || null, ctx.auth.workspaceId, id]
    );
    await audit(ctx, 'social.template.updated', { resourceType: 'social_template', resourceId: id, metadata: { fields: names } });
  }
  return present(await requireRow(ctx.auth.workspaceId, id));
}

async function remove(ctx, id) {
  await requireRow(ctx.auth.workspaceId, id);
  await run('DELETE FROM social_post_templates WHERE workspace_id = ? AND id = ?', [ctx.auth.workspaceId, id]);
  await audit(ctx, 'social.template.deleted', { resourceType: 'social_template', resourceId: id });
  return { deleted: true };
}

module.exports = { list, create, update, remove };
