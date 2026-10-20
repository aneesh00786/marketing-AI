const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Automation workflows. AI and mail are mocked; the engine is driven tick by tick.
let A;
let B;
let running;
let draftSeq;
let socialCampaign;

const db = () => h.db();
const api = (ws, method, path, body) => h.api(method, `/api/v1/automations${path}`, { token: ws.token, body });
const engine = () => require('../modules/automation/automationEngine');
const aiDown = { match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) };
const emit = (...a) => require('../lib/automationEvents').emit(...a);

/** Runs the engine until no pending events remain (other test files leave events behind). */
async function drain() {
  for (let i = 0; i < 40; i++) {
    await engine().processAutomation('test-worker', { maxRuns: 200 });
    const p = await db().get("SELECT COUNT(*) AS n FROM automation_events WHERE status = 'pending'");
    if (Number(p.n) === 0) break;
  }
  await engine().processAutomation('test-worker', { maxRuns: 200 });
}

async function addLead(ws, body) {
  const mock = h.mockFetch([aiDown]);
  try {
    const r = await h.api('POST', '/api/v1/leads', { token: ws.token, body });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.lead.id;
  } finally { mock.restore(); }
}

/** Each test starts with no active workflows in A, so one failure cannot leak into the next. */
const quiet = () => db().run("UPDATE automation_workflows SET status = 'paused' WHERE workspace_id = ? AND status = 'active'", [A.workspaceId]);

async function workflow(ws, def, { activate = true } = {}) {
  const r = await api(ws, 'POST', '/', { name: `WF ${Date.now()}`, ...def });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  if (activate) assert.equal((await api(ws, 'POST', `/${r.data.workflow.id}/activate`, { confirm: true })).status, 200);
  return r.data.workflow.id;
}

const runsOf = wid => db().all('SELECT * FROM automation_runs WHERE workflow_id = ? ORDER BY id', [wid]);
const stepsOf = rid => db().all('SELECT * FROM automation_run_steps WHERE run_id = ? ORDER BY step_index', [rid]);

async function sequence(ws, { approve, seedLead }) {
  const c = (await h.api('POST', '/api/v1/outreach/campaigns', { token: ws.token, body: { name: `Seq ${Date.now()}`, sendDays: [1, 2, 3, 4, 5, 6, 7], sendStartHour: 0, sendEndHour: 24, dailyLimit: 500 } })).data.campaign;
  await h.api('PUT', `/api/v1/outreach/campaigns/${c.id}/steps`, { token: ws.token, body: { steps: [{ delayDays: 0, subject: 'Hello', body: 'Hi {{first_name}}' }, { delayDays: 3, subject: 'Follow-up', body: 'Hi again' }] } });
  if (seedLead) await h.api('POST', `/api/v1/outreach/campaigns/${c.id}/recipients`, { token: ws.token, body: { leadIds: [seedLead] } });
  if (approve) assert.equal((await h.api('POST', `/api/v1/outreach/campaigns/${c.id}/approve`, { token: ws.token, body: { confirm: true } })).status, 200);
  return c.id;
}

test.before(async () => {
  await h.prepareDatabase();
  await db().run("UPDATE outreach_campaigns SET status = 'stopped' WHERE status = 'running'");
  await db().run("UPDATE automation_workflows SET status = 'paused' WHERE status = 'active'");
  await drain();
  A = await h.createWorkspace({ name: 'Auto A' });
  B = await h.createWorkspace({ name: 'Auto B' });
  assert.equal((await h.api('POST', '/api/v1/mail/config', { token: A.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: 'zepto-A', sender_email: 'hello@a-co.io' } })).status, 200);
  const seed = await addLead(A, { name: 'Seed Lead', email: 'seed@fleet.io' });
  running = await sequence(A, { approve: true, seedLead: seed });
  draftSeq = await sequence(A, { approve: false });
  socialCampaign = (await h.api('POST', '/api/v1/social/campaigns', { token: A.token, body: { name: 'Auto social', platforms: ['linkedin'] } })).data.campaign.id;
  await drain();
});
test.after(() => h.shutdown());

