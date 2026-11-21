const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Storage is UTC; days people pick ("From", "To") are days where they are (X-Time-Zone from the browser).
const time = require('../lib/time');
const db = () => h.db();
let W;

test.before(async () => {
  await h.prepareDatabase();
  W = await h.createWorkspace({ name: 'Time zones' });
  // 20 Nov 20:00 UTC is 21 Nov 01:30 in India.
  await db().run("INSERT INTO emails (workspace_id, sender, sender_email, recipient_email, subject, body, status, message_id, smtp_status, received_at) VALUES (?, 'Kim', 'kim@kimco.io', 'me@x.io', 'Late night', 'x', 'Unread', 'tz-1@kimco.io', 'Received via IMAP', '2026-11-20 20:00:00')", [W.workspaceId]);
});
test.after(() => h.shutdown());

test('helpers: the viewer zone from the header (invalid → UTC), local days and their UTC start', () => {
  assert.equal(time.requestTimeZone({ headers: { 'x-time-zone': 'Asia/Kolkata' } }), 'Asia/Kolkata');
  assert.equal(time.requestTimeZone({ headers: { 'x-time-zone': 'Not/AZone' } }), 'UTC');
  assert.equal(time.requestTimeZone({ headers: {} }), 'UTC');
  assert.equal(time.dayStartUtc('2026-11-21', 'Asia/Kolkata'), '2026-11-20 18:30:00');
  assert.equal(time.dayStartUtc('2026-07-01', 'America/New_York'), '2026-07-01 04:00:00', 'daylight-saving offset of that day');
  assert.equal(time.dayInZone(new Date('2026-11-20T20:00:00Z'), 'Asia/Kolkata'), '2026-11-21');
  assert.equal(time.nextDay('2026-12-31'), '2027-01-01');
  assert.equal(time.sqlOffset('Asia/Kolkata'), '+05:30');
  assert.equal(time.sqlOffset('UTC'), '+00:00');
});

test('Inbox "From/To" are the viewer\'s days: an email at 01:30 India time is on the 21st there, the 20th in UTC', async () => {
  const list = (day, tz) => h.api('GET', `/api/v1/emails/inbox?from=${day}&to=${day}`, { token: W.token, headers: tz ? { 'X-Time-Zone': tz } : {} });
  const has = r => r.data.emails.some(e => e.subject === 'Late night');
  const india21 = await list('2026-11-21', 'Asia/Kolkata');
  assert.equal(india21.status, 200, JSON.stringify(india21.data));
  assert.ok(has(india21));
  assert.ok(!has(await list('2026-11-20', 'Asia/Kolkata')));
  assert.ok(has(await list('2026-11-20')), 'no header: UTC days');
  assert.ok(!has(await list('2026-11-21')));
});
