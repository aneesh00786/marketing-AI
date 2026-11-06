const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Mail Center charts, email log and campaign log: read-only, workspace-scoped, counted from stored rows.
const db = () => h.db();
const tok = () => crypto.randomBytes(12).toString('hex');
const day = offset => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
const at = offset => `${day(offset)} 10:00:00`;

let A; let B;

async function email(ws, o) {
  const r = await db().run(
    'INSERT INTO emails (workspace_id, sender_email, recipient_email, subject, body, status, sent_at, received_at, smtp_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [ws.workspaceId, o.from || 'hello@a.io', o.to || 'kim@client.io', o.subject || 'Hi', 'Body', o.status, o.sent_at || null, o.received_at || null, o.smtp_status || null]);
  return r.lastID;
}

test.before(async () => {
  await h.prepareDatabase();
  A = await h.createWorkspace({ name: 'Activity A' });
  B = await h.createWorkspace({ name: 'Activity B' });
  const run = (sql, p) => db().run(sql, p);

  // Workspace A: 2 Compose/draft sends today, 1 yesterday, 1 not sent, 2 received; one AI campaign.
  const sentToday = await email(A, { status: 'Sent', sent_at: at(0), subject: 'Order shipped' });
  const welcome = await email(A, { status: 'Sent', sent_at: at(0), subject: 'Welcome' });
  await run("INSERT INTO mail_send_requests (workspace_id, idempotency_key, request_hash, status, email_id, declared_purpose, applied_purpose, created_at, updated_at) VALUES (?, ?, ?, 'sent', ?, 'transactional', 'transactional', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [A.workspaceId, tok(), tok(), welcome]);
  await email(A, { status: 'Sent', sent_at: at(1), subject: 'Invoice' });
  await email(A, { status: 'Not Sent', sent_at: at(1), subject: 'Bounced setup', smtp_status: 'SMTP login failed' });
  await email(A, { status: 'Unread', received_at: at(0), from: 'kim@client.io', to: 'hello@a.io', subject: 'Re: Welcome' });
  await email(A, { status: 'Read', received_at: at(2), from: 'lee@client.io', to: 'hello@a.io', subject: 'Question' });
  await run("INSERT INTO mail_message_tracking (workspace_id, email_id, tracking_token, track_opens, track_clicks, delivery_status, status_rank, delivered_at, first_open_at, created_at, updated_at) VALUES (?, ?, ?, 1, 0, 'delivered', 2, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())", [A.workspaceId, sentToday, tok()]);

  const c = await run("INSERT INTO outreach_campaigns (workspace_id, name, status, created_at, updated_at) VALUES (?, 'Spring sequence', 'active', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [A.workspaceId]);
  const step = await run("INSERT INTO outreach_steps (workspace_id, campaign_id, step_order, subject, body_text, delay_days, created_at, updated_at) VALUES (?, ?, 1, 'S', 'B', 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())", [A.workspaceId, c.lastID]);
  for (const [i, status] of ['replied', 'active', 'bounced'].entries()) {
    const r = await run('INSERT INTO outreach_recipients (workspace_id, campaign_id, email, status, unsubscribe_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())', [A.workspaceId, c.lastID, `r${i}@lead.io`, status, tok()]);
    // An AI campaign send that also recorded an email row must be counted once (as a campaign send).
    const linked = i === 0 ? await email(A, { status: 'Sent', sent_at: at(0), subject: 'Campaign step 1' }) : null;
    await run("INSERT INTO outreach_sends (workspace_id, campaign_id, recipient_id, step_id, step_order, status, email_id, sent_at, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, UTC_TIMESTAMP())",
      [A.workspaceId, c.lastID, r.lastID, step.lastID, i === 2 ? 'failed' : 'sent', linked, i === 2 ? null : at(0)]);
  }
  await run("INSERT INTO mail_campaigns (workspace_id, name, subject, status, version, report_json, submitted_at, created_at, updated_at) VALUES (?, 'Newsletter', 'News', 'submitted', 1, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP())",
    [A.workspaceId, JSON.stringify({ emails_sent_count: '120', opens_count: '40', bounces_count: '2', unsub_count: '1' })]);

  // Workspace B has its own mail that A must never see.
  await email(B, { status: 'Sent', sent_at: at(0), subject: 'B secret' });
  await run("INSERT INTO outreach_campaigns (workspace_id, name, status, created_at, updated_at) VALUES (?, 'B campaign', 'draft', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [B.workspaceId]);
});
test.after(() => h.shutdown());

test('summary: sends per day by channel (campaign emails counted once), received, not sent and tracked delivery', async () => {
  const r = await h.api('GET', '/api/v1/mail/activity/summary?days=7', { token: A.token });
  assert.equal(r.status, 200);
  const { totals, daily, delivery, range } = r.data;
  assert.equal(range.days, 7);
  assert.equal(daily.length, 7);
  assert.equal(daily[6].date, day(0));
  assert.deepEqual(totals, { sentMailbox: 3, sentCampaigns: 2, received: 2, notSent: 1, campaignFailed: 1 });
  assert.deepEqual(daily[6], { date: day(0), mailbox: 2, campaigns: 2, received: 1 });
  assert.deepEqual(daily[5], { date: day(1), mailbox: 1, campaigns: 0, received: 0 });
  assert.equal(delivery.tracked, 1);
  assert.equal(delivery.delivered, 1);
  assert.equal(delivery.opened, 1);
  assert.equal(delivery.clicked, 0);
});

test('Sent Mail lists only outgoing email with delivery, purpose and source, filters by status/purpose/text/date; never another workspace', async () => {
  const r = await h.api('GET', '/api/v1/emails/sent', { token: A.token });
  assert.equal(r.status, 200);
  const subjects = r.data.emails.map(e => e.subject);
  assert.ok(!subjects.includes('B secret'), 'workspace isolation');
  assert.ok(!subjects.includes('Question') && !subjects.includes('Re: Welcome'), 'received mail is never listed as sent');
  assert.equal(r.data.emails.length, 5);
  const by = s => r.data.emails.find(e => e.subject === s);
  assert.deepEqual([by('Order shipped').delivery, by('Invoice').delivery, by('Bounced setup').delivery], ['opened', 'sent', 'not_sent']);
  assert.equal(by('Bounced setup').failure, 'SMTP login failed');
  assert.deepEqual([by('Welcome').purpose, by('Welcome').source], ['transactional', 'compose']);
  assert.deepEqual([by('Campaign step 1').purpose, by('Campaign step 1').source], ['marketing', 'ai_campaign']);
  assert.equal(by('Invoice').purpose, null);

  const q = async qs => (await h.api('GET', `/api/v1/emails/sent?${qs}`, { token: A.token })).data.emails.map(e => e.subject).sort();
  assert.deepEqual(await q('status=opened'), ['Order shipped']);
  assert.deepEqual(await q('status=not_sent'), ['Bounced setup']);
  assert.deepEqual(await q('purpose=marketing'), ['Campaign step 1']);
  assert.deepEqual(await q('purpose=not_recorded'), ['Bounced setup', 'Invoice', 'Order shipped']);
  assert.deepEqual(await q('q=invoice'), ['Invoice']);
  assert.deepEqual(await q(`q=${encodeURIComponent('%')}`), [], 'LIKE wildcards are matched literally');
  assert.deepEqual(await q(`from=${day(0)}&to=${day(0)}`), ['Campaign step 1', 'Order shipped', 'Welcome']);
  assert.equal((await h.api('GET', '/api/v1/emails/sent?status=read', { token: A.token })).status, 400);
});

test('Inbox lists only received email with unread count, read filter, search and date range', async () => {
  const r = await h.api('GET', '/api/v1/emails/inbox', { token: A.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.emails.map(e => e.subject), ['Re: Welcome', 'Question'], 'newest first, received only');
  assert.equal(r.data.unread, 1);
  assert.deepEqual(r.data.emails.map(e => e.read), [false, true]);
  assert.equal(r.data.emails[0].from, 'kim@client.io');
  const q = async qs => (await h.api('GET', `/api/v1/emails/inbox?${qs}`, { token: A.token })).data.emails.map(e => e.subject);
  assert.deepEqual(await q('read=unread'), ['Re: Welcome']);
  assert.deepEqual(await q('q=lee%40client'), ['Question']);
  assert.deepEqual(await q('q=Body'), ['Re: Welcome', 'Question'], 'searches message content');
  assert.deepEqual(await q(`from=${day(1)}`), ['Re: Welcome']);
  assert.equal((await h.api('GET', '/api/v1/emails/inbox', { token: B.token })).data.emails.length, 0);
});

test('message detail and read/unread: workspace-scoped, received mail only, nothing sent', async () => {
  const inbox = (await h.api('GET', '/api/v1/emails/inbox', { token: A.token })).data.emails;
  const id = inbox.find(e => e.subject === 'Re: Welcome').id;
  const d = await h.api('GET', `/api/v1/emails/${id}`, { token: A.token });
  assert.equal(d.status, 200);
  assert.deepEqual([d.data.email.direction, d.data.email.read, d.data.email.body, d.data.email.purpose], ['received', false, 'Body', null]);
  assert.equal((await h.api('GET', `/api/v1/emails/${id}`, { token: B.token })).status, 404, 'another workspace');
  assert.equal((await h.api('PUT', `/api/v1/emails/${id}/read`, { token: B.token, body: { read: true } })).status, 404);

  const approver = await h.addMember(A.workspaceId, 'Approver');
  assert.equal((await h.api('PUT', `/api/v1/emails/${id}/read`, { token: approver.token, body: { read: true } })).status, 200);
  assert.equal((await h.api('GET', '/api/v1/emails/inbox?read=unread', { token: A.token })).data.unread, 0);
  assert.equal((await h.api('PUT', `/api/v1/emails/${id}/read`, { token: A.token, body: { read: false } })).status, 200);
  assert.equal((await db().get('SELECT is_read, status FROM emails WHERE id = ?', [id])).status, 'Unread');

  const sent = (await h.api('GET', '/api/v1/emails/sent?q=Welcome', { token: A.token })).data.emails[0];
  assert.equal((await h.api('PUT', `/api/v1/emails/${sent.id}/read`, { token: A.token, body: { read: true } })).status, 409, 'sent mail has no read state');
  const sd = (await h.api('GET', `/api/v1/emails/${sent.id}`, { token: A.token })).data.email;
  assert.deepEqual([sd.direction, sd.purpose, sd.source], ['sent', 'transactional', 'compose']);
  assert.equal((await h.api('PUT', `/api/v1/emails/${id}/read`, { token: A.token, body: { read: 'yes' } })).status, 400);
  assert.equal((await h.api('GET', '/api/v1/emails/inbox')).status, 401);
});

test('campaign log: AI campaigns with send/reply/bounce counts and email campaigns with their report', async () => {
  const r = await h.api('GET', '/api/v1/mail/activity/campaigns', { token: A.token });
  assert.equal(r.status, 200);
  assert.ok(!r.data.campaigns.some(c => c.name === 'B campaign'));
  const ai = r.data.campaigns.find(c => c.type === 'ai');
  assert.deepEqual([ai.name, ai.recipients, ai.sent, ai.failed, ai.replied, ai.bounced], ['Spring sequence', 3, 2, 1, 1, 1]);
  const email = r.data.campaigns.find(c => c.type === 'email');
  assert.deepEqual([email.name, email.sent, email.opened, email.bounced, email.unsubscribed, email.recipients], ['Newsletter', 120, 40, 2, 1, null]);
  const onlyEmail = await h.api('GET', '/api/v1/mail/activity/campaigns?type=email', { token: A.token });
  assert.deepEqual(onlyEmail.data.campaigns.map(c => c.type), ['email']);
});

test('logs list only what was sent: no draft, approved-but-unsent or failed campaigns; date range filters sends', async () => {
  const C = await h.createWorkspace({ name: 'Logs only sent' });
  const run = (sql, p) => db().run(sql, p);
  const tokenStr = () => crypto.randomBytes(12).toString('hex');
  // AI: one with sends 3 days ago and today, one draft that never sent
  const sentAi = (await run("INSERT INTO outreach_campaigns (workspace_id, name, status, created_at, updated_at) VALUES (?, 'Sent sequence', 'active', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [C.workspaceId])).lastID;
  await run("INSERT INTO outreach_campaigns (workspace_id, name, status, created_at, updated_at) VALUES (?, 'Draft sequence', 'draft', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [C.workspaceId]);
  const step = (await run("INSERT INTO outreach_steps (workspace_id, campaign_id, step_order, subject, body_text, delay_days, created_at, updated_at) VALUES (?, ?, 1, 'S', 'B', 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())", [C.workspaceId, sentAi])).lastID;
  for (const [i, when] of [[0, at(3)], [1, at(0)]]) {
    const r = (await run('INSERT INTO outreach_recipients (workspace_id, campaign_id, email, status, unsubscribe_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())', [C.workspaceId, sentAi, `x${i}@lead.io`, 'active', tokenStr()])).lastID;
    await run("INSERT INTO outreach_sends (workspace_id, campaign_id, recipient_id, step_id, step_order, status, sent_at, created_at) VALUES (?, ?, ?, ?, 1, 'sent', ?, UTC_TIMESTAMP())", [C.workspaceId, sentAi, r, step, when]);
  }
  // Email campaigns: sent 3 days ago, plus draft, approved and failed (never sent)
  await run("INSERT INTO mail_campaigns (workspace_id, name, subject, status, version, submitted_at, created_at, updated_at) VALUES (?, 'Submitted news', 'N', 'submitted', 1, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())", [C.workspaceId, at(3)]);
  for (const st of ['draft', 'approved', 'failed']) {
    await run("INSERT INTO mail_campaigns (workspace_id, name, subject, status, version, created_at, updated_at) VALUES (?, ?, 'N', ?, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())", [C.workspaceId, `Email ${st}`, st]);
  }
  const log = async qs => (await h.api('GET', `/api/v1/mail/activity/campaigns${qs}`, { token: C.token })).data.campaigns;
  const all = await log('');
  assert.deepEqual(all.map(c => c.name).sort(), ['Sent sequence', 'Submitted news']);
  assert.equal(all.find(c => c.name === 'Sent sequence').sent, 2);
  const today = await log(`?from=${day(0)}&to=${day(0)}`);
  assert.deepEqual(today.map(c => [c.name, c.sent]), [['Sent sequence', 1]], 'only sends in the range are counted; the email campaign sent earlier is left out');
  const earlier = await log(`?from=${day(5)}&to=${day(2)}`);
  assert.deepEqual(earlier.map(c => c.name).sort(), ['Sent sequence', 'Submitted news']);
  assert.equal((await log(`?from=${day(1)}&to=${day(1)}`)).length, 0);
  assert.equal((await h.api('GET', '/api/v1/mail/activity/campaigns?from=yesterday', { token: C.token })).status, 400);
});

test('Sent Mail with sentOnly leaves out failed sends (the Logs view)', async () => {
  const r = await h.api('GET', '/api/v1/emails/sent?sentOnly=1', { token: A.token });
  assert.equal(r.status, 200);
  assert.ok(r.data.emails.length > 0);
  assert.ok(r.data.emails.every(e => e.delivery !== 'not_sent'));
  assert.ok((await h.api('GET', '/api/v1/emails/sent', { token: A.token })).data.emails.some(e => e.delivery === 'not_sent'));
});

test('the mailbox list shows each sent email\'s delivery status (opened, not sent, plain sent) without raw tracking columns', async () => {
  const r = await h.api('GET', '/api/v1/emails', { token: A.token });
  assert.equal(r.status, 200);
  const by = s => r.data.emails.find(e => e.subject === s);
  assert.equal(by('Order shipped').delivery, 'opened');
  assert.ok(by('Order shipped').delivery_detail.firstOpenAt);
  assert.equal(by('Order shipped').delivery_detail.tracked, true);
  assert.equal(by('Invoice').delivery, 'sent');
  assert.equal(by('Invoice').delivery_detail.tracked, false);
  assert.equal(by('Bounced setup').delivery, 'not_sent');
  assert.equal(by('Question').delivery, null);
  assert.ok(!Object.keys(by('Order shipped')).some(k => k.startsWith('t_')));
});

test('every role with mail.view can read activity; unknown filters and signed-out calls are refused', async () => {
  const approver = await h.addMember(A.workspaceId, 'Approver');
  assert.equal((await h.api('GET', '/api/v1/mail/activity/summary', { token: approver.token })).status, 200);
  assert.equal((await h.api('GET', '/api/v1/mail/activity/summary')).status, 401);
  assert.equal((await h.api('GET', '/api/v1/mail/activity/summary?days=365', { token: A.token })).status, 400);
  assert.equal((await h.api('GET', '/api/v1/emails/sent?workspace_id=2', { token: A.token })).status, 400);
});

test('mail settings: sample IMAP values (reserved demo hosts) do not count as replies being set up', async () => {
  const save = imap_host => h.api('POST', '/api/v1/mail/config', { token: B.token, body: { provider: 'custom_smtp', smtp_host: 'smtp.b.io', smtp_user: 'u@b.io', smtp_pass: 'p', imap_host, imap_user: 'inbox@b.io', imap_pass: 'x', sender_email: 'u@b.io' } });
  assert.equal((await save('imap.demo.invalid')).data.config.has_imap_auth, false);
  assert.equal((await save('imap.b.io')).data.config.has_imap_auth, true);
});
