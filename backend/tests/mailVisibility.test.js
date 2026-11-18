const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Mail Center visibility (lib/mailAccess): Owners/Admins and members granted "View all mail"
// (mail.view_all) see every draft, email and campaign of the workspace; everyone else sees only
// their own. Rows are seeded directly; nothing is sent and no external service is called.
const db = () => h.db();
const uid = () => crypto.randomBytes(4).toString('hex');

let W; let ADMIN; let ANA; let BEN; let APPROVER; let OTHER;
const ids = {};

async function email(ws, row) {
  const r = await db().run(
    `INSERT INTO emails (workspace_id, sender, sender_email, recipient_email, recipient_name, subject, body, status, sent_by_user_id, sent_at, received_at, is_read, is_urgent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [ws, row.sender || null, row.from || null, row.to, row.toName || '', row.subject, row.body || 'Hello', row.status,
      row.by || null, row.status === 'Sent' ? '2026-11-10 10:00:00' : null, row.status === 'Sent' ? null : '2026-11-11 10:00:00', row.urgent ? 1 : 0]);
  return r.lastID;
}
async function draft(ws, by, subject, status = 'Draft') {
  const r = await db().run(
    `INSERT INTO email_drafts (workspace_id, recipient_email, recipient_name, subject, body_html, body_text, tone, status, created_by_user_id, created_at, updated_at)
     VALUES (?, ?, '', ?, '<p>Hi</p>', 'Hi', 'Professional', ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ws, `to-${uid()}@client.io`, subject, status, by]);
  return r.lastID;
}
async function campaign(ws, by, name, extra = {}) {
  const r = await db().run(
    `INSERT INTO mail_campaigns (workspace_id, name, subject, from_name, from_email, html_content, mail_list_ids_json, status, version, created_by, updated_by, submitted_by, submitted_at, created_at, updated_at)
     VALUES (?, ?, 'Subject', 'Acme', 'news@acme.io', '<p>Hi</p>', '[]', ?, 1, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [ws, name, extra.status || 'draft', by, by, extra.submittedBy || null, extra.status === 'submitted' ? '2026-11-10 10:00:00' : null]);
  return r.lastID;
}

const get = (who, path) => h.api('GET', path, { token: who.token });
const grant = (target, cap = 'mail.view_all') => h.api('PUT', `/api/v1/workspace/members/${target.userId}/grants/${cap}`, { token: ADMIN.token });
const revoke = (target, cap = 'mail.view_all') => h.api('DELETE', `/api/v1/workspace/members/${target.userId}/grants/${cap}`, { token: ADMIN.token });
const subjects = list => list.map(x => x.subject).sort();

test.before(async () => {
  await h.prepareDatabase();
  ADMIN = await h.createWorkspace({ name: 'Mail visibility' });
  W = ADMIN.workspaceId;
  ANA = await h.addMember(W, 'Member');
  BEN = await h.addMember(W, 'Member');
  APPROVER = await h.addMember(W, 'Approver');
  OTHER = await h.createWorkspace({ name: 'Mail visibility other' });

  // Ana emailed kim@client.io; Ben emailed lee@client.io; the admin emailed pat@client.io.
  ids.anaSent = await email(W, { status: 'Sent', to: 'kim@client.io', subject: 'Ana to Kim', by: ANA.userId });
  ids.benSent = await email(W, { status: 'Sent', to: 'lee@client.io', subject: 'Ben to Lee', by: BEN.userId });
  ids.adminSent = await email(W, { status: 'Sent', to: 'pat@client.io', subject: 'Admin to Pat', by: ADMIN.userId });
  // Replies: Kim (Ana's contact, different case), Lee (Ben's), and a stranger nobody emailed.
  ids.kimReply = await email(W, { status: 'Unread', from: 'Kim@Client.io', sender: 'Kim', to: 'team@acme.io', subject: 'Re: Ana to Kim', urgent: true });
  ids.leeReply = await email(W, { status: 'Unread', from: 'lee@client.io', sender: 'Lee', to: 'team@acme.io', subject: 'Re: Ben to Lee', urgent: true });
  ids.stranger = await email(W, { status: 'Unread', from: 'cold@elsewhere.io', sender: 'Cold', to: 'team@acme.io', subject: 'Cold inbound' });
  // Ben's campaign went to sam@client.io, who replied.
  ids.benCampaign = await campaign(W, BEN.userId, 'Ben campaign', { status: 'submitted', submittedBy: BEN.userId });
  await db().run("INSERT INTO mail_campaign_recipients (workspace_id, campaign_id, version, email, status) VALUES (?, ?, 1, 'sam@client.io', 'sent')", [W, ids.benCampaign]);
  ids.samReply = await email(W, { status: 'Unread', from: 'sam@client.io', sender: 'Sam', to: 'team@acme.io', subject: 'Re: Ben campaign' });
  ids.anaCampaign = await campaign(W, ANA.userId, 'Ana campaign');

  ids.anaDraft = await draft(W, ANA.userId, 'Ana draft', 'Pending Approval');
  ids.benDraft = await draft(W, BEN.userId, 'Ben draft', 'Pending Approval');
  ids.legacyDraft = await draft(W, null, 'Legacy draft');

  // Another workspace's mail must never appear.
  await email(OTHER.workspaceId, { status: 'Sent', to: 'kim@client.io', subject: 'Other ws to Kim', by: OTHER.userId });
  await draft(OTHER.workspaceId, OTHER.userId, 'Other ws draft');
  await campaign(OTHER.workspaceId, OTHER.userId, 'Other ws campaign');
});
test.after(() => h.shutdown());

test('migration 064: drafts record their author (nullable column with an index)', async () => {
  assert.ok(await db().get("SELECT 1 AS x FROM schema_migrations WHERE id = '064_draft_author'"));
  const col = await db().get("SELECT IS_NULLABLE AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_drafts' AND COLUMN_NAME = 'created_by_user_id'");
  assert.equal(col.n, 'YES');
});

test('an owner sees every draft, email and campaign of the workspace, and none of another workspace', async () => {
  const d = await get(ADMIN, '/api/v1/drafts');
  assert.deepEqual(subjects(d.data.drafts), ['Ana draft', 'Ben draft', 'Legacy draft']);
  const sent = await get(ADMIN, '/api/v1/emails/sent');
  assert.deepEqual(subjects(sent.data.emails), ['Admin to Pat', 'Ana to Kim', 'Ben to Lee']);
  const inbox = await get(ADMIN, '/api/v1/emails/inbox');
  assert.deepEqual(subjects(inbox.data.emails), ['Cold inbound', 'Re: Ana to Kim', 'Re: Ben campaign', 'Re: Ben to Lee']);
  assert.equal(inbox.data.unread, 4);
  const c = await get(ADMIN, '/api/v1/mail/campaigns');
  assert.deepEqual(c.data.campaigns.map(x => x.name).sort(), ['Ana campaign', 'Ben campaign']);
});

test('a member sees only their own drafts, sent mail and replies from people they emailed', async () => {
  const d = await get(ANA, '/api/v1/drafts');
  assert.deepEqual(subjects(d.data.drafts), ['Ana draft']);
  const sent = await get(ANA, '/api/v1/emails/sent');
  assert.deepEqual(subjects(sent.data.emails), ['Ana to Kim']);
  const inbox = await get(ANA, '/api/v1/emails/inbox');
  assert.deepEqual(subjects(inbox.data.emails), ['Re: Ana to Kim']);
  assert.equal(inbox.data.unread, 1, 'the unread count covers only their own mail');
  const all = await get(ANA, '/api/v1/emails');
  assert.deepEqual(subjects(all.data.emails), ['Ana to Kim', 'Re: Ana to Kim']);

  // Ben also sees the reply to his campaign.
  const benInbox = await get(BEN, '/api/v1/emails/inbox');
  assert.deepEqual(subjects(benInbox.data.emails), ['Re: Ben campaign', 'Re: Ben to Lee']);
});

test("a member gets 404 for anyone else's draft, email or campaign, for reading and acting alike", async () => {
  assert.equal((await get(ANA, `/api/v1/drafts/${ids.benDraft}`)).status, 404);
  assert.equal((await get(ANA, `/api/v1/drafts/${ids.legacyDraft}`)).status, 404, 'drafts without an author are for those who see all mail');
  assert.equal((await h.api('DELETE', `/api/v1/drafts/${ids.benDraft}`, { token: ANA.token })).status, 404);
  assert.ok(await db().get('SELECT id FROM email_drafts WHERE id = ?', [ids.benDraft]), 'nothing was deleted');
  assert.equal((await h.api('PATCH', `/api/v1/drafts/${ids.benDraft}`, { token: ANA.token, body: { subject: 'Hijacked' } })).status, 404);
  assert.equal((await get(ANA, `/api/v1/emails/${ids.benSent}`)).status, 404);
  assert.equal((await get(ANA, `/api/v1/emails/${ids.leeReply}`)).status, 404);
  assert.equal((await get(ANA, `/api/v1/emails/${ids.stranger}`)).status, 404);
  assert.equal((await h.api('PUT', `/api/v1/emails/${ids.leeReply}/read`, { token: ANA.token, body: { read: true } })).status, 404);
  assert.equal(Number((await db().get('SELECT is_read FROM emails WHERE id = ?', [ids.leeReply])).is_read), 0);
  assert.equal((await get(ANA, `/api/v1/mail/campaigns/${ids.benCampaign}`)).status, 404);
  assert.equal((await get(ANA, `/api/v1/mail/tracking/emails/${ids.benSent}`)).status, 404);
  assert.equal((await get(ANA, `/api/v1/mail/tracking/drafts/${ids.benDraft}`)).status, 404);

  // Their own items open normally.
  assert.equal((await get(ANA, `/api/v1/drafts/${ids.anaDraft}`)).status, 200);
  assert.equal((await get(ANA, `/api/v1/emails/${ids.kimReply}`)).status, 200);
  assert.equal((await get(ANA, `/api/v1/mail/campaigns/${ids.anaCampaign}`)).status, 200);
  const list = await get(ANA, '/api/v1/mail/campaigns');
  assert.deepEqual(list.data.campaigns.map(x => x.name), ['Ana campaign']);
});

test('an approver sees only their own mail too, and cannot approve a member\'s draft without "View all mail"', async () => {
  assert.deepEqual((await get(APPROVER, '/api/v1/drafts')).data.drafts, []);
  assert.deepEqual((await get(APPROVER, '/api/v1/emails/inbox')).data.emails, []);
  assert.equal((await h.api('PUT', `/api/v1/drafts/${ids.anaDraft}/approve`, { token: APPROVER.token })).status, 404);
});

test('"View all mail" gives a member the full view; removing it takes it away', async () => {
  assert.equal((await grant(BEN)).status, 200);
  const d = await get(BEN, '/api/v1/drafts');
  assert.deepEqual(subjects(d.data.drafts), ['Ana draft', 'Ben draft', 'Legacy draft']);
  const inbox = await get(BEN, '/api/v1/emails/inbox');
  assert.equal(inbox.data.emails.length, 4);
  assert.equal((await get(BEN, `/api/v1/mail/campaigns/${ids.anaCampaign}`)).status, 200);
  assert.equal((await revoke(BEN)).status, 200);
  assert.deepEqual(subjects((await get(BEN, '/api/v1/drafts')).data.drafts), ['Ben draft']);
});

test('the Mail Center summary and campaign log count only the member\'s own mail', async () => {
  const mine = await get(ANA, '/api/v1/mail/activity/summary?days=90');
  const everyone = await get(ADMIN, '/api/v1/mail/activity/summary?days=90');
  assert.equal(mine.status, 200);
  assert.ok(mine.data.totals.received <= everyone.data.totals.received);
  assert.equal(mine.data.totals.sentMailbox <= everyone.data.totals.sentMailbox, true);
  const log = await get(ANA, '/api/v1/mail/activity/campaigns');
  assert.equal(log.status, 200);
  assert.ok(!JSON.stringify(log.data).includes('Ben campaign'));
  const adminLog = await get(ADMIN, '/api/v1/mail/activity/campaigns');
  assert.ok(JSON.stringify(adminLog.data).includes('Ben campaign'));
});

test('drafts made in Mail Center record who made them', async () => {
  const r = await h.api('POST', '/api/tools/send_email', { token: ANA.token, body: { recipient_email: `x-${uid()}@client.io`, subject: 'Tool draft', body: 'Hi there' } });
  assert.equal(r.status, 200);
  const row = await db().get("SELECT created_by_user_id AS by FROM email_drafts WHERE workspace_id = ? AND subject = 'Tool draft'", [W]);
  assert.equal(Number(row.by), ANA.userId);
  assert.ok(subjects((await get(ANA, '/api/v1/drafts')).data.drafts).includes('Tool draft'));
  assert.ok(!subjects((await get(BEN, '/api/v1/drafts')).data.drafts).includes('Tool draft'));
});

test('notifications: urgent replies and drafts awaiting approval reach only those who may see them', async () => {
  const svc = require('../modules/notifications/notificationService');
  for (const who of [ANA, BEN, ADMIN]) svc.resetThrottle();
  const n = async who => (await get(who, '/api/v1/notifications')).data;
  const titles = b => JSON.stringify(b);
  const ana = titles(await n(ANA));
  assert.ok(ana.includes('Re: Ana to Kim'));
  assert.ok(!ana.includes('Re: Ben to Lee'));
  const admin = titles(await n(ADMIN));
  assert.ok(admin.includes('Re: Ben to Lee') && admin.includes('Ben draft'));
});

// ------------------------------------------------------------------ Mail Center → Settings

test('mail settings are read and changed only by Owners/Admins or people given "Manage mail settings"', async () => {
  const reads = ['/api/v1/mail/config', '/api/v1/mail/tracking/settings'];
  for (const who of [ANA, APPROVER]) {
    for (const p of reads) assert.equal((await get(who, p)).status, 403, `${p} is closed`);
    assert.equal((await h.api('POST', '/api/v1/mail/config', { token: who.token, body: { provider: 'smtp', smtp_host: 'smtp.x.io', smtp_user: 'u', smtp_pass: 'p', sender_email: 'a@x.io' } })).status, 403);
    assert.equal((await h.api('PUT', '/api/v1/mail/ses/settings', { token: who.token, body: { region: 'us-east-1' } })).status, 403);
    assert.equal((await h.api('POST', '/api/v1/mail/marketing', { token: who.token, body: { approved: true, confirm: true } })).status, 403);
    // The Campaigns screen still learns whether SES is set up, but no keys, region or SNS details.
    const ses = await get(who, '/api/v1/mail/ses/settings');
    assert.equal(ses.status, 200);
    assert.equal(ses.data.canConfigure, false);
    assert.deepEqual(Object.keys(ses.data.ses), ['configured']);
  }
  for (const p of reads) assert.equal((await get(ADMIN, p)).status, 200, `${p} opens for the owner`);
  assert.equal((await get(ADMIN, '/api/v1/mail/ses/settings')).data.canConfigure, true);

  assert.equal((await grant(ANA, 'mail.configure')).status, 200);
  for (const p of reads) assert.equal((await get(ANA, p)).status, 200, `${p} opens with the grant`);
  assert.equal((await get(ANA, '/api/v1/mail/ses/settings')).data.canConfigure, true);
  assert.equal((await revoke(ANA, 'mail.configure')).status, 200);
  assert.equal((await get(ANA, '/api/v1/mail/tracking/settings')).status, 403, 'closed again once removed');
});
