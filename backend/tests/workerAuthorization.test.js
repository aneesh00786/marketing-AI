const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Background workers re-check authorization immediately before publishing or sending:
// active workspace, scheduler/approver still an active member with the needed capability,
// and job/account/content/recipient all in the same workspace. Providers are mocked and
// unmatched requests fail loudly, so nothing real is posted or emailed.
const db = () => h.db();
const worker = () => require('../workers/socialWorker');
const sender = () => require('../modules/outreach/outreachSender');

const feedRoute = (respond) => ({ match: (u, init) => init.method === 'POST' && /\/page\d+\/feed$/.test(new URL(u).pathname), respond });
const permalinkRoute = { match: (u, init) => (init.method || 'GET') === 'GET' && u.includes('fields=permalink_url'), respond: () => h.json(200, { permalink_url: 'https://facebook.com/p/1' }) };
const posts = mock => mock.calls.filter(c => c.method === 'POST' && /\/feed$/.test(new URL(c.url).pathname));

async function publishSetup(name) {
  const owner = await h.createWorkspace({ name });
  const account = await h.createAccount(owner.workspaceId, { accountType: 'facebook_page', externalId: `page${Date.now()}${Math.floor(Math.random() * 1000)}` });
  const manager = await h.addMember(owner.workspaceId, 'Marketing Manager');
  return { owner, account, manager };
}

/** Approved post, queued for immediate publishing by `who` (needs content.publish). */
async function queuedPost(s, who, caption = 'Worker auth post') {
  const c = await h.api('POST', '/api/v1/social/content', { token: s.owner.token, body: { platformKey: 'facebook', socialAccountId: s.account.id, caption } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal((await h.api('POST', `/api/v1/social/content/${c.data.content.id}/approve`, { token: s.owner.token, body: {} })).status, 200);
  const job = await h.api('POST', `/api/v1/social/content/${c.data.content.id}/publish-now`, { token: who.token, body: {} });
  assert.equal(job.status, 202, JSON.stringify(job.data));
  return { contentId: c.data.content.id, jobId: job.data.job.id };
}

async function runPublisher(respondId = '1') {
  const mock = h.mockFetch([feedRoute(() => h.json(200, { id: `x_${respondId}` })), permalinkRoute]);
  try { await worker().processPublishing(); } finally { mock.restore(); }
  return mock;
}

const job = id => db().get('SELECT * FROM publishing_jobs WHERE id = ?', [id]);
const contentRow = id => db().get('SELECT status, last_error FROM content_items WHERE id = ?', [id]);
const auditFor = (action, resourceId) => db().get('SELECT * FROM audit_logs WHERE action = ? AND resource_id = ? ORDER BY id DESC LIMIT 1', [action, String(resourceId)]);

async function assertBlocked(jobId, contentId, code, mock) {
  assert.equal(posts(mock).length, 0, 'nothing is posted');
  const j = await job(jobId);
  assert.equal(j.status, 'failed');
  assert.equal(j.last_error_code, code);
  assert.equal(j.locked_by, null);
  assert.equal(j.external_post_id, null);
  const a = await auditFor('social.publish.blocked', jobId);
  assert.ok(a, 'audited');
  assert.equal(JSON.parse(a.metadata_json).reason, code);
  assert.equal(a.actor_type, 'worker');
  if (contentId) assert.equal((await contentRow(contentId)).status, 'failed');
}

test.before(async () => {
  await h.prepareDatabase();
  process.env.META_APP_ID = 'app-id';
  process.env.META_APP_SECRET = 'app-secret';
  // Leftovers from earlier runs in the shared test database must not be picked up here.
  await db().run("UPDATE publishing_jobs SET status = 'cancelled' WHERE status = 'queued'");
  await db().run("UPDATE outreach_campaigns SET status = 'stopped' WHERE status = 'running'");
});
test.after(() => h.shutdown());

// ------------------------------------------------------------------ social publishing

test('publishing: a valid job (active workspace, authorized scheduler) is published once', async () => {
  const s = await publishSetup('Pub valid');
  const p = await queuedPost(s, s.manager);
  const mock = await runPublisher('valid');
  assert.equal(posts(mock).length, 1);
  assert.equal((await job(p.jobId)).status, 'succeeded');
  assert.equal((await contentRow(p.contentId)).status, 'published');
});

test('publishing: a removed scheduler blocks the job; an authorized retry re-queues it under the retrier', async () => {
  const s = await publishSetup('Pub removed');
  const p = await queuedPost(s, s.manager);
  await db().run("UPDATE workspace_members SET status = 'Removed' WHERE workspace_id = ? AND user_id = ?", [s.owner.workspaceId, s.manager.userId]);
  await assertBlocked(p.jobId, p.contentId, 'SCHEDULER_NOT_MEMBER', await runPublisher());

  const retry = await h.api('POST', `/api/v1/social/queue/${p.jobId}/retry`, { token: s.owner.token, body: {} });
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(Number((await job(p.jobId)).requested_by), Number(s.owner.userId));
  const mock = await runPublisher('retried');
  assert.equal(posts(mock).length, 1);
  assert.equal((await job(p.jobId)).status, 'succeeded');
});

test('publishing: a scheduler who lost content.publish (demoted) is refused', async () => {
  const s = await publishSetup('Pub demoted');
  const p = await queuedPost(s, s.manager);
  await db().run("UPDATE workspace_members SET role = 'Approver' WHERE workspace_id = ? AND user_id = ?", [s.owner.workspaceId, s.manager.userId]);
  await assertBlocked(p.jobId, p.contentId, 'SCHEDULER_NOT_AUTHORIZED', await runPublisher());
});

test('publishing: an inactive workspace publishes nothing', async () => {
  const s = await publishSetup('Pub inactive');
  const p = await queuedPost(s, s.owner);
  await db().run("UPDATE workspaces SET status = 'Suspended' WHERE id = ?", [s.owner.workspaceId]);
  await assertBlocked(p.jobId, p.contentId, 'WORKSPACE_INACTIVE', await runPublisher());
});

test('publishing: a job without a recorded scheduler is refused, not run anonymously', async () => {
  const s = await publishSetup('Pub legacy');
  const p = await queuedPost(s, s.owner);
  await db().run('UPDATE publishing_jobs SET requested_by = NULL WHERE id = ?', [p.jobId]);
  await assertBlocked(p.jobId, p.contentId, 'SCHEDULER_UNKNOWN', await runPublisher());
});

/** Writes a row the schema forbids (composite FKs off on a private connection) to simulate corruption. */
async function forceUpdate(sql, params) {
  const mysql = require('mysql2/promise');
  const raw = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: parseInt(process.env.DB_PORT || '3306', 10), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME });
  try {
    await raw.query('SET FOREIGN_KEY_CHECKS = 0');
    await raw.execute(sql, params);
  } finally {
    await raw.query('SET FOREIGN_KEY_CHECKS = 1');
    await raw.end();
  }
}

