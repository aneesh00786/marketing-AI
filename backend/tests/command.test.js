const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Campaign Command Center: strategist brief, audience, builder (reusing the email-sequence
// and Social campaign modules) and overview. All AI and mail calls are mocked.
let A;
let B;
let prodA;
let prodB;
const leads = {};

const db = () => h.db();
const api = (ws, method, path, body) => h.api(method, `/api/v1/command${path}`, { token: ws.token, body });
const aiDown = { match: u => u.startsWith('https://api.groq.com/'), respond: () => h.json(500, {}) };

const BRIEF = {
  objectives: ['Book intro calls with courier operations managers'],
  audience: { summary: 'Operations managers at courier companies', segments: ['Contacted leads'] },
  messaging: { value_proposition: 'RouteKit plans delivery routes', key_messages: ['Plan routes faster', 'Driver app included', 'Cut planning time by 30%'], proof_points: ['Driver app'], call_to_action: 'Book a call' },
  content_plan: [
    { channel: 'email', format: '2-step email sequence', count: 2, purpose: 'Intro and follow-up' },
    { channel: 'linkedin', format: 'posts', count: 2, purpose: 'Awareness' },
    { channel: 'youtube', format: 'video', count: 1, purpose: 'not a chosen channel' }
  ],
  timeline: [{ phase: 'Launch', start_day: 0, end_day: 14, activities: ['Send emails', 'Publish posts'] }],
  kpis: [
    { metric: 'reply_rate', name: 'Reply rate', target: null, why: 'Shows interest' },
    { metric: 'emails_sent', name: 'Emails sent', target: null, why: 'Reach' },
    { metric: 'posts_published', name: 'Posts published', target: null, why: 'Activity' }
  ],
  gaps: ['No customer examples saved']
};
const SEQ = { steps: [
  { delay_days: 0, subject: 'Routes for {{company}}', body: 'Hi {{first_name}},\n\nRouteKit plans delivery routes. Worth a short call?' },
  { delay_days: 3, subject: 'Following up', body: 'Hi {{first_name}},\n\nChecking in on route planning.' }
] };

/** Mock AI: brief prompts get BRIEF, email-sequence prompts get SEQ. Captures prompts. */
function aiMock(prompts = [], { failEmail = false } = {}) {
  return h.mockFetch([{
    match: u => u.startsWith('https://api.groq.com/'),
    respond: (url, init) => {
      const text = JSON.parse(init.body).messages.map(m => m.content).join('\n');
      prompts.push(text);
      if (/email outreach sequence/.test(text)) return failEmail ? h.json(500, {}) : h.json(200, { choices: [{ message: { content: JSON.stringify(SEQ) } }] });
      return h.json(200, { choices: [{ message: { content: JSON.stringify(BRIEF) } }] });
    }
  }]);
}

async function addLead(ws, body) {
  const mock = h.mockFetch([aiDown]);
  try {
    const r = await h.api('POST', '/api/v1/leads', { token: ws.token, body });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.lead.id;
  } finally { mock.restore(); }
}

async function newProgram(ws, extra = {}) {
  const r = await api(ws, 'POST', '/programs', { name: `Program ${Date.now()}`, productId: prodA, goal: 'Book intro calls', targetAudience: 'Courier ops managers', channels: ['email', 'linkedin'], budgetAmount: 500, budgetCurrency: 'USD', ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.program;
}

async function approvedProgram(ws) {
  const p = await newProgram(ws);
  const mock = aiMock();
  try { assert.equal((await api(ws, 'POST', `/programs/${p.id}/brief`)).status, 200); } finally { mock.restore(); }
  assert.equal((await api(ws, 'POST', `/programs/${p.id}/brief/approve`, { confirm: true, acknowledgeFlags: true })).status, 200);
  return p;
}

test.before(async () => {
  await h.prepareDatabase();
  await db().run("UPDATE outreach_campaigns SET status = 'stopped' WHERE status = 'running'");
  A = await h.createWorkspace({ name: 'Command A' });
  B = await h.createWorkspace({ name: 'Command B' });
  assert.equal((await h.api('POST', '/api/v1/mail/config', { token: A.token, body: { provider: 'zeptomail', smtp_user: 'emailapikey', smtp_pass: 'zepto-A', sender_email: 'hello@a-co.io' } })).status, 200);
  prodA = (await h.api('POST', '/api/v1/products', { token: A.token, body: { name: 'RouteKit', tagline: 'Plan delivery routes', features: ['Driver app'] } })).data.productId;
  prodB = (await h.api('POST', '/api/v1/products', { token: B.token, body: { name: 'B Secret Product', tagline: 'B only' } })).data.productId;
  leads.dana = await addLead(A, { name: 'Dana Smith', email: 'dana@fleetco.io', companyName: 'FleetCo', status: 'Contacted', productId: prodA });
  leads.lee = await addLead(A, { name: 'Lee Wong', email: 'lee@fleetco.io', status: 'Contacted', productId: prodA });
  leads.pat = await addLead(A, { name: 'Pat', email: 'pat@example.com', status: 'Contacted', productId: prodA });
  leads.unsub = await addLead(A, { name: 'Una Sub', email: 'una@shipit.io', status: 'Contacted', productId: prodA });
  leads.b = await addLead(B, { name: 'B Lead', email: 'b@other.io' });
  await db().run("INSERT IGNORE INTO email_suppressions (workspace_id, email, reason, source) VALUES (?, 'una@shipit.io', 'unsubscribed', 'test')", [A.workspaceId]);
});
test.after(() => h.shutdown());

test('programs validate inputs and product ownership', async () => {
  assert.equal((await api(A, 'POST', '/programs', { name: 'X', productId: prodB, channels: ['email'] })).status, 404, 'foreign product');
  assert.equal((await api(A, 'POST', '/programs', { name: 'X', channels: ['tiktok'] })).status, 400);
  assert.equal((await api(A, 'POST', '/programs', { name: 'X', channels: [] })).status, 400);
  assert.equal((await api(A, 'POST', '/programs', { name: 'X', channels: ['email'], budgetAmount: 100 })).status, 400, 'budget needs a currency');
  assert.equal((await api(A, 'POST', '/programs', { name: 'X', channels: ['email'], startDate: '2026-02-01', endDate: '2026-01-01' })).status, 400);
  const p = await newProgram(A, { workspace_id: undefined });
  assert.equal(p.status, 'draft');
  assert.deepEqual(p.budget, { amount: 500, currency: 'USD', note: null });
});

test('strategist brief: AI only, grounded in product facts and CRM counts, honest KPIs', async () => {
  const p = await newProgram(A);
  const down = h.mockFetch([aiDown]);
  let r;
  try { r = await api(A, 'POST', `/programs/${p.id}/brief`); } finally { down.restore(); }
  assert.equal(r.status, 503);
  assert.equal(r.data.code, 'AI_UNAVAILABLE');
  const after = (await api(A, 'GET', `/programs/${p.id}`)).data.program;
  assert.equal(after.status, 'draft');
  assert.equal(after.brief, null, 'no canned brief');

  const prompts = [];
  const mock = aiMock(prompts);
  try { r = await api(A, 'POST', `/programs/${p.id}/brief`); } finally { mock.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const prog = r.data.program;
  assert.equal(prog.status, 'brief_ready');
  assert.match(prompts[0], /Plan delivery routes/);
  assert.match(prompts[0], /"leads_with_email"/);
  assert.match(prompts[0], /"amount":500/);
  assert.doesNotMatch(prompts[0], /B Secret Product|B only/);
  assert.deepEqual(prog.brief.content_plan.map(c => c.channel), ['email', 'linkedin'], 'unchosen channels dropped');
  assert.ok(prog.brief.kpis.every(k => k.target === null));
  assert.deepEqual(prog.briefFlags, ['30%']);
});

test('approval gates: brief approval before build; roles are enforced', async () => {
  const p = await newProgram(A);
  assert.equal((await api(A, 'POST', `/programs/${p.id}/build`, { confirm: true })).status, 409, 'no build before a brief');
  const mock = aiMock();
  try { await api(A, 'POST', `/programs/${p.id}/brief`); } finally { mock.restore(); }
  const build = await api(A, 'POST', `/programs/${p.id}/build`, { confirm: true });
  assert.equal(build.status, 409);
  assert.equal(build.data.code, 'BRIEF_NOT_APPROVED');
  assert.equal((await api(A, 'POST', `/programs/${p.id}/brief/approve`, {})).status, 400, 'confirm required');
  const flagged = await api(A, 'POST', `/programs/${p.id}/brief/approve`, { confirm: true });
  assert.equal(flagged.status, 409);
  assert.equal(flagged.data.code, 'UNVERIFIED_CLAIMS');

  const member = await h.addMember(A.workspaceId, 'Member');
  const approver = await h.addMember(A.workspaceId, 'Approver');
  assert.equal((await api(member, 'POST', `/programs/${p.id}/brief/approve`, { confirm: true, acknowledgeFlags: true })).status, 403);
  assert.equal((await api(member, 'POST', '/programs', { name: 'X', channels: ['email'] })).status, 403);
  assert.equal((await api(approver, 'POST', `/programs/${p.id}/brief/approve`, { confirm: true, acknowledgeFlags: true })).status, 200, 'approvers approve briefs');
  assert.equal((await api(approver, 'POST', `/programs/${p.id}/build`, { confirm: true })).status, 403, 'but cannot build');
  assert.equal((await api(A, 'PATCH', `/programs/${p.id}`, { name: 'Changed' })).status, 409, 'approved brief is locked');
  assert.equal((await api(A, 'POST', `/programs/${p.id}/build`, {})).status, 400, 'build needs confirmation');
});

test('audience: real CRM leads with reasons; suppressed, placeholder and foreign leads excluded', async () => {
  const p = await newProgram(A);
  const r = await api(A, 'POST', `/programs/${p.id}/audience/preview`, { filter: { statuses: ['Contacted'], minScore: 0 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const byName = Object.fromEntries(r.data.audience.map(a => [a.name, a]));
  assert.equal(byName['Dana Smith'].eligible, true);
  assert.ok(byName['Dana Smith'].reasons.includes('Status is Contacted'));
  assert.ok(byName['Dana Smith'].reasons.some(x => /Interested in RouteKit/.test(x)));
  assert.ok(byName['Dana Smith'].reasons.some(x => /Score factors: .*Valid email/.test(x)));
  assert.equal(byName.Pat.eligible, false);
  assert.equal(byName['Una Sub'].eligible, false);
  assert.match(byName['Una Sub'].reason, /unsubscribed/);
  assert.ok(!r.data.audience.some(a => a.name === 'B Lead'));

  assert.equal((await api(A, 'PUT', `/programs/${p.id}/audience`, { leadIds: [leads.dana, leads.b] })).status, 404, 'foreign lead');
  const saved = await api(A, 'PUT', `/programs/${p.id}/audience`, { leadIds: [leads.dana, leads.lee, leads.pat, leads.unsub] });
  assert.equal(saved.data.saved, 2);
  assert.deepEqual(saved.data.program.leadIds.sort(), [leads.dana, leads.lee].sort());
});

test('builder creates an email sequence and a social campaign through the existing modules, sending nothing', async () => {
  const p = await approvedProgram(A);
  await api(A, 'PUT', `/programs/${p.id}/audience`, { leadIds: [leads.dana, leads.lee] });
  const emailsBefore = Number((await db().get('SELECT COUNT(*) AS n FROM emails WHERE workspace_id = ?', [A.workspaceId])).n);
  const prompts = [];
  const mock = aiMock(prompts);
  let r;
  try { r = await api(A, 'POST', `/programs/${p.id}/build`, { confirm: true }); } finally { mock.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.program.status, 'built');
  const emailId = r.data.result.email.campaignId;
  const socialId = r.data.result.social.campaignId;
  assert.equal(r.data.result.social.generation.status, 'queued');
  assert.match(prompts.find(x => /email outreach sequence/.test(x)), /Plan routes faster/, 'brief messaging feeds the sequence');

  // The email sequence lives in the outreach module, still a draft that needs its own approval.
  const email = await h.api('GET', `/api/v1/outreach/campaigns/${emailId}`, { token: A.token });
  assert.equal(email.status, 200);
  assert.equal(email.data.campaign.status, 'draft');
  assert.equal(email.data.campaign.steps.length, 2);
  assert.equal(email.data.campaign.stats.pending, 2);
  // The social campaign lives in Social Media Marketing with generation queued (worker writes the posts).
  const social = await h.api('GET', `/api/v1/social/campaigns/${socialId}`, { token: A.token });
  assert.equal(social.status, 200);
  assert.deepEqual(social.data.campaign.platforms, ['linkedin']);
  assert.equal(social.data.campaign.generationStatus, 'queued');
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM emails WHERE workspace_id = ?', [A.workspaceId])).n), emailsBefore, 'nothing sent');
  assert.equal(Number((await db().get("SELECT COUNT(*) AS n FROM content_items WHERE campaign_id = ? AND status IN ('scheduled','published')", [socialId])).n), 0, 'nothing published');

  // Rebuilding is idempotent: no duplicate campaigns or recipients.
  const again = await api(A, 'POST', `/programs/${p.id}/build`, { confirm: true });
  assert.equal(again.data.result.email.campaignId, emailId);
  assert.equal(again.data.result.social.campaignId, socialId);
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM outreach_recipients WHERE campaign_id = ?', [emailId])).n), 2);

  // Other workspaces cannot reach the built campaigns.
  assert.equal((await h.api('GET', `/api/v1/outreach/campaigns/${emailId}`, { token: B.token })).status, 404);
  assert.equal((await h.api('GET', `/api/v1/social/campaigns/${socialId}`, { token: B.token })).status, 404);
});

test('a failed email generation is reported; the build can be retried without duplicates', async () => {
  const p = await approvedProgram(A);
  let mock = aiMock([], { failEmail: true });
  let r;
  try { r = await api(A, 'POST', `/programs/${p.id}/build`, { confirm: true }); } finally { mock.restore(); }
  assert.equal(r.status, 200);
  assert.match(r.data.result.email.error, /AI|model/i);
  const emailId = r.data.result.email.campaignId;
  assert.ok(emailId, 'the draft sequence exists, without emails');
  assert.equal(r.data.program.status, 'built');
  assert.match(r.data.program.lastError, /^Email:/);
  mock = aiMock();
  try { r = await api(A, 'POST', `/programs/${p.id}/build`, { confirm: true }); } finally { mock.restore(); }
  assert.equal(r.data.result.email.campaignId, emailId);
  assert.equal(r.data.result.email.sequence, 'generated');
  assert.equal(r.data.program.lastError, null);
});

test('overview shows approvals, scheduled activity, failures and real metrics against KPIs', async () => {
  const p = await approvedProgram(A);
  await api(A, 'PUT', `/programs/${p.id}/audience`, { leadIds: [leads.dana] });
  let mock = aiMock();
  let built;
  try { built = await api(A, 'POST', `/programs/${p.id}/build`, { confirm: true }); } finally { mock.restore(); }
  const emailId = built.data.result.email.campaignId;
  const socialId = built.data.result.social.campaignId;

  let ov = (await api(A, 'GET', `/programs/${p.id}/overview`)).data;
  assert.ok(ov.approvals.some(a => a.kind === 'email'), 'email sequence awaits approval');
  assert.equal(ov.metrics.emails_sent, 0);
  assert.equal(ov.kpis.find(k => k.metric === 'reply_rate').actual, null, 'no rate before anything is sent');

  // Approve and send the first email through the existing outreach engine (mocked provider).
  await db().run('UPDATE outreach_campaigns SET send_days = ?, send_start_hour = 0, send_end_hour = 24 WHERE id = ?', ['1,2,3,4,5,6,7', emailId]);
  assert.equal((await h.api('POST', `/api/v1/outreach/campaigns/${emailId}/approve`, { token: A.token, body: { confirm: true } })).status, 200);
  const calls = [];
  mock = h.mockFetch([{ match: u => u.startsWith('https://api.zeptomail.com/'), respond: () => { calls.push(1); return h.json(200, { request_id: 'r1' }); } }]);
  try { await require('../modules/outreach/outreachSender').processOutreach('test-worker'); } finally { mock.restore(); }
  assert.equal(calls.length, 1);
  await db().run("UPDATE campaigns SET generation_status = 'failed', generation_error = 'AI quota reached' WHERE id = ?", [socialId]);

  ov = (await api(A, 'GET', `/programs/${p.id}/overview`)).data;
  assert.equal(ov.metrics.emails_sent, 1);
  assert.equal(ov.metrics.reply_rate, 0);
  assert.equal(ov.kpis.find(k => k.metric === 'emails_sent').actual, 1);
  assert.ok(ov.scheduled.some(s => s.kind === 'email'), 'next follow-up is scheduled');
  assert.ok(ov.failures.some(f => /generation failed: AI quota reached/.test(f.label)));
  assert.equal(ov.metrics.posts_published, 0);
  await h.api('POST', `/api/v1/outreach/campaigns/${emailId}/stop`, { token: A.token });
});

test('programs are private to their workspace', async () => {
  const p = await newProgram(A);
  for (const [m, path, b] of [['GET', `/programs/${p.id}`], ['PATCH', `/programs/${p.id}`, { name: 'x' }], ['POST', `/programs/${p.id}/brief`],
    ['POST', `/programs/${p.id}/brief/approve`, { confirm: true }], ['POST', `/programs/${p.id}/audience/preview`, {}], ['PUT', `/programs/${p.id}/audience`, { leadIds: [] }],
    ['POST', `/programs/${p.id}/build`, { confirm: true }], ['GET', `/programs/${p.id}/overview`], ['DELETE', `/programs/${p.id}`]]) {
    assert.equal((await api(B, m, path, b)).status, 404, `${m} ${path}`);
  }
  assert.ok(!(await api(B, 'GET', '/programs')).data.programs.some(x => x.id === p.id));
  assert.equal((await h.api('GET', '/api/v1/command/programs')).status, 401);
});
