const { run, get, all } = require('../../db/database');
const { audit } = require('../../lib/audit');
const svc = require('./automationService');
const { isValidRecipient } = require('../../services/emailService');

/**
 * Executes automation workflows (called by the worker; safe to restart).
 * - Events become at most one run per workflow (unique workflow_id + event_id). Only events
 *   after the workflow was activated are used, so turning a workflow on never replays history.
 * - Each step is recorded in automation_run_steps (unique per run + step): a finished step is
 *   never repeated. Transient failures retry with backoff; permanent ones fail the run. A
 *   non-idempotent action interrupted by a crash is flagged needs_review, not repeated.
 * - Outbound actions never reach suppressed (unsubscribed/bounced) leads, and a reply exits
 *   the run when exit_on_reply is on. Nothing here sends or publishes: enrolment only emails
 *   through an approved, running sequence; drafts wait for human approval.
 * - Events caused by an automation carry their chain, so a workflow never re-triggers itself
 *   and chains stop after MAX_DEPTH.
 */
const BACKOFF_MIN = [1, 5, 30];
const MAX_ATTEMPTS = 3;
const MAX_DEPTH = 3;
const STALE_MS = 10 * 60 * 1000;
const WORKSPACE_DAILY_LIMIT = parseInt(process.env.AUTOMATION_DAILY_RUN_LIMIT || '2000', 10);

