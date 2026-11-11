const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Lead ownership and access (lib/leadAccess.js): who sees, edits, deletes and shares which lead.
// Owner = Workspace Owner (lead admin), Admin = Workspace Admin (lead admin), A and B = Members.
const db = () => h.db();
let Owner, Admin, A, B, Other;
const call = (who, method, path, body) => h.api(method, path, { token: who.token, body });
const leads = (who, q = '') => call(who, 'GET', `/api/v1/leads?limit=200${q}`);
const ids = r => (r.data.leads || []).map(l => l.id);
const create = async (who, name, extra = {}) => {
  const r = await call(who, 'POST', '/api/v1/leads', { name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@corp.io`, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.lead;
};

test.before(async () => {
  await h.prepareDatabase();
  Owner = await h.createWorkspace({ name: 'Leads team' });
  Admin = await h.addMember(Owner.workspaceId, 'Workspace Admin');
  A = await h.addMember(Owner.workspaceId, 'Member');
  B = await h.addMember(Owner.workspaceId, 'Member');
  Other = await h.createWorkspace({ name: 'Another company' });
});
test.after(() => h.shutdown());

let aLead, adminLead;

test('1–2. A member\'s lead: they and the admins can use it; another member cannot, even with its id', async () => {
  aLead = await create(A, 'Alpha Buyer', { ownerUserId: B.userId, created_by_user_id: B.userId });
  assert.equal(aLead.ownerUserId, A.userId, 'ownership comes from the session, not the request');
  assert.equal(aLead.createdByUserId, A.userId);
  assert.equal(aLead.leadSource, 'manual');
  for (const who of [A, Admin, Owner]) assert.equal((await call(who, 'GET', `/api/v1/leads/${aLead.id}`)).status, 200);
  assert.ok(ids(await leads(Admin)).includes(aLead.id));

  assert.equal((await call(B, 'GET', `/api/v1/leads/${aLead.id}`)).status, 404, 'not revealed');
  assert.equal((await call(B, 'PATCH', `/api/v1/leads/${aLead.id}`, { status: 'Won' })).status, 404);
  assert.equal((await call(B, 'DELETE', `/api/v1/leads/${aLead.id}`)).status, 404);
  assert.equal((await call(B, 'POST', `/api/v1/leads/${aLead.id}/ai-qualify`)).status, 404);
  assert.equal((await call(B, 'GET', `/api/v1/leads/${aLead.id}/access`)).status, 404);
  assert.ok(!ids(await leads(B)).includes(aLead.id));
  assert.ok(!ids(await leads(B, '&q=Alpha')).includes(aLead.id), 'search');
  assert.ok(!(await call(B, 'GET', '/api/v1/leads/export')).data.leads.some(l => l.id === aLead.id), 'export');
  // A can edit and update the status of their own lead.
  assert.equal((await call(A, 'PATCH', `/api/v1/leads/${aLead.id}`, { status: 'Contacted', notes: 'Called' })).status, 200);
});

test('3. An admin\'s lead stays private to the admins', async () => {
  adminLead = await create(Admin, 'Admin Prospect');
  assert.equal(adminLead.ownerUserId, Admin.userId);
  for (const who of [A, B]) {
    assert.equal((await call(who, 'GET', `/api/v1/leads/${adminLead.id}`)).status, 404);
    assert.ok(!ids(await leads(who)).includes(adminLead.id));
  }
  assert.equal((await call(Owner, 'GET', `/api/v1/leads/${adminLead.id}`)).status, 200, 'other admins see it');
  const views = (await leads(Owner)).data;
  assert.equal(views.canManageAccess, true);
  assert.ok(ids(await leads(Owner, '&view=admin_created')).includes(adminLead.id));
  assert.ok(!ids(await leads(Owner, '&view=admin_created')).includes(aLead.id));
  assert.ok(ids(await leads(Owner, '&view=user_created')).includes(aLead.id));
  assert.deepEqual((await leads(A)).data.views, ['all', 'mine']);
});

test('4–7. Sharing: view only, then manage (no sharing/deleting), then revoked at once', async () => {
  const share = (level, who = Admin, userIds = [B.userId]) => call(who, 'PUT', `/api/v1/leads/${adminLead.id}/access`, { userIds, level });
  assert.equal((await share('view', A)).status, 403, 'members cannot share');
  assert.equal((await share('view')).status, 200);
  const r = await call(B, 'GET', `/api/v1/leads/${adminLead.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.lead.accessLevel, 'view');
  const listed = (await leads(B, '&view=shared_with_me')).data.leads.find(l => l.id === adminLead.id);
  assert.equal(listed.accessLevel, 'view');
  assert.equal((await call(B, 'PATCH', `/api/v1/leads/${adminLead.id}`, { status: 'Won' })).status, 403, 'view only cannot edit');
  assert.equal((await call(B, 'DELETE', `/api/v1/leads/${adminLead.id}`)).status, 403);

  assert.equal((await share('manage')).status, 200);
  assert.equal((await call(B, 'PATCH', `/api/v1/leads/${adminLead.id}`, { status: 'Qualified', notes: 'Demo booked' })).status, 200, 'manage can edit');
  assert.equal((await call(B, 'DELETE', `/api/v1/leads/${adminLead.id}`)).status, 403, 'manage cannot delete');
  assert.equal((await call(B, 'PUT', `/api/v1/leads/${adminLead.id}/access`, { userIds: [A.userId], level: 'manage' })).status, 403, 'manage cannot share');
  assert.equal((await call(B, 'PUT', `/api/v1/leads/${adminLead.id}/access`, { userIds: [B.userId], level: 'manage' })).status, 403, 'cannot raise own access');
  assert.equal((await call(B, 'PUT', `/api/v1/leads/${adminLead.id}/owner`, { ownerUserId: B.userId })).status, 403);
  assert.equal((await call(A, 'GET', `/api/v1/leads/${adminLead.id}`)).status, 404, 'only B was given access');

  const access = (await call(Admin, 'GET', `/api/v1/leads/${adminLead.id}/access`)).data;
  assert.deepEqual(access.grants.map(g => [g.userId, g.level]), [[B.userId, 'manage']]);
  assert.equal(access.createdBy.userId, Admin.userId);

  assert.equal((await call(Admin, 'DELETE', `/api/v1/leads/${adminLead.id}/access/${B.userId}`)).status, 200);
  assert.equal((await call(B, 'GET', `/api/v1/leads/${adminLead.id}`)).status, 404, 'revoked immediately');
  const actions = (await db().all("SELECT action FROM audit_logs WHERE workspace_id = ? AND resource_type = 'lead' AND resource_id = ? ORDER BY id", [Owner.workspaceId, String(adminLead.id)])).map(r => r.action);
  for (const a of ['leads.created', 'leads.access_granted', 'leads.access_changed', 'leads.access_revoked']) assert.ok(actions.includes(a), a);
});

test('8. Changing the owner moves access in one step; the previous owner keeps only what is chosen', async () => {
  const r = await call(Admin, 'PUT', `/api/v1/leads/${aLead.id}/owner`, { ownerUserId: B.userId });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.access.owner.userId, B.userId);
  assert.equal((await call(A, 'GET', `/api/v1/leads/${aLead.id}`)).status, 404, 'previous owner has no access');
  assert.equal((await call(B, 'DELETE', `/api/v1/leads/${aLead.id}`)).status === 200 ? 'deleted' : 'kept', 'deleted', 'the new owner may delete');
  const again = await create(A, 'Second Alpha');
  await call(Admin, 'PUT', `/api/v1/leads/${again.id}/owner`, { ownerUserId: B.userId, previousOwnerAccess: 'view' });
  assert.equal((await call(A, 'GET', `/api/v1/leads/${again.id}`)).data.lead.accessLevel, 'view');
  assert.equal((await call(A, 'PATCH', `/api/v1/leads/${again.id}`, { status: 'Won' })).status, 403);
  assert.equal((await call(Admin, 'PUT', `/api/v1/leads/${again.id}/owner`, { ownerUserId: Other.userId })).status, 400, 'owner must be a member');
  const log = await db().get("SELECT metadata_json FROM audit_logs WHERE workspace_id = ? AND action = 'leads.owner_changed' AND resource_id = ?", [Owner.workspaceId, String(again.id)]);
  assert.deepEqual([JSON.parse(log.metadata_json).previous, JSON.parse(log.metadata_json).owner], [A.userId, B.userId]);
});

