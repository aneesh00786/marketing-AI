const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Email campaigns to chosen contacts of a contact list (migration 065): a chosen list goes to everyone in
// it unless contacts were picked from it, and then only to those who can be emailed. Nothing is sent:
// recipients are only prepared (sesCampaigns.prepare writes who would get it).
const db = () => h.db();
const uid = () => crypto.randomBytes(4).toString('hex');
const api = (who, method, p, body) => h.api(method, `/api/v1/mail/campaigns${p}`, { token: who.token, body });

let W; let OTHER; let LIST; let SECOND; let OTHER_LIST;
const people = {};

async function list(ws, name) {
  return (await db().run('INSERT INTO mail_lists (workspace_id, name) VALUES (?, ?)', [ws, name])).lastID;
}
async function contact(ws, listId, email, { status = 'subscribed', name = null } = {}) {
  const id = (await db().run('INSERT INTO mail_contacts (workspace_id, email, first_name) VALUES (?, ?, ?)', [ws, email, name])).lastID;
  await db().run('INSERT INTO mail_list_members (list_id, contact_id, status) VALUES (?, ?, ?)', [listId, id, status]);
  return id;
}
const recipientsOf = async id => (await db().all('SELECT email FROM mail_campaign_recipients WHERE campaign_id = ? ORDER BY email', [id])).map(r => r.email);

test.before(async () => {
  await h.prepareDatabase();
  W = await h.createWorkspace({ name: 'Picks' });
  OTHER = await h.createWorkspace({ name: 'Picks other' });
  LIST = await list(W.workspaceId, 'Karnataka');
  SECOND = await list(W.workspaceId, 'Kerala');
  OTHER_LIST = await list(OTHER.workspaceId, 'Theirs');
  const s = uid();
  people.asha = await contact(W.workspaceId, LIST, `asha-${s}@client.io`, { name: 'Asha' });
  people.ben = await contact(W.workspaceId, LIST, `ben-${s}@client.io`, { name: 'Ben' });
  people.cy = await contact(W.workspaceId, LIST, `cy-${s}@client.io`, { name: 'Cy' });
  people.gone = await contact(W.workspaceId, LIST, `gone-${s}@client.io`, { status: 'unsubscribed' });
  people.dee = await contact(W.workspaceId, SECOND, `dee-${s}@client.io`, { name: 'Dee' });
  people.theirs = await contact(OTHER.workspaceId, OTHER_LIST, `theirs-${s}@client.io`);
  people.suffix = s;
});
test.after(() => h.shutdown());

test('migration 065 adds the nullable picks column', async () => {
  assert.ok(await db().get("SELECT 1 AS x FROM schema_migrations WHERE id = '065_campaign_list_picks'"));
  const col = await db().get("SELECT IS_NULLABLE AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_campaigns' AND COLUMN_NAME = 'mail_list_picks_json'");
  assert.equal(col.n, 'YES');
});

test('the people of a list to pick from: subscribed only, searchable, with who can be emailed; other workspaces 404', async () => {
  const r = await api(W, 'GET', `/audiences/${LIST}/contacts`);
  assert.equal(r.status, 200);
  assert.equal(r.data.total, 3, 'unsubscribed people are not offered');
  assert.equal(r.data.reachable, 3);
  assert.ok(r.data.contacts.every(c => c.canEmail));
  assert.deepEqual(r.data.reachableIds, [people.asha, people.ben, people.cy].sort((x, y) => x - y), 'Select all covers the whole list');
  assert.equal((await api(W, 'GET', `/audiences/${LIST}/contacts?page=2`)).data.reachableIds, undefined, 'only on the first page');
  const q = await api(W, 'GET', `/audiences/${LIST}/contacts?q=asha`);
  assert.deepEqual(q.data.contacts.map(c => c.name), ['Asha']);
  assert.equal((await api(W, 'GET', `/audiences/${OTHER_LIST}/contacts`)).status, 404);
  const member = await h.addMember(W.workspaceId, 'Approver'); // no mail.compose
  assert.equal((await api(member, 'GET', `/audiences/${LIST}/contacts`)).status, 403);
});

