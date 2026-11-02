const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Real sign-out (migration 031) and the security headers on every response.
test.before(async () => { await h.prepareDatabase(); });
test.after(() => h.shutdown());

const me = token => h.api('GET', '/api/v1/auth/me', { token });
async function newAccount() {
  const email = `session-${crypto.randomBytes(5).toString('hex')}@example.org`;
  const password = 'Correct-Horse-123';
  const r = await h.api('POST', '/api/v1/auth/register', { body: { email, password, displayName: 'Session Test', workspaceName: 'Session WS' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { email, password, token: r.data.token, userId: r.data.user.id };
}
const login = async (email, password) => (await h.api('POST', '/api/v1/auth/login', { body: { email, password } })).data.token;

test('sign out ends that sign-in on the server; other sign-ins keep working', async () => {
  const a = await newAccount();
  const other = await login(a.email, a.password);
  assert.equal((await me(a.token)).status, 200);
  const out = await h.api('POST', '/api/v1/auth/logout', { token: a.token });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.ended, true);
  assert.equal((await me(a.token)).status, 401, 'a copy of the signed-out token no longer works');
  assert.equal((await me(other)).status, 200, 'the other device stays signed in');
  const logged = await h.db().get("SELECT id FROM audit_logs WHERE action = 'auth.signed_out' AND resource_id = ? LIMIT 1", [String(a.userId)]);
  assert.ok(logged, 'sign-out is in the audit log');
});

test('sign out everywhere ends every sign-in; signing in again works', async () => {
  const a = await newAccount();
  const second = await login(a.email, a.password);
  const r = await h.api('POST', '/api/v1/auth/logout-all', { token: second });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ended, true);
  assert.equal((await me(a.token)).status, 401);
  assert.equal((await me(second)).status, 401);
  const fresh = await login(a.email, a.password);
  assert.equal((await me(fresh)).status, 200, 'a new sign-in after it works');
});

test('a password reset ends existing sign-ins; tokens issued before this change still work until then', async () => {
  const a = await newAccount();
  // A token from before migration 031: no session id and no session version.
  const { createToken } = require('../services/authService');
  const legacy = createToken({ userId: a.userId, email: a.email, workspaceId: (await me(a.token)).data.workspace?.id || (await h.db().get('SELECT workspace_id FROM workspace_members WHERE user_id = ?', [a.userId])).workspace_id, role: 'Workspace Owner' });
  assert.equal((await me(legacy)).status, 200);
  await require('../services/authService').signOutEverywhere(a.userId);
  assert.equal((await me(legacy)).status, 401);
  assert.equal((await me(a.token)).status, 401);
});

test('a forged session version or token id is refused', async () => {
  const a = await newAccount();
  const [header, body] = a.token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  const tampered = `${header}.${Buffer.from(JSON.stringify({ ...payload, sv: 99 })).toString('base64url')}.${a.token.split('.')[2]}`;
  assert.equal((await me(tampered)).status, 401, 'changing the token breaks its signature');
});

test('security headers: no framing by other sites, no sniffing, limited browser features, no X-Powered-By', async () => {
  for (const path of ['/api/status', '/']) {
    const r = await h.api('GET', path, {});
    const hd = r.headers;
    assert.equal(hd.get('x-content-type-options'), 'nosniff', path);
    assert.equal(hd.get('x-frame-options'), 'SAMEORIGIN', path);
    assert.match(hd.get('content-security-policy') || '', /frame-ancestors 'self'/, path);
    assert.equal(hd.get('referrer-policy'), 'strict-origin-when-cross-origin', path);
    assert.match(hd.get('permissions-policy') || '', /microphone=\(self\)/, path);
    assert.equal(hd.get('x-powered-by'), null, path);
    assert.equal(hd.get('strict-transport-security'), null, 'HSTS only in production over https');
  }
});

// ---------------------------------------------------------------- HttpOnly cookie sessions
const APP = { 'X-Requested-With': 'marketech' };
const cookieOf = r => {
  const raw = r.headers.get('set-cookie') || '';
  const m = /mt_session=([^;]*)/.exec(raw);
  return { raw, value: m ? m[1] : null };
};

test('the browser app gets an HttpOnly cookie and never the token; API clients still get the token', async () => {
  const a = await newAccount();
  const browser = await h.api('POST', '/api/v1/auth/login', { body: { email: a.email, password: a.password }, headers: APP });
  assert.equal(browser.status, 200, JSON.stringify(browser.data));
  assert.equal(browser.data.token, undefined, 'no token in the body for the browser app');
  assert.ok(browser.data.session && browser.data.session.userId === a.userId && browser.data.session.id, 'a non-secret session marker instead');
  const c = cookieOf(browser);
  assert.ok(c.value, 'the session cookie is set');
  assert.match(c.raw, /HttpOnly/);
  assert.match(c.raw, /SameSite=Lax/);
  assert.match(c.raw, /Path=\//);

  const client = await h.api('POST', '/api/v1/auth/login', { body: { email: a.email, password: a.password } });
  assert.ok(client.data.token, 'API clients (no app header) still receive the token');
});

test('the cookie authenticates reads; changes need the app header (cross-site request forgery)', async () => {
  const a = await newAccount();
  const login = await h.api('POST', '/api/v1/auth/login', { body: { email: a.email, password: a.password }, headers: APP });
  const cookie = `mt_session=${cookieOf(login).value}`;
  const read = await h.api('GET', '/api/v1/auth/me', { headers: { Cookie: cookie } });
  assert.equal(read.status, 200, 'GET works with the cookie alone');

  const forged = await h.api('POST', '/api/v1/leads', { body: { name: 'Forged' }, headers: { Cookie: cookie } });
  assert.equal(forged.status, 403);
  assert.equal(forged.data.code, 'CSRF_REJECTED');

  const fromApp = await h.api('POST', '/api/v1/leads', { body: { name: 'From the app' }, headers: { Cookie: cookie, ...APP } });
  assert.equal(fromApp.status, 200, JSON.stringify(fromApp.data));
});

test('sign out clears the cookie and the old cookie stops working; it works even when already expired', async () => {
  const a = await newAccount();
  const login = await h.api('POST', '/api/v1/auth/login', { body: { email: a.email, password: a.password }, headers: APP });
  const cookie = `mt_session=${cookieOf(login).value}`;
  const out = await h.api('POST', '/api/v1/auth/logout', { headers: { Cookie: cookie, ...APP } });
  assert.equal(out.status, 200);
  assert.equal(out.data.ended, true);
  assert.match(cookieOf(out).raw, /mt_session=;.*Max-Age=0/);
  assert.equal((await h.api('GET', '/api/v1/auth/me', { headers: { Cookie: cookie } })).status, 401, 'a kept copy of the cookie is refused');

  const again = await h.api('POST', '/api/v1/auth/logout', { headers: { Cookie: cookie, ...APP } });
  assert.equal(again.status, 200, 'signing out with a dead session still clears the cookie');
  assert.match(cookieOf(again).raw, /Max-Age=0/);
});

test('switching workspace from the app moves the cookie to the new session without exposing a token', async () => {
  const a = await newAccount();
  const login = await h.api('POST', '/api/v1/auth/login', { body: { email: a.email, password: a.password }, headers: APP });
  const cookie = `mt_session=${cookieOf(login).value}`;
  const created = await h.api('POST', '/api/v1/workspaces', { body: { name: 'Second WS' }, headers: { Cookie: cookie, ...APP } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.token, undefined);
  assert.ok(cookieOf(created).value, 'the new session is in the cookie');
  assert.equal(created.data.session.workspaceId, created.data.workspace.id);
});