test('9–11. Excel imports belong to the importer; exports never include leads someone may not see', async () => {
  const imp = await call(A, 'POST', '/api/v1/leads/import-bulk', { leads: [{ name: 'Imp One', email: 'imp.one@corp.io' }, { name: 'Imp Two' }, { name: 'Dup of admin', email: 'admin.prospect@corp.io' }] });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  assert.equal(imp.data.imported, 2);
  assert.equal(imp.data.duplicates[0].leadId, null, 'an admin lead\'s id is not revealed');
  const rows = await db().all(`SELECT owner_user_id, created_by_user_id, lead_source FROM leads WHERE id IN (${imp.data.leadIds.join(',')})`);
  assert.ok(rows.every(r => r.owner_user_id === A.userId && r.created_by_user_id === A.userId && r.lead_source === 'import'));
  for (const id of imp.data.leadIds) {
    assert.equal((await call(B, 'GET', `/api/v1/leads/${id}`)).status, 404);
    assert.equal((await call(Admin, 'GET', `/api/v1/leads/${id}`)).status, 200);
  }
  const adminImp = await call(Owner, 'POST', '/api/v1/leads/import-bulk', { leads: [{ name: 'Owner Imported' }] });
  const ownerLead = adminImp.data.leadIds[0];
  assert.equal((await db().get('SELECT owner_user_id FROM leads WHERE id = ?', [ownerLead])).owner_user_id, Owner.userId);
  assert.equal((await call(A, 'GET', `/api/v1/leads/${ownerLead}`)).status, 404);
  const exp = (await call(A, 'GET', '/api/v1/leads/export')).data.leads.map(l => l.id);
  assert.ok(!exp.includes(ownerLead) && !exp.includes(adminLead.id));
  assert.ok(imp.data.leadIds.every(id => exp.includes(id)));
});