test('picks are saved per chosen list, counted, copied by Duplicate, and dropped with the list or by "Everyone"', async () => {
  const c = await api(W, 'POST', '', { name: `Picks ${uid()}`, mailListIds: [LIST, SECOND], mailListPicks: { [LIST]: [people.ben, people.asha, people.asha] } });
  assert.equal(c.status, 200);
  assert.deepEqual(c.data.campaign.mailListPicks, { [LIST]: [people.asha, people.ben].sort((a, b) => a - b) });
  const lists = Object.fromEntries(c.data.campaign.mailLists.map(l => [l.id, l]));
  assert.equal(lists[LIST].reachable, 2);
  assert.equal(lists[LIST].picked, 2);
  assert.equal(lists[SECOND].reachable, 1, 'a list without picks goes to everyone');
  assert.equal(lists[SECOND].picked, null);
  const id = c.data.campaign.id;

  const copy = await api(W, 'POST', `/${id}/duplicate`);
  assert.deepEqual(copy.data.campaign.mailListPicks, c.data.campaign.mailListPicks);

  // Unticking the list drops its picks.
  const u = await api(W, 'PATCH', `/${id}`, { mailListIds: [SECOND] });
  assert.deepEqual(u.data.campaign.mailListPicks, {});
  // Picks for a list that is not chosen are ignored; "Everyone" (null) clears them.
  const v = await api(W, 'PATCH', `/${id}`, { mailListIds: [LIST], mailListPicks: { [LIST]: [people.cy], [SECOND]: [people.dee] } });
  assert.deepEqual(v.data.campaign.mailListPicks, { [LIST]: [people.cy] });
  const e = await api(W, 'PATCH', `/${id}`, { mailListPicks: null });
  assert.deepEqual(e.data.campaign.mailListPicks, {});
});

test('picks are checked: contacts of another list or workspace are refused, an empty pick is invalid', async () => {
  const c = await api(W, 'POST', '', { name: `Bad ${uid()}`, mailListIds: [LIST] });
  const id = c.data.campaign.id;
  assert.equal((await api(W, 'PATCH', `/${id}`, { mailListIds: [LIST], mailListPicks: { [LIST]: [people.theirs] } })).status, 400);
  assert.equal((await api(W, 'PATCH', `/${id}`, { mailListIds: [LIST], mailListPicks: { [LIST]: [people.dee] } })).status, 400, 'in another list');
  assert.equal((await api(W, 'PATCH', `/${id}`, { mailListIds: [LIST], mailListPicks: { [LIST]: [] } })).status, 400);
  // A mix keeps only the list's own contacts.
  const mix = await api(W, 'PATCH', `/${id}`, { mailListIds: [LIST], mailListPicks: { [LIST]: [people.ben, people.dee] } });
  assert.deepEqual(mix.data.campaign.mailListPicks, { [LIST]: [people.ben] });
});

test('sending goes only to the picked contacts who can be emailed, plus everyone in lists without picks', async () => {
  const c = await api(W, 'POST', '', { name: `Send ${uid()}`, mailListIds: [LIST, SECOND], mailListPicks: { [LIST]: [people.ben, people.cy] } });
  // Cy unsubscribes from the list after being picked: left out.
  await db().run("UPDATE mail_list_members SET status = 'unsubscribed' WHERE list_id = ? AND contact_id = ?", [LIST, people.cy]);
  try {
    const row = await db().get('SELECT * FROM mail_campaigns WHERE id = ?', [c.data.campaign.id]);
    await require('../modules/mail/ses/sesCampaigns').prepare(W.ctx, row);
    const s = people.suffix;
    assert.deepEqual(await recipientsOf(row.id), [`ben-${s}@client.io`, `dee-${s}@client.io`]);
    const v = await api(W, 'POST', `/${row.id}/validate`);
    assert.ok(v.data.validation.warnings.some(w => w.includes('"Karnataka" (2 chosen)')), JSON.stringify(v.data.validation.warnings));
  } finally {
    await db().run("UPDATE mail_list_members SET status = 'subscribed' WHERE list_id = ? AND contact_id = ?", [LIST, people.cy]);
  }
});
