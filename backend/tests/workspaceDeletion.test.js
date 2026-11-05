const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

const db = () => h.db();
let admin;
let member;
const api = (u, method, p, body) => h.api(method, `/api/v1/platform${p}`, { token: u?.token, body });

test.before(async () => {
  await h.prepareDatabase();
  await db().run("INSERT IGNORE INTO workspaces (id, name, slug, owner_email, plan, status, created_at) VALUES (1, 'Platform', 'platform-test', 'owner@example.test', 'Starter', 'Active', UTC_TIMESTAMP())");
  admin = await h.createWorkspace({ name: 'Deletion admin home' });
  await db().run("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES (1, ?, 'Workspace Owner', 'Active') ON DUPLICATE KEY UPDATE role = 'Workspace Owner', status = 'Active'", [admin.userId]);
});
test.after(() => h.shutdown());

async function doomed(name) {
  member = await h.createWorkspace({ name });
  const ws = member.workspaceId;
  const lead = await h.api('POST', '/api/v1/leads', { token: member.token, body: { name: 'Kim', email: `kim.${Date.now()}@shop.io` } });
  assert.equal(lead.status, 200, JSON.stringify(lead.data));
  await db().run("INSERT INTO background_jobs (workspace_id, job_type, payload_json, idempotency_key, status, run_at, max_attempts, created_by, created_at) VALUES (?, 'sync_inbox', '{}', ?, 'queued', UTC_TIMESTAMP() + INTERVAL 1 HOUR, 3, ?, UTC_TIMESTAMP())", [ws, `del-${ws}`, member.userId]);
  const oc = await h.api('POST', '/api/v1/outreach/campaigns', { token: member.token, body: { name: 'Running' } });
  assert.equal(oc.status, 200, JSON.stringify(oc.data));
  await db().run("UPDATE outreach_campaigns SET status = 'running' WHERE id = ?", [oc.data.campaign.id]);
  const real = (await db().get('SELECT name FROM workspaces WHERE id = ?', [ws])).name;
  return { ws, name: real, leadId: lead.data.lead.id, outreachId: oc.data.campaign.id };
}

test('only the platform admin can delete; the name must be typed; the platform workspace and the current one are refused', async () => {
  const { ws } = await doomed(`Guarded ${Date.now()}`);
  assert.equal((await api(member, 'POST', `/workspaces/${ws}/delete`, { confirmName: 'x' })).status, 403, 'a workspace Owner cannot');
  const wrong = await api(admin, 'POST', `/workspaces/${ws}/delete`, { confirmName: 'Something else' });
  assert.deepEqual([wrong.status, wrong.data.code], [400, 'CONFIRMATION_MISMATCH']);
  assert.equal((await api(admin, 'POST', '/workspaces/1/delete', { confirmName: 'Platform' })).data.code, 'PROTECTED_WORKSPACE');
  const home = (await db().get('SELECT name FROM workspaces WHERE id = ?', [admin.workspaceId])).name;
  const own = await api(admin, 'POST', `/workspaces/${admin.workspaceId}/delete`, { confirmName: home });
  assert.equal(own.data.code, 'CURRENT_WORKSPACE', 'not the workspace the admin is signed in to');
  assert.equal((await db().get('SELECT status FROM workspaces WHERE id = ?', [ws])).status, 'Active');
});