test('12–13. Ids from another workspace are refused, also for its admins', async () => {
  for (const [m, p, b] of [['GET', `/api/v1/leads/${adminLead.id}`], ['PATCH', `/api/v1/leads/${adminLead.id}`, { status: 'Won' }], ['DELETE', `/api/v1/leads/${adminLead.id}`],
    ['GET', `/api/v1/leads/${adminLead.id}/access`], ['PUT', `/api/v1/leads/${adminLead.id}/access`, { userIds: [Other.userId], level: 'view' }], ['PUT', `/api/v1/leads/${adminLead.id}/owner`, { ownerUserId: Other.userId }]]) {
    assert.equal((await call(Other, m, p, b)).status, 404, `${m} ${p}`);
  }
  assert.equal((await call(Admin, 'PUT', `/api/v1/leads/${adminLead.id}/access`, { userIds: [Other.userId], level: 'view' })).status, 400, 'only members of this workspace');
  assert.equal((await call(Other, 'POST', '/api/v1/leads/bulk-owner', { leadIds: [adminLead.id], ownerUserId: Other.userId })).data.changed, 0);
});

test('14. A removed member loses shared access at once', async () => {
  const C = await h.addMember(Owner.workspaceId, 'Member');
  await call(Admin, 'PUT', `/api/v1/leads/${adminLead.id}/access`, { userIds: [C.userId], level: 'manage' });
  assert.equal((await call(C, 'GET', `/api/v1/leads/${adminLead.id}`)).status, 200);
  assert.equal((await call(Owner, 'DELETE', `/api/v1/workspace/members/${C.userId}`)).status, 200);
  assert.ok([401, 403].includes((await call(C, 'GET', `/api/v1/leads/${adminLead.id}`)).status));
  assert.equal(await db().get('SELECT id FROM lead_user_access WHERE user_id = ?', [C.userId]), undefined ?? null);
});

test('15. Dashboards, campaign audiences, outreach and drafts count and pick only visible leads', async () => {
  const mine = (await leads(A)).data.total;
  const dash = await call(A, 'GET', '/api/v1/dashboard/summary');
  if (dash.status === 200 && dash.data.leads) assert.ok(dash.data.leads.length <= mine);
  const picker = await call(A, 'GET', '/api/v1/mail/campaigns/lead-options');
  assert.equal(picker.status, 200, JSON.stringify(picker.data));
  assert.ok(!(picker.data.leads || []).some(l => l.id === adminLead.id), 'campaign lead picker');
  const recips = await call(A, 'GET', '/api/v1/mail/product-emails/recipients');
  if (recips.status === 200) assert.ok(!(recips.data.leads || []).some(l => l.id === adminLead.id), 'product emails');
  const out = await call(A, 'POST', '/api/v1/outreach/audience/preview', { leadIds: [adminLead.id] });
  assert.equal(out.status, 404, 'outreach audience by id');
  const draft = await call(A, 'POST', '/api/v1/drafts/generate', { leadId: adminLead.id, goal: 'Intro' });
  assert.ok([400, 404].includes(draft.status), 'draft for a hidden lead');
});

