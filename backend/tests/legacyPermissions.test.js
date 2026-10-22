const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Workspace-1-only (legacy) routes check capabilities server-side; other workspaces stay blocked.
const db = () => h.db();
const LEGACY = 1;
const roles = {};
let other;

test.before(async () => {
  await h.prepareDatabase();
  for (const role of ['Workspace Owner', 'Workspace Admin', 'Marketing Manager', 'Approver', 'Member']) roles[role] = await h.addMember(LEGACY, role);
  other = await h.createWorkspace({ name: 'Not legacy' });
});
test.after(() => h.shutdown());

const call = (who, method, path, body) => h.api(method, path, { token: who.token, body });
const forbidden = res => res.status === 403 && res.data.code === 'FORBIDDEN';

async function newContent() {
  const ins = await db().run(
    "INSERT INTO content_items (workspace_id, platform, body_text, status, created_at) VALUES (?, 'linkedin', 'Legacy permission test', 'draft', UTC_TIMESTAMP())",
    [LEGACY]
  );
  return ins.lastID;
}
const contentExists = async id => !!(await db().get('SELECT id FROM content_items WHERE id = ?', [id]));

test('billing plan changes are blocked for everyone, Owners included, with no subscription written', async () => {
  const before = Number((await db().get('SELECT COUNT(*) AS n FROM subscriptions')).n);
  for (const who of Object.values(roles)) {
    for (const path of ['/api/v1/billing/change-plan', '/api/billing/change-plan']) {
      const res = await call(who, 'POST', path, { planKey: 'pro' });
      assert.equal(res.status, 501, path);
      assert.equal(res.data.code, 'BILLING_NOT_AVAILABLE');
    }
  }
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM subscriptions')).n), before);
});

test('business profile updates: Owners and Admins only', async () => {
  const profile = { businessName: 'Legacy Co', industry: 'Retail', websiteUrl: '', description: '', brandVoice: 'Friendly', products: [] };
  for (const role of ['Marketing Manager', 'Approver', 'Member']) {
    for (const path of ['/api/v1/business-profile', '/api/business-profile']) {
      assert.ok(forbidden(await call(roles[role], 'PUT', path, profile)), `${role} ${path}`);
    }
  }
  for (const role of ['Workspace Owner', 'Workspace Admin']) {
    const res = await call(roles[role], 'PUT', '/api/v1/business-profile', profile);
    assert.equal(res.status, 200, role);
  }
  // Reading stays open to members.
  assert.equal((await call(roles.Member, 'GET', '/api/v1/business-profile')).status, 200);
});

test('content deletion needs content.create (Approvers cannot delete; creators can)', async () => {
  const id = await newContent();
  for (const path of [`/api/v1/content/${id}`, `/api/content/${id}`]) {
    assert.ok(forbidden(await call(roles.Approver, 'DELETE', path)), path);
  }
  assert.ok(await contentExists(id), 'a refused delete leaves the item');

  for (const role of ['Member', 'Marketing Manager', 'Workspace Admin', 'Workspace Owner']) {
    const cid = await newContent();
    assert.equal((await call(roles[role], 'DELETE', `/api/v1/content/${cid}`)).status, 200, role);
    assert.ok(!(await contentExists(cid)), role);
  }
});

test('B2B: creating campaigns needs campaigns.manage; creating clients needs leads.manage', async () => {
  const campaign = { name: 'Perm test', subject: 'Hi', templateBody: 'Body' };
  const campaigns = async () => Number((await db().get('SELECT COUNT(*) AS n FROM email_campaigns')).n);
  const c0 = await campaigns();
  for (const role of ['Approver', 'Member']) {
    for (const path of ['/api/v1/b2b/campaigns', '/api/b2b/campaigns']) {
      assert.ok(forbidden(await call(roles[role], 'POST', path, campaign)), `${role} ${path}`);
    }
  }
  assert.equal(await campaigns(), c0, 'refused requests write nothing');
  for (const role of ['Marketing Manager', 'Workspace Admin', 'Workspace Owner']) {
    assert.equal((await call(roles[role], 'POST', '/api/v1/b2b/campaigns', campaign)).status, 200, role);
  }

  const clients = async () => Number((await db().get('SELECT COUNT(*) AS n FROM b2b_clients')).n);
  const k0 = await clients();
  const client = { companyName: 'Perm Test Ltd', email: 'buyer@perm.example' };
  assert.ok(forbidden(await call(roles.Approver, 'POST', '/api/v1/b2b/clients', client)));
  assert.equal(await clients(), k0);
  for (const role of ['Member', 'Marketing Manager', 'Workspace Owner']) {
    assert.equal((await call(roles[role], 'POST', '/api/b2b/clients', client)).status, 200, role);
  }
});

test('B2B reads stay available to every legacy-workspace role', async () => {
  for (const who of Object.values(roles)) {
    for (const path of ['/api/v1/b2b/clients', '/api/v1/b2b/campaigns', '/api/v1/b2b/replies', '/api/v1/b2b/ideas']) {
      assert.equal((await call(who, 'GET', path)).status, 200, path);
    }
  }
});

test('other workspaces stay blocked from these routes, Owners included', async () => {
  const id = await newContent();
  const attempts = [
    ['POST', '/api/v1/billing/change-plan', { planKey: 'pro' }],
    ['PUT', '/api/v1/business-profile', { businessName: 'X' }],
    ['DELETE', `/api/v1/content/${id}`],
    ['POST', '/api/v1/b2b/campaigns', { name: 'X' }],
    ['POST', '/api/v1/b2b/clients', { companyName: 'X', email: 'x@x.example' }],
    ['GET', '/api/v1/b2b/clients']
  ];
  for (const [method, path, body] of attempts) {
    const res = await call(other, method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.data.code, 'MODULE_NOT_TENANT_AWARE');
  }
  assert.ok(await contentExists(id));
});

test('unauthenticated requests are refused', async () => {
  for (const [method, path] of [['POST', '/api/v1/billing/change-plan'], ['PUT', '/api/v1/business-profile'], ['DELETE', '/api/v1/content/1'], ['POST', '/api/v1/b2b/campaigns']]) {
    assert.equal((await h.api(method, path, { body: {} })).status, 401, path);
  }
});
