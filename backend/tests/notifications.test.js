const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// The bell: each person's notifications, kept with read state, resolved when dealt with, never shown to anyone else.
const db = () => h.db();
let Owner, A, B, Other, leadA, fuOverdue;
const call = (who, method, path, body) => h.api(method, path, { token: who.token, body });
const at = mins => new Date(Date.now() + mins * 60000).toISOString().slice(0, 19).replace('T', ' ');
const svc = () => require('../modules/notifications/notificationService');
const bell = async who => { svc().resetThrottle(); const r = await call(who, 'GET', '/api/v1/notifications'); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
const kinds = d => d.notifications.map(n => n.kind).sort();

test.before(async () => {
  await h.prepareDatabase();
  Owner = await h.createWorkspace({ name: 'Bell team' });
  A = await h.addMember(Owner.workspaceId, 'Member');
  B = await h.addMember(Owner.workspaceId, 'Member');
  Other = await h.createWorkspace({ name: 'Bell other' });
  const W = Owner.workspaceId;
  const { run } = db();
  const lead = async (name, extra = '') => (await run(`INSERT INTO leads (workspace_id, name, status, owner_user_id, created_by_user_id, lead_source, created_at${extra ? ', ai_category' : ''}) VALUES (?, ?, 'New', ?, ?, 'manual', UTC_TIMESTAMP()${extra ? ', ?' : ''})`,
    [W, name, A.userId, Owner.userId, ...(extra ? [extra] : [])])).lastID;
  leadA = await lead('Acme');
  const hot = await lead('Hot Co', 'Hot');
  const fu = (title, due, assignedBy = null) => run(`INSERT INTO lead_followups (workspace_id, lead_id, assigned_user_id, followup_type, title, priority, due_at, status, created_by, assigned_by, assigned_at, created_at, updated_at)
    VALUES (?, ?, ?, 'call', ?, 'medium', ?, 'pending', ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [W, leadA, A.userId, title, due, A.userId, assignedBy, assignedBy ? at(-60) : null]);
  fuOverdue = (await fu('Call back', at(-120))).lastID;
  await fu('Send quote', at(120));
  await fu('Demo prep', at(3 * 1440), Owner.userId);
  // Three leads given to A in one go by the Owner: one notification.
  for (const id of [leadA, hot, leadA]) await run("INSERT INTO audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata_json, created_at) VALUES (?, ?, 'leads.owner_changed', 'lead', ?, ?, UTC_TIMESTAMP())",
    [W, Owner.userId, String(id), JSON.stringify({ previous: null, owner: A.userId, bulk: true })]);
  await run("INSERT INTO crm_call_logs (user_id, phone, transcribe, transcript_status, answered, duration_seconds, lead_id, lead_workspace_id, started_at, ended_at) VALUES (?, '+61400000001', 1, 'failed', 1, 30, ?, ?, ?, ?)", [A.userId, leadA, W, at(-30), at(-29)]);
  // A emailed Kim, so Kim's urgent reply is A's mail (members see only their own; the owner sees all).
  await run("INSERT INTO emails (workspace_id, sender, sender_email, recipient_email, subject, body, status, is_read, sent_by_user_id, sent_at) VALUES (?, 'A', 'team@bell.io', 'kim@client.io', 'Contract', 'x', 'Sent', 1, ?, UTC_TIMESTAMP())", [W, A.userId]);
  await run("INSERT INTO emails (workspace_id, sender, sender_email, recipient_email, subject, body, status, is_read, is_urgent, received_at) VALUES (?, 'Kim', 'kim@client.io', 'team@bell.io', 'Contract question', 'x', 'Unread', 0, 1, UTC_TIMESTAMP())", [W]);
  await run("INSERT INTO email_drafts (workspace_id, recipient_name, recipient_email, subject, body, status, created_at, updated_at) VALUES (?, 'Kim', 'kim@client.io', 'Proposal', 'x', 'Pending Approval', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [W]);
  const acc = await h.createAccount(W);
  const item = (await run("INSERT INTO content_items (workspace_id, content_type, title, platform, status, version, source, created_by, created_at) VALUES (?, 'post', 'Launch post', 'facebook', 'failed', 1, 'social_hub', ?, UTC_TIMESTAMP())", [W, A.userId])).lastID;
  await run(`INSERT INTO publishing_jobs (workspace_id, content_item_id, social_account_id, content_version, idempotency_key, status, scheduled_for, next_attempt_at, last_error, requested_by, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, 'failed', UTC_TIMESTAMP(), UTC_TIMESTAMP(), 'Token expired', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [W, item, acc.id, `bell-${item}`, A.userId]);
  await run("INSERT INTO social_content_generations (workspace_id, user_id, kind, purpose, provider, model, status, error, request_key, created_at, updated_at) VALUES (?, ?, 'image', 'product_ad', 'openai', 'gpt-image-1', 'failed', 'Model unavailable', ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())",
    [W, A.userId, `bell-gen-${Date.now()}`]);
});
test.after(() => h.shutdown());

test('a member sees their own follow-ups, leads, calls, posts and generations, and the mail they may read', async () => {
  const d = await bell(A);
  assert.deepEqual(kinds(d), ['email_urgent', 'followup_assigned', 'followup_due', 'followup_overdue', 'generation_failed', 'hot_lead', 'lead_assigned', 'publish_failed', 'transcript_failed'].sort());
  assert.equal(d.unread, d.notifications.length, 'all new');
  const assigned = d.notifications.find(n => n.kind === 'lead_assigned');
  assert.equal(assigned.title, '3 leads assigned to you', 'one notification per assignment, not per lead');
  assert.match(assigned.detail, /^by /);
  const overdue = d.notifications.find(n => n.kind === 'followup_overdue');
  assert.deepEqual(overdue.link, { route: 'leads', leadId: leadA });
  assert.equal(overdue.tone, 'danger');
  assert.equal(overdue.icon, 'calendar');
  assert.deepEqual(d.notifications.find(n => n.kind === 'publish_failed').link, { route: 'social', section: 'queue', status: 'failed' });
  assert.ok(!kinds(d).includes('draft_approval'), 'a Member cannot approve drafts, so is not asked to');
});

test('others see only what is theirs; the owner is asked to approve the draft; another workspace sees nothing', async () => {
  const b = await bell(B);
  assert.deepEqual(kinds(b), [], "nothing of A's: not A's follow-ups, nor the reply to A's email");
  const o = await bell(Owner);
  assert.ok(kinds(o).includes('draft_approval'));
  assert.ok(kinds(o).includes('email_urgent'), 'the owner sees all mail');
  assert.ok(!kinds(o).some(k => k.startsWith('followup') || k === 'publish_failed'), "A's follow-ups and posts are A's");
  assert.equal((await bell(Other)).notifications.length, 0);
});

test('read state: one, then all; it stays read when the same thing is reported again', async () => {
  let d = await bell(A);
  const first = d.notifications[0];
  assert.equal((await call(A, 'POST', `/api/v1/notifications/${first.id}/read`)).status, 200);
  d = await bell(A);
  assert.equal(d.unread, d.notifications.length - 1);
  assert.equal(d.notifications.find(n => n.id === first.id).read, true);
  assert.equal((await call(B, 'POST', `/api/v1/notifications/${first.id}/read`)).status, 404, "nobody marks another person's");
  const all = await call(A, 'POST', '/api/v1/notifications/read-all');
  assert.equal(all.data.marked, d.notifications.length - 1);
  d = await bell(A);
  assert.equal(d.unread, 0, 'the badge clears');
  assert.ok(d.notifications.every(n => n.read), 'still listed, as read');
});

test('dealt with → gone: completing the overdue follow-up resolves its notification; a new problem is unread again', async () => {
  await db().run("UPDATE lead_followups SET status = 'completed', completed_at = UTC_TIMESTAMP() WHERE id = ?", [fuOverdue]);
  let d = await bell(A);
  assert.ok(!kinds(d).includes('followup_overdue'));
  const row = await db().get("SELECT resolved_at FROM user_notifications WHERE ref_key = ?", [`followup:${fuOverdue}:overdue`]);
  assert.ok(row.resolved_at, 'kept as resolved, then removed after 30 days');
  // Reopened and overdue again: it comes back (as read, since it was read before).
  await db().run("UPDATE lead_followups SET status = 'pending', completed_at = NULL WHERE id = ?", [fuOverdue]);
  d = await bell(A);
  assert.ok(kinds(d).includes('followup_overdue'));
  // Something new: unread.
  await db().run("INSERT INTO crm_call_logs (user_id, phone, transcribe, transcript_status, answered, duration_seconds, lead_id, lead_workspace_id, started_at, ended_at) VALUES (?, '+61400000002', 1, 'failed', 1, 30, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())", [A.userId, leadA, Owner.workspaceId]);
  d = await bell(A);
  assert.equal(d.unread, 1);
  assert.equal(d.notifications[0].kind, 'transcript_failed', 'unread first');
});

test('the bell needs a signed-in person; checks run at most every 30 seconds per person', async () => {
  assert.equal((await h.api('GET', '/api/v1/notifications')).status, 401);
  svc().resetThrottle();
  await call(A, 'GET', '/api/v1/notifications');
  const before = await db().get('SELECT COUNT(*) n FROM user_notifications WHERE user_id = ?', [A.userId]);
  await db().run("INSERT INTO crm_call_logs (user_id, phone, transcribe, transcript_status, answered, duration_seconds, lead_id, lead_workspace_id, started_at, ended_at) VALUES (?, '+61400000003', 1, 'failed', 1, 30, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())", [A.userId, leadA, Owner.workspaceId]);
  await call(A, 'GET', '/api/v1/notifications');
  assert.equal((await db().get('SELECT COUNT(*) n FROM user_notifications WHERE user_id = ?', [A.userId])).n, before.n, 'not re-checked within 30 s');
  svc().resetThrottle();
  await call(A, 'GET', '/api/v1/notifications');
  assert.equal((await db().get('SELECT COUNT(*) n FROM user_notifications WHERE user_id = ?', [A.userId])).n, before.n + 1);
});
