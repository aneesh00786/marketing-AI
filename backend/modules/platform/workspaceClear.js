const path = require('path');
const { z } = require('zod');
const { run, get, all } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { deleteRows, removeDir } = require('./workspaceDeletion');

/**
 * Clear data (platform admin): erases the chosen kinds of data of one workspace at once, keeping
 * the workspace itself. For test data, e.g. in the platform workspace, which cannot be deleted.
 * Always kept: the workspace, its business profile, connections and settings (email, social
 * accounts, Telnyx), Owners, and the activity log. Not undoable; the activity log records it.
 */
const OWNER = 'Workspace Owner';
const CATEGORIES = [
  { key: 'leads', label: 'Leads and AI Lead Discovery searches', count: 'leads',
    tables: ['lead_place_refs', 'lead_consent_events', 'lead_discovery_places', 'lead_discovery_runs', 'leads'] },
  { key: 'contacts', label: 'Contact lists and their contacts (Mail Center)', count: 'mail_contacts',
    tables: ['mail_lists', 'mail_contacts', 'mail_hidden_lists'] },
  { key: 'mailCampaigns', label: 'Email campaigns and their reports', count: 'mail_campaigns', calls: true,
    tables: ['mail_campaign_recipients', 'mail_campaign_contacts', 'zoho_campaign_submissions', 'mail_campaigns'] },
  { key: 'emails', label: 'Emails: Inbox, Sent Mail, drafts, product email batches and tracking', count: 'emails',
    tables: ['mail_tracked_links', 'mail_events', 'mail_message_tracking', 'mail_send_requests', 'mail_draft_batches', 'email_drafts', 'emails'] },
  { key: 'outreach', label: 'Outreach sequences and A/B tests', count: 'outreach_campaigns',
    tables: ['ab_tests', 'outreach_sends', 'outreach_step_variants', 'outreach_steps', 'outreach_recipients', 'outreach_campaigns'] },
  { key: 'programs', label: 'Command Center programs, budgets and approvals', count: 'campaign_programs',
    tables: ['budget_alerts', 'budget_revenue_entries', 'budget_spend_entries', 'budget_spend_sources', 'campaign_budgets', 'approval_requests', 'campaign_programs'] },
  { key: 'automations', label: 'Automations and their runs', count: 'automation_workflows',
    tables: ['automation_run_steps', 'automation_runs', 'automation_events', 'automation_workflows'] },
  { key: 'social', label: 'Social: AI Campaigns, posts, schedule, inbox, analytics and media', count: 'content_items', files: 'social',
    tables: ['publishing_attempts', 'publishing_jobs', 'content_versions', 'content_items', 'campaigns', 'engagement_messages', 'engagement_threads',
      'social_metric_snapshots', 'social_post_templates', 'video_jobs', 'assets'] },
  { key: 'conversations', label: 'Calls and Mark conversations (call records, chat history)', count: 'call_records',
    tables: ['conversation_messages', 'conversations', 'call_records'] },
  { key: 'legacy', label: 'Demos, tasks and older B2B data', count: 'appointments',
    tables: ['appointments', 'tasks', 'client_replies', 'b2b_clients', 'email_campaigns'] },
  { key: 'templates', label: 'Email templates and their images', count: 'mail_templates', files: 'mail',
    tables: ['mail_template_assets', 'mail_templates'] },
  { key: 'products', label: 'Digital Products', count: 'digital_products',
    tables: ['digital_products'] },
  { key: 'stopList', label: 'Unsubscribes and bounces (stop-list)', count: 'email_suppressions', warn: 'Anyone who unsubscribed could be emailed again.',
    tables: ['email_suppressions'] },
  { key: 'jobs', label: 'Background job history', count: 'background_jobs',
    tables: ['background_jobs'] },
  { key: 'members', label: 'Members other than Owners, and pending invitations', count: null, members: true, tables: [] }
];
const KEYS = CATEGORIES.map(c => c.key);

