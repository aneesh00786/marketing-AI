const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Global CRM and support. Records are shared across workspaces; access is a per-user grant, never a
// workspace role. Nothing here touches email, AI or any provider.
const db = () => h.db();
let manager;
let sales;
let support;
let viewer;
let outsider;
let seq = 0;

const crm = (user, method, p, body) => h.api(method, `/api/v1/global-crm${p}`, { token: user?.token, body });
const access = () => require('../modules/crm/crmAccess');
const unique = () => `c${++seq}-${Date.now()}@client-co.io`;
const ok = (r, key) => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data[key]; };

const contact = (extra = {}) => crm(manager, 'POST', '/contacts', { fullName: `Person ${++seq}`, email: unique(), ...extra }).then(r => ok(r, 'contact'));
const company = (extra = {}) => crm(manager, 'POST', '/companies', { name: `Company ${++seq}-${Date.now()}`, ...extra }).then(r => ok(r, 'company'));
const deal = (extra = {}) => crm(manager, 'POST', '/deals', { name: `Deal ${++seq}`, ...extra }).then(r => ok(r, 'deal'));
const ticket = (extra = {}) => crm(manager, 'POST', '/tickets', { subject: `Issue ${++seq}`, description: 'It broke', ...extra }).then(r => ok(r, 'ticket'));

async function staff(role) {
  const w = await h.createWorkspace({ name: `CRM ${role}` });
  await access().grant(w.userId, role);
  return w;
}

test.before(async () => {
  await h.prepareDatabase();
  manager = await staff('manager');
  sales = await staff('sales');
  support = await staff('support');
  viewer = await staff('viewer');
  outsider = await h.createWorkspace({ name: 'No CRM' });
});
test.after(() => h.shutdown());

// ------------------------------------------------------------------ access

test('being a Workspace Owner gives no CRM access: every route refuses, and /me says so', async () => {
  assert.deepEqual((await crm(outsider, 'GET', '/me')).data, { success: true, access: null });
  for (const [method, p] of [['GET', '/overview'], ['GET', '/team'], ['GET', '/contacts'], ['POST', '/contacts'], ['GET', '/companies'], ['GET', '/deals'], ['GET', '/tickets'], ['POST', '/tickets'], ['PATCH', '/activities/1']]) {
    const r = await crm(outsider, method, p, method === 'GET' ? undefined : {});
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.equal(r.data.code, 'CRM_ACCESS_REQUIRED');
  }
});

test('every CRM route needs a signed-in user', async () => {
  for (const p of ['/me', '/overview', '/contacts', '/tickets']) assert.equal((await crm(null, 'GET', p)).status, 401, p);
  assert.equal((await h.api('GET', '/api/v1/global-crm/contacts', { token: 'not-a-token' })).status, 401);
});

test('no workspace role anywhere includes a CRM permission', () => {
  const { ROLE_CAPABILITIES, CAPABILITIES } = require('../lib/permissions');
  for (const caps of [...Object.values(ROLE_CAPABILITIES), CAPABILITIES]) assert.ok(!caps.some(c => c.startsWith('crm.')));
});

test('the workspace plays no part: the same grant and data from any workspace, and a second member gets nothing', async () => {
  const c = await contact();
  const inSameWorkspace = await h.addMember(manager.workspaceId, 'Workspace Admin');
  assert.equal((await crm(inSameWorkspace, 'GET', '/contacts')).status, 403, 'an admin of the same workspace has no access');
  const { createToken } = require('../services/authService');
  const other = await h.createWorkspace({ name: 'Second workspace' });
  await db().run("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES (?, ?, 'Member', 'Active')", [other.workspaceId, manager.userId]);
  const token = createToken({ userId: manager.userId, workspaceId: other.workspaceId, email: manager.email, role: 'Member' });
  assert.equal((await crm({ token }, 'GET', `/contacts/${c.id}`)).data.contact.id, c.id);
  assert.equal((await crm({ token }, 'GET', '/me')).data.access.role, 'manager');
});