test('definitions are validated against a whitelist and the caller workspace', async () => {
  const base = { name: 'X', trigger: { type: 'lead.created' }, steps: [{ type: 'action', action: 'update_lead_status', params: { status: 'Contacted' } }] };
  assert.equal((await api(A, 'POST', '/', { ...base, trigger: { type: 'cron.hourly' } })).status, 400);
  assert.equal((await api(A, 'POST', '/', { ...base, steps: [{ type: 'action', action: 'send_email_now', params: {} }] })).status, 400, 'no direct-send action exists');
  assert.equal((await api(A, 'POST', '/', { ...base, steps: [{ type: 'action', action: 'update_lead_status', params: { status: 'Bogus' } }] })).status, 400);
  assert.equal((await api(A, 'POST', '/', { ...base, trigger: { type: 'social.post_published' } })).status, 400, 'lead action on a social trigger');
  const foreign = await sequence(B, { approve: false });
  assert.equal((await api(A, 'POST', '/', { ...base, steps: [{ type: 'action', action: 'enroll_in_sequence', params: { emailCampaignId: foreign } }] })).status, 404, 'foreign sequence');
  assert.equal((await api(A, 'POST', '/', { ...base, steps: [{ type: 'action', action: 'create_email_draft', params: { subject: 'Hi', body: 'Hi {{last_name}}' } }] })).status, 400, 'unknown placeholder');
  assert.equal((await api(A, 'POST', '/', { ...base, steps: [{ type: 'wait', hours: 1 }] })).status, 400, 'needs an action');
  const member = await h.addMember(A.workspaceId, 'Member');
  assert.equal((await api(member, 'POST', '/', base)).status, 403);
  assert.equal((await api(B, 'GET', '/')).data.workflows.length, 0);
});

test('activation is an explicit approval; only later events run; enrolment respects sequence approval', async () => {
  await quiet();
  const before = await addLead(A, { name: 'Before Activation', email: 'before@fleet.io' });
  const wid = await workflow(A, {
    trigger: { type: 'lead.created' },
    conditions: [{ field: 'has_valid_email', op: 'is', value: true }],
    steps: [
      { type: 'action', action: 'enroll_in_sequence', params: { emailCampaignId: running } },
      { type: 'action', action: 'enroll_in_sequence', params: { emailCampaignId: draftSeq } },
      { type: 'action', action: 'update_lead_status', params: { status: 'Contacted' } }
    ]
  }, { activate: false });
  assert.equal((await api(A, 'POST', `/${wid}/activate`, {})).status, 400, 'confirm required');
  const wf = (await api(A, 'POST', `/${wid}/activate`, { confirm: true })).data.workflow;
  assert.deepEqual(wf.requiredCapabilities.sort(), ['leads.manage', 'mail.send']);
  assert.ok(wf.outboundActions.includes('Add the lead to an email sequence'));

  const lead = await addLead(A, { name: 'Dana New', email: 'dana@fleet.io' });
  const noEmail = await addLead(A, { name: 'No Email' });
  await drain();
  const runs = await runsOf(wid);
  assert.equal(runs.length, 2, 'the lead created before activation is ignored');
  const byLead = Object.fromEntries(runs.map(r => [r.subject_id, r]));
  assert.equal(byLead[lead].status, 'completed', JSON.stringify(byLead[lead]));
  assert.equal(byLead[noEmail].status, 'skipped');
  assert.match(byLead[noEmail].exit_reason, /Has a valid email/);
  assert.ok(!byLead[before]);

  const inRunning = await db().get('SELECT status FROM outreach_recipients WHERE campaign_id = ? AND lead_id = ?', [running, lead]);
  const inDraft = await db().get('SELECT status FROM outreach_recipients WHERE campaign_id = ? AND lead_id = ?', [draftSeq, lead]);
  assert.equal(inRunning.status, 'active', 'approved, running sequence emails in its window');
  assert.equal(inDraft.status, 'pending', 'draft sequence waits for its own approval');
  assert.equal((await db().get('SELECT status FROM leads WHERE id = ?', [lead])).status, 'Contacted');

  // Idempotency: the same event cannot create a second run, re-running does not duplicate.
  await emit(A.workspaceId, 'lead.created', { subjectType: 'lead', subjectId: lead, key: `lead.created:${lead}` });
  await drain();
  assert.equal((await runsOf(wid)).length, 2);
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM outreach_recipients WHERE campaign_id = ? AND lead_id = ?', [running, lead])).n), 1);
  const audit = await db().get("SELECT COUNT(*) AS n FROM audit_logs WHERE workspace_id = ? AND action = 'automation.action.enroll_in_sequence' AND actor_type = 'automation'", [A.workspaceId]);
  assert.ok(Number(audit.n) >= 2, 'actions are audited as automation');
  await api(A, 'POST', `/${wid}/pause`);
});

