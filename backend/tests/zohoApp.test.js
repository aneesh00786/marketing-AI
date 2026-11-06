const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Zoho Campaigns API client entered in Mail Center → Settings (migration 026), instead of .env.
// Zoho's token endpoint is faked behind the fetch mock; nothing reaches Zoho.
delete process.env.ZOHO_CAMPAIGNS_CLIENT_ID;
delete process.env.ZOHO_CAMPAIGNS_CLIENT_SECRET;
process.env.APP_BASE_URL = 'https://app.marketech.test';
const db = () => h.db();
const ALL_SCOPES = 'ZohoCampaigns.campaign.CREATE,ZohoCampaigns.campaign.READ,ZohoCampaigns.campaign.UPDATE,ZohoCampaigns.contact.READ';
const CLIENT_ID = '1000.WORKSPACEAPPCLIENTID01';
const SECRET = 'ws-secret-0123456789abcdef';
let A; let B;

const zapi = (ws, method, p, body) => h.api(method, `/api/v1/mail/zoho${p}`, { token: ws.token, body });
const appRow = wsId => db().get("SELECT * FROM mail_provider_apps WHERE workspace_id = ? AND provider = 'zoho_campaigns'", [wsId]);
const connRow = wsId => db().get("SELECT * FROM mail_provider_connections WHERE workspace_id = ? AND provider = 'zoho_campaigns'", [wsId]);

/** Connects through the real /connect + /callback with a faked Zoho token endpoint; returns the token request forms. */
async function connect(ws) {
  const forms = [];
  const mock = h.mockFetch([{
    match: u => /^https:\/\/accounts\.zoho\.com\/oauth\/v2\/token$/.test(u),
    respond: (url, init) => { const f = Object.fromEntries(new URLSearchParams(init.body)); forms.push(f); return h.json(200, { access_token: 'at-1', refresh_token: `rt-${ws.workspaceId}`, expires_in: 3600, scope: ALL_SCOPES }); }
  }]);
  try {
    const start = await zapi(ws, 'POST', '/connect', {});
    assert.equal(start.status, 200, JSON.stringify(start.data));
    const url = new URL(start.data.authorizeUrl);
    const cb = await h.api('GET', `/api/v1/mail/zoho/callback?${new URLSearchParams({ state: url.searchParams.get('state'), code: 'code-1', location: 'us' })}`);
    return { url, cb, forms };
  } finally { mock.restore(); }
}

test.before(async () => {
  await h.prepareDatabase();
  A = await h.createWorkspace({ name: 'Zoho app A' });
  B = await h.createWorkspace({ name: 'Zoho app B' });
});
test.after(() => h.shutdown());

test('migration 026: mail_provider_apps, one client per workspace and provider, deleted with the workspace', async () => {
  assert.ok(await db().get("SELECT 1 AS x FROM schema_migrations WHERE id = '026_mail_provider_apps'"));
  assert.ok(await db().get("SELECT 1 AS x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_provider_apps' AND INDEX_NAME = 'uq_mail_provider_apps' AND NON_UNIQUE = 0"));
  const fk = await db().get("SELECT DELETE_RULE AS d FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_mail_provider_apps_ws'");
  assert.equal(fk.d, 'CASCADE');
});

test('without credentials anywhere, Settings says so and Connect is refused with a pointer to Settings', async () => {
  const app = await zapi(A, 'GET', '/app');
  assert.equal(app.status, 200);
  assert.equal(app.data.app.source, null);
  assert.equal(app.data.app.redirectUri, 'https://app.marketech.test/api/v1/mail/zoho/callback');
  assert.equal((await zapi(A, 'GET', '/status')).data.serverConfigured, false);
  const c = await zapi(A, 'POST', '/connect', {});
  assert.equal(c.status, 409);
  assert.match(c.data.error, /Settings → Campaigns/);
});

test('only Owners/Admins (mail.configure) can read or change the credentials', async () => {
  for (const role of ['Member', 'Approver', 'Marketing Manager']) {
    const m = await h.addMember(A.workspaceId, role);
    assert.equal((await zapi(m, 'GET', '/app')).status, 403, role);
    assert.equal((await zapi(m, 'PUT', '/app', { clientId: CLIENT_ID, clientSecret: SECRET })).status, 403, role);
    assert.equal((await zapi(m, 'DELETE', '/app')).status, 403, role);
  }
  assert.equal((await h.api('PUT', '/api/v1/mail/zoho/app', { body: { clientId: CLIENT_ID, clientSecret: SECRET } })).status, 401);
  assert.equal(await appRow(A.workspaceId), null);
});