test('publishing: an account or content from another workspace is never used', async () => {
  const s = await publishSetup('Pub cross A');
  const other = await publishSetup('Pub cross B');

  const p1 = await queuedPost(s, s.owner, 'Cross account');
  // The schema already refuses this (composite FK workspace_id + social_account_id)...
  await assert.rejects(db().run('UPDATE publishing_jobs SET social_account_id = ? WHERE id = ?', [other.account.id, p1.jobId]), /foreign key/i);
  // ...and the worker refuses it too if such a row ever exists.
  await forceUpdate('UPDATE publishing_jobs SET social_account_id = ? WHERE id = ?', [other.account.id, p1.jobId]);
  await assertBlocked(p1.jobId, p1.contentId, 'ACCOUNT_WORKSPACE_MISMATCH', await runPublisher());

  const p2 = await queuedPost(s, s.owner, 'Cross content');
  const foreign = await queuedPost(other, other.owner, 'Belongs to B');
  await db().run("UPDATE publishing_jobs SET status = 'cancelled' WHERE id = ?", [foreign.jobId]);
  await assert.rejects(db().run('UPDATE publishing_jobs SET content_item_id = ? WHERE id = ?', [foreign.contentId, p2.jobId]), /foreign key/i);
  await forceUpdate('UPDATE publishing_jobs SET content_item_id = ? WHERE id = ?', [foreign.contentId, p2.jobId]);
  await assertBlocked(p2.jobId, null, 'CONTENT_WORKSPACE_MISMATCH', await runPublisher());
  assert.equal((await contentRow(foreign.contentId)).status, 'scheduled', "the other workspace's content is untouched");
});

// ------------------------------------------------------------------ email outreach

const SEQ = { steps: [{ delay_days: 0, subject: 'Routes for {{company}}', body: 'Hi {{first_name}},\n\nRouteKit plans delivery routes. Worth a short call?' }] };
const zepto = calls => ({
  match: u => u.startsWith('https://api.zeptomail.com/'),
  respond: (url, init) => { calls.push(JSON.parse(init.body).to[0].email_address.address); return h.json(200, { request_id: `req-${calls.length}` }); }
});
const aiDown = { match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) };
const tick = () => sender().processOutreach('auth-test-worker', { now: new Date() });

async function outreachSetup(name) {
  const owner = await h.createWorkspace({ name });
  const manager = await h.addMember(owner.workspaceId, 'Marketing Manager');
  assert.equal((await h.api('POST', '/api/v1/mail/config', { token: owner.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: 'zepto-test', sender_email: 'hello@auth-test.io', sender_name: 'Auth Test' } })).status, 200);
  const product = (await h.api('POST', '/api/v1/products', { token: owner.token, body: { name: 'RouteKit', tagline: 'Plan delivery routes', features: ['Driver app'] } })).data.productId;
  const leads = [];
  const mock = h.mockFetch([aiDown]);
  try {
    for (const [n, e] of [['Dana Smith', 'dana'], ['Lee Wong', 'lee']]) {
      const r = await h.api('POST', '/api/v1/leads', { token: owner.token, body: { name: n, email: `${e}-${owner.workspaceId}@fleetco.io`, companyName: 'FleetCo' } });
      leads.push(r.data.lead.id);
    }
  } finally { mock.restore(); }
  return { owner, manager, product, leads };
}

