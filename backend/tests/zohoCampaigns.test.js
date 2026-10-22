const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Email campaigns managed in Marketech.ai, delivered through Zoho Campaigns. Zoho Accounts and the
// Campaigns API are a local fake behind the fetch mock; unmatched requests fail loudly, so no
// real Zoho call is made and nothing is ever sent.
const db = () => h.db();
const zohoSvc = () => require('../modules/mail/zoho/zohoService');
let A;
let B;

process.env.ZOHO_CAMPAIGNS_CLIENT_ID = 'test-client-id';
process.env.ZOHO_CAMPAIGNS_CLIENT_SECRET = 'test-client-secret';
// Zoho imports content from a public https URL (validated); this host is never contacted.
process.env.APP_BASE_URL = 'https://app.marketech.test';
const ALL_SCOPES = 'ZohoCampaigns.campaign.CREATE,ZohoCampaigns.campaign.READ,ZohoCampaigns.campaign.UPDATE,ZohoCampaigns.contact.READ';

// Zoho campaign keys are unique per account, across tests too.
let keySeq = 9000 + Math.floor(Math.random() * 1e6) * 10;

function fakeZoho() {
  const z = { calls: [], codes: {}, refresh: {}, access: {}, accounts: {}, issued: 0, createResponder: null, sendResponder: null, refreshResponder: null };
  z.account = (name, { lists = [{ listkey: 'L1', listname: 'Opted-in customers', noofcontacts: '120' }], topics = [] } = {}) => {
    z.accounts[name] = { lists, topics, campaigns: {} };
    return name;
  };
  z.grant = (code, account, dc = 'com', scope = ALL_SCOPES) => { z.codes[code] = { refresh: `rt-${account}`, dc, scope }; z.refresh[`rt-${account}`] = account; };
  const form = init => Object.fromEntries(new URLSearchParams(init.body));
  z.routes = [
    {
      match: u => /^https:\/\/accounts\.zoho\.[a-z.]+\/oauth\/v2\/token$/.test(u),
      respond: (url, init) => {
        const f = form(init);
        z.calls.push({ kind: 'token', url, grant: f.grant_type });
        if (f.grant_type === 'authorization_code') {
          const c = z.codes[f.code];
          if (!c || !url.startsWith(`https://accounts.zoho.${c.dc}/`)) return h.json(200, { error: 'invalid_code' });
          delete z.codes[f.code];
          return h.json(200, { access_token: `first-${c.refresh}`, refresh_token: c.refresh, expires_in: 3600, scope: c.scope });
        }
        if (z.refreshResponder) return z.refreshResponder(f);
        const account = z.refresh[f.refresh_token];
        if (!account) return h.json(200, { error: 'invalid_code' });
        const token = `at-${account}-${++z.issued}`;
        z.access[token] = account;
        return h.json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
      }
    },
    {
      match: u => /^https:\/\/campaigns\.zoho\.[a-z.]+\/api\/v1\.1\//.test(u),
      respond: (url, init) => {
        const u = new URL(url);
        const endpoint = u.pathname.split('/').pop();
        const params = Object.fromEntries(init.method === 'POST' ? new URLSearchParams(init.body) : u.searchParams);
        const token = String(init.headers.Authorization || '').replace('Zoho-oauthtoken ', '');
        z.calls.push({ kind: 'api', endpoint, host: u.host, token, params, method: init.method });
        const account = z.access[token];
        if (!account) return h.json(401, { status: 'error', code: '1007', message: 'Unauthorized key' });
        const acct = z.accounts[account];
        if (endpoint === 'getmailinglists') return h.json(200, { status: 'success', code: '0', list_of_details: acct.lists });
        if (endpoint === 'topics') return h.json(200, { code: '0', topicDetails: acct.topics });
        if (endpoint === 'createCampaign') {
          if (z.createResponder) return z.createResponder(params, acct);
          const key = String(++keySeq);
          acct.campaigns[key] = { name: params.campaignname, status: 'Draft', params };
          return h.json(200, { message: 'Campaign created successfully', campaignKey: key, code: '200' });
        }
        if (endpoint === 'recentcampaigns') {
          const list = Object.entries(acct.campaigns).map(([k, c]) => ({ campaign_key: k, campaign_name: c.name, campaign_status: c.status }));
          if (!list.length) return h.json(200, { status: 'error', code: '6101', message: 'No campaign available in this view' });
          return h.json(200, { status: 'success', code: '0', recent_campaigns: list });
        }
        const c = acct.campaigns[params.campaignkey];
        if (!c) return h.json(200, { status: 'error', code: '6301', message: 'Invalid campiagn key.' });
        if (endpoint === 'sendcampaign') {
          if (z.sendResponder) return z.sendResponder(c);
          if (c.status === 'Sent') return h.json(200, { status: 'error', code: '6600', message: 'Campaign is sent.' });
          c.status = 'Sent';
          return h.json(200, { status: 'success', code: '200', message: 'Campaign has been sent successfully', campaign_status: 'inprogress' });
        }
        if (endpoint === 'getcampaigndetails') {
          return h.json(200, { status: 'success', code: '0', campaign_status: c.status, 'campaign-details': [{ campaign_name: c.name }], 'campaign-reports': [{ emails_sent_count: c.status === 'Sent' ? '120' : '0', delivered_count: c.status === 'Sent' ? '118' : '0', bounces_count: '2', opens_count: '40' }] });
        }
        return h.json(404, { status: 'error', code: '404' });
      }
    }
  ];
  return z;
}