test('Unassigned (older) leads: only admins see them; admins can hand several to one member', async () => {
  const { run } = db();
  const ins = await run("INSERT INTO leads (workspace_id, name, status, created_at) VALUES (?, 'Legacy One', 'New', UTC_TIMESTAMP()), (?, 'Legacy Two', 'New', UTC_TIMESTAMP())", [Owner.workspaceId, Owner.workspaceId]);
  const legacy = [ins.lastID, ins.lastID + 1];
  assert.ok(ids(await leads(Owner, '&view=unassigned')).includes(legacy[0]));
  assert.ok(!ids(await leads(A)).includes(legacy[0]));
  assert.equal((await call(A, 'POST', '/api/v1/leads/bulk-owner', { leadIds: legacy, ownerUserId: A.userId })).status, 403);
  const r = await call(Admin, 'POST', '/api/v1/leads/bulk-owner', { leadIds: legacy, ownerUserId: A.userId });
  assert.equal(r.data.changed, 2);
  assert.ok(legacy.every(async id => (await call(A, 'GET', `/api/v1/leads/${id}`)).status === 200));
  assert.equal((await call(A, 'GET', `/api/v1/leads/${legacy[1]}`)).status, 200);
});

test('Admins select several leads and assign an owner or share them in one action', async () => {
  const picks = [await create(Owner, 'Bulk One'), await create(Owner, 'Bulk Two'), await create(Owner, 'Bulk Three')].map(l => l.id);
  assert.equal((await call(A, 'POST', '/api/v1/leads/bulk-access', { leadIds: picks, userIds: [A.userId], level: 'manage' })).status, 403, 'members cannot');
  const share = await call(Admin, 'POST', '/api/v1/leads/bulk-access', { leadIds: picks, userIds: [A.userId, B.userId, Owner.userId], level: 'view' });
  assert.equal(share.status, 200, JSON.stringify(share.data));
  assert.equal(share.data.granted, 6, '3 leads × 2 members');
  assert.equal(share.data.skipped, 3, 'the Owner already sees every lead');
  for (const id of picks) assert.equal((await call(B, 'GET', `/api/v1/leads/${id}`)).data.lead.accessLevel, 'view');
  const own = await call(Admin, 'POST', '/api/v1/leads/bulk-owner', { leadIds: picks, ownerUserId: A.userId });
  assert.equal(own.data.changed, 3);
  for (const id of picks) assert.equal((await call(A, 'GET', `/api/v1/leads/${id}`)).data.lead.accessLevel, 'owner', 'owner, and its old share removed');
  assert.equal((await db().get(`SELECT COUNT(*) AS n FROM lead_user_access WHERE user_id = ? AND lead_id IN (${picks.join(',')})`, [A.userId])).n, 0);
});

test('deleting several leads at once: the same rule as one at a time; others are skipped and reported', async () => {
  const a1 = await create(A, 'Bulk One');
  const a2 = await create(A, 'Bulk Two');
  const b1 = await create(B, 'Bulk Bee');
  const o1 = await create(Owner, 'Bulk Owner Lead');
  const otherLead = await create(Other, 'Bulk Elsewhere');
  const del = (who, leadIds) => call(who, 'POST', '/api/v1/leads/bulk-delete', { leadIds });
  // A deletes their own two; B's lead, the owner's lead and another workspace's lead are skipped, untouched.
  const r = await del(A, [a1.id, a2.id, b1.id, o1.id, otherLead.id, 999999999]);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.deleted, 2);
  assert.deepEqual(r.data.deletedIds.sort(), [a1.id, a2.id].sort());
  assert.deepEqual(r.data.skipped.map(s => s.id).sort(), [b1.id, o1.id, otherLead.id, 999999999].sort());
  for (const s of r.data.skipped) assert.equal(s.reason, 'not found', 'what A cannot see is not revealed');
  for (const id of [b1.id, o1.id]) assert.equal((await call(Owner, 'GET', `/api/v1/leads/${id}`)).status, 200, 'still there');
  assert.equal((await call(Other, 'GET', `/api/v1/leads/${otherLead.id}`)).status, 200);
  assert.equal((await call(Owner, 'GET', `/api/v1/leads/${a1.id}`)).status, 404, 'gone');
  // An admin deletes anyone's leads in this workspace.
  const r2 = await del(Admin, [b1.id, o1.id]);
  assert.equal(r2.data.deleted, 2);
  assert.equal(await db().get("SELECT COUNT(*) n FROM audit_logs WHERE action = 'leads.deleted' AND workspace_id = ? AND resource_id IN (?, ?, ?, ?)", [Owner.workspaceId, String(a1.id), String(a2.id), String(b1.id), String(o1.id)]).then(x => x.n), 4, 'each deletion audited');
  // Validation.
  assert.equal((await del(A, [])).status, 400);
  assert.equal((await del(A, Array.from({ length: 501 }, (_, i) => i + 1))).status, 400);
  assert.equal((await del(A, ['x'])).status, 400);
});