test('the platform admin (Owner of workspace 1) has full access with no grant; nobody else does through a workspace', async () => {
  await db().run("INSERT IGNORE INTO workspaces (id, name, slug, owner_email, plan, status, created_at) VALUES (1, 'Platform', 'platform-test', 'owner@example.test', 'Starter', 'Active', UTC_TIMESTAMP())");
  const { createToken } = require('../services/authService');
  const person = await h.createWorkspace({ name: 'Becomes admin' });
  const asPlatformMember = async role => {
    await db().run("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES (1, ?, ?, 'Active') ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'Active'", [person.userId, role]);
  };
  assert.equal((await crm(person, 'GET', '/contacts')).status, 403, 'owner of their own workspace only');
  for (const role of ['Workspace Admin', 'Member', 'Marketing Manager']) {
    await asPlatformMember(role);
    assert.equal((await crm(person, 'GET', '/contacts')).status, 403, `${role} of workspace 1`);
  }
  await asPlatformMember('Workspace Owner');
  const me = (await crm(person, 'GET', '/me')).data.access;
  assert.deepEqual([me.role, me.platformAdmin, me.capabilities], ['manager', true, ['crm.view', 'crm.manage', 'crm.deals', 'crm.support']]);
  assert.equal((await crm(person, 'POST', '/contacts', { fullName: `Admin made ${++seq}` })).status, 200);
  assert.equal((await crm(person, 'POST', '/deals', { name: 'Admin deal' })).status, 200);
  assert.equal((await crm(person, 'POST', '/tickets', { subject: 'x', description: 'y' })).status, 200);
  assert.equal(await db().get('SELECT 1 AS x FROM crm_user_access WHERE user_id = ?', [person.userId]) ?? null, null, 'no grant was needed');
  assert.ok((await crm(manager, 'GET', '/team')).data.team.some(t => t.id === person.userId), 'can be assigned work');
  assert.equal((await crm(manager, 'POST', '/deals', { name: 'For admin', assignedTo: person.userId })).status, 200);
  const elsewhere = createToken({ userId: person.userId, workspaceId: person.workspaceId, email: person.email, role: 'Workspace Owner' });
  assert.equal((await crm({ token: elsewhere }, 'GET', '/contacts')).status, 200, 'signed in to any of their workspaces');
  assert.equal(await access().revoke(person.userId), false);
  await db().run("UPDATE workspace_members SET status = 'Removed' WHERE workspace_id = 1 AND user_id = ?", [person.userId]);
  assert.equal((await crm(person, 'GET', '/contacts')).status, 403, 'removed as Owner, access ends at once');
});