let Z;
let mock;

test.before(async () => {
  await h.prepareDatabase();
  process.env.APP_BASE_URL = 'https://app.marketech.test';
  A = await h.createWorkspace({ name: 'Campaigns A' });
  B = await h.createWorkspace({ name: 'Campaigns B' });
});
test.beforeEach(() => { Z = fakeZoho(); mock = h.mockFetch(Z.routes); zohoSvc()._tokenCache.clear(); });
test.afterEach(() => mock.restore());
test.after(() => h.shutdown());

const zapi = (ws, method, p, body) => h.api(method, `/api/v1/mail/zoho${p}`, { token: ws.token, body });
const capi = (ws, method, p, body) => h.api(method, `/api/v1/mail/campaigns${p}`, { token: ws.token, body });
const apiCalls = endpoint => Z.calls.filter(c => c.kind === 'api' && c.endpoint === endpoint);

async function connect(ws, account, { location = 'us', accountsServer, code = `code-${account}-${Date.now()}-${Math.random()}`, dc = 'com', scope } = {}) {
  Z.grant(code, account, dc, scope);
  const start = await zapi(ws, 'POST', '/connect', {});
  assert.equal(start.status, 200, JSON.stringify(start.data));
  const state = new URL(start.data.authorizeUrl).searchParams.get('state');
  const q = new URLSearchParams({ state, code, location, ...(accountsServer ? { 'accounts-server': accountsServer } : {}) });
  const cb = await h.api('GET', `/api/v1/mail/zoho/callback?${q}`);
  return { cb, state, location: cb.headers.get('location') || '' };
}
const connection = wsId => db().get("SELECT * FROM mail_provider_connections WHERE workspace_id = ? AND provider = 'zoho_campaigns'", [wsId]);

const GOOD = {
  name: 'October newsletter',
  subject: 'What is new in October',
  fromName: 'Acme',
  fromEmail: 'news@acme-co.io',
  html: '<p>Hello!</p><p>Our October update.</p><p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>',
  lists: [{ key: 'L1', name: 'Opted-in customers' }]
};

async function readyCampaign(ws, extra = {}) {
  const c = await capi(ws, 'POST', '', { ...GOOD, ...extra });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const a = await capi(ws, 'POST', `/${c.data.campaign.id}/approve`, {});
  assert.equal(a.status, 200, JSON.stringify(a.data));
  return a.data.campaign;
}
const row = id => db().get('SELECT * FROM mail_campaigns WHERE id = ?', [id]);

// ------------------------------------------------------------------ connection