test('suppressed leads never get outbound actions; a reply exits a waiting run', async () => {
  await quiet();
  const wid = await workflow(A, {
    trigger: { type: 'lead.created' },
    steps: [{ type: 'wait', hours: 1 }, { type: 'action', action: 'create_email_draft', params: { subject: 'Hi {{first_name}}', body: 'Following up, {{first_name}}.' } }]
  });
  await db().run("INSERT IGNORE INTO email_suppressions (workspace_id, email, reason, source) VALUES (?, 'gone@fleet.io', 'unsubscribed', 'test')", [A.workspaceId]);
  const suppressed = await addLead(A, { name: 'Gone Away', email: 'gone@fleet.io' });
  const replier = await addLead(A, { name: 'Rae Reply', email: 'rae@fleet.io' });
  const quietLead = await addLead(A, { name: 'Quinn Quiet', email: 'quinn@fleet.io' });
  await drain();
  let runs = Object.fromEntries((await runsOf(wid)).map(r => [r.subject_id, r]));
  assert.ok(Object.values(runs).every(r => r.status === 'waiting' && r.current_step === 1), 'all waiting after the delay step');

  await db().run("INSERT INTO emails (workspace_id, sender, sender_email, recipient_email, recipient_name, subject, body, status, smtp_status, received_at) VALUES (?, 'Rae', 'rae@fleet.io', 'hello@a-co.io', 'A', 'Re: hi', 'Interested', 'Unread', 'Received via IMAP', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 SECOND))", [A.workspaceId]);
  await db().run('UPDATE automation_runs SET next_run_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE workflow_id = ?', [wid]);
  await new Promise(r => setTimeout(r, 1100));
  await drain();
  runs = Object.fromEntries((await runsOf(wid)).map(r => [r.subject_id, r]));
  assert.equal(runs[suppressed].status, 'exited');
  assert.match(runs[suppressed].exit_reason, /unsubscribed or bounced/);
  assert.equal(runs[replier].status, 'exited');
  assert.match(runs[replier].exit_reason, /replied/);
  assert.equal(runs[quietLead].status, 'completed');
  const drafts = await db().all('SELECT lead_id, status, subject FROM email_drafts WHERE lead_id IN (?, ?, ?)', [suppressed, replier, quietLead]);
  assert.deepEqual(drafts.map(d => [d.lead_id, d.status, d.subject]), [[quietLead, 'Draft', 'Hi Quinn']], 'only a draft for approval, only for the eligible lead');
  await api(A, 'POST', `/${wid}/pause`);
});

