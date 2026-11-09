const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Lead follow-ups: scheduled tasks, notes/activities, and the lead's emails + calls through the same
// history as a campaign's Follow up. Telnyx is mocked; nothing is dialled or transcribed for real.
const db = () => h.db();
let Owner, A, B, C, Other, lead;
const call = (who, method, path, body, headers) => h.api(method, path, { token: who.token, body, headers });
const soon = mins => new Date(Date.now() + mins * 60000).toISOString();

test.before(async () => {
  await h.prepareDatabase();
  Owner = await h.createWorkspace({ name: 'Follow-up team' });
  A = await h.addMember(Owner.workspaceId, 'Member');
  B = await h.addMember(Owner.workspaceId, 'Member');
  C = await h.addMember(Owner.workspaceId, 'Member');
  Other = await h.createWorkspace({ name: 'Elsewhere' });
  const r = await call(A, 'POST', '/api/v1/leads', { name: 'Priya Shah', email: 'priya@shop.io', phone: '+61 412 345 678' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  lead = r.data.lead;
  // B can view (shared view only); C has no access.
  assert.equal((await call(Owner, 'PUT', `/api/v1/leads/${lead.id}/access`, { userIds: [B.userId], level: 'view' })).status, 200);
});
test.after(() => h.shutdown());

let fu;

test('schedule, edit, reschedule, complete and cancel follow-ups (owner); assignees must be able to work on the lead', async () => {
  const bad = await call(A, 'POST', `/api/v1/leads/${lead.id}/followups`, { title: 'x', type: 'fax', dueAt: soon(60) });
  assert.equal(bad.status, 400);
  assert.equal((await call(A, 'POST', `/api/v1/leads/${lead.id}/followups`, { title: 'Call back', type: 'call', dueAt: soon(60), assignedUserId: C.userId })).data.code, 'ASSIGNEE_NO_ACCESS');
  const r = await call(A, 'POST', `/api/v1/leads/${lead.id}/followups`, { title: 'Call back about pricing', type: 'call', dueAt: soon(60), priority: 'high', description: 'Asked for a quote', reminderMinutes: 15 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  fu = r.data.followup;
  assert.deepEqual([fu.status, fu.priority, fu.assignedUserId], ['pending', 'high', A.userId]);

  const res = await call(A, 'PATCH', `/api/v1/leads/${lead.id}/followups/${fu.id}`, { dueAt: soon(-30) });
  assert.equal(res.data.followup.status, 'overdue', 'past due and pending shows as overdue');
  const done = await call(A, 'PATCH', `/api/v1/leads/${lead.id}/followups/${fu.id}`, { action: 'complete', completionNotes: 'Sent the quote' });
  assert.deepEqual([done.data.followup.status, done.data.followup.completionNotes], ['completed', 'Sent the quote']);
  assert.equal((await call(A, 'PATCH', `/api/v1/leads/${lead.id}/followups/${fu.id}`, { action: 'cancel' })).status, 409);
  const other = (await call(A, 'POST', `/api/v1/leads/${lead.id}/followups`, { title: 'Meeting', type: 'meeting', dueAt: soon(120) })).data.followup;
  assert.equal((await call(A, 'PATCH', `/api/v1/leads/${lead.id}/followups/${other.id}`, { action: 'cancel' })).data.followup.status, 'cancelled');
  const actions = (await db().all("SELECT action FROM audit_logs WHERE workspace_id = ? AND resource_id = ? AND action LIKE 'leads.followup%'", [Owner.workspaceId, String(lead.id)])).map(x => x.action);
  for (const a of ['leads.followup_scheduled', 'leads.followup_rescheduled', 'leads.followup_completed', 'leads.followup_cancelled']) assert.ok(actions.includes(a), a);
});

test('notes and activities: owner adds, edits and deletes; a next-follow-up date schedules one', async () => {
  const n = await call(A, 'POST', `/api/v1/leads/${lead.id}/activities`, { type: 'note', noteCategory: 'objections', description: 'Price is high for them' });
  assert.equal(n.status, 200, JSON.stringify(n.data));
  assert.equal((await call(A, 'POST', `/api/v1/leads/${lead.id}/activities`, { type: 'note', description: '' })).status, 400);
  const ed = await call(A, 'PATCH', `/api/v1/leads/${lead.id}/activities/${n.data.activity.id}`, { description: 'Price is high; wants a discount' });
  assert.equal(ed.data.activity.description, 'Price is high; wants a discount');
  const m = await call(A, 'POST', `/api/v1/leads/${lead.id}/activities`, { type: 'meeting', title: 'Demo', description: 'Walked through the app', durationMinutes: 30, nextFollowupAt: soon(60 * 24) });
  assert.ok(m.data.followup?.id, 'follow-up scheduled from the activity');
  const notes = (await call(A, 'GET', `/api/v1/leads/${lead.id}/notes`)).data;
  assert.equal(notes.notes.length, 1);
  assert.equal(notes.canEdit, true);
  const tmp = await call(A, 'POST', `/api/v1/leads/${lead.id}/activities`, { type: 'whatsapp', title: 'Sent brochure' });
  assert.equal((await call(A, 'DELETE', `/api/v1/leads/${lead.id}/activities/${tmp.data.activity.id}`)).status, 200);
});

test('view-only access reads the history but cannot change it; no access sees nothing; other workspaces are refused', async () => {
  assert.equal((await call(B, 'GET', `/api/v1/leads/${lead.id}/timeline`)).status, 200);
  assert.equal((await call(B, 'GET', `/api/v1/leads/${lead.id}/followup-summary`)).data.canAct, false);
  assert.equal((await call(B, 'GET', `/api/v1/leads/${lead.id}/notes`)).data.canEdit, false);
  for (const [m, p, body] of [['POST', 'followups', { title: 'x', type: 'call', dueAt: soon(5) }], ['POST', 'activities', { type: 'note', description: 'x' }], ['PATCH', `followups/${fu.id}`, { action: 'reopen' }]]) {
    assert.equal((await call(B, m, `/api/v1/leads/${lead.id}/${p}`, body)).status, 403, `view-only ${m} ${p}`);
  }
  for (const who of [C, Other]) {
    for (const p of ['timeline', 'followup-summary', 'notes']) assert.equal((await call(who, 'GET', `/api/v1/leads/${lead.id}/${p}`)).status, 404, p);
    assert.equal((await call(who, 'POST', `/api/v1/leads/${lead.id}/followups`, { title: 'x', type: 'call', dueAt: soon(5) })).status, 404);
  }
});

test('a call from the lead (existing 📞) is linked to the lead and its follow-up, transcribed (mocked) and shown with the emails', async () => {
  process.env.TELNYX_WEBRTC_API_KEY = 'KEY_TEST';
  process.env.TELNYX_WEBRTC_CONNECTION_ID = 'conn-1';
  process.env.TELNYX_CALLER_ID = '+61390000000';
  const access = require('../modules/crm/crmAccess');
  await access.grant(A.userId, 'sales');
  await access.grant(C.userId, 'sales');
  const task = (await call(A, 'POST', `/api/v1/leads/${lead.id}/followups`, { title: 'Call Priya', type: 'call', dueAt: soon(10) })).data.followup;

  const mock = h.mockFetch([
    { match: u => u.endsWith('/telephony_credentials'), respond: () => h.json(200, { data: { id: 'cred-1' } }) },
    { match: u => u.includes('/telephony_credentials/cred-1/token'), respond: () => h.json(200, { data: { token: 'tok' } }) },
    { match: u => u.includes('/ai/audio/transcriptions'), respond: () => h.json(200, { segments: [{ start: 1, end: 3, text: 'Hi Priya, following up on the quote.' }] }) }
  ]);
  try {
    assert.equal((await call(C, 'POST', '/api/v1/calling/token', { to: lead.phone, leadId: lead.id })).status, 404, 'calling grant alone is not lead access');
    assert.equal((await call(B, 'POST', '/api/v1/calling/token', { to: lead.phone, leadId: lead.id })).status, 403, 'no calling permission');
    const s = await call(A, 'POST', '/api/v1/calling/token', { to: lead.phone, name: lead.name, leadId: lead.id, followupId: task.id, transcribe: true });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    const logId = s.data.callLogId;
    const row = await db().get('SELECT lead_id, lead_workspace_id, followup_id FROM crm_call_logs WHERE id = ?', [logId]);
    assert.deepEqual([row.lead_id, row.lead_workspace_id, row.followup_id], [lead.id, Owner.workspaceId, task.id]);
    assert.equal((await call(A, 'POST', `/api/v1/calling/logs/${logId}/end`, { durationSeconds: 95, answered: true, audioCaptured: true })).status, 200);
    for (const track of ['agent', 'customer']) {
      const up = await h.api('POST', `/api/v1/calling/logs/${logId}/audio/${track}`, { token: A.token, rawBody: Buffer.from('fake-audio'), headers: { 'Content-Type': 'audio/webm' } });
      assert.equal(up.status, 200, JSON.stringify(up.data));
    }
  } finally { mock.restore(); }

  const done = (await call(A, 'GET', `/api/v1/leads/${lead.id}/timeline?types=followup`)).data.items.find(i => i.id === task.id);
  assert.equal(done.status, 'completed', 'the answered call completed its follow-up');
  assert.ok(done.callLogId);

  // An email to the lead's address (Sent Mail) is part of the same history.
  await db().run("INSERT INTO emails (workspace_id, sender, sender_email, recipient_email, recipient_name, subject, body, status, sent_at) VALUES (?, 'Me', 'me@co.io', 'priya@shop.io', 'Priya', 'Your quote', 'Here it is', 'Sent', UTC_TIMESTAMP())", [Owner.workspaceId]);
  const t = (await call(B, 'GET', `/api/v1/leads/${lead.id}/timeline`)).data.items;
  const c = t.find(i => i.kind === 'call');
  assert.equal(c.durationSeconds, 95);
  assert.equal(c.conversation.length, 2);
  assert.ok(t.some(i => i.kind === 'email' && i.title === 'Your quote'));
  assert.deepEqual((await call(A, 'GET', `/api/v1/leads/${lead.id}/timeline?types=email`)).data.items.map(i => i.kind), ['email']);

  const sum = (await call(A, 'GET', `/api/v1/leads/${lead.id}/followup-summary`)).data;
  assert.equal(sum.totalCalls, 1);
  assert.equal(sum.totalEmails, 1);
  assert.ok(sum.completedFollowups >= 2);
  assert.ok(['call', 'email'].includes(sum.lastContacted.type));
  assert.match(sum.lastCall.transcriptStart, /following up on the quote/);
  assert.ok(sum.nextFollowup, 'the meeting follow-up is next');
});

test('the notification list: my overdue and newly assigned follow-ups, only on leads I can see', async () => {
  // The owner shares the lead with C (manage) and assigns C an overdue follow-up.
  await call(Owner, 'PUT', `/api/v1/leads/${lead.id}/access`, { userIds: [C.userId], level: 'manage' });
  await call(Owner, 'POST', `/api/v1/leads/${lead.id}/followups`, { title: 'Chase', type: 'email', dueAt: soon(-60), assignedUserId: C.userId });
  const mine = (await call(C, 'GET', '/api/v1/leads/followups/mine')).data;
  assert.equal(mine.overdue.length, 1);
  assert.equal(mine.overdue[0].leadName, 'Priya Shah');
  assert.equal(mine.newlyAssigned.length, 1);
  await call(Owner, 'DELETE', `/api/v1/leads/${lead.id}/access/${C.userId}`);
  const after = (await call(C, 'GET', '/api/v1/leads/followups/mine')).data;
  assert.equal(after.overdue.length, 0, 'not shown once the lead is no longer visible');
});
