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
const DELIVERY_SCOPES = 'ZohoCampaigns.campaign.CREATE,ZohoCampaigns.campaign.READ,ZohoCampaigns.campaign.UPDATE,ZohoCampaigns.contact.READ';
const ALL_SCOPES = `${DELIVERY_SCOPES},ZohoCampaigns.contact.CREATE`;
// What the app asks for: contact.UPDATE is optional (names for personalization).
const REQUESTED_SCOPES = `${ALL_SCOPES},ZohoCampaigns.contact.UPDATE`;
const NAME_SCOPES = REQUESTED_SCOPES;

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
        if (endpoint === 'getlistsubscribers') {
          const all = (acct.contacts || {})[params.listkey] || [];
          const from = Number(params.fromindex) - 1;
          return h.json(200, { status: 'success', code: 0, list_of_details: all.filter(c => (c.state || 'active') === params.status).slice(from, from + Number(params.range)) });
        }
        if (endpoint === 'addlistandcontacts') {
          if (z.listResponder) return z.listResponder(params, acct);
          if (acct.lists.some(l => l.listname === params.listname)) return h.json(200, { status: 'error', code: '2205', message: 'List name already exists.' });
          const key = `SYNC${++keySeq}`;
          acct.lists.push({ listkey: key, listname: params.listname, noofcontacts: '0' });
          acct.added = { ...acct.added, [key]: params.emailids.split(',') };
          return h.json(200, { status: 'success', code: 0, listkey: key, message: 'List created' });
        }
        if (endpoint === 'addlistsubscribersinbulk') {
          if (z.bulkResponder) { const r = z.bulkResponder(params, acct); if (r) return r; }
          acct.added[params.listkey].push(...params.emailids.split(','));
          return h.json(200, { status: 'success', code: 0, message: 'Added' });
        }
        if (endpoint === 'listsubscribe') {
          assert.ok(u.pathname.endsWith('/api/v1.1/json/listsubscribe'), u.pathname);
          if (z.nameResponder) { const r = z.nameResponder(params, acct); if (r) return r; }
          acct.names = { ...acct.names, [JSON.parse(params.contactinfo)['Contact Email']]: { list: params.listkey, ...JSON.parse(params.contactinfo) } };
          return h.json(200, { status: 'success', code: '0', message: 'A confirmation email is sent to the user. User needs to confirm to successfully subscribe.' });
        }
        if (endpoint === 'listunsubscribe') {
          assert.ok(u.pathname.endsWith('/api/v1.1/json/listunsubscribe'), u.pathname);
          acct.removed = [...(acct.removed || []), { list: params.listkey, email: JSON.parse(params.contactinfo)['Contact Email'] }];
          return h.json(200, { status: 'success', code: '0', message: 'Contact unsubscribed' });
        }
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
  assert.equal(u.searchParams.get('scope'), REQUESTED_SCOPES);
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