test('checks after a delay use fresh lead data; editing a workflow stops its waiting runs', async () => {
  await quiet();
  const wid = await workflow(A, {
    trigger: { type: 'lead.created' },
    steps: [{ type: 'wait', hours: 24 }, { type: 'check', conditions: [{ field: 'status', op: 'eq', value: 'New' }] }, { type: 'action', action: 'add_lead_note', params: { text: 'Still new after a day' } }]
  });
  const moved = await addLead(A, { name: 'Moved On', email: 'moved@fleet.io' });
  const still = await addLead(A, { name: 'Still New', email: 'still@fleet.io' });
  const edited = await addLead(A, { name: 'Edited Wf', email: 'edited@fleet.io' });
  await drain();
  await h.api('PATCH', `/api/v1/leads/${moved}`, { token: A.token, body: { status: 'Qualified' } });
  await db().run('UPDATE automation_runs SET next_run_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE workflow_id = ? AND subject_id IN (?, ?)', [wid, moved, still]);
  await drain();
  const runs = Object.fromEntries((await runsOf(wid)).map(r => [r.subject_id, r]));
  assert.equal(runs[moved].status, 'exited');
  assert.match(runs[moved].exit_reason, /Lead status eq "New"/);
  assert.equal(runs[still].status, 'completed');
  assert.match((await db().get('SELECT notes FROM leads WHERE id = ?', [still])).notes, /\[Automation: .*\] Still new after a day/);

  const def = (await api(A, 'GET', `/${wid}`)).data.workflow;
  const upd = await api(A, 'PUT', `/${wid}`, { name: def.name, trigger: def.trigger, steps: def.steps });
  assert.equal(upd.data.workflow.status, 'draft', 'edits need re-approval');
  await db().run('UPDATE automation_runs SET next_run_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE workflow_id = ? AND subject_id = ?', [wid, edited]);
  await drain();
  const r = (await runsOf(wid)).find(x => x.subject_id === edited);
  assert.equal(r.status, 'exited');
  assert.match(r.exit_reason, /changed or deactivated/);
});

test('transient failures retry with backoff; permanent ones fail at once; interrupted drafts need review', async () => {
  await quiet();
  const contentService = require('../modules/social/contentService');
  const original = contentService.createContent;
  let calls = 0;
  contentService.createContent = async (...args) => { calls++; if (calls === 1) throw new Error('temporary database hiccup'); return original(...args); };
  const wid = await workflow(A, { trigger: { type: 'social.post_published' }, steps: [{ type: 'action', action: 'create_social_draft', params: { platformKey: 'linkedin', caption: 'Follow-up to {{post_title}}', socialCampaignId: socialCampaign } }] });
  const post = (await db().run("INSERT INTO content_items (workspace_id, campaign_id, content_type, title, caption_text, platform_key, status, version, created_at) VALUES (?, ?, 'post', 'Launch post', 'x', 'linkedin', 'published', 1, UTC_TIMESTAMP())", [A.workspaceId, socialCampaign])).lastID;
  try {
    await emit(A.workspaceId, 'social.post_published', { subjectType: 'content', subjectId: post, payload: { socialCampaignId: socialCampaign }, key: `social.published:${post}:t1` });
    await drain();
    let [r] = await runsOf(wid);
    assert.equal(r.status, 'waiting');
    assert.match(r.last_error, /will retry: temporary database hiccup/);
    assert.equal((await stepsOf(r.id))[0].attempts, 1);
    await db().run('UPDATE automation_runs SET next_run_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id = ?', [r.id]);
    await drain();
    [r] = await runsOf(wid);
    assert.equal(r.status, 'completed');
    const draft = await db().get("SELECT status, caption_text FROM content_items WHERE workspace_id = ? AND source = 'automation' ORDER BY id DESC LIMIT 1", [A.workspaceId]);
    assert.equal(draft.status, 'draft', 'social posts still need review, approval and publishing');
    assert.equal(draft.caption_text, 'Follow-up to Launch post');
  } finally { contentService.createContent = original; }
  await api(A, 'POST', `/${wid}/pause`);

  // Permanent: the target sequence was stopped after activation.
  const stopped = await sequence(A, { approve: false });
  const wid2 = await workflow(A, { trigger: { type: 'lead.created' }, steps: [{ type: 'action', action: 'enroll_in_sequence', params: { emailCampaignId: stopped } }] });
  await h.api('POST', `/api/v1/outreach/campaigns/${stopped}/stop`, { token: A.token });
  await addLead(A, { name: 'Late Lead', email: 'late@fleet.io' });
  await drain();
  const [p] = await runsOf(wid2);
  assert.equal(p.status, 'failed');
  assert.match(p.last_error, /stopped; it no longer accepts recipients/);
  assert.equal((await stepsOf(p.id))[0].attempts, 1, 'no retries for permanent errors');
  await api(A, 'POST', `/${wid2}/pause`);

  // A crash during a non-idempotent action is flagged, not repeated.
  const wid3 = await workflow(A, { trigger: { type: 'lead.created' }, steps: [{ type: 'action', action: 'create_email_draft', params: { subject: 'S', body: 'B' } }] });
  const lead = await addLead(A, { name: 'Crash Case', email: 'crash@fleet.io' });
  await engine().matchEvents(500);
  const [cr] = await runsOf(wid3);
  await db().run("UPDATE automation_runs SET status = 'running', locked_by = 'dead-worker', locked_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR) WHERE id = ?", [cr.id]);
  await db().run("INSERT INTO automation_run_steps (workspace_id, run_id, step_index, step_type, status, attempts) VALUES (?, ?, 0, 'create_email_draft', 'running', 1)", [A.workspaceId, cr.id]);
  await drain();
  const after = (await runsOf(wid3))[0];
  assert.equal(after.status, 'needs_review');
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM email_drafts WHERE lead_id = ?', [lead])).n), 0, 'not repeated');
  await api(A, 'POST', `/${wid3}/pause`);
});

