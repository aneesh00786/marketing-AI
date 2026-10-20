const { z } = require('zod');
const { run, get, all } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { capabilitiesForRole } = require('../../lib/permissions');

/**
 * Automation workflows: trigger → conditions → steps (wait / check / action).
 * Definitions are validated against a fixed whitelist. Activating a workflow is an explicit
 * approval: it needs confirm: true and the permissions of every action it contains (an
 * enrolment action needs mail.send because it can lead to emails being sent). Any edit sets
 * the workflow back to draft, so it must be approved again. Runs execute as the activating
 * user, whose permissions are re-checked at every step.
 */
const TRIGGERS = {
  'lead.created': { subject: 'lead', label: 'A lead is created (form, API or import)', config: ['productId'] },
  'lead.status_changed': { subject: 'lead', label: 'A lead changes status', config: ['toStatus'] },
  'email.replied': { subject: 'lead', label: 'A lead replies to an email sequence', config: ['emailCampaignId'] },
  'email.unsubscribed': { subject: 'lead', label: 'A lead unsubscribes from an email sequence', config: ['emailCampaignId'] },
  'email.sequence_completed': { subject: 'lead', label: 'A lead finishes an email sequence without replying', config: ['emailCampaignId'] },
  'social.post_published': { subject: 'content', label: 'A social post is published', config: ['socialCampaignId'] }
};

const CONDITION_FIELDS = {
  status: { ops: ['eq', 'neq', 'in'], type: 'string', label: 'Lead status' },
  score: { ops: ['gte', 'lte'], type: 'number', label: 'Lead score' },
  product: { ops: ['eq'], type: 'id', label: 'Linked product' },
  has_valid_email: { ops: ['is'], type: 'boolean', label: 'Has a valid email address' },
  has_company: { ops: ['is'], type: 'boolean', label: 'Has a company name' },
  replied: { ops: ['is'], type: 'boolean', label: 'Has replied to any email sequence' },
  suppressed: { ops: ['is'], type: 'boolean', label: 'Is unsubscribed/bounced' }
};

// Every action: the permission it needs and whether it can reach people outside the company.
const ACTIONS = {
  update_lead_status: { subject: 'lead', capability: 'leads.manage', outbound: false, idempotent: true, label: 'Set the lead status' },
  add_lead_note: { subject: 'lead', capability: 'leads.manage', outbound: false, idempotent: false, label: 'Add a note to the lead' },
  enroll_in_sequence: { subject: 'lead', capability: 'mail.send', outbound: true, idempotent: true, label: 'Add the lead to an email sequence' },
  stop_sequences: { subject: 'lead', capability: 'mail.compose', outbound: false, idempotent: true, label: "Stop the lead's email sequences" },
  create_email_draft: { subject: 'lead', capability: 'mail.compose', outbound: true, idempotent: false, label: 'Create a Mail Draft for approval' },
  create_social_draft: { subject: 'any', capability: 'content.create', outbound: true, idempotent: false, label: 'Create a social post draft for approval' }
};

const MAX_ACTIVE = parseInt(process.env.AUTOMATION_MAX_ACTIVE_WORKFLOWS || '25', 10);
const MAX_STEPS = 12;

function httpError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

const ws = ctx => ctx.auth.workspaceId;
const parse = (v, fb) => { try { return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
const id = z.union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)]);

const conditionSchema = z.object({
  field: z.enum(Object.keys(CONDITION_FIELDS)),
  op: z.enum(['eq', 'neq', 'in', 'gte', 'lte', 'is']),
  value: z.union([z.string().max(100), z.number(), z.boolean(), z.array(z.string().max(100)).max(20)])
}).strict().superRefine((c, ctx) => {
  const f = CONDITION_FIELDS[c.field];
  if (!f.ops.includes(c.op)) ctx.addIssue({ code: 'custom', message: `${c.field} supports ${f.ops.join(', ')}` });
  if (f.type === 'boolean' && typeof c.value !== 'boolean') ctx.addIssue({ code: 'custom', message: `${c.field} needs true or false` });
  if ((f.type === 'number' || f.type === 'id') && typeof c.value !== 'number') ctx.addIssue({ code: 'custom', message: `${c.field} needs a number` });
  if (c.op === 'in' && !Array.isArray(c.value)) ctx.addIssue({ code: 'custom', message: 'in needs a list' });
});

const actionParams = {
  update_lead_status: z.object({ status: z.string().min(1).max(50) }).strict(),
  add_lead_note: z.object({ text: z.string().trim().min(1).max(1000) }).strict(),
  enroll_in_sequence: z.object({ emailCampaignId: id }).strict(),
  stop_sequences: z.object({ emailCampaignId: id.optional().nullable() }).strict(),
  create_email_draft: z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(5000) }).strict(),
  create_social_draft: z.object({ platformKey: z.enum(['facebook', 'instagram', 'linkedin', 'youtube', 'x']), caption: z.string().trim().min(1).max(5000), socialCampaignId: id.optional().nullable() }).strict()
};

const stepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('wait'), hours: z.number().min(0.25).max(24 * 60) }).strict(),
  z.object({ type: z.literal('check'), conditions: z.array(conditionSchema).min(1).max(10) }).strict(),
  z.object({ type: z.literal('action'), action: z.enum(Object.keys(ACTIONS)), params: z.record(z.any()) }).strict()
]);

const workflowSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(1000).optional().nullable(),
  // Unknown trigger keys (e.g. the display label returned by GET) are ignored; config keys are checked below.
  trigger: z.object({ type: z.enum(Object.keys(TRIGGERS)), config: z.record(z.any()).optional() }).strip(),
  conditions: z.array(conditionSchema).max(10).optional(),
  steps: z.array(stepSchema).min(1).max(MAX_STEPS),
  exitOnReply: z.boolean().optional(),
  maxRunsPerDay: z.number().int().min(1).max(5000).optional()
}).strict();

const TOKENS = ['first_name', 'company', 'lead_name', 'post_title'];
const unknownTokens = text => [...String(text).matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map(m => m[1].toLowerCase()).filter(t => !TOKENS.includes(t));

/** Validates the definition and every referenced record against the caller's workspace. */
async function validateDefinition(ctx, input) {
  const v = workflowSchema.parse(input);
  const trig = TRIGGERS[v.trigger.type];
  const cfg = v.trigger.config || {};
  for (const k of Object.keys(cfg)) if (!trig.config.includes(k)) throw httpError(`Trigger ${v.trigger.type} has no option "${k}".`, 400, 'VALIDATION_ERROR');
  if (cfg.productId && !(await get('SELECT id FROM digital_products WHERE workspace_id = ? AND id = ?', [ws(ctx), Number(cfg.productId)]))) throw httpError('Product not found in this workspace.', 404, 'NOT_FOUND');
  if (cfg.emailCampaignId && !(await get('SELECT id FROM outreach_campaigns WHERE workspace_id = ? AND id = ?', [ws(ctx), Number(cfg.emailCampaignId)]))) throw httpError('Email sequence not found in this workspace.', 404, 'NOT_FOUND');
  if (cfg.socialCampaignId && !(await get('SELECT id FROM campaigns WHERE workspace_id = ? AND id = ?', [ws(ctx), Number(cfg.socialCampaignId)]))) throw httpError('Social campaign not found in this workspace.', 404, 'NOT_FOUND');
  if (trig.subject !== 'lead' && (v.conditions || []).length) throw httpError('Lead conditions need a lead trigger.', 400, 'VALIDATION_ERROR');

  const steps = [];
  for (const [i, s] of v.steps.entries()) {
    if (s.type === 'check' && trig.subject !== 'lead') throw httpError(`Step ${i + 1}: lead checks need a lead trigger.`, 400, 'VALIDATION_ERROR');
    if (s.type !== 'action') { steps.push(s); continue; }
    const def = ACTIONS[s.action];
    if (def.subject === 'lead' && trig.subject !== 'lead') throw httpError(`Step ${i + 1}: "${def.label}" needs a lead trigger.`, 400, 'VALIDATION_ERROR');
    const params = actionParams[s.action].parse(s.params || {});
    for (const text of [params.subject, params.body, params.caption, params.text].filter(Boolean)) {
      const bad = unknownTokens(text);
      if (bad.length) throw httpError(`Step ${i + 1}: unknown placeholder(s) ${bad.map(t => `{{${t}}}`).join(', ')}. Use ${TOKENS.map(t => `{{${t}}}`).join(', ')}.`, 400, 'VALIDATION_ERROR');
    }
    if (params.emailCampaignId && !(await get('SELECT id FROM outreach_campaigns WHERE workspace_id = ? AND id = ?', [ws(ctx), Number(params.emailCampaignId)]))) throw httpError(`Step ${i + 1}: email sequence not found in this workspace.`, 404, 'NOT_FOUND');
    if (params.socialCampaignId && !(await get('SELECT id FROM campaigns WHERE workspace_id = ? AND id = ?', [ws(ctx), Number(params.socialCampaignId)]))) throw httpError(`Step ${i + 1}: social campaign not found in this workspace.`, 404, 'NOT_FOUND');
    if (s.action === 'update_lead_status') {
      const { STATUSES } = require('../leads/leadService');
      if (!STATUSES.includes(params.status)) throw httpError(`Step ${i + 1}: status must be one of ${STATUSES.join(', ')}.`, 400, 'VALIDATION_ERROR');
    }
    steps.push({ type: 'action', action: s.action, params });
  }
  if (!steps.some(s => s.type === 'action')) throw httpError('A workflow needs at least one action.', 400, 'VALIDATION_ERROR');
  return { ...v, trigger: { type: v.trigger.type, config: cfg }, steps };
}

function requiredCapabilities(steps) {
  return [...new Set(steps.filter(s => s.type === 'action').map(s => ACTIONS[s.action].capability))];
}

function present(w) {
  const steps = parse(w.steps_json, []);
  return {
    id: w.id, name: w.name, description: w.description,
    trigger: { type: w.trigger_type, config: parse(w.trigger_config_json, {}), label: TRIGGERS[w.trigger_type]?.label },
    conditions: parse(w.conditions_json, []), steps,
    exitOnReply: !!w.exit_on_reply, maxRunsPerDay: w.max_runs_per_day,
    status: w.status, version: w.version, activatedAt: w.activated_at, activatedBy: w.activated_by,
    requiredCapabilities: requiredCapabilities(steps),
    outboundActions: steps.filter(s => s.type === 'action' && ACTIONS[s.action].outbound).map(s => ACTIONS[s.action].label),
    createdAt: w.created_at, updatedAt: w.updated_at
  };
}

async function requireWorkflow(ctx, rawId) {
  const wid = Number(rawId);
  if (!Number.isInteger(wid) || wid <= 0) throw httpError('Invalid workflow id.', 400, 'VALIDATION_ERROR');
  const w = await get('SELECT * FROM automation_workflows WHERE id = ? AND workspace_id = ?', [wid, ws(ctx)]);
  if (!w) throw httpError('Workflow not found', 404, 'NOT_FOUND');
  return w;
}

async function runStats(workspaceId, workflowId) {
  const rows = await all('SELECT status, COUNT(*) AS n FROM automation_runs WHERE workspace_id = ? AND workflow_id = ? GROUP BY status', [workspaceId, workflowId]);
  return Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
}

async function listWorkflows(ctx) {
  const rows = await all('SELECT * FROM automation_workflows WHERE workspace_id = ? ORDER BY id DESC LIMIT 200', [ws(ctx)]);
  const out = [];
  for (const w of rows) out.push({ ...present(w), runs: await runStats(ws(ctx), w.id) });
  return out;
}

async function getWorkflow(ctx, wid) {
  const w = await requireWorkflow(ctx, wid);
  return { ...present(w), runs: await runStats(ws(ctx), w.id) };
}

async function createWorkflow(ctx, input) {
  const v = await validateDefinition(ctx, input);
  const r = await run(
    `INSERT INTO automation_workflows (workspace_id, name, description, trigger_type, trigger_config_json, conditions_json, steps_json, exit_on_reply, max_runs_per_day, status, version, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ws(ctx), v.name, v.description || null, v.trigger.type, JSON.stringify(v.trigger.config), JSON.stringify(v.conditions || []), JSON.stringify(v.steps),
      v.exitOnReply === false ? 0 : 1, v.maxRunsPerDay ?? 200, ctx.auth.userId || null]
  );
  await audit(ctx, 'automation.workflow_created', { resourceType: 'automation_workflow', resourceId: r.lastID, metadata: { trigger: v.trigger.type } });
  return getWorkflow(ctx, r.lastID);
}

async function updateWorkflow(ctx, wid, input) {
  const w = await requireWorkflow(ctx, wid);
  const v = await validateDefinition(ctx, input);
  // Any change needs a new approval: the workflow goes back to draft and waiting runs exit on their next step.
  await run(
    `UPDATE automation_workflows SET name = ?, description = ?, trigger_type = ?, trigger_config_json = ?, conditions_json = ?, steps_json = ?, exit_on_reply = ?, max_runs_per_day = ?,
       status = 'draft', version = version + 1, activated_by = NULL, activated_at = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?`,
    [v.name, v.description || null, v.trigger.type, JSON.stringify(v.trigger.config), JSON.stringify(v.conditions || []), JSON.stringify(v.steps),
      v.exitOnReply === false ? 0 : 1, v.maxRunsPerDay ?? w.max_runs_per_day, w.id, ws(ctx)]
  );
  await audit(ctx, 'automation.workflow_updated', { resourceType: 'automation_workflow', resourceId: w.id, metadata: { previousVersion: w.version } });
  return getWorkflow(ctx, w.id);
}

async function activate(ctx, wid, input = {}) {
  const w = await requireWorkflow(ctx, wid);
  if (w.status === 'active') throw httpError('The workflow is already active.', 409, 'ALREADY_ACTIVE');
  if (input.confirm !== true) throw httpError('Explicit confirmation (confirm: true) is required to activate a workflow.', 400, 'CONFIRMATION_REQUIRED');
  const steps = parse(w.steps_json, []);
  const needed = requiredCapabilities(steps);
  const missing = needed.filter(c => !ctx.auth.capabilities.has(c));
  if (missing.length) throw httpError(`Activating this workflow needs: ${missing.join(', ')}.`, 403, 'FORBIDDEN');
  const active = await get("SELECT COUNT(*) AS n FROM automation_workflows WHERE workspace_id = ? AND status = 'active'", [ws(ctx)]);
  if (Number(active.n) >= MAX_ACTIVE) throw httpError(`At most ${MAX_ACTIVE} workflows can be active at once.`, 429, 'LIMIT_REACHED');
  // Only events recorded after this point start runs: activating never replays history.
  const last = await get('SELECT MAX(id) AS id FROM automation_events');
  await run("UPDATE automation_workflows SET status = 'active', activated_by = ?, activated_at = UTC_TIMESTAMP(), activated_version = version, activated_after_event_id = ?, updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?",
    [ctx.auth.userId || null, last && last.id ? last.id : 0, w.id, ws(ctx)]);
  await audit(ctx, 'automation.workflow_activated', { resourceType: 'automation_workflow', resourceId: w.id, metadata: { version: w.version, capabilities: needed, outbound: present(w).outboundActions } });
  return getWorkflow(ctx, w.id);
}

async function pause(ctx, wid) {
  const w = await requireWorkflow(ctx, wid);
  if (w.status !== 'active') throw httpError('Only an active workflow can be paused.', 409, 'NOT_ACTIVE');
  await run("UPDATE automation_workflows SET status = 'paused', updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?", [w.id, ws(ctx)]);
  await audit(ctx, 'automation.workflow_paused', { resourceType: 'automation_workflow', resourceId: w.id });
  return getWorkflow(ctx, w.id);
}

async function deleteWorkflow(ctx, wid) {
  const w = await requireWorkflow(ctx, wid);
  const runs = await get('SELECT COUNT(*) AS n FROM automation_runs WHERE workflow_id = ? AND workspace_id = ?', [w.id, ws(ctx)]);
  if (Number(runs.n) > 0) throw httpError('This workflow has run history; pause it instead of deleting so its audit trail is kept.', 409, 'HAS_HISTORY');
  await run('DELETE FROM automation_workflows WHERE id = ? AND workspace_id = ?', [w.id, ws(ctx)]);
  await audit(ctx, 'automation.workflow_deleted', { resourceType: 'automation_workflow', resourceId: w.id });
  return { deleted: true };
}

async function listRuns(ctx, wid, { limit = 50 } = {}) {
  const w = await requireWorkflow(ctx, wid);
  const runs = await all(`SELECT * FROM automation_runs WHERE workspace_id = ? AND workflow_id = ? ORDER BY id DESC LIMIT ${Math.min(Math.max(Number(limit) || 50, 1), 200)}`, [ws(ctx), w.id]);
  const ids = runs.map(r => r.id);
  const steps = ids.length ? await all(`SELECT * FROM automation_run_steps WHERE workspace_id = ? AND run_id IN (${ids.map(() => '?').join(',')}) ORDER BY run_id, step_index`, [ws(ctx), ...ids]) : [];
  return runs.map(r => ({
    id: r.id, status: r.status, subjectType: r.subject_type, subjectId: r.subject_id, currentStep: r.current_step, nextRunAt: r.next_run_at,
    exitReason: r.exit_reason, lastError: r.last_error, createdAt: r.created_at, finishedAt: r.finished_at, workflowVersion: r.workflow_version,
    steps: steps.filter(s => s.run_id === r.id).map(s => ({ index: s.step_index, type: s.step_type, status: s.status, attempts: s.attempts, result: parse(s.result_json, null), error: s.error, finishedAt: s.finished_at }))
  }));
}

/** The activating user's current permissions (runs stop if they lose them or leave). */
async function activatorContext(workflow) {
  if (!workflow.activated_by) return null;
  const m = await get("SELECT m.role, m.status, u.status AS user_status FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ?", [workflow.workspace_id, workflow.activated_by]);
  if (!m || m.status !== 'Active' || (m.user_status && m.user_status !== 'Active')) return null;
  return { auth: { workspaceId: workflow.workspace_id, userId: workflow.activated_by, role: m.role, capabilities: capabilitiesForRole(m.role), actorType: 'automation' } };
}

module.exports = {
  TRIGGERS, CONDITION_FIELDS, ACTIONS, TOKENS,
  listWorkflows, getWorkflow, createWorkflow, updateWorkflow, activate, pause, deleteWorkflow, listRuns,
  requiredCapabilities, activatorContext, httpError
};