test('only delivery and contact-sync endpoints can be called: no list deletions or content updates', async () => {
  const client = require('../modules/mail/zoho/zohoClient');
  // json/listsubscribe is allowed (it adds a contact's name to the campaign's own list); nothing deletes.
  for (const ep of ['listsubscribe', 'updatecampaign', 'json/unsubscribe', 'deletecampaign', 'deletemailinglist', 'updatelistdetails', 'addcontacts']) {
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

test('campaign list: size-capped thumbnails only when asked; never another workspace\'s campaigns', async () => {
  const big = `<p>${'y'.repeat(50000)}</p><p><a href="$[LI:UNSUBSCRIBE]$">u</a></p>`;
  const made = await capi(A, 'POST', '', { ...GOOD, name: 'Thumb test', html: big });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const plain = (await capi(A, 'GET', '')).data.campaigns;
  assert.ok(plain.every(c => c.thumbHtml === undefined && c.html === undefined), 'no HTML unless asked');
  const thumbs = (await capi(A, 'GET', '?thumbs=1')).data.campaigns;
  const t = thumbs.find(c => c.name === 'Thumb test');
  assert.ok(t.thumbHtml.startsWith('<p>yyy'));
  assert.ok(t.thumbHtml.length <= 40000, 'capped');
  assert.ok(!(await capi(B, 'GET', '?thumbs=1')).data.campaigns.some(c => c.name === 'Thumb test'));
});

test('scopes in Zoho\'s real space-separated format count as granted (no endless "reconnect")', async () => {
  const S = await h.createWorkspace({ name: 'Campaigns space scopes' });
  const { location } = await connect(S, 'space-scopes', { scope: ALL_SCOPES.split(',').join(' ') });
  assert.match(location, /zoho=connected/);
  const st = await zapi(S, 'GET', '/status');
  assert.equal(st.data.connection.connected, true);
  assert.deepEqual(st.data.connection.missingScopes, []);
  assert.equal(st.data.connection.scopes.length, 5);
  assert.equal(st.data.connection.canSyncContacts, true);
  await zohoSvc().assertReady(S.workspaceId);
});

test('list contacts: read-only, one page at a time, by status; audited without addresses; never stored', async () => {
  const C = await h.createWorkspace({ name: 'List contacts' });
  Z.account('acctC');
  Z.accounts.acctC.contacts = { L1: [
    { contact_email: 'kim@client.io', firstname: 'Kim', lastname: 'Lee', companyname: 'Acme', phone: '+1 555 0100', added_time: '1793766534000' },
    { contact_email: 'no.name@client.io' },
    { contact_email: 'Lead@Shop.com.au', firstname: 'Shop team' },
    { contact_email: 'gone@client.io', firstname: 'Gone', state: 'unsub' },
  ] };
  await connect(C, 'acctC');
  // A matching lead (by email, any case) fills in business, contact, phone, product and status.
  const lead = await db().run("INSERT INTO leads (workspace_id, name, email, company_name, phone, status, product_interest, created_at) VALUES (?, 'Sam Shop', 'lead@shop.com.au', 'Shop Pty Ltd', '0400 000 000', 'Contacted', 'Boxes', UTC_TIMESTAMP())", [C.workspaceId]);
  const get = (who, qs = '') => h.api('GET', `/api/v1/mail/campaigns/audiences/L1/contacts${qs}`, { token: who.token });
  const r = await get(C);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.contacts, [
    { email: 'kim@client.io', name: 'Kim Lee', company: 'Acme', phone: '+1 555 0100', addedAt: '2026-11-04T04:28:54.000Z', leadId: null, contactName: 'Kim Lee', product: null, leadStatus: null },
    { email: 'no.name@client.io', name: null, company: null, phone: null, addedAt: null, leadId: null, contactName: null, product: null, leadStatus: null },
    { email: 'Lead@Shop.com.au', name: 'Shop team', company: 'Shop Pty Ltd', phone: '0400 000 000', addedAt: null, leadId: lead.lastID, contactName: 'Sam Shop', product: 'Boxes', leadStatus: 'Contacted' }
  ]);
  assert.equal(r.data.hasMore, false);
  assert.deepEqual((await get(C, '?status=unsubscribed')).data.contacts.map(c => c.email), ['gone@client.io']);
  const call = apiCalls('getlistsubscribers').at(-1);
  assert.equal(call.params.status, 'unsub');
  assert.equal(call.method, 'GET');

  const page2 = await get(C, '?page=2');
  assert.equal(apiCalls('getlistsubscribers').at(-1).params.fromindex, '51');
  assert.deepEqual(page2.data.contacts, []);

  assert.equal((await get(C, '?status=everyone')).status, 400);
  assert.equal((await h.api('GET', '/api/v1/mail/campaigns/audiences/bad%20key!/contacts', { token: C.token })).status, 400);
  const member = await h.addMember(C.workspaceId, 'Member');
  assert.equal((await get(member)).status, 403, 'addresses: mail.send roles only');
  assert.equal((await get(await h.addMember(C.workspaceId, 'Approver'))).status, 200);
  assert.equal((await h.api('GET', '/api/v1/mail/campaigns/audiences/L1/contacts')).status, 401);
  const D = await h.createWorkspace({ name: 'Not connected' });
  assert.equal((await get(D)).status, 409, 'another workspace cannot read through this one');

  const logged = await db().all("SELECT metadata_json FROM audit_logs WHERE workspace_id = ? AND action = 'mail.zoho_list_contacts_viewed'", [C.workspaceId]);
  assert.ok(logged.length >= 3);
  assert.ok(logged.every(l => !l.metadata_json.includes('@')), 'no addresses in the audit log');
  const zohoWrites = Z.calls.filter(c => c.kind === 'api' && c.method === 'POST');
  assert.equal(zohoWrites.length, 0, 'nothing written to Zoho');
});

// ------------------------------------------------------------------ selected contacts

let leadSeq = 0;
const SYNC_NAME = /^Marketech campaign \d+ v\d+ [a-f0-9]{6}$/;

async function addLead(ws, { consent = 'granted', evidence = true, email } = {}) {
  const addr = email || `lead${++leadSeq}-${Date.now()}@client-co.io`;
  const r = await db().run(
    `INSERT INTO leads (workspace_id, name, email, company_name, marketing_consent, marketing_consent_method, marketing_consent_obtained_at, marketing_consent_evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [ws.workspaceId, `Lead ${leadSeq}`, addr, 'Client Co', consent, evidence ? 'web_form' : null, evidence ? '2026-01-01 00:00:00' : null, evidence ? 'Signup form' : null]
  );
  return { id: r.lastID, email: addr.toLowerCase() };
}

async function contactCampaign(ws, leads, { extra = { lists: [] } } = {}) {
  const c = (await capi(ws, 'POST', '', { ...GOOD, ...extra })).data.campaign;
  const r = await capi(ws, 'PUT', `/${c.id}/contacts/leads`, { leadIds: leads.map(l => l.id) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = await capi(ws, 'POST', `/${c.id}/approve`, {});
  assert.equal(a.status, 200, JSON.stringify(a.data));
  return a.data.campaign;
}

async function freshConnected(name, opts = {}) {
  const ws = await h.createWorkspace({ name });
  const account = `acct-${name.replace(/\W/g, '')}-${Math.random()}`;
  Z.account(account, opts.account);
  await connect(ws, account, opts.connect);
  return { ws, acct: Z.accounts[account] };
}

const uploaded = acct => Object.values(acct.added || {}).flat();

test('selection: leads without recorded consent are accepted (Zoho handles consent); opted-out leads or another workspace are refused and never stored', async () => {
  const { ws } = await freshConnected('Pick');
  const good = await addLead(ws);
  const noConsent = await addLead(ws, { consent: 'unknown', evidence: false });
  const noEvidence = await addLead(ws, { consent: 'granted', evidence: false });
  const withdrawn = await addLead(ws, { consent: 'withdrawn', evidence: false });
  const suppressed = await addLead(ws);
  await db().run("INSERT INTO email_suppressions (workspace_id, email, reason, source) VALUES (?, ?, 'unsubscribed', 'test')", [ws.workspaceId, suppressed.email]);
  const other = await addLead(B);
  const c = (await capi(ws, 'POST', '', GOOD)).data.campaign;
  const r = await capi(ws, 'PUT', `/${c.id}/contacts/leads`, { leadIds: [good, noConsent, noEvidence, withdrawn, suppressed, other].map(l => l.id) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.added, r.data.refused], [3, 3]);
  assert.deepEqual(r.data.contacts.map(x => x.email).sort(), [good.email, noConsent.email, noEvidence.email].sort());
  assert.equal(r.data.campaign.contactCount, 3);
  assert.equal((await capi(B, 'GET', `/${c.id}/contacts`)).status, 404);
});

test('selection: Select all ids are not limited to the product-email batch size', async () => {
  const { ws } = await freshConnected('Pick all');
  for (let i = 0; i < 3; i++) await addLead(ws);
  await addLead(ws, { consent: 'withdrawn', evidence: false });
  const prev = process.env.MAIL_BATCH_MAX_RECIPIENTS;
  process.env.MAIL_BATCH_MAX_RECIPIENTS = '2';
  try {
    const r = await capi(ws, 'GET', '/lead-options');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.total, 4);
    assert.equal(r.data.eligibleIds.length, 3);
  } finally {
    if (prev === undefined) delete process.env.MAIL_BATCH_MAX_RECIPIENTS; else process.env.MAIL_BATCH_MAX_RECIPIENTS = prev;
  }
});

test('selection: changing the contacts clears the approval, like any other edit', async () => {
  const { ws } = await freshConnected('Pick reset');
  const [a, b] = [await addLead(ws), await addLead(ws)];
  const c = await contactCampaign(ws, [a]);
  assert.equal(c.status, 'approved');
  const r = await capi(ws, 'PUT', `/${c.id}/contacts/leads`, { leadIds: [a.id, b.id] });
  assert.equal(r.data.campaign.status, 'draft');
  assert.equal(r.data.campaign.version, c.version + 1);
  assert.equal((await capi(ws, 'POST', `/${c.id}/send`, { confirm: true })).status, 409);
  const app = await capi(ws, 'POST', `/${c.id}/approve`, {});
  assert.equal(app.status, 200);
  const rem = await capi(ws, 'POST', `/${c.id}/contacts/remove`, { ids: [r.data.contacts[0].id] });
  assert.equal(rem.status, 200);
  assert.equal(rem.data.campaign.status, 'draft');
  assert.equal(rem.data.total, 1);
  assert.equal((await capi(ws, 'POST', `/${c.id}/contacts/remove`, { all: true })).data.total, 0);
});

test('a submitted campaign keeps its contacts: the selection cannot change', async () => {
  const { ws } = await freshConnected('Pick locked');
  const a = await addLead(ws);
  const c = await contactCampaign(ws, [a]);
  assert.equal((await capi(ws, 'POST', `/${c.id}/send`, { confirm: true })).status, 200);
  assert.equal((await capi(ws, 'PUT', `/${c.id}/contacts/leads`, { leadIds: [] })).data.code, 'NOT_EDITABLE');
  assert.equal((await capi(ws, 'POST', `/${c.id}/contacts/remove`, { all: true })).data.code, 'NOT_EDITABLE');
});

test('Send adds selected contacts to a new private Zoho list in batches of 10, then sends to it and the chosen lists', async () => {
  const { ws, acct } = await freshConnected('Sync');
  const leads = [];
  for (let i = 0; i < 23; i++) leads.push(await addLead(ws));
  const c = await contactCampaign(ws, leads, { extra: {} });
  const r = await capi(ws, 'POST', `/${c.id}/send`, { confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.campaign.status, 'submitted');

  const [made] = apiCalls('addlistandcontacts');
  assert.equal(apiCalls('addlistandcontacts').length, 1);
  assert.match(made.params.listname, SYNC_NAME);
  assert.deepEqual([made.params.signupform, made.params.mode, made.method], ['private', 'newlist', 'POST']);
  assert.equal(made.params.emailids.split(',').length, 10);
  assert.deepEqual(apiCalls('addlistsubscribersinbulk').map(x => x.params.emailids.split(',').length), [10, 3]);
  assert.deepEqual([...uploaded(acct)].sort(), leads.map(l => l.email).sort());

  const syncKey = (await row(c.id)).contact_list_key;
  const details = JSON.parse(apiCalls('createCampaign')[0].params.list_details);
  assert.deepEqual(Object.keys(details).sort(), ['L1', syncKey].sort());
  assert.equal(apiCalls('sendcampaign').length, 1);
  const order = Z.calls.filter(x => x.kind === 'api').map(x => x.endpoint);
  assert.ok(order.lastIndexOf('addlistsubscribersinbulk') < order.indexOf('createCampaign'), 'all contacts are in Zoho before the campaign is created');

  const aud = await capi(ws, 'GET', '/audiences');
  assert.deepEqual(aud.data.lists.map(l => l.key), ['L1'], 'generated lists are not offered as recipients');
});

test('a campaign without selected contacts never touches contacts in Zoho', async () => {
  const { ws } = await freshConnected('Lists only');
  const c = await readyCampaign(ws);
  assert.equal((await capi(ws, 'POST', `/${c.id}/send`, { confirm: true })).status, 200);
  assert.equal(apiCalls('addlistandcontacts').length + apiCalls('addlistsubscribersinbulk').length, 0);
});

test('consent is checked again at send: a lead who withdrew after approval is not uploaded', async () => {
  const { ws, acct } = await freshConnected('Sync withdraw');
  const [keep, gone, bounced] = [await addLead(ws), await addLead(ws), await addLead(ws)];
  const c = await contactCampaign(ws, [keep, gone, bounced]);
  await db().run("UPDATE leads SET marketing_consent = 'withdrawn' WHERE id = ?", [gone.id]);
  await db().run("INSERT INTO email_suppressions (workspace_id, email, reason, source) VALUES (?, ?, 'bounced', 'test')", [ws.workspaceId, bounced.email]);
  const v = await capi(ws, 'POST', `/${c.id}/validate`, {});
  assert.ok(v.data.validation.warnings.some(w => /2 selected contact\(s\) cannot be emailed/.test(w)), JSON.stringify(v.data));
  assert.equal((await capi(ws, 'POST', `/${c.id}/send`, { confirm: true })).status, 200);
  assert.deepEqual(uploaded(acct), [keep.email]);
});

test('when nobody selected can be emailed any more and no list is chosen, nothing is sent', async () => {
  const { ws, acct } = await freshConnected('Sync none');
  const only = await addLead(ws);
  const c = await contactCampaign(ws, [only]);
  await db().run("UPDATE leads SET marketing_consent = 'withdrawn' WHERE id = ?", [only.id]);
  const r = await capi(ws, 'POST', `/${c.id}/send`, { confirm: true });
  assert.equal(r.status, 400);
  assert.equal(apiCalls('createCampaign').length, 0);
  assert.equal(uploaded(acct).length, 0);
  assert.equal((await row(c.id)).status, 'approved', 'refused by validation before the claim');
});

test('a sync that stops halfway emails nobody; Send again resumes without repeating the list or contacts', async () => {
  const { ws, acct } = await freshConnected('Sync retry');
  const leads = [];
  for (let i = 0; i < 25; i++) leads.push(await addLead(ws));
  const c = await contactCampaign(ws, leads);
  let calls = 0;
  Z.bulkResponder = () => (++calls === 2 ? h.json(200, { status: 'error', code: '2302', message: 'Maximum contact limit reached' }) : null);
  const first = await capi(ws, 'POST', `/${c.id}/send`, { confirm: true });
  assert.equal(first.status, 400);
  assert.equal(first.data.providerCode, '2302');
  const after = await row(c.id);
  assert.deepEqual([after.status, after.submit_stage], ['failed', 'sync']);
  assert.equal(apiCalls('createCampaign').length + apiCalls('sendcampaign').length, 0, 'nothing is created or sent after a failed sync');

  Z.bulkResponder = null;
  const again = await capi(ws, 'POST', `/${c.id}/send`, { confirm: true });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(apiCalls('addlistandcontacts').length, 1, 'the same list is reused');
  assert.equal(uploaded(acct).length, 25);
  assert.equal(new Set(uploaded(acct)).size, 25, 'no contact is added twice');
  assert.equal(apiCalls('sendcampaign').length, 1);
});

test('a contact who opted out after being added to Zoho stops the retry until they are removed', async () => {
  const { ws } = await freshConnected('Sync stale');
  const leads = [];
  for (let i = 0; i < 12; i++) leads.push(await addLead(ws));
  const c = await contactCampaign(ws, leads);
  Z.bulkResponder = () => h.json(200, { status: 'error', code: '2302', message: 'limit' });
  await capi(ws, 'POST', `/${c.id}/send`, { confirm: true });
  const synced = await db().get('SELECT l.id, l.email FROM mail_campaign_contacts c JOIN leads l ON l.id = c.lead_id WHERE c.campaign_id = ? AND c.synced_version IS NOT NULL LIMIT 1', [c.id]);
  await db().run("UPDATE leads SET marketing_consent = 'withdrawn' WHERE id = ?", [synced.id]);
  Z.bulkResponder = null;
  const r = await capi(ws, 'POST', `/${c.id}/send`, { confirm: true });
  assert.equal(r.data.code, 'CONTACTS_CHANGED');
  assert.equal(apiCalls('createCampaign').length, 0);
  const sel = (await capi(ws, 'GET', `/${c.id}/contacts`)).data.contacts.find(x => x.leadId === synced.id);
  await capi(ws, 'POST', `/${c.id}/contacts/remove`, { ids: [sel.id] });
  assert.equal((await capi(ws, 'POST', `/${c.id}/approve`, {})).status, 200);
  assert.equal((await capi(ws, 'POST', `/${c.id}/send`, { confirm: true })).status, 200);
  assert.equal(apiCalls('addlistandcontacts').length, 2, 'the new version gets its own list, without that contact');
  assert.ok(!apiCalls('addlistandcontacts')[1].params.emailids.includes(synced.email));
});

test('an unclear list creation is settled by name: the list made by that try is found, a stranger\'s never is', async () => {
  const { ws, acct } = await freshConnected('Sync unclear');
  const lead = await addLead(ws);
  const c = await contactCampaign(ws, [lead]);
  let made = null;
  Z.listResponder = (params, a) => {
    made = params.listname;
    a.lists.push({ listkey: 'SYNCMADE', listname: params.listname, noofcontacts: '1' });
    a.added = { SYNCMADE: [] };
    return h.json(503, {});
  };
  assert.equal((await capi(ws, 'POST', `/${c.id}/send`, { confirm: true })).status, 502);
  assert.equal((await row(c.id)).status, 'failed', 'nothing was emailed, so it is a plain failure');
  Z.listResponder = null;
  assert.equal((await capi(ws, 'POST', `/${c.id}/send`, { confirm: true })).status, 200);
  assert.equal(apiCalls('addlistandcontacts').at(-1).params.listname, made);
  assert.deepEqual(acct.added.SYNCMADE, [lead.email]);
  assert.equal((await row(c.id)).contact_list_key, 'SYNCMADE');

  const d = await contactCampaign(ws, [lead]);
  Z.listResponder = () => h.json(200, { status: 'error', code: '2205', message: 'List name already exists.' });
  const r = await capi(ws, 'POST', `/${d.id}/send`, { confirm: true });
  assert.equal(r.data.providerCode, '2205');
  assert.equal((await row(d.id)).status, 'failed');
  assert.equal(apiCalls('createCampaign').length, 1, 'only the first campaign reached Zoho');
});

test('unsubscribes from an earlier generated list carry over: the next campaign does not add them back', async () => {
  const { ws, acct } = await freshConnected('Sync optout');
  const [stay, leave, bounce] = [await addLead(ws), await addLead(ws), await addLead(ws)];
  const first = await contactCampaign(ws, [stay, leave, bounce]);
  assert.equal((await capi(ws, 'POST', `/${first.id}/send`, { confirm: true })).status, 200);
  const key = (await row(first.id)).contact_list_key;
  acct.contacts = { [key]: [{ contact_email: leave.email.toUpperCase(), state: 'unsub' }, { contact_email: bounce.email, state: 'bounce' }] };

  const next = await contactCampaign(ws, [stay, leave, bounce]);
  assert.equal((await capi(ws, 'POST', `/${next.id}/send`, { confirm: true })).status, 200);
  const nextKey = (await row(next.id)).contact_list_key;
  assert.deepEqual(acct.added[nextKey], [stay.email]);
  const sup = await db().all('SELECT email, reason, source FROM email_suppressions WHERE workspace_id = ? ORDER BY reason', [ws.workspaceId]);
  assert.deepEqual(sup.map(s => [s.email, s.reason, s.source]), [[bounce.email, 'bounced', 'zoho_campaigns'], [leave.email, 'unsubscribed', 'zoho_campaigns']]);
});

test('if opt-outs cannot be read from Zoho, no contact is uploaded', async () => {
  const { ws, acct } = await freshConnected('Sync optout down');
  const a = await addLead(ws);
  const first = await contactCampaign(ws, [a]);
  await capi(ws, 'POST', `/${first.id}/send`, { confirm: true });
  const next = await contactCampaign(ws, [await addLead(ws)]);
  const before = uploaded(acct).length;
  const routes = Z.routes[1].respond;
  Z.routes[1].respond = (url, init) => (url.includes('getlistsubscribers') ? h.json(500, {}) : routes(url, init));
  const r = await capi(ws, 'POST', `/${next.id}/send`, { confirm: true });
  assert.equal(r.status, 502);
  assert.equal((await row(next.id)).status, 'failed');
  assert.equal(uploaded(acct).length, before);
  assert.equal(apiCalls('createCampaign').length, 1, 'only the first campaign');
});

test('contacts picked from a Zoho list: only addresses Zoho shows as subscribed there are accepted', async () => {
  const { ws, acct } = await freshConnected('Pick zoho');
  acct.contacts = { L1: [
    { contact_email: 'Real@client-co.io', firstname: 'Real', lastname: 'One', companyname: 'Client' },
    { contact_email: 'gone@client-co.io', state: 'unsub' },
    { contact_email: 'blocked@client-co.io' }
  ] };
  await db().run("INSERT INTO email_suppressions (workspace_id, email, reason, source) VALUES (?, 'blocked@client-co.io', 'complaint', 'test')", [ws.workspaceId]);
  const c = (await capi(ws, 'POST', '', { ...GOOD, lists: [] })).data.campaign;
  const r = await capi(ws, 'POST', `/${c.id}/contacts/zoho`, { listKey: 'L1', pages: [{ page: 1, emails: ['real@client-co.io', 'gone@client-co.io', 'blocked@client-co.io', 'forged@other-co.io'] }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.added, r.data.refused], [1, 3]);
  assert.deepEqual(r.data.contacts.map(x => [x.email, x.name, x.source]), [['real@client-co.io', 'Real One', 'zoho_list']]);
  assert.equal(r.data.contacts[0].sourceListKey, 'L1');

  const none = await capi(ws, 'POST', `/${c.id}/contacts/zoho`, { listKey: 'L1', pages: [{ page: 1, emails: ['forged@other-co.io'] }] });
  assert.equal(none.data.added, 0);
  assert.equal(none.data.campaign.version, r.data.campaign.version, 'nothing added, nothing to approve again');

  assert.equal((await capi(ws, 'POST', `/${c.id}/approve`, {})).status, 200);
  acct.contacts.L1[0].state = 'unsub';
  const s = await capi(ws, 'POST', `/${c.id}/send`, { confirm: true });
  assert.equal(s.status, 400, 'unsubscribed from the source list after being picked');
  assert.equal(uploaded(acct).length, 0);
});

test('ticking a whole list covers the contacts picked from it: they are not uploaded again', async () => {
  const { ws, acct } = await freshConnected('Pick covered');
  acct.contacts = { L1: [{ contact_email: 'kim@client-co.io' }] };
  const c = (await capi(ws, 'POST', '', { ...GOOD, lists: [] })).data.campaign;
  await capi(ws, 'POST', `/${c.id}/contacts/zoho`, { listKey: 'L1', pages: [{ page: 1, emails: ['kim@client-co.io'] }] });
  await capi(ws, 'PATCH', `/${c.id}`, { lists: [{ key: 'L1', name: 'Opted-in customers' }] });
  assert.equal((await capi(ws, 'POST', `/${c.id}/approve`, {})).status, 200);
  assert.equal((await capi(ws, 'POST', `/${c.id}/send`, { confirm: true })).status, 200);
  assert.equal(apiCalls('addlistandcontacts').length, 0);
  assert.deepEqual(Object.keys(JSON.parse(apiCalls('createCampaign')[0].params.list_details)), ['L1']);
});

test('picking from Zoho needs the same role as reading its addresses', async () => {
  const { ws } = await freshConnected('Pick roles');
  const c = (await capi(ws, 'POST', '', GOOD)).data.campaign;
  const member = await h.addMember(ws.workspaceId, 'Member');
  const r = await capi(member, 'POST', `/${c.id}/contacts/zoho`, { listKey: 'L1', pages: [{ page: 1, emails: ['a@client-co.io'] }] });
  assert.equal(r.status, 403);
});

test('a connection without contact.CREATE still sends to lists, and is told to reconnect for selected contacts', async () => {
  const { ws, acct } = await freshConnected('Old scope', { connect: { scope: DELIVERY_SCOPES } });
  const st = await zapi(ws, 'GET', '/status');
  assert.deepEqual(st.data.connection.missingScopes, []);
  assert.equal(st.data.connection.canSyncContacts, false);
  const plain = await readyCampaign(ws);
  assert.equal((await capi(ws, 'POST', `/${plain.id}/send`, { confirm: true })).status, 200);

  const c = (await capi(ws, 'POST', '', GOOD)).data.campaign;
  await capi(ws, 'PUT', `/${c.id}/contacts/leads`, { leadIds: [(await addLead(ws)).id] });
  const a = await capi(ws, 'POST', `/${c.id}/approve`, {});
  assert.equal(a.status, 400);
  assert.match(a.data.error, /Reconnect Zoho Campaigns to allow adding selected contacts/);
  assert.equal(uploaded(acct).length, 0);
});

test('a campaign with no lists and no contacts cannot be approved', async () => {
  const { ws } = await freshConnected('No recipients');
  const c = (await capi(ws, 'POST', '', { ...GOOD, lists: [] })).data.campaign;
  const a = await capi(ws, 'POST', `/${c.id}/approve`, {});
  assert.equal(a.status, 400);
  assert.match(a.data.error, /Choose at least one Zoho mailing list or contact/);
});

test('duplicate: a sent campaign becomes a new draft with its content and recipients, and none of its history', async () => {
  const { ws } = await freshConnected('Dup sent');
  const leads = [await addLead(ws), await addLead(ws)];
  const c = await contactCampaign(ws, leads, { extra: {} });
  assert.equal((await capi(ws, 'POST', `/${c.id}/send`, { confirm: true })).status, 200);
  await capi(ws, 'POST', `/${c.id}/refresh`, {});
  const before = await row(c.id);

  const r = await capi(ws, 'POST', `/${c.id}/duplicate`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const d = r.data.campaign;
  assert.notEqual(d.id, c.id);
  assert.equal(d.name, `${GOOD.name} (copy)`);
  assert.deepEqual([d.subject, d.fromName, d.fromEmail], [GOOD.subject, GOOD.fromName, GOOD.fromEmail]);
  assert.equal(d.html, before.html_content);
  assert.deepEqual(d.lists, [{ key: 'L1', name: 'Opted-in customers' }]);
  assert.equal(d.contactCount, 2);
  assert.deepEqual([d.status, d.version, d.approved, d.zohoPrepared, d.report, d.submittedAt], ['draft', 1, false, false, null, null]);
  const copy = await row(d.id);
  assert.deepEqual([copy.zoho_campaign_key, copy.contact_list_key, copy.contact_list_name, copy.content_token_hash, copy.approved_by], [null, null, null, null, null]);
  assert.equal((await db().get('SELECT COUNT(*) AS n FROM mail_campaign_contacts WHERE campaign_id = ? AND synced_version IS NOT NULL', [d.id])).n, 0);

  assert.equal((await capi(ws, 'POST', `/${d.id}/send`, { confirm: true })).status, 409, 'the copy needs its own approval');
  assert.equal((await capi(ws, 'POST', `/${d.id}/approve`, {})).status, 200);
  assert.equal((await capi(ws, 'POST', `/${d.id}/send`, { confirm: true })).status, 200);
  assert.equal(apiCalls('addlistandcontacts').length, 2, 'the copy gets its own Zoho list');
  assert.equal(apiCalls('sendcampaign').length, 2);
  const orig = await row(c.id);
  assert.deepEqual([orig.status, orig.zoho_campaign_key, orig.version], [before.status, before.zoho_campaign_key, before.version], 'the original is untouched');
});

test('duplicate: contacts who can no longer be emailed are left out of the copy, and the count says so', async () => {
  const { ws } = await freshConnected('Dup consent');
  const [keep, gone] = [await addLead(ws), await addLead(ws)];
  const c = await contactCampaign(ws, [keep, gone]);
  await db().run("UPDATE leads SET marketing_consent = 'withdrawn' WHERE id = ?", [gone.id]);
  const r = await capi(ws, 'POST', `/${c.id}/duplicate`, {});
  assert.equal(r.data.contactsDropped, 1);
  assert.equal(r.data.campaign.contactCount, 1);
  assert.deepEqual((await capi(ws, 'GET', `/${r.data.campaign.id}/contacts`)).data.contacts.map(x => x.email), [keep.email]);
  assert.equal((await capi(ws, 'GET', `/${c.id}/contacts`)).data.total, 2, 'the original keeps its record');
});

test('duplicate: a long name stays within the limit; other workspaces and read-only roles are refused', async () => {
  const { ws } = await freshConnected('Dup rules');
  const c = (await capi(ws, 'POST', '', { ...GOOD, name: 'n'.repeat(150) })).data.campaign;
  const r = await capi(ws, 'POST', `/${c.id}/duplicate`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.campaign.name.length, 150);
  assert.ok(r.data.campaign.name.endsWith(' (copy)'));
  assert.equal((await capi(B, 'POST', `/${c.id}/duplicate`, {})).status, 404);
  const approver = await h.addMember(ws.workspaceId, 'Approver');
  assert.equal((await capi(approver, 'POST', `/${c.id}/duplicate`, {})).status, 403);
});

// ------------------------------------------------------------------ personalization

async function namedLead(ws, name, company = 'Client Co') {
  const l = await addLead(ws);
  await db().run('UPDATE leads SET name = ?, company_name = ? WHERE id = ?', [name, company, l.id]);
  return l;
}

test('personalization: {{first_name}} / {{last_name}} become Zoho merge tags in the subject and the imported content', async () => {
  const { ws } = await freshConnected('Personal tags', { connect: { scope: NAME_SCOPES } });
  const c = await readyCampaign(ws, { subject: 'News for you, {{first_name}}', html: '<p>Hi {{ first_name }} {{last_name}},</p><p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>' });
  const v = await capi(ws, 'POST', `/${c.id}/validate`, {});
  assert.equal(v.data.validation.ready, true, JSON.stringify(v.data.validation));
  assert.ok(v.data.validation.warnings.some(w => /Personalized with merge tags/.test(w)));
  assert.equal((await capi(ws, 'POST', `/${c.id}/send`, { confirm: true })).status, 200);
  const created = apiCalls('createCampaign')[0].params;
  assert.equal(created.subject, 'News for you, $[FNAME|there]$');
  const token = created.content_url.split('/content/')[1];
  const html = await require('../modules/mail/campaigns/campaignService').contentByToken(token);
  assert.equal(html, '<p>Hi $[FNAME|there]$ $[LNAME||]$,</p><p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>');
  assert.match((await row(c.id)).html_content, /\{\{ first_name \}\}/, 'the stored campaign keeps the readable tokens');
});

test('personalization: Zoho merge tags from the Merge Tags menu (custom default value, links, organization) pass through unchanged', async () => {
  const { ws } = await freshConnected('Personal zoho tags', { connect: { scope: NAME_SCOPES } });
  const html = '<p><a href="$[LI:VIEWINBROWSER]$">View in browser</a></p><p>Dear $[FNAME|Customer]$ $[LNAME||]$,</p><p>$[HF:ORGADDRESS]$ · $[ML:LISTNAME]$</p><p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>';
  const c = await readyCampaign(ws, { subject: 'Hey $[FNAME|Jin]$, your weekly update', html });
  const v = await capi(ws, 'POST', `/${c.id}/validate`, {});
  assert.equal(v.data.validation.ready, true, JSON.stringify(v.data.validation));
  assert.ok(v.data.validation.warnings.some(w => /Personalized with merge tags/.test(w)));
  assert.equal((await capi(ws, 'POST', `/${c.id}/send`, { confirm: true })).status, 200);
  const created = apiCalls('createCampaign')[0].params;
  assert.equal(created.subject, 'Hey $[FNAME|Jin]$, your weekly update');
  const token = created.content_url.split('/content/')[1];
  assert.equal(await require('../modules/mail/campaigns/campaignService').contentByToken(token), html);
});

test('sample email: [bracketed] parts and the example.com link block approval until replaced', async () => {
  const { ws } = await freshConnected('Sample email');
  const html = '<p>Hi $[FNAME|there]$,</p><p>[Your offer in one sentence]</p><p><a href="https://example.com">Book a call</a></p><p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a></p>';
  const c = (await capi(ws, 'POST', '', { ...GOOD, html })).data.campaign;
  const v = (await capi(ws, 'POST', `/${c.id}/validate`, {})).data.validation;
  assert.ok(v.problems.some(p => p.includes('[Your offer in one sentence]')), JSON.stringify(v.problems));
  assert.ok(v.problems.some(p => p.includes('example.com')), JSON.stringify(v.problems));
  assert.notEqual((await capi(ws, 'POST', `/${c.id}/approve`, {})).status, 200);
});

test('personalization: other tokens such as {{company}} still block approval with a clear message', async () => {
  const { ws } = await freshConnected('Personal company');
  const c = (await capi(ws, 'POST', '', { ...GOOD, html: '<p>Hi {{first_name}} at {{company}}</p><p><a href="$[LI:UNSUBSCRIBE]$">x</a></p>' })).data.campaign;
  const a = await capi(ws, 'POST', `/${c.id}/approve`, {});
  assert.notEqual(a.status, 200);
  const v = (await capi(ws, 'POST', `/${c.id}/validate`, {})).data.validation;
  assert.ok(v.problems.some(p => p.includes('{{company}}') && p.includes('{{first_name}} and {{last_name}}')), JSON.stringify(v.problems));
  assert.ok(!v.problems.some(p => p.includes('{{first_name}},')), 'first_name is supported');
});

test('names of selected leads are sent to Zoho on the campaign list; leads without a contact person get the business name', async () => {
  const { ws, acct } = await freshConnected('Names sync', { connect: { scope: NAME_SCOPES } });
  const person = await namedLead(ws, 'Priya  Nair Menon');
  const single = await namedLead(ws, 'Arun');
  const business = await namedLead(ws, 'Global Quality Foods', 'Global Quality Foods');
  const c = await contactCampaign(ws, [person, single, business], { extra: { lists: [], html: '<p>Hi {{first_name}}</p><p><a href="$[LI:UNSUBSCRIBE]$">x</a></p>' } });
  const r = await capi(ws, 'POST', `/${c.id}/send`, { confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const listKey = (await row(c.id)).contact_list_key;
  assert.deepEqual(acct.names[person.email], { list: listKey, 'Contact Email': person.email, 'First Name': 'Priya', 'Last Name': 'Nair Menon' });
  assert.deepEqual(acct.names[single.email], { list: listKey, 'Contact Email': single.email, 'First Name': 'Arun' });
  assert.deepEqual(acct.names[business.email], { list: listKey, 'Contact Email': business.email, 'First Name': 'Global Quality Foods team' }, 'a lead without a contact person is greeted as the business');
  const order = Z.calls.filter(x => x.kind === 'api').map(x => x.endpoint);
  assert.ok(order.lastIndexOf('listsubscribe') < order.indexOf('createCampaign'), 'names are in Zoho before the campaign is created');
});

test('a failed name update never stops the send; without contact.UPDATE no names are sent and validation says to reconnect', async () => {
  const { ws, acct } = await freshConnected('Names fail', { connect: { scope: NAME_SCOPES } });
  const lead = await namedLead(ws, 'Kim Lee');
  Z.nameResponder = () => h.json(200, { status: 'error', code: '2006', message: 'Contact belongs to Do-not-mail registry' });
  const c = await contactCampaign(ws, [lead], { extra: { lists: [], html: '<p>Hi {{first_name}}</p><p><a href="$[LI:UNSUBSCRIBE]$">x</a></p>' } });
  const r = await capi(ws, 'POST', `/${c.id}/send`, { confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.campaign.status, 'submitted');
  assert.equal(acct.names, undefined);

  Z.nameResponder = null;
  const before = apiCalls('listsubscribe').length;
  assert.equal(before, 1, 'the failed name call was made once');
  const old = await freshConnected('Names old scope');
  const l2 = await namedLead(old.ws, 'Sam Roy');
  const c2 = (await capi(old.ws, 'POST', '', { ...GOOD, lists: [], html: '<p>Hi {{first_name}}</p><p><a href="$[LI:UNSUBSCRIBE]$">x</a></p>' })).data.campaign;
  await capi(old.ws, 'PUT', `/${c2.id}/contacts/leads`, { leadIds: [l2.id] });
  const v = (await capi(old.ws, 'POST', `/${c2.id}/validate`, {})).data.validation;
  assert.ok(v.warnings.some(w => /Reconnect Zoho Campaigns .* names/.test(w)), JSON.stringify(v.warnings));
  await capi(old.ws, 'POST', `/${c2.id}/approve`, {});
  assert.equal((await capi(old.ws, 'POST', `/${c2.id}/send`, { confirm: true })).status, 200);
  assert.equal(apiCalls('listsubscribe').length, before, 'no name calls without the scope');
});

test('personName: person names split into first and last; business names and emails are ignored', () => {
  const { personName } = require('../modules/mail/campaigns/campaignContacts');
  assert.deepEqual(personName({ name: ' Mary  Ann Smith ', company: 'Acme' }), { first: 'Mary', last: 'Ann Smith' });
  assert.equal(personName({ name: 'Acme Ltd', company: 'acme ltd' }), null);
  assert.equal(personName({ name: 'kim@x.io', email: 'kim@x.io' }), null);
  assert.equal(personName({ name: '' }), null);
  assert.equal(personName({ name: 'Nimbin Bakery', company: 'North Coast Wholesale' }), null, 'a business in the name field is not a person');
});

test('greetingName: leads without a contact person are greeted as the business, with Google extras and legal endings removed', () => {
  const { businessName, greetingName } = require('../modules/mail/campaigns/campaignContacts');
  assert.equal(businessName('Pacific Packaging Australia | Melbourne'), 'Pacific Packaging Australia');
  assert.equal(businessName('MPS Packaging Australia (Previously: Melbourne Packaging Supplies Pty Ltd)'), 'MPS Packaging Australia');
  assert.equal(businessName('A & J Australia Pty Ltd - Packaging Supplies Sydney'), 'A & J Australia');
  assert.equal(businessName('Khushboo Foods Pty Ltd'), 'Khushboo Foods');
  assert.equal(businessName('JR Packaging Australia Pty Ltd.'), 'JR Packaging Australia');
  assert.equal(businessName('The Better Food Distribution Co.'), 'The Better Food Distribution');
  assert.equal(businessName('THE Distributors Brisbane'), 'The Distributors Brisbane');
  assert.equal(businessName('A&W Packaging'), 'A&W Packaging');
  assert.equal(businessName('x'.repeat(41)), null, 'too long for a greeting');
  assert.equal(businessName('info@shop.com'), null);
  assert.equal(businessName(''), null);
  assert.deepEqual(greetingName({ name: 'Mary Smith', company: 'Acme' }), { first: 'Mary', last: 'Smith' });
  assert.deepEqual(greetingName({ name: 'Big Red Packaging', company: 'Big Red Packaging' }), { first: 'Big Red Packaging team', last: '', business: true });
  assert.deepEqual(greetingName({ name: 'Nimbin Bakery', company: 'North Coast Wholesale & Distribution' }).first, 'North Coast Wholesale & Distribution team');
  assert.equal(greetingName({ name: 'Ops Team', company: 'Ops Team' }).first, 'Ops Team', '"team" is not added twice');
  assert.equal(greetingName({ name: '', company: '', email: 'a@b.co' }), null, 'nothing to use: Zoho shows the default value');
  // Lead discovery: Google gave no business name, so the lead is a numbered stand-in.
  assert.equal(greetingName({ name: 'Prospect 3: Packaging supplier (Sydney)', company: null }), null, 'a stand-in name is never used: the default ("there") is');
  // Lead discovery: the business website named a person.
  assert.deepEqual(greetingName({ name: 'Peter Kemsley', company: 'UCC Australia' }), { first: 'Peter', last: 'Kemsley' });
  assert.equal(greetingName({ name: 'Sales Team', company: 'Acme Pty Ltd' }).first, 'Acme team', 'a role is not a person');
});

// ------------------------------------------------------------------ Zoho Campaigns → Contact lists

test('contact lists: view lists, create one with leads and typed addresses (names sent, blocked addresses skipped)', async () => {
  const { ws, acct } = await freshConnected('Lists create', { connect: { scope: NAME_SCOPES } });
  const r0 = await capi(ws, 'GET', '/zoho-lists');
  assert.equal(r0.status, 200, JSON.stringify(r0.data));
  assert.equal(r0.data.canAdd, true);
  assert.equal(r0.data.canRemove, true);
  const person = await namedLead(ws, 'Priya Nair');
  const withdrawn = await addLead(ws, { consent: 'withdrawn', evidence: false });
  const suppressed = 'gone@client-co.io';
  await db().run("INSERT INTO email_suppressions (workspace_id, email, reason, source) VALUES (?, ?, 'unsubscribed', 'test')", [ws.workspaceId, suppressed]);
  const typed = Array.from({ length: 12 }, (_, i) => `buyer${i}@shop-${i}.com.au`);
  const r = await capi(ws, 'POST', '/zoho-lists', { name: 'Sydney buyers', leadIds: [person.id, withdrawn.id], emails: [...typed, suppressed, 'not-an-email', ' Buyer0@Shop-0.com.au '] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.added, 13);
  assert.deepEqual(r.data.skipped.map(x => x.email).sort(), [withdrawn.email, suppressed, 'not-an-email'].sort());
  const made = apiCalls('addlistandcontacts').at(-1).params;
  assert.equal(made.listname, 'Sydney buyers');
  assert.equal(made.emailids.split(',').length, 10, 'Zoho creates the list with the first 10');
  assert.equal(made.signupform, 'private');
  assert.equal(uploaded(acct).length, 13);
  assert.equal(acct.names[person.email]['First Name'], 'Priya');
  const lists = (await capi(ws, 'GET', '/zoho-lists')).data.lists;
  assert.ok(lists.some(l => l.key === r.data.list.key && l.name === 'Sydney buyers' && l.campaignList === false));
  // Same name again: refused, nothing created.
  const before = apiCalls('addlistandcontacts').length;
  const dup = await capi(ws, 'POST', '/zoho-lists', { name: 'sydney BUYERS', emails: ['x@y.com.au'] });
  assert.equal(dup.status, 409);
  assert.equal(apiCalls('addlistandcontacts').length, before);
  // No contacts: refused.
  assert.equal((await capi(ws, 'POST', '/zoho-lists', { name: 'Empty', emails: [] })).status, 400);
});

test('contact lists: add contacts to a list and remove one (unsubscribed from that list only)', async () => {
  const { ws, acct } = await freshConnected('Lists add', { connect: { scope: NAME_SCOPES } });
  const list = (await capi(ws, 'POST', '/zoho-lists', { name: 'Melbourne', emails: ['a@m.com.au'] })).data.list;
  const lead = await namedLead(ws, 'Big Red Packaging', 'Big Red Packaging');
  const r = await capi(ws, 'POST', `/zoho-lists/${list.key}/contacts`, { leadIds: [lead.id], emails: ['b@m.com.au', 'a@m.com.au'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.added, 3);
  assert.deepEqual(acct.added[list.key].sort(), ['a@m.com.au', 'a@m.com.au', 'b@m.com.au', lead.email].sort());
  assert.equal(acct.names[lead.email]['First Name'], 'Big Red Packaging team');
  const rm = await capi(ws, 'POST', `/zoho-lists/${list.key}/remove`, { email: 'B@m.com.au' });
  assert.equal(rm.status, 200, JSON.stringify(rm.data));
  assert.deepEqual(acct.removed, [{ list: list.key, email: 'b@m.com.au' }]);
  assert.equal((await capi(ws, 'POST', '/zoho-lists/NOPE/contacts', { emails: ['c@m.com.au'] })).status, 404, 'an unknown list is refused');
  assert.equal((await capi(B, 'POST', `/zoho-lists/${list.key}/remove`, { email: 'a@m.com.au' })).status >= 400, true, 'another workspace cannot touch it');
});

test('contact lists: without the contact permissions, adding and removing ask to reconnect; read-only roles are refused', async () => {
  const { ws } = await freshConnected('Lists scopes', { connect: { scope: DELIVERY_SCOPES } });
  const r = await capi(ws, 'GET', '/zoho-lists');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.canAdd, false);
  assert.equal(r.data.canRemove, false);
  assert.equal((await capi(ws, 'POST', '/zoho-lists', { name: 'X', emails: ['a@b.com.au'] })).data.code || 'x', 'ZOHO_SCOPES_MISSING');
  const viewer = await h.addMember(ws.workspaceId, 'Member');
  assert.equal((await capi(viewer, 'POST', '/zoho-lists', { name: 'X', emails: ['a@b.com.au'] })).status, 403);
});

// ------------------------------------------------------------------ Leads Excel import → Zoho list

const importLeads = (ws, body) => h.api('POST', '/api/v1/leads/import-bulk', { token: ws.token, body });
const CONSENT = { method: 'imported_with_proof', obtainedAt: '2026-10-01', evidence: 'Trade show sign-up sheet, Oct 2026', attest: true };

test('import: rows become leads; with consent they get it recorded and go into a new Zoho list with their names', async () => {
  const { ws, acct } = await freshConnected('Import list', { connect: { scope: NAME_SCOPES } });
  const withdrawn = await addLead(ws, { consent: 'withdrawn', evidence: false });
  const rows = [
    { name: 'Priya Nair', email: 'priya@acme.com.au', companyName: 'Acme' },
    { name: 'Big Red Packaging', email: 'orders@bigred.com.au', companyName: 'Big Red Packaging' },
    { name: 'Old Contact', email: withdrawn.email },
    { name: 'No Email' }
  ];
  const r = await importLeads(ws, { leads: rows, consent: CONSENT, zohoList: { name: 'Trade show Oct' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.imported, 3);
  assert.equal(r.data.duplicates.length, 1);
  assert.equal(r.data.duplicates[0].leadId, withdrawn.id, 'a duplicate row reports the lead it matched');
  assert.equal(r.data.consentRecorded, 3, 'consent recorded on the new leads only, never over withdrawn consent');
  const old = await db().get('SELECT marketing_consent FROM leads WHERE id = ?', [withdrawn.id]);
  assert.equal(old.marketing_consent, 'withdrawn');
  assert.equal(r.data.zoho.error, null, JSON.stringify(r.data.zoho));
  assert.equal(r.data.zoho.list.name, 'Trade show Oct');
  assert.equal(r.data.zoho.added, 2);
  assert.equal(r.data.zoho.skipped, 2, 'the withdrawn lead and the lead without email are not added');
  assert.deepEqual(acct.added[r.data.zoho.list.key].sort(), ['orders@bigred.com.au', 'priya@acme.com.au']);
  assert.equal(acct.names['priya@acme.com.au']['First Name'], 'Priya');
  assert.equal(acct.names['orders@bigred.com.au']['First Name'], 'Big Red Packaging team');
  const ev = await db().get("SELECT COUNT(*) AS n FROM lead_consent_events WHERE workspace_id = ? AND status = 'granted' AND method = 'imported_with_proof'", [ws.workspaceId]);
  assert.equal(Number(ev.n), 3, 'every consent change is kept with its evidence');
});

test('import: without consent the leads are imported and still go to the Zoho list (Zoho handles consent)', async () => {
  const { ws, acct } = await freshConnected('Import noconsent', { connect: { scope: NAME_SCOPES } });
  const list = (await capi(ws, 'POST', '/zoho-lists', { name: 'Existing', emails: ['a@m.com.au'] })).data.list;
  const r = await importLeads(ws, { leads: [{ name: 'Kim Lee', email: 'kim@shop.com.au' }], zohoList: { key: list.key } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.imported, 1);
  assert.equal(r.data.zoho.error, null, JSON.stringify(r.data.zoho));
  assert.equal(r.data.zoho.added, 1);
  assert.deepEqual(acct.added[list.key].sort(), ['a@m.com.au', 'kim@shop.com.au']);
});

test('import: bad consent details refuse the whole import; a Zoho list needs the send permission', async () => {
  const { ws } = await freshConnected('Import rules', { connect: { scope: NAME_SCOPES } });
  const before = Number((await db().get('SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ?', [ws.workspaceId])).n);
  const bad = await importLeads(ws, { leads: [{ name: 'A', email: 'a@b.com.au' }], consent: { ...CONSENT, attest: false } });
  assert.equal(bad.status, 400);
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ?', [ws.workspaceId])).n), before, 'nothing imported');
  const member = await h.addMember(ws.workspaceId, 'Member');
  const r = await importLeads(member, { leads: [{ name: 'A', email: 'a@b.com.au' }], zohoList: { name: 'X' } });
  assert.equal(r.status, 403);
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM leads WHERE workspace_id = ?', [ws.workspaceId])).n), before, 'refused before importing');
});