async function runningCampaign(s, approver) {
  const api = (method, path, body, who = s.owner) => h.api(method, `/api/v1/outreach${path}`, { token: who.token, body });
  const c = (await api('POST', '/campaigns', { name: `Auth ${Date.now()}`, productId: s.product, sendDays: [1, 2, 3, 4, 5, 6, 7], sendStartHour: 0, sendEndHour: 24 })).data.campaign;
  const mock = h.mockFetch([h.groqRoute(() => JSON.stringify(SEQ))]);
  try { assert.equal((await api('POST', `/campaigns/${c.id}/generate`, { steps: 1 })).status, 200); } finally { mock.restore(); }
  assert.equal((await api('POST', `/campaigns/${c.id}/recipients`, { leadIds: s.leads })).status, 200);
  const ok = await api('POST', `/campaigns/${c.id}/approve`, { confirm: true }, approver);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  return c.id;
}

async function runSender() {
  const calls = [];
  const mock = h.mockFetch([zepto(calls)]);
  try { await tick(); } finally { mock.restore(); }
  return calls;
}

const campaign = id => db().get('SELECT * FROM outreach_campaigns WHERE id = ?', [id]);
const sendCount = async id => Number((await db().get('SELECT COUNT(*) AS n FROM outreach_sends WHERE campaign_id = ?', [id])).n);

async function assertCampaignBlocked(id, code, calls) {
  assert.equal(calls.length, 0, 'no email is sent');
  assert.equal(await sendCount(id), 0, 'no send is claimed');
  const c = await campaign(id);
  assert.equal(c.status, 'paused');
  assert.match(c.last_error, /^Paused: /);
  const a = await auditFor('outreach.campaign_blocked', id);
  assert.ok(a, 'audited');
  assert.equal(JSON.parse(a.metadata_json).reason, code);
}

test('outreach: a valid campaign sends', async () => {
  const s = await outreachSetup('Out valid');
  const id = await runningCampaign(s, s.manager);
  const calls = await runSender();
  assert.equal(calls.length, 2);
  assert.equal(await sendCount(id), 2);
});

test('outreach: a removed approver pauses the campaign; re-approval by a current member resumes it', async () => {
  const s = await outreachSetup('Out removed');
  const id = await runningCampaign(s, s.manager);
  await db().run("UPDATE workspace_members SET status = 'Removed' WHERE workspace_id = ? AND user_id = ?", [s.owner.workspaceId, s.manager.userId]);
  await assertCampaignBlocked(id, 'SCHEDULER_NOT_MEMBER', await runSender());

  const resumed = await h.api('POST', `/api/v1/outreach/campaigns/${id}/resume`, { token: s.owner.token, body: { confirm: true } });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  assert.equal(Number((await campaign(id)).approved_by), Number(s.owner.userId));
  assert.equal((await runSender()).length, 2);
});

test('outreach: an approver without mail.send, a missing approver, or an inactive workspace sends nothing', async () => {
  const s = await outreachSetup('Out demoted');
  const id = await runningCampaign(s, s.manager);
  await db().run("UPDATE workspace_members SET role = 'Member' WHERE workspace_id = ? AND user_id = ?", [s.owner.workspaceId, s.manager.userId]);
  await assertCampaignBlocked(id, 'SCHEDULER_NOT_AUTHORIZED', await runSender());

  const s2 = await outreachSetup('Out legacy');
  const id2 = await runningCampaign(s2, s2.owner);
  await db().run('UPDATE outreach_campaigns SET approved_by = NULL WHERE id = ?', [id2]);
  await assertCampaignBlocked(id2, 'SCHEDULER_UNKNOWN', await runSender());

  const s3 = await outreachSetup('Out inactive');
  const id3 = await runningCampaign(s3, s3.owner);
  await db().run("UPDATE workspaces SET status = 'Suspended' WHERE id = ?", [s3.owner.workspaceId]);
  await assertCampaignBlocked(id3, 'WORKSPACE_INACTIVE', await runSender());
});

test('outreach: a recipient row from another workspace is held for review, never emailed', async () => {
  const s = await outreachSetup('Out cross A');
  const other = await h.createWorkspace({ name: 'Out cross B' });
  const id = await runningCampaign(s, s.owner);
  const [r1, r2] = await db().all('SELECT id, email FROM outreach_recipients WHERE campaign_id = ? ORDER BY id', [id]);
  await db().run('UPDATE outreach_recipients SET workspace_id = ? WHERE id = ?', [other.workspaceId, r2.id]);

  const calls = await runSender();
  assert.deepEqual(calls, [r1.email], 'only the same-workspace recipient is emailed');
  const held = await db().get('SELECT status, last_error, next_send_at FROM outreach_recipients WHERE id = ?', [r2.id]);
  assert.equal(held.status, 'needs_review');
  assert.equal(held.next_send_at, null);
  const a = await auditFor('outreach.recipient_blocked', r2.id);
  assert.equal(JSON.parse(a.metadata_json).reason, 'RECIPIENT_WORKSPACE_MISMATCH');
  assert.equal(Number(a.workspace_id), Number(s.owner.workspaceId));
});
