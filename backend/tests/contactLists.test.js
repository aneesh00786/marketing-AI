const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Contact lists, consent and campaign unsubscribes (kept in Marketech.ai). Nothing is sent here.
const db = () => h.db();
process.env.APP_BASE_URL = 'https://app.marketech.test';
process.env.SES_SEND_INLINE = '0';

test.before(async () => { await h.prepareDatabase(); process.env.APP_BASE_URL = 'https://app.marketech.test'; });
test.after(() => h.shutdown());

const capi = (ws, method, p, body) => h.api(method, `/api/v1/mail/campaigns${p}`, { token: ws.token, body });
const lead = (ws, email, consent, method = null, evidence = null) => db().run(`INSERT INTO leads (workspace_id, name, email, status, marketing_consent, marketing_consent_method, marketing_consent_evidence, marketing_consent_obtained_at, created_at, updated_at)
  VALUES (?, ?, ?, 'New', ?, ?, ?, '2026-10-01 09:00:00', UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [ws.workspaceId, email, email, consent, method, evidence]);

test('contact lists: create, add people, view with status and consent, remove, delete; another workspace sees none', async () => {
  const ws = await h.createWorkspace({ name: `Lists ${Date.now()}` });
  await db().run("INSERT INTO email_suppressions (workspace_id, email, reason, source) VALUES (?, 'stop@x.io', 'unsubscribed', 'test')", [ws.workspaceId]);
  const made = await capi(ws, 'POST', '/contact-lists', { name: 'Sydney buyers', emails: ['Stop@X.io', 'not-an-email'], contacts: [{ name: 'Kim Lee', company: 'Shop', email: 'KIM@shop.com.au', phone: '0400' }] });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal(made.data.added, 2);
  assert.deepEqual(made.data.skipped.map(x => x.email), ['not-an-email']);
  assert.equal((await capi(ws, 'POST', '/contact-lists', { name: 'Sydney buyers' })).status, 409, 'names are unique');
  const id = made.data.list.id;
  await lead(ws, 'kim@shop.com.au', 'granted', 'web_form', 'Signed up on the website');
  const again = await capi(ws, 'POST', `/contact-lists/${id}/contacts`, { emails: ['kim@shop.com.au', 'new@x.io'] });
  assert.deepEqual([again.data.added, again.data.alreadyIn], [1, 1]);
  const l = (await capi(ws, 'GET', '/contact-lists')).data.lists.find(x => x.id === id);
  assert.deepEqual([l.total, l.reachable, l.noConsent], [3, 1, 1], 'Kim has consent; new@x.io has none; the stop-list wins for stop@x.io');
  const view = (await capi(ws, 'GET', `/contact-lists/${id}/contacts?status=all`)).data.contacts;
  const kim = view.find(c => c.email === 'kim@shop.com.au');
  assert.deepEqual([kim.name, kim.company, kim.phone, kim.status, kim.consent], ['Kim Lee', 'Shop', '0400', 'subscribed', 'granted']);
  assert.equal(view.find(c => c.email === 'stop@x.io').status, 'unsubscribed');
  assert.equal(view.find(c => c.email === 'new@x.io').consent, 'none');
  assert.equal((await capi(ws, 'POST', `/contact-lists/${id}/remove`, { contactIds: [kim.id] })).data.removed, 1);
  const other = await h.createWorkspace({ name: `Lists other ${Date.now()}` });
  assert.equal((await capi(other, 'GET', `/contact-lists/${id}/contacts`)).status, 404, 'other workspace');
  assert.equal((await capi(ws, 'DELETE', `/contact-lists/${id}`, {})).status, 400, 'needs confirmation');
  assert.equal((await capi(ws, 'DELETE', `/contact-lists/${id}`, { confirm: true })).status, 200);
  assert.equal((await capi(ws, 'GET', '/contact-lists')).data.lists.some(x => x.id === id), false);
  assert.ok(await db().get('SELECT 1 AS x FROM mail_contacts WHERE workspace_id = ? AND email = ?', [ws.workspaceId, 'kim@shop.com.au']), 'people stay in contacts');
});

test('consent: no evidence, unknown and withdrawn are left out; picked leads need consent and the picker says why', async () => {
  const ws = await h.createWorkspace({ name: `Consent ${Date.now()}` });
  for (const [email, consent, method, evidence] of [['granted@shop.io', 'granted', 'web_form', 'Form #1'], ['noevidence@shop.io', 'granted', null, null], ['unknown@shop.io', 'unknown'], ['withdrawn@shop.io', 'withdrawn', 'web_form', 'Form #2']]) {
    await lead(ws, email, consent, method, evidence);
  }
  const listId = (await capi(ws, 'POST', '/contact-lists', { name: 'Mixed', emails: ['granted@shop.io', 'noevidence@shop.io', 'unknown@shop.io', 'withdrawn@shop.io'] })).data.list.id;
  const l = (await capi(ws, 'GET', '/contact-lists')).data.lists.find(x => x.id === listId);
  assert.deepEqual([l.reachable, l.noConsent], [1, 3]);
  const opts = (await capi(ws, 'GET', '/lead-options?q=shop.io')).data.leads;
  assert.equal(opts.find(x => x.email === 'granted@shop.io').eligible, true);
  const cold = opts.find(x => x.email === 'unknown@shop.io');
  assert.equal(cold.eligible, false);
  assert.ok(cold.reasons.some(r => /consent/i.test(r)), JSON.stringify(cold.reasons));
  // A campaign whose list has nobody with consent cannot be approved, with the reason.
  const cold2 = (await capi(ws, 'POST', '/contact-lists', { name: 'Cold', emails: ['unknown@shop.io'] })).data.list.id;
  const c = (await capi(ws, 'POST', '', { name: 'Cold send', subject: 'Hi', fromEmail: 'news@acme-co.io', html: '<p>Hi</p><a href="$[LI:UNSUBSCRIBE]$">Unsubscribe</a>', mailListIds: [cold2] })).data.campaign;
  const v = (await capi(ws, 'POST', `/${c.id}/validate`, {})).data.validation;
  assert.ok(v.problems.some(p => /no recorded marketing consent/.test(p)), JSON.stringify(v.problems));
});

test('campaign unsubscribe link: asks first, then stops the address in every list; a forged link is refused', async () => {
  const ws = await h.createWorkspace({ name: `Unsub ${Date.now()}` });
  await lead(ws, 'ann@shop.io', 'granted', 'web_form', 'Form #3');
  const a = (await capi(ws, 'POST', '/contact-lists', { name: 'A', emails: ['ann@shop.io'] })).data.list.id;
  const b = (await capi(ws, 'POST', '/contact-lists', { name: 'B', emails: ['ann@shop.io'] })).data.list.id;
  const c = (await capi(ws, 'POST', '', { name: 'Unsub test', subject: 'Hi', mailListIds: [a] })).data.campaign;
  const row = await db().get('SELECT * FROM mail_campaigns WHERE id = ?', [c.id]);
  const token = require('../modules/mail/campaigns/campaignService').unsubscribeTokenOf(row);
  const url = `/api/v1/mail/unsubscribe/c/${token}?e=${encodeURIComponent('ann@shop.io')}`;
  const page = await h.api('GET', url);
  assert.equal(page.status, 200);
  assert.match(page.data, /Unsubscribe\?/, 'asks to confirm (link scanners do not unsubscribe anyone)');
  assert.equal((await db().get('SELECT COUNT(*) AS n FROM email_suppressions WHERE workspace_id = ? AND email = ?', [ws.workspaceId, 'ann@shop.io'])).n, 0);
  const done = await h.api('POST', url);
  assert.equal(done.status, 200);
  assert.match(done.data, /You are unsubscribed/);
  assert.ok(await db().get("SELECT 1 AS x FROM email_suppressions WHERE workspace_id = ? AND email = 'ann@shop.io' AND reason = 'unsubscribed'", [ws.workspaceId]));
  for (const id of [a, b]) {
    const m = await db().get('SELECT m.status FROM mail_list_members m JOIN mail_contacts x ON x.id = m.contact_id WHERE m.list_id = ? AND x.email = ?', [id, 'ann@shop.io']);
    assert.equal(m.status, 'unsubscribed', `list ${id}`);
  }
  const forged = `/api/v1/mail/unsubscribe/c/${c.id}-${'0'.repeat(32)}?e=ann%40shop.io`;
  assert.equal((await h.api('GET', forged)).status, 404);
});
