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
  await email(A, { status: 'Sent', sent_at: at(0), subject: 'Welcome' });
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

test('email log: newest first, with direction, source, delivery and filters; never another workspace', async () => {
  const r = await h.api('GET', '/api/v1/mail/activity/emails', { token: A.token });
  assert.equal(r.status, 200);
  const subjects = r.data.emails.map(e => e.subject);
  assert.ok(!subjects.includes('B secret'));
  assert.equal(r.data.emails.length, 7);
  const shipped = r.data.emails.find(e => e.subject === 'Order shipped');
  assert.equal(shipped.direction, 'sent');
  assert.equal(shipped.delivery, 'opened');
  assert.equal(r.data.emails.find(e => e.subject === 'Campaign step 1').source, 'ai_campaign');
  const failed = r.data.emails.find(e => e.subject === 'Bounced setup');
  assert.deepEqual([failed.direction, failed.delivery, failed.detail], ['not_sent', 'not_sent', 'SMTP login failed']);
  assert.equal(r.data.emails.find(e => e.subject === 'Question').delivery, null);

  const received = await h.api('GET', '/api/v1/mail/activity/emails?direction=received', { token: A.token });
  assert.deepEqual(received.data.emails.map(e => e.subject).sort(), ['Question', 'Re: Welcome']);
  const search = await h.api('GET', '/api/v1/mail/activity/emails?q=invoice', { token: A.token });
  assert.deepEqual(search.data.emails.map(e => e.subject), ['Invoice']);
  const wild = await h.api('GET', `/api/v1/mail/activity/emails?q=${encodeURIComponent('%')}`, { token: A.token });
  assert.equal(wild.data.emails.length, 0, 'LIKE wildcards are matched literally');
});

test('campaign log: AI campaigns with send/reply/bounce counts and Zoho campaigns with their report', async () => {
  const r = await h.api('GET', '/api/v1/mail/activity/campaigns', { token: A.token });
  assert.equal(r.status, 200);
  assert.ok(!r.data.campaigns.some(c => c.name === 'B campaign'));
  const ai = r.data.campaigns.find(c => c.type === 'ai');
  assert.deepEqual([ai.name, ai.recipients, ai.sent, ai.failed, ai.replied, ai.bounced], ['Spring sequence', 3, 2, 1, 1, 1]);
  const zoho = r.data.campaigns.find(c => c.type === 'zoho');
  assert.deepEqual([zoho.name, zoho.sent, zoho.opened, zoho.bounced, zoho.unsubscribed, zoho.recipients], ['Newsletter', 120, 40, 2, 1, null]);
  const onlyZoho = await h.api('GET', '/api/v1/mail/activity/campaigns?type=zoho', { token: A.token });
  assert.deepEqual(onlyZoho.data.campaigns.map(c => c.type), ['zoho']);
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
  assert.equal((await h.api('GET', '/api/v1/mail/activity/emails?workspace_id=2', { token: A.token })).status, 400);
});

test('mail settings: sample IMAP values (reserved demo hosts) do not count as replies being set up', async () => {
  const save = imap_host => h.api('POST', '/api/v1/mail/config', { token: B.token, body: { provider: 'custom_smtp', smtp_host: 'smtp.b.io', smtp_user: 'u@b.io', smtp_pass: 'p', imap_host, imap_user: 'inbox@b.io', imap_pass: 'x', sender_email: 'u@b.io' } });
  assert.equal((await save('imap.demo.invalid')).data.config.has_imap_auth, false);
  assert.equal((await save('imap.b.io')).data.config.has_imap_auth, true);
});