test('connect: Owners/Admins only; offline access with the delivery scopes and a single-use state', async () => {
  for (const role of ['Member', 'Approver', 'Marketing Manager']) {
    const m = await h.addMember(A.workspaceId, role);
    assert.equal((await zapi(m, 'POST', '/connect', {})).status, 403, role);
    assert.equal((await zapi(m, 'POST', '/disconnect', {})).status, 403, role);
  }
  const u = new URL((await zapi(A, 'POST', '/connect', {})).data.authorizeUrl);
  assert.equal(u.origin, 'https://accounts.zoho.com');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('scope'), ALL_SCOPES);
  assert.equal(u.searchParams.get('redirect_uri'), 'https://app.marketech.test/api/v1/mail/zoho/callback');
  assert.ok(!(await db().get('SELECT 1 AS x FROM oauth_states WHERE state_hash = ?', [u.searchParams.get('state')])), 'raw state never stored');
  const s = await zapi(A, 'GET', '/status');
  assert.equal(s.data.limits.known, false, 'sending limits are not assumed');
});

test('callback: connects with an encrypted refresh token, never logged; states are single use', async () => {
  Z.account('acctA');
  const { state, location } = await connect(A, 'acctA');
  assert.match(location, /view=mail/);
  assert.match(location, /zoho=connected/);
  const r = await connection(A.workspaceId);
  assert.equal(r.status, 'connected');
  assert.ok(r.refresh_token_ciphertext && !r.refresh_token_ciphertext.includes('rt-acctA'));
  const logs = await db().all("SELECT metadata_json FROM audit_logs WHERE workspace_id = ? AND action LIKE 'mail.zoho.%'", [A.workspaceId]);
  assert.ok(logs.every(l => !String(l.metadata_json || '').includes('rt-acctA')));
  const reuse = await h.api('GET', `/api/v1/mail/zoho/callback?${new URLSearchParams({ state, code: 'x' })}`);
  assert.match(reuse.headers.get('location'), /reason=invalid_state/);
});

test('callback: region from the allowlist only; foreign accounts-server refused before any token request', async () => {
  const C = await h.createWorkspace({ name: 'Campaigns EU' });
  Z.account('acctEU');
  assert.match((await connect(C, 'acctEU', { location: 'eu', accountsServer: 'https://accounts.zoho.eu', dc: 'eu' })).location, /zoho=connected/);
  assert.equal((await connection(C.workspaceId)).api_host, 'https://campaigns.zoho.eu');
  assert.equal((await capi(C, 'GET', '/audiences')).status, 200);
  assert.ok(Z.calls.filter(c => c.kind === 'api').every(c => c.host === 'campaigns.zoho.eu'));

  const D = await h.createWorkspace({ name: 'Campaigns evil' });
  const before = Z.calls.length;
  assert.match((await connect(D, 'acctX', { location: 'eu', accountsServer: 'https://evil.example.net' })).location, /reason=unknown_region/);
  assert.equal(Z.calls.length, before);
});

test('callback: a member who lost mail.configure cannot complete the connection', async () => {
  const E = await h.createWorkspace({ name: 'Campaigns demoted' });
  const admin = await h.addMember(E.workspaceId, 'Workspace Admin');
  Z.grant('code-demoted', 'acctD');
  const start = await zapi(admin, 'POST', '/connect', {});
  await db().run("UPDATE workspace_members SET role = 'Member' WHERE workspace_id = ? AND user_id = ?", [E.workspaceId, admin.userId]);
  const state = new URL(start.data.authorizeUrl).searchParams.get('state');
  const cb = await h.api('GET', `/api/v1/mail/zoho/callback?${new URLSearchParams({ state, code: 'code-demoted', location: 'us' })}`);
  assert.match(cb.headers.get('location'), /reason=not_allowed/);
  assert.equal(await connection(E.workspaceId), null);
});

test('a connection without the delivery scopes (made in Phase 6B) must reconnect before sending', async () => {
  Z.account('acctOld');
  const F = await h.createWorkspace({ name: 'Campaigns old scopes' });
  await connect(F, 'acctOld', { scope: 'ZohoCampaigns.campaign.READ,ZohoCampaigns.campaign.UPDATE' });
  const s = await zapi(F, 'GET', '/status');
  assert.deepEqual(s.data.connection.missingScopes, ['ZohoCampaigns.campaign.CREATE', 'ZohoCampaigns.contact.READ']);
  assert.equal((await capi(F, 'GET', '/audiences')).data.code, 'ZOHO_SCOPES_MISSING');
});

