const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let A;
let B;
let accountA;
let contentA;

test.before(async () => {
  await h.prepareDatabase();
  A = await h.createWorkspace({ name: 'Tenant A' });
  B = await h.createWorkspace({ name: 'Tenant B' });
  accountA = await h.createAccount(A.workspaceId);
  const res = await h.api('POST', '/api/v1/social/content', { token: A.token, body: { platformKey: 'facebook', caption: 'Tenant A private draft', socialAccountId: accountA.id } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  contentA = res.data.content;
});

test.after(() => h.shutdown());

test('unauthenticated requests are rejected on social and legacy routes', async () => {
  for (const p of ['/api/v1/social/overview', '/api/v1/social/accounts', '/api/v1/crm/leads', '/api/v1/drafts', '/api/v1/auth/me']) {
    const res = await h.api('GET', p);
    assert.equal(res.status, 401, p);
  }
  const forged = await h.api('GET', '/api/v1/social/accounts', { token: A.token.slice(0, -3) + 'abc' });
  assert.equal(forged.status, 401);
});

test('voice tool webhooks require the shared secret when no user session is present', async () => {
  delete process.env.TOOL_WEBHOOK_SECRET;
  const res = await h.api('POST', '/api/tools/track_lead', { body: { name: 'x' } });
  assert.equal(res.status, 401);
  process.env.TOOL_WEBHOOK_SECRET = 'tool-secret-value';
  const wrong = await h.api('POST', '/api/tools/track_lead', { body: { name: 'x' }, headers: { 'X-Tool-Secret': 'nope' } });
  assert.equal(wrong.status, 401);
});

test('removed shell-command endpoints no longer exist', async () => {
  for (const p of ['/api/tools/launch_app', '/api/tools/system_control', '/api/tools/open_website']) {
    const res = await h.api('POST', p, { token: A.token, body: { app_name: 'calc' } });
    assert.ok([403, 404].includes(res.status), `${p} returned ${res.status}`);
  }
});

test('single-tenant legacy modules are closed to other workspaces', async () => {
  // Leads, Products and Mail are workspace-aware now; Appointments is still a workspace-1-only legacy module.
  const res = await h.api('GET', '/api/v1/crm/appointments', { token: B.token });
  assert.equal(res.status, 403);
  assert.equal(res.data.code, 'MODULE_NOT_TENANT_AWARE');
});

test('a workspace cannot read or change another workspace\'s social records', async () => {
  const read = await h.api('GET', `/api/v1/social/content/${contentA.id}`, { token: B.token });
  assert.equal(read.status, 404);
  const edit = await h.api('PATCH', `/api/v1/social/content/${contentA.id}`, { token: B.token, body: { caption: 'hijacked' } });
  assert.equal(edit.status, 404);
  const approve = await h.api('POST', `/api/v1/social/content/${contentA.id}/approve`, { token: B.token, body: {} });
  assert.equal(approve.status, 404);
  const disconnect = await h.api('DELETE', `/api/v1/social/accounts/${accountA.id}`, { token: B.token });
  assert.equal(disconnect.status, 404);
  const list = await h.api('GET', '/api/v1/social/content', { token: B.token });
  assert.equal(list.data.items.some(i => i.id === contentA.id), false);
  const accounts = await h.api('GET', '/api/v1/social/accounts', { token: B.token });
  assert.equal(accounts.data.accounts.length, 0);

  // Referencing a foreign account from your own content is rejected too.
  const steal = await h.api('POST', '/api/v1/social/content', { token: B.token, body: { platformKey: 'facebook', caption: 'x', socialAccountId: accountA.id } });
  assert.equal(steal.status, 400);

  const { get } = h.db();
  const row = await get('SELECT caption_text FROM content_items WHERE id = ?', [contentA.id]);
  assert.equal(row.caption_text, 'Tenant A private draft');
});

test('a token for a removed membership stops working immediately', async () => {
  const C = await h.createWorkspace();
  const ok = await h.api('GET', '/api/v1/social/settings', { token: C.token });
  assert.equal(ok.status, 200);
  const { run } = h.db();
  await run("UPDATE workspace_members SET status = 'Removed' WHERE workspace_id = ? AND user_id = ?", [C.workspaceId, C.userId]);
  const after = await h.api('GET', '/api/v1/social/settings', { token: C.token });
  assert.equal(after.status, 401);
});

test('capability checks are enforced on the server', async () => {
  const member = await h.addMember(A.workspaceId, 'Member');
  const approve = await h.api('POST', `/api/v1/social/content/${contentA.id}/approve`, { token: member.token, body: {} });
  assert.equal(approve.status, 403);
  const schedule = await h.api('POST', `/api/v1/social/content/${contentA.id}/publish-now`, { token: member.token, body: {} });
  assert.equal(schedule.status, 403);
  const connect = await h.api('POST', '/api/v1/social/oauth/meta/start', { token: member.token });
  assert.equal(connect.status, 403);
  const settings = await h.api('PUT', '/api/v1/social/settings', { token: member.token, body: { requireApproval: false } });
  assert.equal(settings.status, 403);
  // Members can still draft.
  const draft = await h.api('POST', '/api/v1/social/content', { token: member.token, body: { platformKey: 'linkedin', caption: 'member draft' } });
  assert.equal(draft.status, 200);

  const approver = await h.addMember(A.workspaceId, 'Approver');
  const ok = await h.api('POST', `/api/v1/social/content/${contentA.id}/approve`, { token: approver.token, body: {} });
  assert.equal(ok.status, 200);
  const cannotPublish = await h.api('POST', `/api/v1/social/content/${contentA.id}/publish-now`, { token: approver.token, body: {} });
  assert.equal(cannotPublish.status, 403);
});

test('provider credentials are encrypted at rest and never returned by the API', async () => {
  const res = await h.api('GET', '/api/v1/social/accounts', { token: A.token });
  const text = JSON.stringify(res.data);
  assert.ok(!text.includes('page-token-SECRET'));
  assert.ok(!text.includes('user-token-SECRET'));
  assert.ok(!/secret_ciphertext|access_token|credential_id/.test(text));
  const overview = await h.api('GET', '/api/v1/social/overview', { token: A.token });
  // Env var *names* such as META_APP_SECRET are listed as setup guidance; token values must not appear.
  assert.ok(!JSON.stringify(overview.data).includes('page-token-SECRET'));
  assert.ok(!JSON.stringify(overview.data).includes('user-token-SECRET'));

  const { get } = h.db();
  const cred = await get('SELECT secret_ciphertext FROM provider_credentials WHERE id = ?', [accountA.credentialId]);
  assert.ok(cred.secret_ciphertext.startsWith('enc:v1:'));
  assert.ok(!cred.secret_ciphertext.includes('page-token-SECRET'));
});

test('request validation rejects malformed input', async () => {
  const bad = await h.api('POST', '/api/v1/social/content', { token: A.token, body: { platformKey: 'myspace', caption: 'x' } });
  assert.equal(bad.status, 400);
  const badId = await h.api('GET', '/api/v1/social/content/abc', { token: A.token });
  assert.equal(badId.status, 400);
  const badTz = await h.api('PUT', '/api/v1/social/settings', { token: A.token, body: { timezone: 'Mars/Olympus' } });
  assert.equal(badTz.status, 400);
});

test('registration validates input and creates an isolated workspace on MySQL', async () => {
  const weak = await h.api('POST', '/api/v1/auth/register', { body: { email: 'weak@example.test', password: 'short', workspaceName: 'W' } });
  assert.equal(weak.status, 400);
  const email = `new-${Date.now()}@example.test`;
  const reg = await h.api('POST', '/api/v1/auth/register', { body: { email, password: 'a-long-enough-password', workspaceName: 'New Co', industry: 'Retail' } });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const me = await h.api('GET', '/api/v1/auth/me', { token: reg.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.workspace.id, reg.data.workspace.id);
  const accounts = await h.api('GET', '/api/v1/social/accounts', { token: reg.data.token });
  assert.equal(accounts.data.accounts.length, 0);
});