test('delete closes the workspace at once and stops its work; restore within 30 days brings it back', async () => {
  const { ws, name, leadId, outreachId } = await doomed(`Closing ${Date.now()}`);
  const del = await api(admin, 'POST', `/workspaces/${ws}/delete`, { confirmName: ` ${name.toUpperCase()} `, reason: 'Client left' });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal(del.data.restoreDays, 30);
  assert.deepEqual([del.data.stopped.jobs, del.data.stopped.outreachCampaigns], [1, 1]);
  const days = (new Date(del.data.purgeAfter) - Date.now()) / 86400000;
  assert.ok(days > 29.9 && days <= 30.01, `erased in 30 days (${days})`);

  // Members are out at once, existing sessions included; it leaves the workspace switcher.
  assert.equal((await h.api('GET', '/api/v1/leads', { token: member.token })).status, 401);
  assert.equal((await api(admin, 'POST', `/workspaces/${ws}/open`, {})).data.code, 'WORKSPACE_DELETED', 'nor can the admin open it');
  assert.equal((await api(admin, 'POST', `/workspaces/${ws}/delete`, { confirmName: name })).data.code, 'ALREADY_DELETED');
  // Its work is stopped and is not picked up.
  assert.equal((await db().get('SELECT status FROM outreach_campaigns WHERE id = ?', [outreachId])).status, 'paused');
  assert.equal((await db().get('SELECT status FROM background_jobs WHERE workspace_id = ?', [ws])).status, 'failed');
  await db().run("INSERT INTO background_jobs (workspace_id, job_type, payload_json, idempotency_key, status, run_at, max_attempts, created_by, created_at) VALUES (?, 'sync_inbox', '{}', ?, 'queued', UTC_TIMESTAMP() - INTERVAL 1 MINUTE, 3, ?, UTC_TIMESTAMP())", [ws, `late-${ws}`, member.userId]);
  const claimed = await require('../modules/social/jobsService').claimDue('test-worker', 20);
  assert.ok(!claimed.some(j => j.workspace_id === ws), 'the worker skips a deleted workspace');
  // The admin sees it as deleted, with who, why and when it will be erased; data is still there.
  const view = (await api(admin, 'GET', `/workspaces/${ws}`)).data.workspace;
  assert.deepEqual([view.status, view.deleteReason, !!view.deletedBy, !!view.purgeAfter], ['Deleted', 'Client left', true, true]);
  assert.ok(await db().get('SELECT id FROM leads WHERE id = ?', [leadId]));

  const back = await api(admin, 'POST', `/workspaces/${ws}/restore`, {});
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.match(back.data.note, /scheduled or resumed again/);
  assert.equal((await h.api('GET', '/api/v1/leads', { token: member.token })).status, 200, 'members are back in');
  assert.equal((await api(admin, 'POST', `/workspaces/${ws}/restore`, {})).data.code, 'NOT_DELETED');
  const logged = await db().all("SELECT action FROM audit_logs WHERE workspace_id = ? AND action LIKE 'platform.workspace_%' ORDER BY id", [ws]);
  assert.ok(['platform.workspace_deleted', 'platform.workspace_restored'].every(a => logged.some(l => l.action === a)));
});

test('after 30 days the worker erases the data and files; the record and audit log stay; it cannot be restored', async () => {
  const { ws, name, leadId } = await doomed(`Erased ${Date.now()}`);
  await db().run("INSERT INTO mail_lists (workspace_id, name, source, created_at, updated_at) VALUES (?, 'L', 'local', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [ws]).catch(() => null);
  const dir = path.join(require('../modules/mail/templates/assetStore').storageRoot(), String(ws));
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'x.png'), 'x');
  assert.equal((await api(admin, 'POST', `/workspaces/${ws}/delete`, { confirmName: name })).status, 200);
  const deletion = require('../modules/platform/workspaceDeletion');
  assert.ok(!(await deletion.purgeDue(10)).some(r => r.id === ws), 'not before the 30 days');
  await db().run('UPDATE workspaces SET purge_after = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE id = ?', [ws]);
  const done = (await deletion.purgeDue(10)).find(r => r.id === ws);
  assert.ok(done && done.erased, JSON.stringify(done));
  assert.equal(await db().get('SELECT id FROM leads WHERE id = ?', [leadId]), null);
  for (const t of ['leads', 'outreach_campaigns', 'background_jobs', 'workspace_members', 'mail_lists']) {
    assert.equal(Number((await db().get(`SELECT COUNT(*) AS n FROM ${t} WHERE workspace_id = ?`, [ws])).n), 0, t);
  }
  assert.equal(fs.existsSync(dir), false, 'uploaded files are removed');
  assert.equal((await db().get('SELECT status FROM workspaces WHERE id = ?', [ws])).status, 'Purged');
  assert.ok(await db().get("SELECT id FROM audit_logs WHERE workspace_id = ? AND action = 'platform.workspace_deleted'", [ws]), 'the audit log is kept');
  assert.ok(await db().get('SELECT id FROM users WHERE id = ?', [member.userId]), 'people\'s accounts are not deleted');
  assert.equal((await api(admin, 'POST', `/workspaces/${ws}/restore`, {})).data.code, 'PURGED');
});