// ------------------------------------------------------------------ campaign management in Marketech.ai

test('campaigns are created and edited in Marketech.ai; permissions and workspace isolation', async () => {
  Z.account('acctA');
  await connect(A, 'acctA');
  const member = await h.addMember(A.workspaceId, 'Member');
  const approver = await h.addMember(A.workspaceId, 'Approver');

  const c = await capi(member, 'POST', '', GOOD);
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const id = c.data.campaign.id;
  assert.equal(c.data.campaign.status, 'draft');
  assert.equal((await capi(approver, 'POST', '', GOOD)).status, 403, 'approvers do not write campaigns');
  assert.equal((await capi(member, 'POST', `/${id}/approve`, {})).status, 403, 'members do not approve');
  assert.equal((await capi(member, 'POST', `/${id}/send`, { confirm: true })).status, 403, 'members do not send');
  assert.equal((await capi(member, 'POST', '', { ...GOOD, workspaceId: B.workspaceId })).status, 400, 'no client-supplied workspace');

  const approved = await capi(approver, 'POST', `/${id}/approve`, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.campaign.approved, true);
  // An edit after approval needs a new approval.
  const edited = await capi(member, 'PATCH', `/${id}`, { subject: 'Changed' });
  assert.equal(edited.data.campaign.status, 'draft');
  assert.equal(edited.data.campaign.version, 2);
  assert.equal(edited.data.campaign.approved, false);

  // Another workspace can neither see nor touch it.
  for (const [m, p, body] of [['GET', `/${id}`], ['PATCH', `/${id}`, { name: 'x' }], ['DELETE', `/${id}`], ['POST', `/${id}/approve`, {}], ['POST', `/${id}/send`, { confirm: true }], ['POST', `/${id}/refresh`, {}]]) {
    assert.equal((await capi(B, m, p, body)).status, 404, `${m} ${p}`);
  }
  assert.ok(!(await capi(B, 'GET', '')).data.campaigns.some(x => x.id === id));
  assert.equal(apiCalls('createCampaign').length + apiCalls('sendcampaign').length, 0);
});

test('recipient lists come from the workspace\'s own Zoho account; nothing is uploaded', async () => {
  Z.account('acctA', { lists: [{ listkey: 'L1', listname: 'Opted-in customers', noofcontacts: '120' }, { listkey: 'L2', listname: 'Webinar sign-ups', noofcontacts: '35' }], topics: [{ topicId: 'T1', topicName: 'Product news' }] });
  await connect(A, 'acctA');
  const r = await capi(A, 'GET', '/audiences');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.lists.map(l => l.key), ['L1', 'L2']);
  assert.deepEqual(r.data.topics, [{ id: 'T1', name: 'Product news' }]);
  assert.equal((await capi(B, 'GET', '/audiences')).data.code, 'NOT_CONNECTED');
  assert.ok(Z.calls.filter(c => c.kind === 'api').every(c => ['getmailinglists', 'topics'].includes(c.endpoint)));
});

test('validation: required fields, sender domain, placeholders, lists that exist in Zoho, public content URL', async () => {
  Z.account('acctA');
  await connect(A, 'acctA');
  const bad = await capi(A, 'POST', '', { name: 'Bad', subject: 'Hi [First name]', fromEmail: 'me@gmail.com', html: '<p>Hello [Company]</p><img src="/logo.png">', lists: [{ key: 'GONE' }] });
  const v = (await capi(A, 'POST', `/${bad.data.campaign.id}/validate`, {})).data.validation;
  assert.equal(v.ready, false);
  const all = v.problems.join(' | ');
  assert.match(all, /public mailbox domains/);
  assert.match(all, /\[First name\]/);
  assert.match(all, /\[Company\]/);
  assert.match(all, /no longer exist in Zoho: GONE/);
  assert.ok(v.warnings.some(w => /unsubscribe/i.test(w)));
  assert.ok(v.warnings.some(w => /https/.test(w)));
  assert.equal((await capi(A, 'POST', `/${bad.data.campaign.id}/approve`, {})).data.code, 'NOT_READY');

  const good = await capi(A, 'POST', '', GOOD);
  const gv = (await capi(A, 'POST', `/${good.data.campaign.id}/validate`, {})).data.validation;
  assert.deepEqual(gv.problems, [], 'Zoho merge tags such as $[LI:UNSUBSCRIBE]$ are not placeholders');

  const saved = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'http://localhost:8000';
  try {
    const lv = (await capi(A, 'POST', `/${good.data.campaign.id}/validate`, {})).data.validation;
    assert.ok(lv.problems.some(p => /public https APP_BASE_URL/.test(p)));
  } finally { process.env.APP_BASE_URL = saved; }
});

