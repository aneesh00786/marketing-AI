const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { phoneProblem } = require('../lib/phone');

// Numbers typed in by hand must include their country code; imports are not checked.
let W;
test.before(async () => { await h.prepareDatabase(); W = await h.createWorkspace({ name: 'Phones' }); });
test.after(() => h.shutdown());
const api = (method, path, body) => h.api(method, path, { token: W.token, body });

test('phoneProblem: + country code and 7–15 digits', () => {
  for (const ok of ['', null, '+61 412 345 678', '+91 98765 43210', '+1 (555) 010-0100', '+44 20 7946 0958']) assert.equal(phoneProblem(ok), null, String(ok));
  for (const bad of ['0412 345 678', '412345678', '61 412 345 678', '+0 123 4567', '+61 12', 'call me']) assert.ok(phoneProblem(bad), bad);
});

test('leads: a new number needs its code; an older number without one can be kept when editing', async () => {
  const bad = await api('POST', '/api/v1/leads', { name: 'No code', phone: '0412 345 678' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'INVALID_PHONE');
  const ok = await api('POST', '/api/v1/leads', { name: 'With code', phone: '+61 412 345 678' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));

  // Imported earlier without a code: editing other fields still works.
  const imp = await api('POST', '/api/v1/leads/import-bulk', { leads: [{ name: 'Imported', phone: '0400 111 222' }] });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  const id = imp.data.leadIds?.[0] || (await h.db().get("SELECT id FROM leads WHERE workspace_id = ? AND name = 'Imported'", [W.workspaceId])).id;
  assert.equal((await api('PATCH', `/api/v1/leads/${id}`, { notes: 'Called', phone: '0400 111 222' })).status, 200, 'unchanged number is accepted');
  assert.equal((await api('PATCH', `/api/v1/leads/${id}`, { phone: '0400 999 888' })).status, 400, 'a changed number needs its code');
  assert.equal((await api('PATCH', `/api/v1/leads/${id}`, { phone: '+61 400 999 888' })).status, 200);
});