test('an email address never grants admin access: registering the admin address gives nothing', async () => {
  const r = await h.api('POST', '/api/v1/auth/register', { body: { email: `ADMIN+${Date.now()}@tradesage.ai`, password: 'correct-horse-battery', name: 'Impostor' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await h.api('GET', '/api/v1/global-crm/contacts', { token: r.data.token })).status, 403);
});

test('removing access takes effect on the next request, and an unknown role grants nothing', async () => {
  const u = await staff('viewer');
  assert.equal((await crm(u, 'GET', '/contacts')).status, 200);
  assert.equal(await access().revoke(u.userId), true);
  assert.equal((await crm(u, 'GET', '/contacts')).status, 403);
  await db().run("INSERT INTO crm_user_access (user_id, role) VALUES (?, 'owner')", [u.userId]);
  assert.equal((await crm(u, 'GET', '/contacts')).status, 403);
  await assert.rejects(access().grant(u.userId, 'god'), /Unknown CRM role/);
});

test('roles: viewers read only; sales has no tickets; support has no deals', async () => {
  const c = await contact();
  const co = await company();
  const d = await deal();
  const t = await ticket();
  for (const p of ['/overview', '/team', '/contacts', `/contacts/${c.id}`, `/contacts/${c.id}/activities`, '/companies', `/companies/${co.id}`, `/companies/${co.id}/activities`, '/deals', `/deals/${d.id}`, `/deals/${d.id}/activities`, '/tickets', `/tickets/${t.id}`, `/tickets/${t.id}/activities`]) {
    assert.equal((await crm(viewer, 'GET', p)).status, 200, p);
  }
  const note = { type: 'note', body: 'x' };
  const writes = {
    contacts: [['POST', '/contacts', { fullName: 'x' }], ['PATCH', `/contacts/${c.id}`, { notes: 'x' }], ['POST', `/contacts/${c.id}/activities`, note], ['POST', '/companies', { name: 'x' }], ['PATCH', `/companies/${co.id}`, { notes: 'x' }], ['POST', `/companies/${co.id}/activities`, note]],
    deals: [['POST', '/deals', { name: 'x' }], ['PATCH', `/deals/${d.id}`, { stage: 'Won' }], ['DELETE', `/deals/${d.id}`], ['POST', `/deals/${d.id}/activities`, note]],
    tickets: [['POST', '/tickets', { subject: 'x', description: 'y' }], ['PATCH', `/tickets/${t.id}`, { status: 'Closed' }], ['POST', `/tickets/${t.id}/activities`, note]]
  };
  for (const list of Object.values(writes)) for (const [m, p, b] of list) assert.equal((await crm(viewer, m, p, b)).status, 403, `viewer ${m} ${p}`);
  for (const [m, p, b] of writes.tickets) assert.equal((await crm(sales, m, p, b)).status, 403, `sales ${m} ${p}`);
  for (const [m, p, b] of writes.deals) assert.equal((await crm(support, m, p, b)).status, 403, `support ${m} ${p}`);
  assert.equal((await crm(sales, 'POST', '/deals', { name: 'mine' })).status, 200);
  assert.equal((await crm(support, 'POST', '/tickets', { subject: 'mine', description: 'y' })).status, 200);
  for (const u of [sales, support]) assert.equal((await crm(u, 'POST', '/contacts', { fullName: `Staff ${++seq}` })).status, 200);
});

test('a task can only be completed with the permission for its record', async () => {
  const t = await ticket();
  const task = ok(await crm(manager, 'POST', `/tickets/${t.id}/activities`, { type: 'task', body: 'Call back' }), 'activity');
  assert.equal((await crm(sales, 'PATCH', `/activities/${task.id}`, { done: true })).status, 403);
  assert.equal((await crm(viewer, 'PATCH', `/activities/${task.id}`, { done: true })).status, 403);
  assert.equal(ok(await crm(support, 'PATCH', `/activities/${task.id}`, { done: true }), 'activity').done, true);
});

test('audit entries belong to no workspace, so a workspace admin never sees CRM activity', async () => {
  const c = await contact();
  const row = await db().get("SELECT workspace_id, actor_user_id FROM audit_logs WHERE action = 'crm.contact_created' AND resource_id = ? ORDER BY id DESC LIMIT 1", [String(c.id)]);
  assert.deepEqual([row.workspace_id, row.actor_user_id], [null, manager.userId]);
});

// ------------------------------------------------------------------ separation from Leads

test('the CRM and Leads are separate: neither sees or changes the other', async () => {
  const leads = await db().get('SELECT COUNT(*) AS n FROM leads');
  const email = unique();
  const lead = (await h.api('POST', '/api/v1/leads', { token: manager.token, body: { name: 'A lead', email } })).data.lead;
  assert.equal((await crm(manager, 'GET', `/contacts?q=${encodeURIComponent(email)}`)).data.total, 0, 'leads are not contacts');
  await contact({ email, fullName: 'Same address, separate record' });
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM leads')).n), Number(leads.n) + 1, 'no lead was created');
  assert.equal((await h.api('GET', `/api/v1/crm/leads/${lead.id}`, { token: manager.token })).status, 200, 'the /crm/leads alias of the Leads API is unchanged');
  const cols = await db().all("SELECT TABLE_NAME AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'crm\\_%' AND COLUMN_NAME = 'workspace_id'");
  assert.deepEqual(cols, [], 'no CRM table has a workspace_id');
  const leadCols = await db().all("SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND COLUMN_NAME = 'assigned_to'");
  assert.deepEqual(leadCols, [], 'the leads table is unchanged');
});

test('existing /api/v1/crm routes are not intercepted, for users with or without a CRM grant', async () => {
  const lead = (await h.api('POST', '/api/v1/leads', { token: outsider.token, body: { name: 'Mine' } })).data.lead;
  assert.equal((await h.api('GET', `/api/v1/crm/leads/${lead.id}`, { token: outsider.token })).status, 200, 'the Leads alias works without a CRM grant');
  for (const user of [outsider, manager]) {
    const r = await h.api('GET', '/api/v1/crm/appointments', { token: user.token });
    assert.notEqual(r.data.code, 'CRM_ACCESS_REQUIRED');
  }
});

test('the CRM code does not read workspace tables or the session workspace', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '../modules/crm');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/\b(FROM|JOIN|INTO|UPDATE)\s+(leads|emails|email_drafts|mail_\w+|email_suppressions)\b/i.test(src), f);
    assert.ok(!/leadService|mail\/|emailService/.test(src), f);
    if (f !== 'crmAccess.js') assert.ok(!/workspaceId/.test(src), f);
  }
});

// ------------------------------------------------------------------ contacts

test('contacts: create, edit, view, with company, status, assignee and notes', async () => {
  const co = await company({ name: `Acme ${Date.now()}` });
  const c = await contact({ fullName: 'Ann Lee', phone: '+1 (555) 010-0100', companyId: co.id, status: 'Customer', assignedTo: sales.userId, notes: 'Met at the expo' });
  assert.deepEqual([c.fullName, c.phone, c.companyId, c.companyName, c.status, c.assignedTo, c.notes], ['Ann Lee', '+1 (555) 010-0100', co.id, co.name, 'Customer', sales.userId, 'Met at the expo']);
  assert.ok(c.assigneeName);
  assert.ok(c.createdAt);
  const edited = ok(await crm(manager, 'PATCH', `/contacts/${c.id}`, { fullName: 'Ann Lee-Smith', status: 'Inactive', assignedTo: null, companyId: null, phone: '', notes: '' }), 'contact');
  assert.deepEqual([edited.fullName, edited.status, edited.assignedTo, edited.companyId, edited.phone, edited.notes], ['Ann Lee-Smith', 'Inactive', null, null, null, null]);
  const bare = await contact({ email: null, fullName: 'No email person' });
  assert.deepEqual([bare.email, bare.status], [null, 'Prospect']);
});