test('clear data: shows counts, erases only what was ticked (also in the platform workspace), keeps the workspace and Owners', async () => {
  const { ws, name, leadId, outreachId } = await doomed(`Testing data ${Date.now()}`);
  await db().run("INSERT INTO digital_products (workspace_id, name, url, status, created_at) VALUES (?, 'Keep me', 'https://p.example.org', 'Active', UTC_TIMESTAMP())", [ws]);
  const other = await h.createWorkspace({ name: 'Untouched' });
  const otherLead = (await h.api('POST', '/api/v1/leads', { token: other.token, body: { name: 'Stay' } })).data.lead;

  assert.equal((await api(member, 'GET', `/workspaces/${ws}/clear-options`)).status, 403, 'platform admin only');
  const opts = await api(admin, 'GET', `/workspaces/${ws}/clear-options`);
  assert.equal(opts.status, 200, JSON.stringify(opts.data));
  const count = k => opts.data.categories.find(c => c.key === k).count;
  assert.deepEqual([count('leads'), count('outreach'), count('products')], [1, 1, 1]);
  assert.match(opts.data.kept, /connections and settings/);

  assert.equal((await api(admin, 'POST', `/workspaces/${ws}/clear`, { categories: ['leads'], confirmName: 'nope' })).data.code, 'CONFIRMATION_MISMATCH');
  assert.equal((await api(admin, 'POST', `/workspaces/${ws}/clear`, { categories: [], confirmName: name })).status, 400);
  const r = await api(admin, 'POST', `/workspaces/${ws}/clear`, { categories: ['leads', 'outreach', 'jobs'], confirmName: name });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.cleared.leads, 1);
  assert.equal(await db().get('SELECT id FROM leads WHERE id = ?', [leadId]), null);
  assert.equal(await db().get('SELECT id FROM outreach_campaigns WHERE id = ?', [outreachId]), null);
  assert.ok(await db().get("SELECT id FROM digital_products WHERE workspace_id = ? AND name = 'Keep me'", [ws]), 'not ticked: kept');
  assert.ok(await db().get('SELECT id FROM leads WHERE id = ?', [otherLead.id]), 'other workspaces are untouched');
  assert.equal((await db().get('SELECT status FROM workspaces WHERE id = ?', [ws])).status, 'Active');
  assert.equal((await h.api('GET', '/api/v1/leads', { token: member.token })).status, 200, 'the Owner still works in it');
  assert.ok(await db().get("SELECT id FROM audit_logs WHERE workspace_id = ? AND action = 'platform.workspace_data_cleared'", [ws]));

  // The platform workspace (cannot be deleted) can be cleared.
  await db().run("INSERT INTO leads (workspace_id, name, status, created_at) VALUES (1, 'Platform test lead', 'New', UTC_TIMESTAMP())");
  const platformName = (await db().get('SELECT name FROM workspaces WHERE id = 1')).name;
  const p = await api(admin, 'POST', '/workspaces/1/clear', { categories: ['leads'], confirmName: platformName });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM leads WHERE workspace_id = 1')).n), 0);
  assert.ok(await db().get('SELECT user_id FROM workspace_members WHERE workspace_id = 1 AND user_id = ?', [admin.userId]), 'the admin is still its Owner');
});

test('clear data: members other than Owners are removed; everything can be cleared at once', async () => {
  const { ws, name } = await doomed(`Members ${Date.now()}`);
  const extra = await h.createWorkspace({ name: 'Extra person' });
  await db().run("INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at) VALUES (?, ?, 'Member', 'Active', UTC_TIMESTAMP())", [ws, extra.userId]);
  const all = (await api(admin, 'GET', `/workspaces/${ws}/clear-options`)).data.categories;
  assert.equal(all.find(c => c.key === 'members').count, 1);
  const r = await api(admin, 'POST', `/workspaces/${ws}/clear`, { categories: all.map(c => c.key), confirmName: name });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const left = await db().all('SELECT user_id, role FROM workspace_members WHERE workspace_id = ?', [ws]);
  assert.deepEqual(left.map(m => [m.user_id, m.role]), [[member.userId, 'Workspace Owner']]);
});