test('reply events from the email engine trigger workflows; chains cannot loop', async () => {
  await quiet();
  const lead = await addLead(A, { name: 'Ria Reply', email: 'ria@fleet.io' });
  await h.api('POST', `/api/v1/outreach/campaigns/${running}/pause`, { token: A.token });
  await h.api('POST', `/api/v1/outreach/campaigns/${running}/recipients`, { token: A.token, body: { leadIds: [lead] } });
  await h.api('POST', `/api/v1/outreach/campaigns/${running}/resume`, { token: A.token, body: { confirm: true } });
  const onReply = await workflow(A, { trigger: { type: 'email.replied', config: { emailCampaignId: running } }, steps: [
    { type: 'action', action: 'update_lead_status', params: { status: 'Qualified' } },
    { type: 'action', action: 'stop_sequences', params: {} }
  ] });
  const loop = await workflow(A, { trigger: { type: 'lead.status_changed', config: { toStatus: 'Qualified' } }, steps: [{ type: 'action', action: 'update_lead_status', params: { status: 'Contacted' } }] });
  const back = await workflow(A, { trigger: { type: 'lead.status_changed', config: { toStatus: 'Contacted' } }, steps: [{ type: 'action', action: 'update_lead_status', params: { status: 'Qualified' } }] });

  const calls = [];
  let mock = h.mockFetch([{ match: u => u.startsWith('https://api.zeptomail.com/'), respond: () => { calls.push(1); return h.json(200, { request_id: 'x' }); } }]);
  try { await require('../modules/outreach/outreachSender').processOutreach('test-worker', { maxPerTick: 100 }); } finally { mock.restore(); }
  const rec = await db().get('SELECT id FROM outreach_recipients WHERE campaign_id = ? AND lead_id = ?', [running, lead]);
  await db().run('UPDATE outreach_recipients SET next_send_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE), first_sent_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR) WHERE id = ?', [rec.id]);
  await db().run("INSERT INTO emails (workspace_id, sender, sender_email, recipient_email, recipient_name, subject, body, status, smtp_status, received_at) VALUES (?, 'Ria', 'ria@fleet.io', 'hello@a-co.io', 'A', 'Re: Hello', 'Yes please', 'Unread', 'Received via IMAP', UTC_TIMESTAMP())", [A.workspaceId]);
  mock = h.mockFetch([{ match: u => u.startsWith('https://api.zeptomail.com/'), respond: () => h.json(200, { request_id: 'y' }) }]);
  try { await require('../modules/outreach/outreachSender').processOutreach('test-worker', { maxPerTick: 100 }); } finally { mock.restore(); }
  await drain();

  assert.equal((await runsOf(onReply)).filter(r => r.status === 'completed').length, 1);
  assert.equal((await runsOf(loop)).length, 1, 'loop workflow ran once');
  assert.equal((await runsOf(back)).length, 1, 'counter workflow ran once; it cannot re-trigger the first');
  assert.equal((await db().get('SELECT status FROM leads WHERE id = ?', [lead])).status, 'Qualified');
  for (const w of [onReply, loop, back]) await api(A, 'POST', `/${w}/pause`);
});