// ------------------------------------------------------------------ delivery through Zoho

test('send: Zoho delivery object is created internally, then sent; exactly once; content served safely', async () => {
  Z.account('acctA', { topics: [{ topicId: 'T1', topicName: 'News' }] });
  await connect(A, 'acctA');
  const c = await readyCampaign(A, { topicId: 'T1' });
  assert.equal((await capi(A, 'POST', `/${c.id}/send`, {})).data.code, 'CONFIRMATION_REQUIRED');
  const sent = await capi(A, 'POST', `/${c.id}/send`, { confirm: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.campaign.status, 'submitted');
  assert.equal(sent.data.campaign.zohoStatus, 'inprogress');

  const [create] = apiCalls('createCampaign');
  assert.equal(apiCalls('createCampaign').length, 1);
  assert.equal(create.method, 'POST');
  assert.match(create.params.campaignname, new RegExp(`October newsletter \\(Marketech #${c.id} v1\\)`));
  assert.equal(create.params.from_email, 'news@acme-co.io');
  assert.equal(create.params.from_name, 'Acme');
  assert.equal(create.params.subject, 'What is new in October');
  assert.deepEqual(JSON.parse(create.params.list_details), { L1: [] });
  assert.equal(create.params.topicId, 'T1');
  const [send] = apiCalls('sendcampaign');
  assert.equal(apiCalls('sendcampaign').length, 1);
  assert.equal(send.params.campaignkey, (await row(c.id)).zoho_campaign_key);

  // Zoho imports the content from a token URL: approved HTML only, sandboxed, not cached.
  const url = new URL(create.params.content_url);
  assert.equal(url.origin, 'https://app.marketech.test');
  const content = await h.api('GET', url.pathname);
  assert.equal(content.status, 200);
  assert.match(content.data, /Our October update/);
  assert.match(content.headers.get('content-security-policy'), /sandbox/);
  assert.equal(content.headers.get('cache-control'), 'no-store');
  assert.equal((await h.api('GET', url.pathname.replace(/.$/, c => (c === 'A' ? 'B' : 'A')))).status, 404);
  assert.ok(!(await row(c.id)).content_token_hash.includes(url.pathname.split('/').pop()), 'only the hash is stored');

  const again = await capi(A, 'POST', `/${c.id}/send`, { confirm: true });
  assert.equal(again.data.code, 'ALREADY_SUBMITTED');
  assert.equal(apiCalls('sendcampaign').length, 1);
  const audits = await db().all("SELECT action FROM audit_logs WHERE resource_type = 'mail_campaign' AND resource_id = ? ORDER BY id", [String(c.id)]);
  assert.deepEqual(audits.map(a => a.action).filter(a => a.startsWith('mail.campaign_')), ['mail.campaign_created', 'mail.campaign_approved', 'mail.campaign_submit_started', 'mail.campaign_zoho_prepared', 'mail.campaign_submitted']);
});

test('send: simultaneous requests create and send once', async () => {
  Z.account('acctA');
  await connect(A, 'acctA');
  const c = await readyCampaign(A);
  Z.createResponder = (params, acct) => new Promise(r => setTimeout(() => { const k = String(++keySeq); acct.campaigns[k] = { name: params.campaignname, status: 'Draft' }; r(h.json(200, { campaignKey: k, code: '200' })); }, 120));
  const results = await Promise.all([1, 2, 3].map(() => capi(A, 'POST', `/${c.id}/send`, { confirm: true })));
  assert.equal(apiCalls('createCampaign').length, 1);
  assert.equal(apiCalls('sendcampaign').length, 1);
  assert.equal(results.filter(r => r.status === 200).length, 1);
});

test('unclear create: held for review; reconciled by the unique name in Zoho; the object is reused, never created twice', async () => {
  Z.account('acctA');
  await connect(A, 'acctA');
  const c = await readyCampaign(A);
  const lostKey = String(++keySeq);
  Z.createResponder = (params, acct) => { acct.campaigns[lostKey] = { name: params.campaignname, status: 'Draft' }; return Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
  const r = await capi(A, 'POST', `/${c.id}/send`, { confirm: true });
  assert.equal(r.data.code, 'ZOHO_OUTCOME_UNKNOWN');
  assert.equal((await row(c.id)).status, 'needs_review');
  assert.equal((await capi(A, 'POST', `/${c.id}/send`, { confirm: true })).data.code, 'NEEDS_REVIEW');
  assert.equal((await capi(A, 'PATCH', `/${c.id}`, { subject: 'x' })).status, 409, 'not editable while unclear');

  Z.createResponder = null;
  const refreshed = await capi(A, 'POST', `/${c.id}/refresh`, {});
  assert.equal(refreshed.data.campaign.status, 'failed');
  assert.equal(refreshed.data.campaign.zohoPrepared, true);
  const sent = await capi(A, 'POST', `/${c.id}/send`, { confirm: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(apiCalls('createCampaign').length, 1, 'not created a second time');
  assert.equal(apiCalls('sendcampaign')[0].params.campaignkey, lostKey);
});

test('unclear create that never happened: resolvable only after a wait and a Zoho check, then sent deliberately', async () => {
  Z.account('acctA');
  await connect(A, 'acctA');
  const c = await readyCampaign(A);
  Z.createResponder = () => h.json(503, {});
  assert.equal((await capi(A, 'POST', `/${c.id}/send`, { confirm: true })).data.code, 'ZOHO_OUTCOME_UNKNOWN');
  assert.equal((await capi(A, 'POST', `/${c.id}/resolve`, { confirm: true })).data.code, 'TOO_EARLY');
  await db().run('UPDATE mail_campaigns SET updated_at = UTC_TIMESTAMP() - INTERVAL 20 MINUTE WHERE id = ?', [c.id]);
  const member = await h.addMember(A.workspaceId, 'Member');
  assert.equal((await capi(member, 'POST', `/${c.id}/resolve`, { confirm: true })).status, 403);
  const resolved = await capi(A, 'POST', `/${c.id}/resolve`, { confirm: true });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
  assert.equal(resolved.data.campaign.status, 'failed');
  Z.createResponder = null;
  assert.equal((await capi(A, 'POST', `/${c.id}/send`, { confirm: true })).status, 200);
  assert.equal(apiCalls('createCampaign').length, 2);
  assert.equal(apiCalls('sendcampaign').length, 1);
});

test('unclear send: reconciled from Zoho\'s campaign status; never resent automatically', async () => {
  Z.account('acctA');
  await connect(A, 'acctA');
  const c1 = await readyCampaign(A);
  Z.sendResponder = camp => { camp.status = 'Sent'; return Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } }); };
  assert.equal((await capi(A, 'POST', `/${c1.id}/send`, { confirm: true })).data.code, 'ZOHO_OUTCOME_UNKNOWN');
  assert.equal((await row(c1.id)).submit_stage, 'send');
  const r1 = await capi(A, 'POST', `/${c1.id}/refresh`, {});
  assert.equal(r1.data.campaign.status, 'submitted');
  assert.equal(r1.data.campaign.report.delivered_count, '118', 'delivery figures come from Zoho');

  // Zoho still shows it unsent: after a wait it may be marked not sent and sent again (same object).
  const c2 = await readyCampaign(A, { name: 'Second' });
  Z.sendResponder = () => h.json(502, {});
  assert.equal((await capi(A, 'POST', `/${c2.id}/send`, { confirm: true })).data.code, 'ZOHO_OUTCOME_UNKNOWN');
  await db().run('UPDATE mail_campaigns SET updated_at = UTC_TIMESTAMP() - INTERVAL 20 MINUTE WHERE id = ?', [c2.id]);
  assert.equal((await capi(A, 'POST', `/${c2.id}/resolve`, { confirm: true })).data.campaign.status, 'failed');
  Z.sendResponder = null;
  const creates = apiCalls('createCampaign').length;
  assert.equal((await capi(A, 'POST', `/${c2.id}/send`, { confirm: true })).status, 200);
  assert.equal(apiCalls('createCampaign').length, creates, 'the Zoho object is reused');
});

test('clear Zoho rejections leave the campaign editable; "Campaign is sent" is recorded, not repeated', async () => {
  Z.account('acctA');
  await connect(A, 'acctA');
  const c = await readyCampaign(A);
  Z.createResponder = () => h.json(200, { status: 'error', code: '1004', message: 'Invalid URL for content import.' });
  const r = await capi(A, 'POST', `/${c.id}/send`, { confirm: true });
  assert.equal(r.status, 400);
  assert.equal(r.data.providerCode, '1004');
  assert.equal((await row(c.id)).status, 'failed');
  // Edit -> new version -> approve -> send creates a fresh delivery object.
  Z.createResponder = null;
  await capi(A, 'PATCH', `/${c.id}`, { subject: 'Fixed subject' });
  await capi(A, 'POST', `/${c.id}/approve`, {});
  assert.equal((await capi(A, 'POST', `/${c.id}/send`, { confirm: true })).status, 200);
  assert.match(apiCalls('createCampaign').pop().params.campaignname, /v2\)/);

  const c2 = await readyCampaign(A, { name: 'Dashboard-sent' });
  Z.sendResponder = () => h.json(200, { status: 'error', code: '6600', message: 'Campaign is sent.' });
  assert.equal((await capi(A, 'POST', `/${c2.id}/send`, { confirm: true })).data.code, 'ALREADY_SENT');
  assert.equal((await row(c2.id)).status, 'submitted');
});