const parse = (v, fb) => { try { return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
const dbTime = d => d.toISOString().replace('T', ' ').substring(0, 19);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------
async function leadFacts(workspaceId, lead, since = null) {
  const email = String(lead.email || '').trim().toLowerCase();
  const suppressed = email ? !!(await get('SELECT 1 AS x FROM email_suppressions WHERE workspace_id = ? AND email = ?', [workspaceId, email])) : false;
  const replyParams = [workspaceId, lead.id];
  // With `since`, only replies strictly after that moment count (the trigger's own reply is excluded).
  let replied = !!(await get(`SELECT 1 AS x FROM outreach_recipients WHERE workspace_id = ? AND lead_id = ? AND status = 'replied'${since ? ' AND updated_at > ?' : ''} LIMIT 1`, since ? [...replyParams, since] : replyParams));
  if (!replied && email) {
    const p = [workspaceId, email];
    replied = !!(await get(`SELECT 1 AS x FROM emails WHERE workspace_id = ? AND LOWER(sender_email) = ? AND smtp_status LIKE 'Received%'${since ? ' AND received_at > ?' : ''} LIMIT 1`, since ? [...p, since] : p));
  }
  return { suppressed, replied, validEmail: isValidRecipient(email) };
}

async function conditionsMet(workspaceId, lead, conditions) {
  if (!conditions || !conditions.length) return { ok: true };
  const f = await leadFacts(workspaceId, lead);
  const values = {
    status: lead.status, score: lead.ai_score === null ? null : Number(lead.ai_score), product: lead.product_id === null ? null : Number(lead.product_id),
    has_valid_email: f.validEmail, has_company: !!String(lead.company_name || '').trim(), replied: f.replied, suppressed: f.suppressed
  };
  for (const c of conditions) {
    const v = values[c.field];
    let ok;
    switch (c.op) {
      case 'eq': ok = v === c.value; break;
      case 'neq': ok = v !== c.value; break;
      case 'in': ok = Array.isArray(c.value) && c.value.includes(v); break;
      case 'gte': ok = v !== null && v >= c.value; break;
      case 'lte': ok = v !== null && v <= c.value; break;
      case 'is': ok = v === c.value; break;
      default: ok = false;
    }
    if (!ok) return { ok: false, reason: `${svc.CONDITION_FIELDS[c.field].label} ${c.op} ${JSON.stringify(c.value)} is not true (actual: ${JSON.stringify(v)})` };
  }
  return { ok: true };
}

function triggerMatches(w, event) {
  const cfg = parse(w.trigger_config_json, {});
  const p = parse(event.payload_json, {});
  if (cfg.productId && Number(p.productId) !== Number(cfg.productId)) return false;
  if (cfg.toStatus && p.to !== cfg.toStatus) return false;
  if (cfg.emailCampaignId && Number(p.emailCampaignId) !== Number(cfg.emailCampaignId)) return false;
  if (cfg.socialCampaignId && Number(p.socialCampaignId) !== Number(cfg.socialCampaignId)) return false;
  const chain = p.cause?.workflowIds || [];
  if (chain.includes(w.id) || chain.length >= MAX_DEPTH) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Event → run matching
// ---------------------------------------------------------------------------
async function matchEvents(limit = 100) {
  const events = await all(`SELECT * FROM automation_events WHERE status = 'pending' ORDER BY id LIMIT ${limit}`);
  let created = 0;
  for (const e of events) {
    const workflows = await all("SELECT * FROM automation_workflows WHERE workspace_id = ? AND trigger_type = ? AND status = 'active' AND COALESCE(activated_after_event_id, 0) < ?", [e.workspace_id, e.event_type, e.id]);
    for (const w of workflows) {
      if (!triggerMatches(w, e)) continue;
      let status = 'waiting';
      let reason = null;
      const today = await get("SELECT COUNT(*) AS n FROM automation_runs WHERE workflow_id = ? AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) AND status <> 'skipped'", [w.id]);
      const wsToday = await get("SELECT COUNT(*) AS n FROM automation_runs WHERE workspace_id = ? AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) AND status <> 'skipped'", [w.workspace_id]);
      if (Number(today.n) >= w.max_runs_per_day) { status = 'skipped'; reason = `Daily limit of ${w.max_runs_per_day} runs for this workflow reached.`; }
      else if (Number(wsToday.n) >= WORKSPACE_DAILY_LIMIT) { status = 'skipped'; reason = `Workspace daily automation limit of ${WORKSPACE_DAILY_LIMIT} runs reached.`; }
      else if (e.subject_type === 'lead') {
        const lead = await get('SELECT * FROM leads WHERE workspace_id = ? AND id = ?', [e.workspace_id, e.subject_id]);
        if (!lead) { status = 'skipped'; reason = 'The lead no longer exists.'; }
        else {
          const c = await conditionsMet(e.workspace_id, lead, parse(w.conditions_json, []));
          if (!c.ok) { status = 'skipped'; reason = `Conditions not met: ${c.reason}`; }
        }
      }
      const r = await run(
        `INSERT IGNORE INTO automation_runs (workspace_id, workflow_id, workflow_version, event_id, subject_type, subject_id, status, current_step, next_run_at, exit_reason, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, UTC_TIMESTAMP(), ?, UTC_TIMESTAMP(), ?)`,
        [e.workspace_id, w.id, w.version, e.id, e.subject_type, e.subject_id, status, reason, status === 'skipped' ? dbTime(new Date()) : null]
      );
      if (r.changes) created++;
    }
    await run("UPDATE automation_events SET status = 'processed', processed_at = UTC_TIMESTAMP() WHERE id = ?", [e.id]);
  }
  return created;
}

// ---------------------------------------------------------------------------
// Actions (existing module APIs only)
// ---------------------------------------------------------------------------
function fill(text, vars) {
  return String(text)
    .replace(/\{\{\s*first_name\s*\}\}/gi, vars.first_name || 'there')
    .replace(/\{\{\s*company\s*\}\}/gi, vars.company || 'your team')
    .replace(/\{\{\s*lead_name\s*\}\}/gi, vars.lead_name || 'there')
    .replace(/\{\{\s*post_title\s*\}\}/gi, vars.post_title || '');
}

async function performAction(ctx, runRow, workflow, step, subject) {
  const ws = runRow.workspace_id;
  const p = step.params;
  const lead = subject.lead;
  const vars = lead
    ? { first_name: String(lead.name || '').trim().split(/\s+/)[0], company: lead.company_name, lead_name: lead.name }
    : { post_title: subject.content?.title || '' };
  // Events caused by this action carry the chain, so workflows cannot loop.
  ctx.auth.automation = { workflowIds: [...(subject.chain || []), workflow.id], runId: runRow.id };
  switch (step.action) {
    case 'update_lead_status': {
      const leadService = require('../leads/leadService');
      if (lead.status === p.status) return { unchanged: true, status: p.status };
      await leadService.updateLead(ctx, lead.id, { status: p.status });
      return { status: p.status };
    }
    case 'add_lead_note': {
      const leadService = require('../leads/leadService');
      const note = `[Automation: ${workflow.name}] ${fill(p.text, vars)}`;
      await leadService.updateLead(ctx, lead.id, { notes: `${lead.notes ? `${lead.notes}\n` : ''}${note}`.slice(-5000) });
      return { added: true };
    }
    case 'enroll_in_sequence':
      return require('../outreach/outreachService').enrollLead(ctx, p.emailCampaignId, lead.id);
    case 'stop_sequences':
      return require('../outreach/outreachService').stopLeadSequences(ctx, lead.id, p.emailCampaignId || null);
    case 'create_email_draft': {
      if (!isValidRecipient(lead.email)) return { created: false, reason: 'The lead has no valid email address.' };
      const subj = fill(p.subject, vars).slice(0, 200);
      const text = fill(p.body, vars);
      const r = await run(
        `INSERT INTO email_drafts (workspace_id, product_id, product_name, lead_id, recipient_email, recipient_name, subject, body_html, body_text, tone, status, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'Professional', 'Draft', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [ws, lead.product_id || null, lead.id, String(lead.email).trim(), lead.name || '', subj, `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;">${esc(text).replace(/\n/g, '<br>')}</div>`, text]
      );
      return { draftId: r.lastID, status: 'Draft (needs approval in Mail Drafts)' };
    }
    case 'create_social_draft': {
      const contentService = require('../social/contentService');
      const item = await contentService.createContent(ctx, {
        campaignId: p.socialCampaignId ? Number(p.socialCampaignId) : (subject.content?.campaign_id || null),
        platformKey: p.platformKey,
        title: `Automation: ${workflow.name}`.slice(0, 255),
        caption: fill(p.caption, vars),
        source: 'automation'
      });
      return { contentId: item.id, status: 'draft (needs review and approval in Social Media Marketing)' };
    }
    default:
      throw svc.httpError(`Unknown action ${step.action}`, 400, 'VALIDATION_ERROR');
  }
}

// ---------------------------------------------------------------------------
// Run execution
// ---------------------------------------------------------------------------
async function finish(runRow, status, { reason = null, error = null } = {}) {
  await run('UPDATE automation_runs SET status = ?, exit_reason = ?, last_error = ?, locked_by = NULL, finished_at = UTC_TIMESTAMP() WHERE id = ?',
    [status, reason ? String(reason).slice(0, 500) : null, error ? String(error).slice(0, 1000) : null, runRow.id]);
}

async function wait(runRow, at, stepIndex, error = null) {
  await run("UPDATE automation_runs SET status = 'waiting', current_step = ?, next_run_at = ?, last_error = ?, locked_by = NULL WHERE id = ?",
    [stepIndex, dbTime(at), error ? String(error).slice(0, 1000) : null, runRow.id]);
}

async function stepRecord(runRow, index) {
  return get('SELECT * FROM automation_run_steps WHERE run_id = ? AND step_index = ?', [runRow.id, index]);
}

async function saveStep(runRow, index, type, status, { result = null, error = null, attempts = null } = {}) {
  await run(
    `INSERT INTO automation_run_steps (workspace_id, run_id, step_index, step_type, status, attempts, result_json, error, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), attempts = COALESCE(?, attempts), result_json = VALUES(result_json), error = VALUES(error), finished_at = VALUES(finished_at)`,
    [runRow.workspace_id, runRow.id, index, type, status, attempts ?? 0, result ? JSON.stringify(result).slice(0, 4000) : null, error ? String(error).slice(0, 1000) : null,
      ['done', 'failed', 'skipped', 'needs_review'].includes(status) ? dbTime(new Date()) : null, attempts]
  );
}

const isPermanent = err => err && err.status && err.status < 500 && err.status !== 429;

async function executeRun(runRow) {
  const workflow = await get('SELECT * FROM automation_workflows WHERE id = ? AND workspace_id = ?', [runRow.workflow_id, runRow.workspace_id]);
  if (!workflow) return finish(runRow, 'exited', { reason: 'The workflow was deleted.' });
  if (workflow.version !== runRow.workflow_version || workflow.status === 'draft') return finish(runRow, 'exited', { reason: 'The workflow was changed or deactivated; runs of the previous version stop.' });
  if (workflow.status === 'paused') return wait(runRow, new Date(Date.now() + 15 * 60 * 1000), runRow.current_step);

  const ctx = await svc.activatorContext(workflow);
  if (!ctx) return finish(runRow, 'failed', { error: 'The person who activated this workflow is no longer an active member; re-activate it.' });

  const steps = parse(workflow.steps_json, []);
  const subject = {};
  const event = await get('SELECT payload_json, created_at FROM automation_events WHERE id = ?', [runRow.event_id]);
  subject.chain = parse(event?.payload_json, {}).cause?.workflowIds || [];

  for (let i = runRow.current_step; i < steps.length; i++) {
    const step = steps[i];
    // Fresh subject on every step: later steps see earlier changes and new replies/unsubscribes.
    if (runRow.subject_type === 'lead') {
      subject.lead = await get('SELECT * FROM leads WHERE workspace_id = ? AND id = ?', [runRow.workspace_id, runRow.subject_id]);
      if (!subject.lead) return finish(runRow, 'exited', { reason: 'The lead was deleted.' });
      if (workflow.exit_on_reply) {
        const f = await leadFacts(runRow.workspace_id, subject.lead, event ? event.created_at : runRow.created_at);
        if (f.replied) return finish(runRow, 'exited', { reason: 'The lead replied, so the workflow stopped (exit on reply).' });
      }
    } else {
      subject.content = await get('SELECT id, title, campaign_id FROM content_items WHERE workspace_id = ? AND id = ?', [runRow.workspace_id, runRow.subject_id]);
      if (!subject.content) return finish(runRow, 'exited', { reason: 'The post no longer exists.' });
    }

    const rec = await stepRecord(runRow, i);
    if (rec && ['done', 'skipped'].includes(rec.status)) continue;
    if (rec && rec.status === 'needs_review') return finish(runRow, 'needs_review', { reason: `Step ${i + 1} needs review.` });

    if (step.type === 'wait') {
      const until = new Date(Date.now() + step.hours * 3600 * 1000);
      await saveStep(runRow, i, 'wait', 'done', { result: { until: until.toISOString() } });
      return wait(runRow, until, i + 1);
    }

    if (step.type === 'check') {
      const c = await conditionsMet(runRow.workspace_id, subject.lead, step.conditions);
      await saveStep(runRow, i, 'check', c.ok ? 'done' : 'skipped', { result: c });
      if (!c.ok) return finish(runRow, 'exited', { reason: `Step ${i + 1}: ${c.reason}` });
      continue;
    }

    // Action
    const def = svc.ACTIONS[step.action];
    if (!ctx.auth.capabilities.has(def.capability)) {
      await saveStep(runRow, i, step.action, 'failed', { error: `Missing permission: ${def.capability}` });
      return finish(runRow, 'failed', { error: `Step ${i + 1}: the activating user no longer has ${def.capability}.` });
    }
    if (def.outbound && subject.lead) {
      const f = await leadFacts(runRow.workspace_id, subject.lead);
      if (f.suppressed) {
        await saveStep(runRow, i, step.action, 'skipped', { result: { reason: 'Lead is unsubscribed or bounced.' } });
        return finish(runRow, 'exited', { reason: 'The lead is unsubscribed or bounced; no outbound actions.' });
      }
    }
    const attempts = (rec?.attempts || 0) + 1;
    await saveStep(runRow, i, step.action, 'running', { attempts });
    try {
      const result = await performAction(ctx, runRow, workflow, step, subject);
      await saveStep(runRow, i, step.action, 'done', { result, attempts });
      await audit(ctx, `automation.action.${step.action}`, { resourceType: runRow.subject_type, resourceId: runRow.subject_id, metadata: { workflowId: workflow.id, runId: runRow.id, step: i + 1, result } });
    } catch (err) {
      const message = err.message || 'Action failed';
      if (isPermanent(err) || attempts >= MAX_ATTEMPTS) {
        await saveStep(runRow, i, step.action, 'failed', { error: message, attempts });
        await audit(ctx, 'automation.action_failed', { resourceType: runRow.subject_type, resourceId: runRow.subject_id, metadata: { workflowId: workflow.id, runId: runRow.id, step: i + 1, error: message } });
        return finish(runRow, 'failed', { error: `Step ${i + 1}: ${message}` });
      }
      await saveStep(runRow, i, step.action, 'retry', { error: message, attempts });
      return wait(runRow, new Date(Date.now() + BACKOFF_MIN[attempts - 1] * 60000), i, `Step ${i + 1} will retry: ${message}`);
    }
  }
  return finish(runRow, 'completed');
}

async function recoverStale() {
  const cutoff = dbTime(new Date(Date.now() - STALE_MS));
  const stale = await all("SELECT * FROM automation_runs WHERE status = 'running' AND locked_at < ?", [cutoff]);
  for (const r of stale) {
    const workflow = await get('SELECT steps_json FROM automation_workflows WHERE id = ?', [r.workflow_id]);
    const step = parse(workflow?.steps_json, [])[r.current_step];
    const rec = await stepRecord(r, r.current_step);
    if (step && step.type === 'action' && rec && rec.status === 'running' && !svc.ACTIONS[step.action].idempotent) {
      await saveStep(r, r.current_step, step.action, 'needs_review', { error: 'The worker stopped during this action; it may have completed. Check before continuing.' });
      await finish(r, 'needs_review', { reason: `Step ${r.current_step + 1} was interrupted.` });
    } else {
      await run("UPDATE automation_runs SET status = 'waiting', locked_by = NULL, next_run_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'running'", [r.id]);
    }
  }
  return stale.length;
}

/** One worker tick: match new events, then execute due runs. */
async function processAutomation(workerId, { maxRuns = 50 } = {}) {
  await recoverStale();
  const created = await matchEvents();
  const due = await all(`SELECT id FROM automation_runs WHERE status = 'waiting' AND next_run_at <= UTC_TIMESTAMP() ORDER BY next_run_at, id LIMIT ${maxRuns}`);
  let executed = 0;
  for (const { id } of due) {
    const claim = await run("UPDATE automation_runs SET status = 'running', locked_by = ?, locked_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'waiting'", [workerId, id]);
    if (!claim.changes) continue;
    const runRow = await get('SELECT * FROM automation_runs WHERE id = ?', [id]);
    try {
      await executeRun(runRow);
    } catch (err) {
      await finish(runRow, 'failed', { error: `Internal error: ${err.message}` });
    }
    executed++;
  }
  return created + executed;
}

module.exports = { processAutomation, matchEvents, executeRun, recoverStale, conditionsMet };