test('limits, permission loss and workspace isolation', async () => {
  await quiet();
  const wid = await workflow(A, { trigger: { type: 'lead.created' }, maxRunsPerDay: 1, steps: [{ type: 'action', action: 'update_lead_status', params: { status: 'Contacted' } }] });
  await addLead(A, { name: 'Limit One', email: 'l1@fleet.io' });
  await addLead(A, { name: 'Limit Two', email: 'l2@fleet.io' });
  await drain();
  const runs = await runsOf(wid);
  assert.deepEqual(runs.map(r => r.status).sort(), ['completed', 'skipped']);
  assert.match(runs.find(r => r.status === 'skipped').exit_reason, /Daily limit of 1/);
  await api(A, 'POST', `/${wid}/pause`);

  // Runs execute as the activator; losing the permission stops them.
  const manager = await h.addMember(A.workspaceId, 'Marketing Manager');
  const w2 = (await api(manager, 'POST', '/', { name: 'Mgr', trigger: { type: 'lead.created' }, steps: [{ type: 'action', action: 'enroll_in_sequence', params: { emailCampaignId: draftSeq } }] })).data.workflow.id;
  assert.equal((await api(manager, 'POST', `/${w2}/activate`, { confirm: true })).status, 200);
  await db().run("UPDATE workspace_members SET role = 'Member' WHERE workspace_id = ? AND user_id = ?", [A.workspaceId, manager.userId]);
  await addLead(A, { name: 'Perm Lead', email: 'perm@fleet.io' });
  await drain();
  const [pr] = await runsOf(w2);
  assert.equal(pr.status, 'failed');
  assert.match(pr.last_error, /no longer has mail.send/);
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM outreach_recipients WHERE campaign_id = ? AND email = ?', [draftSeq, 'perm@fleet.io'])).n), 0);
  await api(A, 'POST', `/${w2}/pause`);

  // Isolation: other workspaces cannot see or change A's workflows, and B's events never run A's.
  const wa = await workflow(A, { trigger: { type: 'lead.created' }, steps: [{ type: 'action', action: 'update_lead_status', params: { status: 'Contacted' } }] });
  for (const [m, p, b] of [['GET', `/${wa}`], ['PUT', `/${wa}`, { name: 'x', trigger: { type: 'lead.created' }, steps: [{ type: 'action', action: 'add_lead_note', params: { text: 'x' } }] }], ['POST', `/${wa}/activate`, { confirm: true }], ['POST', `/${wa}/pause`], ['GET', `/${wa}/runs`], ['DELETE', `/${wa}`]]) {
    assert.equal((await api(B, m, p, b)).status, 404, `${m} ${p}`);
  }
  const before = (await runsOf(wa)).length;
  await addLead(B, { name: 'B Lead', email: 'b@other.io' });
  await drain();
  assert.equal((await runsOf(wa)).length, before);
  const listed = await api(A, 'GET', `/${wa}/runs`);
  assert.equal(listed.status, 200);
  assert.equal((await h.api('GET', '/api/v1/automations')).status, 401);
  assert.equal((await api(A, 'DELETE', `/${wid}`)).status, 409, 'workflows with history are kept');
  await api(A, 'POST', `/${wa}/pause`);
});