test('the contact page shows its deals and tickets', async () => {
  const c = await contact();
  const d = await deal({ contactId: c.id });
  const t = await ticket({ contactId: c.id });
  const r = (await crm(viewer, 'GET', `/contacts/${c.id}`)).data;
  assert.deepEqual([r.deals.map(x => x.id), r.tickets.map(x => x.id)], [[d.id], [t.id]]);
});

test('invalid contacts are refused', async () => {
  for (const body of [{ email: unique() }, { fullName: '   ' }, { fullName: 'X', email: 'nope' }, { fullName: 'X', status: 'Nonsense' }, { fullName: 'X', assignedTo: 'me' }, { fullName: 'X', workspaceId: 1 }, { fullName: 'X', fullname: 'y' }]) {
    assert.equal((await crm(manager, 'POST', '/contacts', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await crm(manager, 'POST', '/contacts', { fullName: 'X', companyId: 99999999 })).data.code, 'INVALID_COMPANY');
  assert.equal((await crm(manager, 'POST', '/contacts', { fullName: 'X', assignedTo: outsider.userId })).data.code, 'INVALID_ASSIGNEE', 'only CRM users can be assigned');
  assert.equal((await crm(manager, 'GET', '/contacts/abc')).status, 400);
  assert.equal((await crm(manager, 'GET', '/contacts/99999999')).status, 404);
});

test('duplicates: same email or phone is flagged, the user may save anyway, and nothing is merged', async () => {
  const email = unique();
  const phone = `+44 20 ${Date.now() % 100000000}`;
  const first = await contact({ email, phone });
  const dup = await crm(manager, 'POST', '/contacts', { fullName: 'Again', email: email.toUpperCase() });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, 'DUPLICATE_CONTACT');
  assert.deepEqual(dup.data.details.matches.map(m => m.id), [first.id]);
  const byPhone = await crm(manager, 'POST', '/contacts', { fullName: 'Again', phone: phone.replace(/\s/g, '-') });
  assert.equal(byPhone.status, 409, 'the same digits, written differently');
  const saved = ok(await crm(manager, 'POST', '/contacts', { fullName: 'Shared inbox', email, allowDuplicate: true }), 'contact');
  assert.notEqual(saved.id, first.id);
  assert.equal(ok(await crm(manager, 'GET', `/contacts/${first.id}`), 'contact').fullName, first.fullName);
});

test('phone numbers need a country code, on contacts and companies; the same digits in another country are a different number', async () => {
  for (const phone of ['9876543210', '98765', '+91', '+0 98765 43210', '+91 abc', '+1234567890123456', '91 98765 43210']) {
    assert.equal((await crm(manager, 'POST', '/contacts', { fullName: 'X', phone })).status, 400, `contact ${phone}`);
    assert.equal((await crm(manager, 'POST', '/companies', { name: `Co ${++seq}`, phone })).status, 400, `company ${phone}`);
  }
  const local = `98${String(Date.now()).slice(-8)}`;
  const india = await contact({ email: null, phone: `+91 ${local}` });
  assert.equal(india.phone, `+91 ${local}`);
  await contact({ email: null, phone: `+971 ${local}` });
  assert.equal((await crm(manager, 'POST', '/contacts', { fullName: 'Same', phone: `+91-${local}` })).status, 409, 'same code and number');
  assert.equal((await crm(manager, 'POST', '/contacts', { fullName: 'Blank', phone: '' })).status, 200, 'a phone is optional');
});

test('people without an email or phone are never treated as duplicates, and same-name is not a match', async () => {
  const name = `Common Name ${Date.now()}`;
  await contact({ fullName: name, email: null });
  await contact({ fullName: name, email: null });
});

test('an unchanged duplicate does not block other edits; changing to a duplicate address does', async () => {
  const email = unique();
  await contact({ email });
  const twin = ok(await crm(manager, 'POST', '/contacts', { fullName: 'Twin', email, allowDuplicate: true }), 'contact');
  assert.equal((await crm(manager, 'PATCH', `/contacts/${twin.id}`, { email, notes: 'edit' })).status, 200);
  const other = await contact();
  assert.equal((await crm(manager, 'PATCH', `/contacts/${other.id}`, { email })).status, 409);
  assert.equal((await crm(manager, 'PATCH', `/contacts/${other.id}`, { email, allowDuplicate: true })).status, 200);
});

test('the contact list searches, filters and pages', async () => {
  const mark = `Zzq${Date.now()}`;
  const co = await company({ name: `${mark} Ltd` });
  await contact({ fullName: `${mark} One`, status: 'Customer', assignedTo: support.userId });
  await contact({ fullName: 'Other', companyId: co.id });
  const list = q => crm(viewer, 'GET', `/contacts?${q}`).then(r => r.data);
  assert.equal((await list(`q=${mark}`)).total, 2, 'by name and by company');
  assert.equal((await list(`q=${mark}&status=Customer`)).total, 1);
  assert.equal((await list(`q=${mark}&assignedTo=${support.userId}`)).total, 1);
  assert.equal((await list(`q=${mark}&assignedTo=none`)).total, 1);
  assert.equal((await list(`q=${mark}&limit=1&page=2`)).contacts.length, 1);
  assert.equal((await list('q=%25')).contacts.every(c => c.fullName.includes('%')), true, 'a % is searched for, not a wildcard');
  assert.deepEqual((await list('')).statuses, ['Prospect', 'Customer', 'Inactive']);
});

// ------------------------------------------------------------------ companies

test('companies: create, edit, search and view with contacts, deals and tickets', async () => {
  const name = `Northwind ${Date.now()}`;
  const co = await company({ name, website: 'northwind.io', industry: 'Retail', email: 'hi@northwind.io', phone: '+1 555 010 0100', notes: 'Key account' });
  assert.deepEqual([co.website, co.industry, co.email, co.phone, co.notes], ['https://northwind.io', 'Retail', 'hi@northwind.io', '+1 555 010 0100', 'Key account']);
  const up = ok(await crm(manager, 'PATCH', `/companies/${co.id}`, { industry: 'Food', notes: '' }), 'company');
  assert.deepEqual([up.industry, up.notes, up.name], ['Food', null, name]);
  const c = await contact({ companyId: co.id });
  const d = await deal({ companyId: co.id });
  const t = await ticket({ companyId: co.id });
  const view = (await crm(viewer, 'GET', `/companies/${co.id}`)).data;
  assert.equal(view.company.contactCount, 1);
  assert.deepEqual([view.contacts.map(x => x.id), view.deals.map(x => x.id), view.tickets.map(x => x.id)], [[c.id], [d.id], [t.id]]);
  assert.deepEqual((await crm(viewer, 'GET', `/companies?q=${encodeURIComponent(name)}`)).data.companies.map(x => x.id), [co.id]);
});

test('invalid companies are refused; names are unique; only web addresses are accepted', async () => {
  const name = `Unique ${Date.now()}`;
  const co = await company({ name });
  assert.equal((await crm(manager, 'POST', '/companies', { name: name.toUpperCase() })).data.code, 'DUPLICATE_COMPANY');
  const other = await company();
  assert.equal((await crm(manager, 'PATCH', `/companies/${other.id}`, { name })).data.code, 'DUPLICATE_COMPANY');
  for (const website of ['javascript:alert(1)', 'data:text/html,x', 'not a site']) {
    assert.equal((await crm(manager, 'POST', '/companies', { name: `Bad ${++seq}`, website })).status, 400, website);
  }
  assert.equal((await crm(manager, 'POST', '/companies', { name: '' })).status, 400);
  assert.equal((await crm(manager, 'POST', '/companies', { name: 'X', email: 'nope' })).status, 400);
  assert.ok(co.id);
});

// ------------------------------------------------------------------ deals

test('deals: created at New, with the contact\'s company unless one is chosen', async () => {
  const co = await company();
  const c = await contact({ companyId: co.id });
  const d = await deal({ name: 'Licence', contactId: c.id, value: 12500.5, assignedTo: sales.userId, expectedCloseDate: '2026-12-31', notes: 'Renewal' });
  assert.deepEqual([d.stage, d.value, d.contactName, d.companyId, d.companyName, d.expectedCloseDate, d.notes], ['New', 12500.5, c.fullName, co.id, co.name, '2026-12-31', 'Renewal']);
  assert.equal((await deal({ contactId: c.id, companyId: null })).companyId, null, 'an explicit none is kept');
  assert.equal((await deal()).value, null);
});

test('invalid deals are refused', async () => {
  for (const body of [{ value: 5 }, { name: 'D', value: -1 }, { name: 'D', value: '5' }, { name: 'D', stage: 'Maybe' }, { name: 'D', expectedCloseDate: '2026-02-31' }]) {
    assert.equal((await crm(manager, 'POST', '/deals', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await crm(manager, 'POST', '/deals', { name: 'D', contactId: 99999999 })).data.code, 'INVALID_CONTACT');
  assert.equal((await crm(manager, 'POST', '/deals', { name: 'D', companyId: 99999999 })).data.code, 'INVALID_COMPANY');
  const d = await deal();
  assert.equal((await crm(manager, 'PATCH', `/deals/${d.id}`, { contactId: 99999999 })).status, 400);
});

test('moving a deal through the stages is recorded in its history and the audit log', async () => {
  const d = await deal();
  for (const stage of ['Contacted', 'Qualified', 'Proposal', 'Won', 'Lost', 'New']) assert.equal(ok(await crm(sales, 'PATCH', `/deals/${d.id}`, { stage }), 'deal').stage, stage);
  assert.equal((await crm(manager, 'PATCH', `/deals/${d.id}`, { stage: 'Nope' })).status, 400);
  const history = (await crm(viewer, 'GET', `/deals/${d.id}/activities`)).data.activities;
  assert.deepEqual([history.length, history[0].type, history[0].body], [6, 'change', 'Stage changed from New to Contacted.']);
  assert.equal(Number((await db().get("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'crm.deal_stage_changed' AND resource_id = ?", [String(d.id)])).n), 6);
  await crm(manager, 'PATCH', `/deals/${d.id}`, { stage: 'New', name: 'Renamed' });
  assert.equal((await crm(viewer, 'GET', `/deals/${d.id}/activities`)).data.activities.length, 6, 'no change, no entry');
});

test('the deal list filters; deleting a deal removes its activities', async () => {
  const mark = `Dq${Date.now()}`;
  const d = await deal({ name: `${mark} one`, stage: 'Proposal' });
  await deal({ name: `${mark} two` });
  assert.equal((await crm(viewer, 'GET', `/deals?q=${mark}`)).data.deals.length, 2);
  assert.equal((await crm(viewer, 'GET', `/deals?q=${mark}&stage=Proposal`)).data.deals.length, 1);
  assert.deepEqual((await crm(viewer, 'GET', '/deals')).data.stages, ['New', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost']);
  await crm(manager, 'POST', `/deals/${d.id}/activities`, { type: 'note', body: 'x' });
  assert.equal((await crm(manager, 'DELETE', `/deals/${d.id}`)).status, 200);
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM crm_activities WHERE deal_id = ?', [d.id])).n), 0);
});

// ------------------------------------------------------------------ activities

test('notes and tasks on each kind of record, oldest first, with type, date, author and follow-up date', async () => {
  const records = [['contacts', await contact()], ['companies', await company()], ['deals', await deal()], ['tickets', await ticket()]];
  for (const [parent, rec] of records) {
    const note = ok(await crm(manager, 'POST', `/${parent}/${rec.id}/activities`, { type: 'note', body: 'First' }), 'activity');
    const task = ok(await crm(manager, 'POST', `/${parent}/${rec.id}/activities`, { type: 'task', body: 'Second', dueDate: '2026-11-15' }), 'activity');
    const list = (await crm(viewer, 'GET', `/${parent}/${rec.id}/activities`)).data.activities;
    assert.deepEqual(list.map(a => [a.type, a.body, a.dueDate, a.done]), [['note', 'First', null, false], ['task', 'Second', '2026-11-15', false]], parent);
    assert.ok(list[0].createdBy && list[0].createdAt);
    assert.equal(ok(await crm(manager, 'PATCH', `/activities/${task.id}`, { done: true }), 'activity').done, true);
    assert.equal((await crm(manager, 'PATCH', `/activities/${note.id}`, { done: true })).status, 400, 'a note is not a task');
  }
});

test('invalid activities are refused, and the system type cannot be written by a user', async () => {
  const c = await contact();
  for (const body of [{ type: 'note', body: '   ' }, { type: 'email', body: 'x' }, { type: 'change', body: 'x' }, { type: 'note', body: 'x', dueDate: '2026-11-15' }, { type: 'task', body: 'x', dueDate: 'soon' }]) {
    assert.equal((await crm(manager, 'POST', `/contacts/${c.id}/activities`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await crm(manager, 'POST', '/contacts/99999999/activities', { type: 'note', body: 'x' })).status, 404);
  assert.equal((await crm(manager, 'PATCH', '/activities/99999999', { done: true })).status, 404);
});

test('record integrity: deleting a contact or company keeps deals and tickets; deleting a user keeps records', async () => {
  const co = await company();
  const c = await contact({ companyId: co.id });
  const d = await deal({ contactId: c.id });
  const t = await ticket({ contactId: c.id });
  await crm(manager, 'POST', `/contacts/${c.id}/activities`, { type: 'note', body: 'x' });
  await db().run('DELETE FROM crm_contacts WHERE id = ?', [c.id]);
  assert.equal(ok(await crm(manager, 'GET', `/deals/${d.id}`), 'deal').contactId, null);
  assert.equal(ok(await crm(manager, 'GET', `/tickets/${t.id}`), 'ticket').contactId, null);
  assert.equal(Number((await db().get('SELECT COUNT(*) AS n FROM crm_activities WHERE contact_id = ?', [c.id])).n), 0);
  await db().run('DELETE FROM crm_companies WHERE id = ?', [co.id]);
  assert.equal(ok(await crm(manager, 'GET', `/deals/${d.id}`), 'deal').companyId, null);
  const u = await staff('sales');
  const owned = await deal({ assignedTo: u.userId });
  await db().run('DELETE FROM workspace_members WHERE user_id = ?', [u.userId]);
  await db().run('DELETE FROM users WHERE id = ?', [u.userId]);
  assert.equal(ok(await crm(manager, 'GET', `/deals/${owned.id}`), 'deal').assignedTo, null);
  assert.equal(await db().get('SELECT 1 AS x FROM crm_user_access WHERE user_id = ?', [u.userId]) ?? null, null);
});

test('former team members do not block other edits, but cannot be newly assigned', async () => {
  const u = await staff('sales');
  const c = await contact({ assignedTo: u.userId });
  const d = await deal({ assignedTo: u.userId });
  const t = await ticket({ assignedTo: u.userId });
  await access().revoke(u.userId);
  assert.equal((await crm(manager, 'PATCH', `/contacts/${c.id}`, { assignedTo: u.userId, notes: 'x' })).status, 200);
  assert.equal((await crm(manager, 'PATCH', `/deals/${d.id}`, { assignedTo: u.userId, name: 'x' })).status, 200);
  assert.equal((await crm(manager, 'PATCH', `/tickets/${t.id}`, { assignedTo: u.userId, subject: 'x' })).status, 200);
  assert.equal((await crm(manager, 'POST', '/deals', { name: 'x', assignedTo: u.userId })).data.code, 'INVALID_ASSIGNEE');
  assert.ok(!(await crm(manager, 'GET', '/team')).data.team.some(m => m.id === u.userId));
});

// ------------------------------------------------------------------ support

test('tickets: created Open and Medium, linked to a contact and its company', async () => {
  const co = await company();
  const c = await contact({ companyId: co.id, phone: `+1 555 ${Date.now() % 10000000}` });
  const t = await ticket({ subject: 'Login fails', description: 'Error 500 at login', contactId: c.id, assignedTo: support.userId });
  assert.deepEqual([t.status, t.priority, t.contactName, t.contactEmail, t.contactPhone, t.companyId, t.companyName], ['Open', 'Medium', c.fullName, c.email, c.phone, co.id, co.name]);
  assert.ok(t.assigneeName);
  assert.ok(t.createdBy);
  assert.equal((await ticket({ priority: 'High' })).priority, 'High');
  assert.equal((await ticket({ contactId: c.id, companyId: null })).companyId, null);
});

test('invalid tickets are refused', async () => {
  for (const body of [{ description: 'x' }, { subject: 'x' }, { subject: ' ', description: 'x' }, { subject: 'x', description: 'y', priority: 'Urgent' }, { subject: 'x', description: 'y', status: 'Waiting' }]) {
    assert.equal((await crm(manager, 'POST', '/tickets', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await crm(manager, 'POST', '/tickets', { subject: 'x', description: 'y', contactId: 99999999 })).data.code, 'INVALID_CONTACT');
  assert.equal((await crm(manager, 'POST', '/tickets', { subject: 'x', description: 'y', assignedTo: outsider.userId })).data.code, 'INVALID_ASSIGNEE');
  assert.equal((await crm(manager, 'GET', '/tickets/99999999')).status, 404);
});

test('status, priority and assignment updates are saved and appear in the ticket history', async () => {
  const t = await ticket();
  for (const status of ['In Progress', 'Resolved', 'Closed', 'Open']) assert.equal(ok(await crm(support, 'PATCH', `/tickets/${t.id}`, { status }), 'ticket').status, status);
  assert.equal(ok(await crm(support, 'PATCH', `/tickets/${t.id}`, { priority: 'High' }), 'ticket').priority, 'High');
  assert.equal(ok(await crm(support, 'PATCH', `/tickets/${t.id}`, { assignedTo: support.userId }), 'ticket').assignedTo, support.userId);
  await crm(support, 'PATCH', `/tickets/${t.id}`, { assignedTo: null });
  await crm(support, 'POST', `/tickets/${t.id}/activities`, { type: 'note', body: 'Customer called back' });
  const bodies = (await crm(viewer, 'GET', `/tickets/${t.id}/activities`)).data.activities.map(a => a.body);
  assert.deepEqual(bodies.slice(0, 5), ['Status changed from Open to In Progress.', 'Status changed from In Progress to Resolved.', 'Status changed from Resolved to Closed.', 'Status changed from Closed to Open.', 'Priority changed from Medium to High.']);
  assert.match(bodies[5], /^Assigned to /);
  assert.deepEqual(bodies.slice(6), ['Unassigned.', 'Customer called back']);
  await crm(support, 'PATCH', `/tickets/${t.id}`, { status: 'Open', priority: 'High' });
  assert.equal((await crm(viewer, 'GET', `/tickets/${t.id}/activities`)).data.activities.length, 8, 'no change, no entry');
  for (const body of [{ status: 'Waiting' }, { priority: 'Urgent' }, { assignedTo: outsider.userId }, { subject: '' }]) assert.equal((await crm(support, 'PATCH', `/tickets/${t.id}`, body)).status, 400, JSON.stringify(body));
});

test('the ticket list filters', async () => {
  const mark = `Tq${Date.now()}`;
  await ticket({ subject: `${mark} one`, priority: 'High', status: 'In Progress', assignedTo: support.userId });
  await ticket({ subject: `${mark} two`, priority: 'Low' });
  const list = q => crm(viewer, 'GET', `/tickets?q=${mark}${q}`).then(r => r.data);
  assert.equal((await list('')).tickets.length, 2);
  assert.equal((await list('&priority=High')).tickets.length, 1);
  assert.equal((await list('&status=In%20Progress')).tickets.length, 1);
  assert.equal((await list(`&assignedTo=${support.userId}`)).tickets.length, 1);
  assert.equal((await list('&assignedTo=none')).tickets.length, 1);
  assert.deepEqual([(await list('')).statuses, (await list('')).priorities], [['Open', 'In Progress', 'Resolved', 'Closed'], ['Low', 'Medium', 'High']]);
});

// ------------------------------------------------------------------ dashboard

test('the dashboard counts real data: closed deals and tickets are left out', async () => {
  const before = (await crm(viewer, 'GET', '/overview')).data;
  await contact();
  await company();
  await deal({ value: 1000 });
  await deal({ value: 250.5, stage: 'Proposal' });
  await deal({ value: 5000, stage: 'Won' });
  await deal({ value: 7000, stage: 'Lost' });
  await ticket();
  await ticket({ status: 'In Progress' });
  await ticket({ status: 'Resolved' });
  await ticket({ status: 'Closed' });
  const c = await contact();
  await crm(manager, 'POST', `/contacts/${c.id}/activities`, { type: 'note', body: 'Newest note' });
  const o = (await crm(viewer, 'GET', '/overview')).data;
  assert.equal(o.totalContacts, before.totalContacts + 2);
  assert.equal(o.totalCompanies, before.totalCompanies + 1);
  assert.equal(o.activeDeals, before.activeDeals + 2);
  assert.equal(o.pipelineValue, before.pipelineValue + 1250.5);
  assert.equal(o.openTickets, before.openTickets + 2);
  assert.deepEqual([o.recentActivities[0].body, o.recentActivities[0].subject, o.recentActivities[0].contactId], ['Newest note', c.fullName, c.id]);
  assert.ok(o.recentActivities.length <= 8);
});

test('the access script grants, lists and revokes', async () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const u = await h.createWorkspace({ name: 'Script user' });
  const run = (...args) => spawnSync('node', ['scripts/crmAccess.js', ...args], { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: process.env });
  assert.match(run('grant', u.email, 'support').stdout, /now has CRM access as support/);
  assert.equal((await crm(u, 'GET', '/contacts')).status, 200);
  assert.match(run('list').stdout, new RegExp(`${u.email}\\s+support`));
  assert.equal(run('grant', u.email, 'owner').status, 1);
  assert.equal(run('grant', 'nobody@nowhere.test', 'viewer').status, 1);
  assert.match(run('revoke', u.email).stdout, /no longer has CRM access/);
  assert.equal((await crm(u, 'GET', '/contacts')).status, 403);
  const log = await db().get("SELECT workspace_id, actor_type FROM audit_logs WHERE action = 'crm.access_granted' AND resource_id = ? LIMIT 1", [String(u.userId)]);
  assert.deepEqual([log.workspace_id, log.actor_type], [null, 'system']);
});
