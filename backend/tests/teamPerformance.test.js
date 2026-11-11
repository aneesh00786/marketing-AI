const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Team performance: per-member figures from recorded activity; Owners/Admins see all, others only themselves.
const db = () => h.db();
let Owner, A, B, Other;
const call = (who, method, path, body) => h.api(method, path, { token: who.token, body });
const ago = d => new Date(Date.now() - d * 86400000).toISOString().slice(0, 19).replace('T', ' ');
const ahead = d => new Date(Date.now() + d * 86400000).toISOString().slice(0, 19).replace('T', ' ');

test.before(async () => {
  await h.prepareDatabase();
  Owner = await h.createWorkspace({ name: 'Perf team' });
  A = await h.addMember(Owner.workspaceId, 'Marketing Manager');
  B = await h.addMember(Owner.workspaceId, 'Member');
  Other = await h.createWorkspace({ name: 'Perf other' });
  const W = Owner.workspaceId;
  const { run } = db();
  const lead = async (owner, status = 'New', extra = {}) => (await run(
    `INSERT INTO leads (workspace_id, name, status, owner_user_id, created_by_user_id, lead_source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [W, extra.name || `Lead ${Math.random()}`, status, owner, extra.creator ?? owner, extra.source || 'manual', extra.created || ago(3)])).lastID;
  // A: 4 leads (1 Won, 1 Lost), one never contacted.
  const a1 = await lead(A.userId, 'Won');
  const a2 = await lead(A.userId, 'Lost', { source: 'import' });
  const a3 = await lead(A.userId, 'Qualified');
  await lead(A.userId, 'New', { name: 'Untouched lead' });
  // B: 1 lead, created by the owner and given to B 2 days ago.
  const b1 = await lead(B.userId, 'New', { creator: Owner.userId });
  await run("INSERT INTO audit_logs (workspace_id, actor_user_id, action, resource_type, resource_id, metadata_json, created_at) VALUES (?, ?, 'leads.owner_changed', 'lead', ?, ?, ?)",
    [W, Owner.userId, String(b1), JSON.stringify({ previous: null, owner: B.userId }), ago(2)]);
  // Follow-ups for A: on time, late, overdue now, upcoming.
  const fu = (lead, assignee, due, status, completed) => run(
    `INSERT INTO lead_followups (workspace_id, lead_id, assigned_user_id, followup_type, title, priority, due_at, status, completed_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'call', 'Call', 'medium', ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [W, lead, assignee, due, status, completed, assignee]);
  await fu(a1, A.userId, ago(5), 'completed', ago(6));
  await fu(a2, A.userId, ago(4), 'completed', ago(3));
  await fu(a3, A.userId, ago(1), 'pending', null);
  await fu(a3, A.userId, ahead(2), 'pending', null);
  // Calls by A (from leads of this workspace) and B, and a call by A in another workspace (not counted).
  const callRow = (user, lead, answered, secs, ws = W) => run(
    `INSERT INTO crm_call_logs (user_id, phone, transcribe, transcript_status, answered, duration_seconds, lead_id, lead_workspace_id, started_at, ended_at)
     VALUES (?, '+61400000000', 1, ?, ?, ?, ?, ?, ?, ?)`, [user, answered ? 'done' : 'none', answered ? 1 : 0, secs, lead, ws, ago(2), ago(2)]);
  await callRow(A.userId, a1, true, 300);
  await callRow(A.userId, a2, false, 0);
  await callRow(A.userId, a3, true, 120);
  await callRow(B.userId, b1, true, 60);
  // Notes and activities.
  for (const [type, user, ld] of [['note', A.userId, a1], ['meeting', A.userId, a1], ['whatsapp', B.userId, b1]]) {
    await run(`INSERT INTO lead_activities (workspace_id, lead_id, activity_type, description, activity_at, performed_by, created_at, updated_at) VALUES (?, ?, ?, 'x', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [W, ld, type, ago(1), user]);
  }
  // A sent two one-to-one emails (Sent mail with its sender), B made a social post.
  for (let i = 0; i < 2; i++) await run("INSERT INTO emails (workspace_id, sender_email, recipient_email, subject, body, status, sent_at, smtp_status, sent_by_user_id) VALUES (?, 'a@co.io', ?, 'Hi', 'x', 'Sent', ?, 'sent', ?)", [W, `client${i}@client.io`, ago(1), A.userId]);
  await run("INSERT INTO content_items (workspace_id, content_type, title, platform, status, version, source, created_by, created_at) VALUES (?, 'post', 'Hello', 'facebook', 'draft', 1, 'social_hub', ?, ?)", [W, B.userId, ago(1)]).catch(() => null);
});
test.after(() => h.shutdown());

const memberOf = (r, who) => r.data.members.find(m => m.userId === who.userId);

test('Owners see every member with leads, follow-ups, calls, activities and emails counted from records', async () => {
  const r = await call(Owner, 'GET', '/api/v1/performance');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.scope, 'team');
  assert.equal(r.data.members.length, 3);
  const a = memberOf(r, A);
  assert.deepEqual([a.leads.assigned, a.leads.won, a.leads.lost, a.leads.conversionRate, a.leads.imported, a.leads.neverContacted], [4, 1, 1, 25, 1, 1]);
  assert.deepEqual([a.followups.due, a.followups.completed, a.followups.onTime, a.followups.late, a.followups.onTimeRate, a.followups.overdueNow, a.followups.upcoming], [3, 2, 1, 1, 50, 1, 1]);
  assert.deepEqual([a.calls.made, a.calls.answered, a.calls.answerRate, a.calls.talkMinutes, a.calls.transcribed], [3, 2, 66.7, 7, 2]);
  assert.deepEqual([a.activities.notes, a.activities.meetings, a.activities.total], [1, 1, 2]);
  assert.equal(a.emails.sent, 2);
  assert.equal(a.email, A.email ?? a.email, 'the address is not overwritten by the email figures');
  const b = memberOf(r, B);
  assert.deepEqual([b.leads.assigned, b.leads.assignedInPeriod, b.leads.created], [1, 1, 0]);
  assert.equal(b.leads.firstContact.given, 1);
  assert.equal(b.leads.firstContact.contacted, 1, 'the call after the lead was given counts as first contact');
  assert.equal(b.activities.whatsapp, 1);
  assert.equal(r.data.totals.calls.made, 4);
  assert.equal(r.data.totals.followups.overdueNow, 1);
});

test('the period filters what happened in it; "overdue now" and "never contacted" stay current', async () => {
  const old = await call(Owner, 'GET', '/api/v1/performance?from=2020-01-01&to=2020-01-31');
  const a = memberOf(old, A);
  assert.deepEqual([a.calls.made, a.followups.due, a.emails.sent, a.activities.total], [0, 0, 0, 0]);
  assert.equal(a.followups.overdueNow, 1);
  assert.equal(a.leads.neverContacted, 1);
  assert.equal((await call(Owner, 'GET', '/api/v1/performance?from=2026-02-01&to=2026-01-01')).status, 400);
});

test('a member sees only their own figures and their own open work; other workspaces see nothing of this one', async () => {
  const r = await call(B, 'GET', '/api/v1/performance');
  assert.equal(r.data.scope, 'self');
  assert.deepEqual(r.data.members.map(m => m.userId), [B.userId]);
  assert.equal((await call(B, 'GET', `/api/v1/performance/members/${A.userId}`)).status, 403);
  const mine = await call(B, 'GET', `/api/v1/performance/members/${B.userId}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.data.calls.length, 1);
  const detail = await call(Owner, 'GET', `/api/v1/performance/members/${A.userId}`);
  assert.equal(detail.data.overdueFollowups.length, 1);
  assert.deepEqual(detail.data.neverContactedLeads.map(l => l.leadName), ['Untouched lead']);
  assert.equal(detail.data.completedFollowups.filter(f => f.onTime).length, 1);
  const other = await call(Other, 'GET', '/api/v1/performance');
  assert.deepEqual(other.data.members.map(m => m.userId), [Other.userId]);
  assert.equal(other.data.members[0].calls.made, 0);
  assert.equal((await call(Other, 'GET', `/api/v1/performance/members/${A.userId}`)).status, 404);
});

test('drill-down: trend per day, every lead / follow-up / activity, and a connected call opens with its transcript', async () => {
  const r = await call(Owner, 'GET', '/api/v1/performance');
  const days = r.data.daily;
  assert.equal(days.length, 30);
  assert.equal(days.reduce((a, d) => a + d.calls, 0), 4, 'all four calls of the team are in the trend');
  const d = (await call(Owner, 'GET', `/api/v1/performance/members/${A.userId}`)).data;
  assert.equal(d.leads.length, 4);
  assert.equal(d.leads.filter(l => !l.lastContact).length, 1);
  assert.deepEqual(d.followups.map(f => f.status).sort(), ['completed', 'completed', 'overdue', 'pending']);
  assert.deepEqual(d.activities.map(a => a.type).sort(), ['meeting', 'note']);
  assert.equal(d.daily.reduce((a, x) => a + x.calls, 0), 3);

  const connected = d.calls.find(c => c.answered);
  await db().run('UPDATE crm_call_logs SET agent_segments = ?, customer_segments = ? WHERE id = ?',
    [JSON.stringify([{ start: 1, end: 2, text: 'Hi, this is A.' }]), JSON.stringify([{ start: 3, end: 4, text: 'Hello.' }]), connected.id]);
  const t = await call(Owner, 'GET', `/api/v1/performance/calls/${connected.id}`);
  assert.equal(t.status, 200, JSON.stringify(t.data));
  assert.deepEqual(t.data.call.conversation.map(l => `${l.speaker}: ${l.text}`), ['agent: Hi, this is A.', 'customer: Hello.']);
  assert.equal((await call(A, 'GET', `/api/v1/performance/calls/${connected.id}`)).status, 200, 'the caller sees their own call');
  assert.equal((await call(B, 'GET', `/api/v1/performance/calls/${connected.id}`)).status, 404, 'another member does not');
  assert.equal((await call(Other, 'GET', `/api/v1/performance/calls/${connected.id}`)).status, 404, 'another workspace does not');
  assert.ok(await db().get("SELECT id FROM audit_logs WHERE action = 'performance.transcript_viewed' AND resource_id = ?", [String(connected.id)]));
});

// ------------------------------------------------------------------ Phase 1 audit fixes

const crypto = require('crypto');
const zepto = calls => ({ match: u => u.startsWith('https://api.zeptomail.com/'), respond: (u, init) => { calls.push(JSON.parse(init.body)); return h.json(200, { request_id: `r-${calls.length}` }); } });

test('a Compose email (also from the lead panel) records its sender, counts for them and contacts the lead', async () => {
  const C = await h.createWorkspace({ name: 'Perf compose' });
  assert.equal((await h.api('POST', '/api/v1/mail/config', { token: C.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: 'z-perf', sender_email: 'hello@perf.io', sender_name: 'N' } })).status, 200);
  const leadId = (await db().run("INSERT INTO leads (workspace_id, name, email, status, owner_user_id, created_by_user_id, lead_source, created_at) VALUES (?, 'Kim', 'kim@client.io', 'New', ?, ?, 'manual', ?)",
    [C.workspaceId, C.userId, C.userId, ago(1)])).lastID;
  let before = memberOf(await call(C, 'GET', '/api/v1/performance'), C);
  assert.equal(before.leads.neverContacted, 1);
  const calls = [];
  const mock = h.mockFetch([zepto(calls)]);
  try {
    const r = await h.api('POST', '/api/v1/emails/send', { token: C.token, headers: { 'Idempotency-Key': crypto.randomBytes(16).toString('hex') },
      body: { recipient_email: 'KIM@client.io', subject: 'Your quote', body: 'Here is the quote for order 12.', purpose: 'transactional', confirm: true } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  } finally { mock.restore(); }
  assert.equal(calls.length, 1, 'sent through the mocked provider only');
  const row = await db().get("SELECT sent_by_user_id FROM emails WHERE workspace_id = ? AND recipient_email = 'KIM@client.io'", [C.workspaceId]);
  assert.equal(row.sent_by_user_id, C.userId);
  const after = memberOf(await call(C, 'GET', '/api/v1/performance'), C);
  assert.equal(after.emails.sent, 1);
  assert.equal(after.leads.neverContacted, 0, 'the email to the lead\'s address is contact');
  assert.equal(after.leads.firstContact.contacted, 1, 'first contact of a lead they created themselves');
  const d = (await call(C, 'GET', `/api/v1/performance/members/${C.userId}`)).data;
  assert.equal(d.emails.length, 1);
  assert.equal(d.emails[0].leadId, leadId);
  assert.ok(d.leads[0].lastContact);
});

test('Activity per Day counts each email once (product emails are not added twice) and matches the summary', async () => {
  const W = Owner.workspaceId;
  const batch = (await db().run("INSERT INTO email_drafts (workspace_id, recipient_email, subject, body, status, batch_id, created_at) VALUES (?, 'p@client.io', 'Product', 'x', 'Sent', 'batch-1', UTC_TIMESTAMP())", [W]).catch(() => null));
  const e = await db().run("INSERT INTO emails (workspace_id, sender_email, recipient_email, subject, body, status, sent_at, smtp_status, sent_by_user_id) VALUES (?, 'a@co.io', 'p@client.io', 'Product', 'x', 'Sent', ?, 'sent', ?)", [W, ago(1), A.userId]);
  if (batch) await db().run('UPDATE email_drafts SET email_id = ? WHERE id = ?', [e.lastID, batch.lastID]);
  const r = await call(Owner, 'GET', '/api/v1/performance');
  const a = memberOf(r, A);
  if (batch) assert.deepEqual([a.emails.sent, a.emails.productEmails], [2, 1]);
  const dayEmails = r.data.daily.reduce((s, x) => s + x.emails, 0);
  const sum = r.data.members.reduce((s, m) => s + m.emails.sent + m.emails.productEmails, 0);
  assert.equal(dayEmails, sum, 'the trend and the totals agree');
  if (batch) { await db().run('DELETE FROM email_drafts WHERE id = ?', [batch.lastID]); }
  await db().run('DELETE FROM emails WHERE id = ?', [e.lastID]);
});

test('migration 058 links an older call to its lead only when the number matches exactly one lead', async () => {
  const W = Owner.workspaceId;
  const lone = (await db().run("INSERT INTO leads (workspace_id, name, phone, status, owner_user_id, created_by_user_id, lead_source, created_at) VALUES (?, 'Phone lead', '+91 98765 43210', 'New', ?, ?, 'manual', ?)", [W, B.userId, B.userId, ago(3)])).lastID;
  const c1 = (await db().run("INSERT INTO crm_call_logs (user_id, phone, transcribe, transcript_status, answered, duration_seconds, started_at, ended_at) VALUES (?, '09876543210', 0, 'none', 1, 30, ?, ?)", [B.userId, ago(2), ago(2)])).lastID;
  const c2 = (await db().run("INSERT INTO crm_call_logs (user_id, phone, transcribe, transcript_status, answered, duration_seconds, started_at, ended_at) VALUES (?, '+1 555 000 1111', 0, 'none', 1, 30, ?, ?)", [B.userId, ago(2), ago(2)])).lastID;
  // Re-run the migration's data steps (the schema is already in place).
  await require('../migrations/058_email_sender_and_call_links').up({
    query: (sql, p = []) => db().run(sql, p), tableExists: async () => true, columnInfo: async () => true,
    ensureColumn: async () => false, ensureIndex: async () => false
  });
  const r1 = await db().get('SELECT lead_id, lead_workspace_id FROM crm_call_logs WHERE id = ?', [c1]);
  assert.deepEqual([r1.lead_id, r1.lead_workspace_id], [lone, W]);
  assert.equal((await db().get('SELECT lead_id FROM crm_call_logs WHERE id = ?', [c2])).lead_id, null);
  const b = memberOf(await call(Owner, 'GET', '/api/v1/performance'), B);
  assert.equal(b.calls.made, 2, 'the linked older call now counts for B');
  await db().run('DELETE FROM crm_call_logs WHERE id IN (?, ?)', [c1, c2]);
  await db().run('DELETE FROM leads WHERE id = ?', [lone]);
});

test('dates and periods follow the workspace timezone (Asia/Kolkata)', async () => {
  const T = await h.createWorkspace({ name: 'Perf tz' });
  await db().run("UPDATE workspaces SET timezone = 'Asia/Kolkata' WHERE id = ?", [T.workspaceId]);
  const lead = (await db().run("INSERT INTO leads (workspace_id, name, status, owner_user_id, created_by_user_id, lead_source, created_at) VALUES (?, 'TZ', 'New', ?, ?, 'manual', '2025-03-01 00:00:00')", [T.workspaceId, T.userId, T.userId])).lastID;
  // 20:00 UTC on 10 March is 01:30 on 11 March in India.
  await db().run("INSERT INTO crm_call_logs (user_id, phone, transcribe, transcript_status, answered, duration_seconds, lead_id, lead_workspace_id, started_at, ended_at) VALUES (?, '+919800000000', 0, 'none', 1, 60, ?, ?, '2025-03-10 20:00:00', '2025-03-10 20:01:00')", [T.userId, lead, T.workspaceId]);
  const on = d => call(T, 'GET', `/api/v1/performance?from=${d}&to=${d}`);
  const r10 = await on('2025-03-10'); const r11 = await on('2025-03-11');
  assert.equal(r11.data.timezone, 'Asia/Kolkata');
  assert.equal(memberOf(r10, T).calls.made, 0);
  assert.equal(memberOf(r11, T).calls.made, 1);
  assert.deepEqual(r11.data.daily.map(x => [x.day, x.calls]), [['2025-03-11', 1]]);
});

test('a removed member keeps their history in the report, marked as former', async () => {
  const W = Owner.workspaceId;
  const F = await h.addMember(W, 'Member');
  await db().run("INSERT INTO lead_activities (workspace_id, lead_id, activity_type, description, activity_at, performed_by, created_at, updated_at) SELECT ?, id, 'call', 'x', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP() FROM leads WHERE workspace_id = ? LIMIT 1", [W, ago(1), F.userId, W]);
  await db().run("UPDATE workspace_members SET status = 'Removed' WHERE workspace_id = ? AND user_id = ?", [W, F.userId]);
  const r = await call(Owner, 'GET', '/api/v1/performance');
  const f = memberOf(r, F);
  assert.ok(f, 'still listed');
  assert.equal(f.former, true);
  assert.equal(f.activities.total, 1);
  assert.equal(memberOf(r, A).former, false);
  const d = await call(Owner, 'GET', `/api/v1/performance/members/${F.userId}`);
  assert.equal(d.status, 200);
  assert.equal(d.data.member.former, true);
  // Long ago, with nothing then and no leads: not listed.
  const old = await call(Owner, 'GET', '/api/v1/performance?from=2020-01-01&to=2020-01-31');
  assert.equal(memberOf(old, F), undefined);
  await db().run('DELETE FROM lead_activities WHERE performed_by = ?', [F.userId]);
});

test('team view for a Marketing Manager is a per-member permission, enforced on the server', async () => {
  assert.equal((await call(A, 'GET', '/api/v1/performance')).data.scope, 'self');
  assert.equal((await call(A, 'GET', `/api/v1/performance/members/${B.userId}`)).status, 403);
  assert.equal((await call(A, 'GET', '/api/v1/performance/export')).data.members.length, 1, 'export follows the same scope');
  assert.equal((await h.api('PUT', `/api/v1/workspace/members/${A.userId}/grants/performance.view_team`, { token: Owner.token })).status, 200);
  const r = await call(A, 'GET', '/api/v1/performance');
  assert.equal(r.data.scope, 'team');
  assert.ok(r.data.members.length >= 3);
  assert.equal((await call(A, 'GET', `/api/v1/performance/members/${B.userId}`)).status, 200);
  assert.equal((await h.api('PUT', `/api/v1/workspace/members/${B.userId}/grants/performance.view_team`, { token: A.token })).status, 403, 'only Owners/Admins grant it');
  assert.equal((await h.api('DELETE', `/api/v1/workspace/members/${A.userId}/grants/performance.view_team`, { token: Owner.token })).status, 200);
  assert.equal((await call(A, 'GET', '/api/v1/performance')).data.scope, 'self');
});

test('drill-down lists say how many there are in all when they are cut', async () => {
  const d = (await call(Owner, 'GET', `/api/v1/performance/members/${A.userId}`)).data;
  assert.equal(d.limits.perList, 300);
  assert.equal(d.limits.leads, d.leads.length, 'nothing cut: the counts match the lists');
  assert.equal(d.limits.calls, d.calls.length);
  assert.equal(d.limits.followups, d.followups.length);
  assert.equal(d.limits.activities, d.activities.length);
  assert.equal(d.limits.emails, d.emails.length);
});

test('the Excel export holds the records behind the summary and its totals match the dashboard', async () => {
  const dash = await call(Owner, 'GET', '/api/v1/performance');
  const x = await call(Owner, 'GET', '/api/v1/performance/export');
  assert.equal(x.status, 200);
  const a = memberOf(x, A);
  assert.deepEqual(a, memberOf(dash, A), 'same summary as the dashboard');
  const mine = (sheet, who) => x.data.sheets[sheet].rows.filter(r => r.userId === who.userId);
  assert.equal(mine('calls', A).length, a.calls.made);
  assert.equal(mine('leads', A).length, a.leads.assigned);
  assert.equal(mine('activities', A).length, a.activities.total);
  assert.equal(mine('emails', A).filter(e => e.kind === 'Individual').length, a.emails.sent);
  assert.equal(x.data.sheets.calls.truncated, false);
  assert.ok(await db().get("SELECT id FROM audit_logs WHERE action = 'performance.exported' AND workspace_id = ?", [Owner.workspaceId]));
  const other = await call(Other, 'GET', '/api/v1/performance/export');
  assert.equal(other.data.sheets.calls.rows.length, 0, 'another workspace exports nothing of this one');
});

// ------------------------------------------------------------------ Phase 2: individual staff report

test('the individual report agrees with the team report and breaks leads, calls and days down from records', async () => {
  const { previous, ...team } = memberOf(await call(Owner, 'GET', '/api/v1/performance'), A);
  assert.ok(previous, 'each member carries the previous period too');
  const d = (await call(Owner, 'GET', `/api/v1/performance/members/${A.userId}`)).data;
  const { previous: summaryPrev, ...summary } = d.summary;
  assert.deepEqual(summary, team, 'same figures in the staff report as in the team report');
  assert.deepEqual(summaryPrev.score, previous.score, 'and the same previous-period score');
  assert.deepEqual([d.summary.leads.contacted, d.summary.leads.neverContacted], [3, 1]);
  assert.deepEqual([d.summary.calls.missed, d.summary.calls.leadsCalled, d.summary.calls.perLead], [1, 3, 1]);
  assert.deepEqual([d.summary.followups.pending, d.summary.followups.avgDelayHours], [1, 24]);
  assert.equal(d.leadStatus.reduce((a, x) => a + x.count, 0), d.summary.leads.assigned);
  const imp = d.leadSources.find(x => x.source === 'import');
  assert.deepEqual([imp.count, imp.lost, imp.contacted], [1, 1, 1]);
  assert.deepEqual([d.callOutcomes.connected, d.callOutcomes.notAnswered], [2, 1]);
  assert.equal(d.callOutcomes.connected + d.callOutcomes.notAnswered, d.summary.calls.made);
  assert.equal(d.callSummaries.available, false, 'no AI summaries are claimed');
  const sum = k => d.daily.reduce((a, x) => a + x[k], 0);
  assert.equal(sum('calls'), d.summary.calls.made);
  assert.equal(sum('notes'), 1);
  assert.equal(sum('meetings'), 1);
  assert.equal(sum('leadsCreated'), 4);
  assert.ok(sum('leadsContacted') >= 3, 'each lead called is contacted that day');
  const b = (await call(Owner, 'GET', `/api/v1/performance/members/${B.userId}`)).data;
  assert.equal(b.daily.reduce((a, x) => a + x.leadsAssigned, 0), 1, 'the lead given to B');
});

test('record lists are paged and filtered on the server', async () => {
  const rec = (kind, qs = '') => call(Owner, 'GET', `/api/v1/performance/members/${A.userId}/records/${kind}?${qs}`);
  const p1 = (await rec('leads', 'pageSize=2')).data;
  const p2 = (await rec('leads', 'pageSize=2&page=2')).data;
  assert.deepEqual([p1.total, p1.rows.length, p2.rows.length], [4, 2, 2]);
  assert.equal(new Set([...p1.rows, ...p2.rows].map(r => r.leadId)).size, 4, 'no lead on two pages');
  assert.deepEqual((await rec('leads', 'status=Won')).data.rows.map(r => r.status), ['Won']);
  assert.deepEqual((await rec('leads', 'contacted=no')).data.rows.map(r => r.leadName), ['Untouched lead']);
  assert.equal((await rec('leads', 'source=import')).data.total, 1);
  assert.equal((await rec('leads', 'createdFrom=2020-01-01&createdTo=2020-01-31')).data.total, 0);
  const bAssigned = await call(Owner, 'GET', `/api/v1/performance/members/${B.userId}/records/leads?assignedFrom=${ago(2).slice(0, 10)}`);
  assert.equal(bAssigned.data.total, 1);
  assert.equal((await rec('followups', 'status=overdue')).data.total, 1);
  assert.equal((await rec('followups', 'status=late')).data.rows[0].lateMinutes, 1440);
  assert.equal((await rec('calls', 'answered=no')).data.total, 1);
  assert.equal((await rec('activities', 'type=note')).data.total, 1);
  assert.equal((await rec('emails', 'kind=individual')).data.total, 2);
  assert.equal((await rec('nope')).status, 400);
  assert.equal((await call(B, 'GET', `/api/v1/performance/members/${A.userId}/records/leads`)).status, 403);
  assert.equal((await call(Other, 'GET', `/api/v1/performance/members/${A.userId}/records/calls`)).status, 404);
});

test('picking a day shows what the member actually did that day', async () => {
  const day = ago(2).slice(0, 10);
  const r = await call(Owner, 'GET', `/api/v1/performance/members/${A.userId}/day?date=${day}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.calls.length, 3);
  assert.equal((await call(Owner, 'GET', `/api/v1/performance/members/${B.userId}/day?date=${day}`)).data.leadsAssigned.length, 1);
  assert.equal((await call(Owner, 'GET', `/api/v1/performance/members/${A.userId}/day?date=bad`)).status, 400);
  assert.equal((await call(B, 'GET', `/api/v1/performance/members/${A.userId}/day?date=${day}`)).status, 403);
});

// ------------------------------------------------------------------ Phase 3: staff comparison; overview KPIs vs the previous period

test('the team report carries the previous period of the same length, with period-based conversions', async () => {
  const W = Owner.workspaceId;
  const r = await call(Owner, 'GET', '/api/v1/performance?from=2026-03-01&to=2026-03-10');
  assert.deepEqual([r.data.previous.from, r.data.previous.to], ['2026-02-19', '2026-02-28']);
  assert.equal(r.data.previous.daily.length, 10, 'the previous period day by day, for the trend');
  assert.ok(r.data.scoring.thresholds.conversion.target > r.data.scoring.thresholds.conversion.min);
  // A lead of A won now (recorded status change), and one won long ago: only the first counts in this period.
  const won = (await db().run("INSERT INTO leads (workspace_id, name, status, owner_user_id, created_by_user_id, lead_source, created_at) VALUES (?, 'Won now', 'Won', ?, ?, 'manual', ?)", [W, A.userId, A.userId, ago(4)])).lastID;
  const ev = (at, id) => db().run("INSERT INTO automation_events (workspace_id, event_type, subject_type, subject_id, payload_json, idempotency_key, status, created_at) VALUES (?, 'lead.status_changed', 'lead', ?, ?, ?, 'done', ?)",
    [W, id, JSON.stringify({ from: 'New', to: 'Won' }), `t-${id}-${at}`, at]);
  await ev(ago(1), won);
  const now = await call(Owner, 'GET', '/api/v1/performance');
  const a = memberOf(now, A);
  assert.equal(a.leads.wonInPeriod, 1);
  assert.equal(a.previous.leads.wonInPeriod, 0);
  assert.equal(a.leads.contactedInPeriod, 3, 'the three leads A called');
  const t = now.data.totals;
  assert.equal(t.staff, now.data.members.length);
  assert.equal(t.leads.wonInPeriod, 1);
  assert.equal(t.emails.totalSent, t.emails.sent + t.emails.productEmails);
  assert.equal(now.data.previous.totals.calls.made, 0, 'nothing happened in the 30 days before');
  await db().run('DELETE FROM automation_events WHERE subject_id = ? AND workspace_id = ?', [won, W]);
  await db().run('DELETE FROM leads WHERE id = ?', [won]);
});

test('staff comparison: 2–10 members, working days, growth, weekly activity, conversion time; team access only', async () => {
  const cmp = qs => call(Owner, 'GET', `/api/v1/performance/compare?${qs}`);
  const r = await cmp(`ids=${A.userId},${B.userId}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.members.map(m => m.userId), [A.userId, B.userId]);
  const a = r.data.members[0];
  const { previous, ...dashA } = memberOf(await call(Owner, 'GET', '/api/v1/performance'), A);
  for (const k of ['leads', 'followups', 'calls', 'emails', 'activities']) assert.deepEqual(a[k], dashA[k], `${k} match the dashboard`);
  assert.ok(a.workingDays > 0 && a.workingDays <= 30);
  assert.equal(a.daily.length, 30);
  assert.equal(a.daily.reduce((s, x) => s + x.calls, 0), a.calls.made);
  assert.equal(a.weekly.reduce((s, x) => s + x.total, 0), a.daily.reduce((s, x) => s + x.total, 0));
  assert.ok(a.activeDays >= 2);
  assert.deepEqual(a.conversion, { avgHours: null, measured: 0 }, 'no recorded wins: nothing measured, nothing made up');
  assert.ok(a.previous && a.previous.calls.made === 0);
  assert.equal(r.data.targets, null);
  // Mon–Sat gives at least as many working days as Mon–Fri.
  assert.ok((await cmp(`ids=${A.userId},${B.userId}&workweek=6`)).data.members[0].workingDays >= a.workingDays);
  assert.equal((await cmp(`ids=${A.userId}`)).status, 400);
  assert.equal((await cmp(`ids=${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].join(',')}`)).status, 400);
  assert.equal((await cmp(`ids=${A.userId},${Other.userId}`)).status, 404, 'someone from another workspace');
  assert.equal((await call(B, 'GET', `/api/v1/performance/compare?ids=${A.userId},${B.userId}`)).status, 403);
  assert.ok(await db().get("SELECT id FROM audit_logs WHERE action = 'performance.compared' AND workspace_id = ?", [Owner.workspaceId]));
});

test('working days count the chosen working week from the day someone joined, never past today', () => {
  const svc = require('../modules/performance/performanceService');
  const p = svc.period({ from: '2025-03-03', to: '2025-03-16' }, 'UTC'); // Mon 3 – Sun 16 March
  assert.equal(svc.workingDays(p, null, 5), 10);
  assert.equal(svc.workingDays(p, null, 6), 12);
  assert.equal(svc.workingDays(p, null, 7), 14);
  assert.equal(svc.workingDays(p, '2025-03-10T09:00:00Z', 5), 5, 'joined on the second Monday');
});

// ------------------------------------------------------------------ Redesign: score, filters, timeline, comparison period

test('performance score: weighted rates from the configured measures; no score without enough data', () => {
  const sc = require('../modules/performance/scoring');
  const cfg = sc.normalise(null);
  const row = { leads: { periodConversionRate: 20, contactedInPeriod: 10, assigned: 10, contacted: 10, firstContact: { medianHours: 4 } }, followups: { onTimeRate: 90, completionRate: 95, completed: 10, due: 10 },
    calls: { answerRate: 10 }, emails: { openRate: null }, productivity: { perDay: 15 } };
  assert.deepEqual([sc.score(row, cfg).score, sc.score(row, cfg).level], [100, 'excellent'], 'every enabled measure at its target');
  const weak = { ...row, leads: { ...row.leads, periodConversionRate: 0 }, followups: { onTimeRate: 50, completionRate: 50, completed: 10, due: 10 } };
  assert.equal(sc.score(weak, cfg).score, 30, 'conversion, on time and completion at their minimum: 0 points for 70 % of the weight');
  assert.equal(sc.score(weak, cfg).level, 'critical');
  const thin = { leads: { periodConversionRate: null, assigned: 0, contacted: 0, firstContact: { medianHours: null } }, followups: { onTimeRate: null, completionRate: null }, calls: {}, emails: {}, productivity: { perDay: 2 } };
  assert.equal(sc.score(thin, cfg).score, null, 'one measure is not enough for a score');
  assert.throws(() => sc.validate({ measures: { conversion: { enabled: true, weight: 50, min: 10, target: 5 } } }), /above the minimum/);
  assert.throws(() => sc.validate({ levels: { excellent: 50, onTrack: 60, needsImprovement: 40 } }), /Levels must go down/);
});

test('every member row carries productivity and its score; admins change the scoring, others cannot', async () => {
  const r = await call(Owner, 'GET', '/api/v1/performance');
  const a = memberOf(r, A);
  assert.ok(a.productivity.workingDays >= 0);
  assert.equal(a.productivity.actions, a.calls.made + a.followups.completed + a.emails.sent + a.emails.productEmails + a.activities.total);
  assert.ok('score' in a.score && Array.isArray(a.score.parts));
  assert.ok(r.data.scoring.levels.excellent > r.data.scoring.levels.onTrack);
  assert.equal(r.data.totals.score.scored, r.data.members.filter(m => m.score.score !== null).length);
  const g = await call(Owner, 'GET', '/api/v1/performance/scoring');
  assert.equal(g.status, 200);
  assert.equal(g.data.canEdit, true);
  const cfg = g.data.config;
  cfg.measures.callAnswer = { enabled: true, weight: 20, min: 20, target: 60 };
  assert.equal((await call(Owner, 'PUT', '/api/v1/performance/scoring', { config: cfg })).status, 200);
  const after = memberOf(await call(Owner, 'GET', '/api/v1/performance'), A);
  assert.ok(after.score.parts.some(p => p.key === 'callAnswer'), 'the new measure is used');
  assert.equal((await call(Owner, 'PUT', '/api/v1/performance/scoring', { config: { measures: { conversion: { enabled: true, weight: 10, min: 5, target: 5 } } } })).status, 400);
  assert.equal((await call(B, 'GET', '/api/v1/performance/scoring')).status, 403);
  assert.equal((await call(A, 'PUT', '/api/v1/performance/scoring', { reset: true })).status, 403);
  assert.equal((await call(Owner, 'PUT', '/api/v1/performance/scoring', { reset: true })).data.config.customised, false);
  assert.equal((await call(Other, 'GET', '/api/v1/performance/scoring')).data.config.customised, false, 'settings are per workspace');
});

test('filters by role and staff change the members, the totals and the trend together', async () => {
  const all0 = await call(Owner, 'GET', '/api/v1/performance');
  assert.ok(all0.data.roles.includes('Marketing Manager'));
  const mm = await call(Owner, 'GET', '/api/v1/performance?role=Marketing%20Manager');
  assert.deepEqual(mm.data.members.map(m => m.userId), [A.userId]);
  assert.equal(mm.data.totals.calls.made, 3);
  assert.equal(mm.data.daily.reduce((s, x) => s + x.calls, 0), 3, 'the trend follows the filter');
  const one = await call(Owner, 'GET', `/api/v1/performance?staff=${B.userId}`);
  assert.deepEqual(one.data.members.map(m => m.userId), [B.userId]);
  assert.equal(one.data.totals.staff, 1);
  const days = all0.data.daily;
  assert.equal(days.reduce((s, x) => s + x.callsConnected, 0), all0.data.totals.calls.answered);
  const sel = await call(Owner, 'GET', `/api/v1/performance/export?ids=${A.userId}`);
  assert.deepEqual(sel.data.members.map(m => m.userId), [A.userId], 'export of selected staff');
  assert.ok(sel.data.sheets.calls.rows.every(c => c.userId === A.userId));
});

test('a chosen comparison period replaces the default previous period', async () => {
  const r = await call(Owner, 'GET', '/api/v1/performance?compareFrom=2020-01-01&compareTo=2020-01-31');
  assert.deepEqual([r.data.previous.from, r.data.previous.to], ['2020-01-01', '2020-01-31']);
});

test('lead list: first contact, overdue follow-ups and the open filter; the activity timeline merges everything', async () => {
  const rec = (kind, qs = '') => call(Owner, 'GET', `/api/v1/performance/members/${A.userId}/records/${kind}?${qs}`);
  const leads = (await rec('leads')).data.rows;
  assert.equal(leads.filter(l => l.firstContactAt).length, 3);
  assert.ok(leads.every(l => !l.firstContactAt || !l.lastContact || new Date(l.firstContactAt) <= new Date(l.lastContact)));
  assert.equal(leads.reduce((s, l) => s + l.overdueFollowups, 0), 1);
  assert.deepEqual((await rec('leads', 'status=open')).data.rows.map(l => l.status).sort(), ['New', 'Qualified']);
  const t = (await rec('timeline', 'pageSize=100')).data;
  assert.equal(t.total, 3 + 2 + 2, 'three calls, two emails, a note and a meeting');
  assert.deepEqual([...new Set(t.rows.map(x => x.kind))].sort(), ['call', 'email', 'meeting', 'note']);
  for (let i = 1; i < t.rows.length; i++) assert.ok(new Date(t.rows[i - 1].at) >= new Date(t.rows[i].at), 'newest first');
  assert.equal((await rec('timeline', 'type=call')).data.total, 3);
});

// ------------------------------------------------------------------ Phase 5: staff targets

test('target rules: cycles, pace and statuses', () => {
  const t = require('../modules/performance/targets');
  assert.deepEqual(t.cycleFor('weekly', '2026-11-11'), { from: '2026-11-09', to: '2026-11-15' });
  assert.deepEqual(t.cycleFor('monthly', '2026-11-11'), { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(t.cycleFor('quarterly', '2026-11-11'), { from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(t.previousCycle('monthly', { from: '2026-11-01', to: '2026-11-30' }), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(t.previousCycle('custom', { from: '2026-11-10', to: '2026-11-19' }), { from: '2026-10-31', to: '2026-11-09' });
  const c = { from: '2026-11-01', to: '2026-11-30' };
  const st = (actual, today, rate = false, target = 20) => t.status({ actual, target, rate, cycle: c, today }).status;
  assert.equal(st(10, '2026-11-15'), 'on_track', 'half the target half way through');
  assert.equal(st(4, '2026-11-15'), 'at_risk');
  assert.equal(st(0, '2026-11-03'), 'not_started');
  assert.equal(st(20, '2026-11-15'), 'achieved');
  assert.equal(st(23, '2026-11-15'), 'exceeded');
  assert.equal(st(15, '2026-12-02'), 'missed', 'the month ended short');
  assert.equal(st(5, '2026-10-20'), 'not_started', 'the month has not begun');
  assert.equal(st(85, '2026-11-15', true, 80), 'achieved', 'a rate is judged against the target, not the pace');
  assert.equal(st(70, '2026-11-15', true, 80), 'at_risk');
  assert.equal(st(null, '2026-11-15', true, 80), 'not_started');
});

test('staff targets: managers set them per person or role; progress comes from the same figures as the report', async () => {
  const set = (who, body) => call(who, 'POST', '/api/v1/performance/targets', body);
  // Permissions: a member cannot set targets; a Marketing Manager can once given "Manage staff targets".
  assert.equal((await set(B, { scope: 'member', userId: B.userId, metric: 'calls_made', periodType: 'monthly', target: 10 })).status, 403);
  assert.equal((await set(A, { scope: 'member', userId: B.userId, metric: 'calls_made', periodType: 'monthly', target: 10 })).status, 403);
  assert.equal((await h.api('PUT', `/api/v1/workspace/members/${A.userId}/grants/performance.manage_targets`, { token: Owner.token })).status, 200);
  const roleT = await set(A, { scope: 'role', role: 'Member', metric: 'calls_made', periodType: 'monthly', target: 10 });
  assert.equal(roleT.status, 200, JSON.stringify(roleT.data));
  assert.equal((await h.api('DELETE', `/api/v1/workspace/members/${A.userId}/grants/performance.manage_targets`, { token: Owner.token })).status, 200);
  // Validation.
  for (const bad of [{ scope: 'member', userId: Other.userId, metric: 'calls_made', periodType: 'monthly', target: 5 }, { scope: 'role', role: 'Nope', metric: 'calls_made', periodType: 'monthly', target: 5 },
    { scope: 'member', userId: A.userId, metric: 'nope', periodType: 'monthly', target: 5 }, { scope: 'member', userId: A.userId, metric: 'calls_made', periodType: 'monthly', target: 0 },
    { scope: 'member', userId: A.userId, metric: 'followup_on_time_rate', periodType: 'monthly', target: 120 }, { scope: 'member', userId: A.userId, metric: 'calls_made', periodType: 'custom', target: 5 }]) {
    assert.equal((await set(Owner, bad)).status, 400, JSON.stringify(bad));
  }
  // A's own targets (a monthly one met, a weekly one, a rate), and a role target that B gets.
  const today = new Date().toISOString().slice(0, 10);
  const tA = (await set(Owner, { scope: 'member', userId: A.userId, metric: 'calls_made', periodType: 'custom', target: 3, startDate: '2020-01-01', endDate: today })).data.target;
  await set(Owner, { scope: 'member', userId: A.userId, metric: 'followup_on_time_rate', periodType: 'custom', target: 80, startDate: '2020-01-01', endDate: today });
  const again = await set(Owner, { scope: 'member', userId: A.userId, metric: 'calls_made', periodType: 'custom', target: 6, startDate: '2020-01-01', endDate: today });
  assert.equal(again.data.target.id, tA.id, 'the same person, measure and period replaces the target');
  const r = await call(Owner, 'GET', '/api/v1/performance');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = memberOf(r, A);
  const calls = a.targets.items.find(i => i.metric === 'calls_made');
  assert.deepEqual([calls.target, calls.actual, calls.remaining, calls.pct], [6, 3, 3, 50]);
  assert.equal(calls.from, 'person');
  const rate = a.targets.items.find(i => i.metric === 'followup_on_time_rate');
  assert.deepEqual([rate.actual, rate.status], [50, 'at_risk'], 'the range ends today, so it is still running: 50 % against 80 % is at risk');
  const b = memberOf(r, B);
  const bCalls = b.targets.items.find(i => i.metric === 'calls_made');
  assert.equal(bCalls.from, 'role', 'B (a Member) gets the Member role target');
  assert.equal(bCalls.target, 10);
  assert.ok(r.data.totals.targets.total >= 3);
  assert.ok(r.data.teamTargets.some(g => g.metric === 'calls_made'));
  assert.ok(a.score.parts.some(p => p.key === 'targetAchievement' && p.value === a.targets.achievement), 'target achievement feeds the score');
  // Staff page and the targets list agree with the report.
  const d = (await call(Owner, 'GET', `/api/v1/performance/members/${A.userId}`)).data;
  assert.deepEqual(d.summary.targets.items.map(i => i.actual), a.targets.items.map(i => i.actual));
  const list = await call(Owner, 'GET', '/api/v1/performance/targets');
  assert.equal(list.data.canManage, true);
  assert.ok(list.data.definitions.length >= 3);
  // A member sees only their own targets and cannot change any.
  const mine = await call(B, 'GET', '/api/v1/performance/targets');
  assert.equal(mine.data.canManage, false);
  assert.deepEqual(mine.data.members.map(m => m.userId), [B.userId]);
  assert.ok(mine.data.definitions.every(t => t.scope === 'role' && t.role === 'Member'));
  assert.equal((await call(B, 'DELETE', `/api/v1/performance/targets/${tA.id}`)).status, 403);
  assert.equal((await call(Other, 'DELETE', `/api/v1/performance/targets/${tA.id}`)).status, 404, 'another workspace');
  assert.equal((await call(Owner, 'PUT', `/api/v1/performance/targets/${tA.id}`, { target: 2 })).data.target.target, 2);
  assert.equal(memberOf(await call(Owner, 'GET', '/api/v1/performance'), A).targets.items.find(i => i.metric === 'calls_made').status, 'exceeded');
  assert.ok(await db().get("SELECT id FROM audit_logs WHERE action = 'performance.target_set' AND workspace_id = ?", [Owner.workspaceId]));
  // Clean up so earlier figures stay as they were.
  for (const t of (await call(Owner, 'GET', '/api/v1/performance/targets')).data.definitions) assert.equal((await call(Owner, 'DELETE', `/api/v1/performance/targets/${t.id}`)).status, 200);
  assert.equal((await call(Owner, 'GET', '/api/v1/performance')).data.totals.targets, null, 'no targets, no target figures');
});

// ------------------------------------------------------------------ Phases 6–8: categories, permissions, scheduled reports

test('score categories: each category is the weighted average of its measures with data', async () => {
  const a = memberOf(await call(Owner, 'GET', '/api/v1/performance'), A);
  const cats = a.score.categories.map(c => c.key);
  assert.ok(cats.includes('conversion') && cats.includes('followups') && cats.includes('leads') && cats.includes('productivity'));
  const fu = a.score.categories.find(c => c.key === 'followups');
  const parts = a.score.parts.filter(p => ['followupOnTime', 'followupCompletion'].includes(p.key) && p.points !== null);
  assert.equal(fu.score, parts.length ? Math.round(parts.reduce((s, p) => s + p.points * p.weight, 0) / parts.reduce((s, p) => s + p.weight, 0)) : null);
  // A rate needs at least 3 cases: A completed 2 follow-ups, so on-time does not count yet.
  assert.equal(a.score.parts.find(p => p.key === 'followupOnTime').value, null);
  const sc = require('../modules/performance/scoring');
  const one = { leads: { periodConversionRate: 0, contactedInPeriod: 1, assigned: 2, contacted: 1, firstContact: { medianHours: null } }, followups: {}, calls: { made: 2, answerRate: 100 }, emails: {}, productivity: { perDay: 0.1 } };
  assert.equal(sc.score(one, sc.normalise(null)).score, null, 'one contacted lead is not enough to call conversion 0 %');
});

test('permissions: team view alone does not allow comparing, team export, others\' transcripts, scoring or schedules', async () => {
  const grant = (cap, on = true) => h.api(on ? 'PUT' : 'DELETE', `/api/v1/workspace/members/${A.userId}/grants/${cap}`, { token: Owner.token });
  await grant('performance.view_team');
  const r = await call(A, 'GET', '/api/v1/performance');
  assert.equal(r.data.scope, 'team');
  assert.deepEqual(r.data.permissions, { team: true, compare: false, exportTeam: false, transcripts: false, targets: false, scoring: false, schedule: false });
  assert.equal((await call(A, 'GET', `/api/v1/performance/compare?ids=${A.userId},${B.userId}`)).status, 403);
  assert.equal((await call(A, 'GET', '/api/v1/performance/export')).status, 403);
  const bCall = (await call(Owner, 'GET', `/api/v1/performance/members/${B.userId}/records/calls`)).data.rows[0];
  assert.equal((await call(A, 'GET', `/api/v1/performance/calls/${bCall.id}`)).status, 403, "another member's transcript");
  const own = (await call(A, 'GET', `/api/v1/performance/members/${A.userId}/records/calls`)).data.rows[0];
  assert.equal((await call(A, 'GET', `/api/v1/performance/calls/${own.id}`)).status, 200, 'their own call');
  assert.equal((await call(A, 'PUT', '/api/v1/performance/scoring', { reset: true })).status, 403);
  assert.equal((await call(A, 'GET', '/api/v1/performance/schedules')).status, 403);
  for (const cap of ['performance.compare', 'performance.export', 'performance.view_transcripts', 'performance.configure_scoring', 'performance.schedule_reports']) assert.equal((await grant(cap)).status, 200, cap);
  assert.equal((await call(A, 'GET', `/api/v1/performance/compare?ids=${A.userId},${B.userId}`)).status, 200);
  assert.equal((await call(A, 'GET', '/api/v1/performance/export')).status, 200);
  assert.equal((await call(A, 'GET', `/api/v1/performance/calls/${bCall.id}`)).status, 200);
  assert.equal((await call(A, 'PUT', '/api/v1/performance/scoring', { reset: true })).status, 200);
  assert.equal((await call(A, 'GET', '/api/v1/performance/schedules')).status, 200);
  for (const cap of ['performance.view_team', 'performance.compare', 'performance.export', 'performance.view_transcripts', 'performance.configure_scoring', 'performance.schedule_reports']) await grant(cap, false);
  // Staff without team access still export their own figures.
  const mine = await call(B, 'GET', '/api/v1/performance/export');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.data.members.map(m => m.userId), [B.userId]);
});

test('scheduled reports: timing, validation, preview, and a due report sent once to recipients with team access', async () => {
  const sr = require('../modules/performance/scheduledReports');
  // Timing: weekly on Monday 09:00 reports the previous Mon–Sun; monthly on the 1st reports last month.
  assert.deepEqual(sr.currentCycle({ frequency: 'weekly', weekday: 1 }, '2026-11-11'), { sendDay: '2026-11-09', from: '2026-11-02', to: '2026-11-08', key: 'W2026-11-02' });
  assert.deepEqual(sr.currentCycle({ frequency: 'monthly', day_of_month: 1 }, '2026-11-11'), { sendDay: '2026-11-01', from: '2026-10-01', to: '2026-10-31', key: 'M2026-10' });
  assert.deepEqual(sr.currentCycle({ frequency: 'monthly', day_of_month: 15 }, '2026-11-11').key, 'M2026-09', 'before the 15th: last time was 15 Oct, for September');
  const s0 = { frequency: 'weekly', weekday: 1, send_hour: 9, last_period_key: null };
  assert.ok(sr.isDue(s0, 'UTC', Date.parse('2026-11-09T09:30:00Z')));
  assert.equal(sr.isDue(s0, 'UTC', Date.parse('2026-11-09T08:30:00Z')), null, 'not before the hour');
  assert.equal(sr.isDue({ ...s0, last_period_key: 'W2026-11-02' }, 'UTC', Date.parse('2026-11-10T10:00:00Z')), null, 'already sent for that week');
  assert.ok(sr.isDue(s0, 'Asia/Kolkata', Date.parse('2026-11-09T04:00:00Z')), '09:30 in India is 04:00 UTC');

  const make = body => call(Owner, 'POST', '/api/v1/performance/schedules', body);
  assert.equal((await make({ name: 'x', frequency: 'daily', recipients: [Owner.userId] })).status, 400);
  assert.equal((await make({ name: 'x', frequency: 'weekly', weekday: 1, recipients: [Other.userId] })).status, 400, 'recipients must be members');
  assert.equal((await make({ name: 'x', frequency: 'monthly', dayOfMonth: 31, recipients: [Owner.userId] })).status, 400);
  const c = await make({ name: 'Monday team report', frequency: 'weekly', weekday: 1, sendHour: 0, recipients: [Owner.userId, B.userId], format: 'detailed' });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const id = c.data.schedule.id;
  const pv = await call(Owner, 'GET', `/api/v1/performance/schedules/${id}/preview`);
  assert.equal(pv.status, 200);
  for (const text of ['Key observations', 'Overall performance', 'Staff rankings', 'Overdue follow-ups', 'Leads without contact']) assert.ok(pv.data.html.includes(text), text);
  assert.ok(!/<script/i.test(pv.data.html));
  // Due now: the worker enqueues it once; the job sends only to the Owner (B has no team access) and marks the week as sent.
  assert.equal((await h.api('POST', '/api/v1/mail/config', { token: Owner.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: 'z-perf-owner', sender_email: 'reports@perfteam.io', sender_name: 'Reports' } })).status, 200);
  await db().run("UPDATE workspaces SET timezone = 'UTC' WHERE id = ?", [Owner.workspaceId]);
  const ownerEmail = `owner-${Owner.userId}@perfteam.io`;
  await db().run('UPDATE users SET email = ? WHERE id = ?', [ownerEmail, Owner.userId]);
  const monday = d => { const x = new Date(d); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); x.setUTCHours(1, 0, 0, 0); return x.getTime(); };
  const now = monday(Date.now());
  await sr.enqueueDue(now);
  await sr.enqueueDue(now);
  const jobs = await db().all("SELECT * FROM background_jobs WHERE workspace_id = ? AND job_type = 'performance_report'", [Owner.workspaceId]);
  assert.equal(jobs.length, 1, 'once per week, however often the worker checks');
  const sent = [];
  const mock = h.mockFetch([{ match: u => u.startsWith('https://api.zeptomail.com/'), respond: (u, init) => { sent.push(JSON.parse(init.body)); return h.json(200, { request_id: 'r1' }); } }]);
  let res;
  try { res = await sr.runReportJob(jobs[0]); } finally { mock.restore(); }
  const why = await db().get('SELECT last_error FROM performance_report_schedules WHERE id = ?', [id]);
  assert.deepEqual(res, { sent: 1, failed: 0, skipped: 1 }, why.last_error);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to[0].email_address.address, ownerEmail);
  assert.match(sent[0].subject, /Weekly team performance/);
  const row = await db().get('SELECT last_period_key, last_error FROM performance_report_schedules WHERE id = ?', [id]);
  assert.equal(row.last_period_key, JSON.parse(jobs[0].payload_json).key);
  assert.deepEqual(await sr.runReportJob(jobs[0]), { skipped: true }, 'never sent twice');
  assert.equal(await db().get("SELECT COUNT(*) n FROM emails WHERE workspace_id = ? AND subject LIKE 'Weekly team performance%'", [Owner.workspaceId]).then(r => r.n), 0, 'not kept in Sent mail');
  assert.equal((await call(B, 'GET', '/api/v1/performance/schedules')).status, 403);
  assert.equal((await call(Other, 'DELETE', `/api/v1/performance/schedules/${id}`)).status, 404);
  assert.equal((await call(Owner, 'DELETE', `/api/v1/performance/schedules/${id}`)).status, 200);
});

// ------------------------------------------------------------------ Drill-down popups

test('drill-down: the records behind each figure add up to the dashboard, for the people the viewer may see', async () => {
  const r = await call(Owner, 'GET', '/api/v1/performance');
  const t = r.data.totals;
  const a = memberOf(r, A);
  const d = (qs, who = Owner) => call(who, 'GET', `/api/v1/performance/drill?${qs}`);
  const total = async qs => { const x = await d(qs); assert.equal(x.status, 200, JSON.stringify(x.data)); return x.data.total; };
  assert.equal(await total('kind=calls'), t.calls.made);
  assert.equal(await total('kind=calls_connected'), t.calls.answered);
  assert.equal(await total('kind=followups_completed'), t.followups.completed);
  assert.equal(await total('kind=followups_on_time'), t.followups.onTime);
  assert.equal(await total('kind=followups_overdue'), t.followups.overdueNow);
  assert.equal(await total('kind=never_contacted'), t.leads.neverContacted);
  assert.equal(await total('kind=leads_assigned'), t.leads.assigned);
  assert.equal(await total('kind=leads_contacted'), t.leads.contactedInPeriod);
  assert.equal(await total('kind=leads_converted'), t.leads.wonInPeriod);
  assert.equal(await total('kind=emails_sent'), t.emails.totalSent);
  assert.equal(await total('kind=activities'), t.activities.total);
  assert.equal(await total(`kind=calls&userId=${A.userId}`), a.calls.made);
  assert.equal(await total(`kind=leads_assigned&userId=${A.userId}&status=won`), a.leads.won);
  // One day of the trend.
  const day = r.data.daily.find(x => x.calls);
  assert.equal(await total(`kind=calls&dayFrom=${day.day}`), day.calls);
  const fuDay = r.data.daily.find(x => x.followupsCompleted);
  if (fuDay) assert.equal(await total(`kind=followups_completed&by=completed&dayFrom=${fuDay.day}`), fuDay.followupsCompleted);
  const page = await d('kind=calls&pageSize=2');
  assert.equal(page.data.rows.length, 2);
  assert.ok(page.data.columns.some(c => c.key === 'person'), 'several people: a Staff column');
  assert.ok(page.data.rows[0].person);
  assert.equal((await d('kind=nope')).status, 400);
  // A member sees only their own records; another workspace sees none of these.
  const mine = await d('kind=calls', B);
  assert.equal(mine.data.total, memberOf(await call(B, 'GET', '/api/v1/performance'), B).calls.made);
  assert.ok(mine.data.rows.every(x => x.userId === B.userId));
  assert.ok(!mine.data.columns.some(c => c.key === 'person'), 'one person: no Staff column');
  assert.equal((await d(`kind=calls&userId=${A.userId}`, B)).status, 403);
  assert.equal((await d(`kind=calls&userId=${A.userId}`, Other)).status, 404, 'not in their workspace');
  assert.equal((await d('kind=calls', Other)).data.total, 0);
});