function httpError(status, message, code = 'BAD_REQUEST') {
  return Object.assign(new Error(message), { status, code, expose: true });
}
const auditIn = (ctx, workspaceId, action, opts) => audit({ auth: { ...ctx.auth, workspaceId }, requestId: ctx.requestId, ip: ctx.ip }, action, opts);

async function requireActive(rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'Invalid workspace id.', 'VALIDATION_ERROR');
  const row = await get('SELECT id, name, status FROM workspaces WHERE id = ?', [id]);
  if (!row) throw httpError(404, 'Workspace not found.', 'NOT_FOUND');
  if (row.status && row.status !== 'Active') throw httpError(409, 'This workspace is deleted.', 'WORKSPACE_DELETED');
  return row;
}

const countMembers = id => get(`SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND status = 'Active' AND role <> '${OWNER}'`, [id]).then(r => Number(r.n));

/** What can be cleared, with how many records each has now. */
async function options(ctx, rawId) {
  const row = await requireActive(rawId);
  const categories = [];
  for (const c of CATEGORIES) {
    const count = c.members ? await countMembers(row.id) : Number((await get(`SELECT COUNT(*) AS n FROM \`${c.count}\` WHERE workspace_id = ?`, [row.id])).n);
    categories.push({ key: c.key, label: c.label, count, warn: c.warn || null });
  }
  return { workspace: { id: row.id, name: row.name }, categories, kept: 'The workspace, its business profile, connections and settings (email, social accounts, Telnyx), its Owners and the activity log are always kept.' };
}

const clearSchema = z.object({
  categories: z.array(z.enum(KEYS)).min(1, 'Choose what to clear.'),
  confirmName: z.string().trim().min(1, 'Type the workspace name to confirm.').max(100)
}).strict();

async function clear(ctx, rawId, input) {
  const row = await requireActive(rawId);
  const v = clearSchema.parse(input || {});
  if (v.confirmName.toLowerCase() !== String(row.name).trim().toLowerCase()) throw httpError(400, 'The name you typed does not match the workspace name.', 'CONFIRMATION_MISMATCH');
  const chosen = CATEGORIES.filter(c => v.categories.includes(c.key));
  const cleared = {};
  // Follow-up calls are global CRM records: they keep the call, not the link to these campaigns.
  if (chosen.some(c => c.calls)) {
    await run('UPDATE crm_call_logs SET campaign_id = NULL WHERE campaign_id IN (SELECT id FROM mail_campaigns WHERE workspace_id = ?)', [row.id]);
  }
  for (const c of chosen.filter(x => !x.members)) cleared[c.key] = await deleteRows(row.id, c.tables);
  if (chosen.some(c => c.members)) {
    const gone = await all(`SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role <> '${OWNER}'`, [row.id]);
    const ids = gone.map(g => g.user_id);
    let n = 0;
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      await run(`DELETE FROM workspace_member_capability_grants WHERE workspace_id = ? AND user_id IN (${marks})`, [row.id, ...ids]);
      n = (await run(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id IN (${marks})`, [row.id, ...ids])).changes;
    }
    n += (await run("DELETE FROM workspace_invitations WHERE workspace_id = ? AND status = 'pending'", [row.id]).catch(() => ({ changes: 0 }))).changes;
    cleared.members = n;
  }
  if (chosen.some(c => c.files === 'social')) await removeDir(path.join(require('../social/mediaStore').storageRoot(), String(row.id)));
  if (chosen.some(c => c.files === 'mail')) await removeDir(path.join(require('../mail/templates/assetStore').storageRoot(), String(row.id)));
  await auditIn(ctx, row.id, 'platform.workspace_data_cleared', { resourceType: 'workspace', resourceId: row.id, metadata: { categories: v.categories, cleared } });
  return { cleared, total: Object.values(cleared).reduce((a, b) => a + b, 0) };
}

module.exports = { options, clear, CATEGORIES };