test('the approval must still be backed by an active member with mail.send', async () => {
  Z.account('acctA');
  await connect(A, 'acctA');
  const approver = await h.addMember(A.workspaceId, 'Approver');
  const c = await capi(A, 'POST', '', GOOD);
  await capi(approver, 'POST', `/${c.data.campaign.id}/approve`, {});
  await db().run("UPDATE workspace_members SET status = 'Removed' WHERE workspace_id = ? AND user_id = ?", [A.workspaceId, approver.userId]);
  const r = await capi(A, 'POST', `/${c.data.campaign.id}/send`, { confirm: true });
  assert.equal(r.data.code, 'SCHEDULER_NOT_MEMBER');
  assert.equal(apiCalls('createCampaign').length, 0);
});

test('expired or revoked Zoho access stops sending until reconnected', async () => {
  Z.account('acctA');
  await connect(A, 'acctA');
  const c = await readyCampaign(A);
  zohoSvc()._tokenCache.clear();
  Z.refreshResponder = () => h.json(200, { error: 'invalid_code' });
  const r = await capi(A, 'POST', `/${c.id}/send`, { confirm: true });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Reconnect/);
  assert.equal((await connection(A.workspaceId)).status, 'reauth_required');
  assert.equal(apiCalls('createCampaign').length, 0);
  assert.equal((await row(c.id)).status, 'approved', 'refused before submission');
});

test('only delivery endpoints can be called: no contact uploads, list changes or content updates', async () => {
  const client = require('../modules/mail/zoho/zohoClient');
  for (const ep of ['listsubscribe', 'addlistsubscribersinbulk', 'updatecampaign', 'json/listsubscribe', 'deletecampaign']) {
    await assert.rejects(client.call({ campaigns: 'https://campaigns.zoho.com' }, 't', ep), /not allowed/);
  }
  assert.equal(Z.calls.length, 0);
});

test('disconnect deletes the stored token', async () => {
  Z.account('acctA');
  await connect(A, 'acctA');
  const admin = await h.addMember(A.workspaceId, 'Workspace Admin');
  assert.equal((await zapi(admin, 'POST', '/test', {})).status, 200);
  assert.equal((await zapi(admin, 'POST', '/disconnect', {})).status, 200);
  const r = await connection(A.workspaceId);
  assert.equal(r.refresh_token_ciphertext, null);
  assert.equal((await capi(A, 'GET', '/audiences')).data.code, 'NOT_CONNECTED');
});