test('validation: malformed values are refused; the first save needs the secret', async () => {
  assert.equal((await zapi(A, 'PUT', '/app', { clientId: 'bad id!', clientSecret: SECRET })).status, 400);
  assert.equal((await zapi(A, 'PUT', '/app', { clientId: CLIENT_ID, clientSecret: 'has spaces in it' })).status, 400);
  const noSecret = await zapi(A, 'PUT', '/app', { clientId: CLIENT_ID });
  assert.equal(noSecret.status, 400);
  assert.match(noSecret.data.error, /Client Secret/);
});

test('saving: the secret is encrypted at rest and never returned; only a hint of the Client ID is shown; other workspaces unaffected', async () => {
  const r = await zapi(A, 'PUT', '/app', { clientId: CLIENT_ID, clientSecret: SECRET });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.changed, true);
  const body = JSON.stringify(r.data) + JSON.stringify((await zapi(A, 'GET', '/app')).data) + JSON.stringify((await zapi(A, 'GET', '/status')).data);
  assert.ok(!body.includes(SECRET), 'secret never in a response');
  assert.ok(!body.includes(CLIENT_ID), 'full Client ID never in a response');
  assert.equal(r.data.app.source, 'workspace');
  assert.equal(r.data.app.clientIdHint, '1000.W…ID01');
  const row = await appRow(A.workspaceId);
  assert.equal(row.client_id, CLIENT_ID);
  assert.notEqual(row.client_secret_ciphertext, SECRET);
  assert.ok(!row.client_secret_ciphertext.includes(SECRET));
  const audit = await db().get("SELECT metadata_json FROM audit_logs WHERE workspace_id = ? AND action = 'mail.zoho.app_saved' ORDER BY id DESC LIMIT 1", [A.workspaceId]);
  assert.ok(audit && !audit.metadata_json.includes(SECRET));
  assert.equal((await zapi(A, 'GET', '/status')).data.serverConfigured, true);
  assert.equal((await zapi(A, 'GET', '/status')).data.credentialsSource, 'workspace');
  assert.equal((await zapi(B, 'GET', '/app')).data.app.source, null, 'workspace B has its own (none)');
  assert.equal((await zapi(B, 'POST', '/connect', {})).status, 409);
});

test('connecting uses the workspace\'s own client for the sign-in link and the token exchange', async () => {
  const { url, cb, forms } = await connect(A);
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.match(cb.headers.get('location') || '', /zoho=connected/);
  assert.equal(forms[0].client_id, CLIENT_ID);
  assert.equal(forms[0].client_secret, SECRET);
  assert.equal((await connRow(A.workspaceId)).status, 'connected');
});

test('re-saving the same values changes nothing; a new secret disconnects (the old connection belongs to the old client)', async () => {
  const same = await zapi(A, 'PUT', '/app', { clientId: CLIENT_ID });
  assert.equal(same.data.changed, false, 'leaving the secret out keeps it');
  assert.equal((await connRow(A.workspaceId)).status, 'connected');
  const changed = await zapi(A, 'PUT', '/app', { clientId: CLIENT_ID, clientSecret: 'ws-secret-NEW-9876543210' });
  assert.equal(changed.data.changed, true);
  assert.equal(changed.data.disconnected, true);
  const conn = await connRow(A.workspaceId);
  assert.equal(conn.status, 'disconnected');
  assert.equal(conn.refresh_token_ciphertext, null);
});

test('removing the workspace client falls back to the server .env client when there is one', async () => {
  await connect(A);
  const r = await zapi(A, 'DELETE', '/app');
  assert.equal(r.status, 200);
  assert.equal(r.data.disconnected, true);
  assert.equal(await appRow(A.workspaceId), null);
  assert.equal(r.data.app.source, null);
  process.env.ZOHO_CAMPAIGNS_CLIENT_ID = 'server-client-id-001';
  process.env.ZOHO_CAMPAIGNS_CLIENT_SECRET = 'server-secret-001';
  try {
    assert.equal((await zapi(A, 'GET', '/app')).data.app.source, 'server');
    const start = await zapi(A, 'POST', '/connect', {});
    assert.equal(new URL(start.data.authorizeUrl).searchParams.get('client_id'), 'server-client-id-001');
  } finally {
    delete process.env.ZOHO_CAMPAIGNS_CLIENT_ID;
    delete process.env.ZOHO_CAMPAIGNS_CLIENT_SECRET;
  }
  assert.equal((await zapi(A, 'DELETE', '/app')).status, 404);
});
