const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Mail Center tab access per member (migration 066, lib/mailTabs.js): Inbox, Campaigns, Deliverability,
// Email Templates and Logs can be limited per member; the server refuses the APIs of tabs they do not have.
const db = () => h.db();
let W; let MEM;
const get = (who, p) => h.api('GET', p, { token: who.token });
const setTabs = (tabs, modules = ['mail']) => h.api('PUT', `/api/v1/workspace/members/${MEM.userId}/modules`, { token: W.token, body: { modules, mailTabs: tabs } });

test.before(async () => {
  await h.prepareDatabase();
  W = await h.createWorkspace({ name: 'Mail tabs' });
  MEM = await h.addMember(W.workspaceId, 'Member');
});
test.after(() => h.shutdown());

test('migration 066 adds the nullable column; existing members keep every tab', async () => {
  assert.ok(await db().get("SELECT 1 AS x FROM schema_migrations WHERE id = '066_member_mail_tabs'"));
  const me = await get(MEM, '/api/v1/auth/me');
  assert.deepEqual(me.data.mailTabs.sort(), ['campaigns', 'deliverability', 'inbox', 'logs', 'templates']);
  assert.equal((await get(MEM, '/api/v1/emails/inbox')).status, 200);
});

test('a member limited to some tabs is refused the others on the server; templates stay usable', async () => {
  const r = await setTabs(['campaigns']);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.mailTabs.keys, ['campaigns']);
  const refused = await get(MEM, '/api/v1/emails/inbox');
  assert.equal(refused.status, 403);
  assert.equal(refused.data.code, 'MAIL_TAB_REQUIRED');
  assert.equal(refused.data.tab, 'inbox');
  assert.equal((await get(MEM, '/api/v1/mail/ses/deliverability')).status, 403);
  assert.equal((await get(MEM, '/api/v1/mail/activity/campaigns')).status, 403);
  assert.equal((await h.api('POST', '/api/v1/mail/templates', { token: MEM.token, body: { name: 'T', html: '<p>Hi</p>' } })).status, 403, 'no managing templates');
  assert.equal((await get(MEM, '/api/v1/mail/templates')).status, 200, 'picking a template still works (Compose, Campaigns)');
  assert.equal((await get(MEM, '/api/v1/mail/campaigns')).status, 200, 'the allowed tab works');
  assert.equal((await get(MEM, '/api/v1/emails/sent')).status, 200, 'Sent Mail is not a limited tab');
  assert.deepEqual((await get(MEM, '/api/v1/auth/me')).data.mailTabs, ['campaigns']);
  const list = await get(W, '/api/v1/workspace/members');
  assert.deepEqual(list.data.members.find(m => m.userId === MEM.userId).mailTabs.keys, ['campaigns']);
  assert.deepEqual(list.data.mailTabs.map(t => t.key), ['inbox', 'campaigns', 'deliverability', 'templates', 'logs']);
});

test('all tabs ticked is stored as "all"; leaving mailTabs out keeps them; Owners always have every tab', async () => {
  await setTabs(['inbox', 'campaigns', 'deliverability', 'templates', 'logs']);
  assert.equal((await db().get('SELECT mail_tabs_json AS j FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [W.workspaceId, MEM.userId])).j, null);
  await setTabs(['logs']);
  const keep = await h.api('PUT', `/api/v1/workspace/members/${MEM.userId}/modules`, { token: W.token, body: { modules: ['mail', 'leads'] } });
  assert.deepEqual(keep.data.mailTabs.keys, ['logs'], 'unchanged when not sent');
  assert.equal((await get(W, '/api/v1/emails/inbox')).status, 200);
  // Only Owners/Admins may change it.
  assert.equal((await h.api('PUT', `/api/v1/workspace/members/${W.userId}/modules`, { token: MEM.token, body: { modules: ['mail'], mailTabs: [] } })).status, 403);
});
