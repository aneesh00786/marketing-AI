const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Browser calling. Telnyx is a fake behind the fetch mock: no call or credential is ever real.
const KEY = 'test-webrtc-key';
let admin;
let sales;
let support;
let viewer;
let outsider;
let mock;
let telnyx;

const api = (user, method, p, body) => h.api(method, `/api/v1/calling${p}`, { token: user?.token, body });
const start = (user, to = '+91 98765 43210') => api(user, 'POST', '/token', { to });
const crmAccess = () => require('../modules/crm/crmAccess');

function fakeTelnyx() {
  const z = { calls: [], refuse: false, transcribed: [], sttReply: [], sttFail: false };
  z.routes = [{
    match: u => u.startsWith('https://api.telnyx.com/v2/telephony_credentials'),
    respond: (url, init) => {
      z.calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body || '{}') });
      if (z.refuse) return h.json(401, { errors: [{ detail: `bad key ${KEY}` }] });
      if (url.endsWith('/token')) return { status: 201, text: 'jwt-token' };
      return h.json(201, { data: { id: 'cred-1' } });
    }
  }];
  z.routes.push({
    match: u => u === 'https://api.telnyx.com/v2/ai/audio/transcriptions',
    respond: async (url, init) => {
      const f = init.body;
      const file = f.get('file');
      z.transcribed.push({ auth: init.headers.Authorization, model: f.get('model'), format: f.get('response_format'), granularity: f.get('timestamp_granularities[]'), name: file.name, type: file.type, size: file.size });
      if (z.sttFail) return h.json(500, { errors: [{ detail: `secret ${KEY}` }] });
      return h.json(200, z.sttReply.shift());
    }
  });
  return z;
}

async function staff(role) {
  const w = await h.createWorkspace({ name: `Calling ${role}` });
  await crmAccess().grant(w.userId, role);
  return w;
}

test.before(async () => {
  await h.prepareDatabase();
  Object.assign(process.env, { TELNYX_WEBRTC_API_KEY: KEY, TELNYX_WEBRTC_CONNECTION_ID: 'conn-1', TELNYX_CALLER_ID: '+61390721221', TELNYX_CALLER_NAME: 'Acme' });
  admin = await staff('manager');
  sales = await staff('sales');
  support = await staff('support');
  viewer = await staff('viewer');
  outsider = await h.createWorkspace({ name: 'No calling' });
});
test.beforeEach(() => { telnyx = fakeTelnyx(); mock = h.mockFetch(telnyx.routes); });
test.afterEach(() => mock.restore());
test.after(() => h.shutdown());

test('every calling route needs a signed-in user', async () => {
  assert.equal((await api(null, 'GET', '/status')).status, 401);
  assert.equal((await api(null, 'POST', '/token', { to: '+919876543210' })).status, 401);
  assert.equal(telnyx.calls.length, 0);
});

test('a Workspace Owner without CRM access cannot call, and neither can a viewer', async () => {
  for (const user of [outsider, viewer]) {
    assert.equal((await api(user, 'GET', '/status')).data.canCall, false);
    const r = await start(user);
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'CALLING_NOT_ALLOWED');
  }
  assert.equal(telnyx.calls.length, 0, 'Telnyx is never contacted');
});

test('access follows the grant: sales, support and managers can call, and removal is immediate', async () => {
  for (const user of [admin, sales, support]) assert.equal((await api(user, 'GET', '/status')).data.canCall, true);
  const u = await staff('sales');
  assert.equal((await start(u)).status, 200);
  await crmAccess().revoke(u.userId);
  assert.equal((await start(u)).status, 403);
});

test('a token is created with an expiring credential; the API key never reaches the browser', async () => {
  const r = await start(admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.token, r.data.destination, r.data.callerId, r.data.callerName], ['jwt-token', '+919876543210', '+61390721221', 'Acme']);
  assert.ok(!JSON.stringify(r.data).includes(KEY));
  assert.ok(!('credentialId' in r.data));
  const [create, token] = telnyx.calls;
  assert.equal(create.auth, `Bearer ${KEY}`);
  assert.equal(create.body.connection_id, 'conn-1');
  const ttl = new Date(create.body.expires_at).getTime() - Date.now();
  assert.ok(ttl > 0 && ttl <= 2 * 60 * 60 * 1000, 'the credential expires by itself');
  assert.ok(token.url.endsWith('/telephony_credentials/cred-1/token'));
});

test('only complete international numbers can be called', async () => {
  const u = await staff('sales');
  for (const to of ['9876543210', '', '+91', '+0123456789', '+91 abc 43210', '+1234567890123456', 'sip:someone@example.org', null]) {
    const r = await start(u, to);
    assert.equal(r.status, 400, String(to));
    assert.equal(r.data.code, 'INVALID_NUMBER');
  }
  assert.equal(telnyx.calls.length, 0);
  assert.equal((await start(u, '+1 (555) 010-0100')).data.destination, '+15550100100');
});

test('calling is off until it is set up, and the app can tell', async () => {
  const key = process.env.TELNYX_WEBRTC_API_KEY;
  const main = process.env.TELNYX_API_KEY;
  delete process.env.TELNYX_WEBRTC_API_KEY;
  process.env.TELNYX_API_KEY = 'the-other-telnyx-key';
  try {
    assert.equal((await api(admin, 'GET', '/status')).data.configured, false);
    const r = await start(admin);
    assert.equal(r.status, 503);
    assert.equal(r.data.code, 'CALLING_NOT_CONFIGURED');
    assert.equal(telnyx.calls.length, 0, 'the main Telnyx key is not used');
  } finally {
    process.env.TELNYX_WEBRTC_API_KEY = key;
    if (main === undefined) delete process.env.TELNYX_API_KEY; else process.env.TELNYX_API_KEY = main;
  }
  assert.equal((await api(admin, 'GET', '/status')).data.configured, true);
});

test('a Telnyx refusal is a clear error that does not leak what Telnyx said', async () => {
  telnyx.refuse = true;
  const r = await start(support);
  assert.equal(r.status, 502);
  assert.equal(r.data.code, 'TELNYX_REFUSED');
  assert.ok(!JSON.stringify(r.data).includes(KEY));
});

test('each call is audited with only the last digits, outside any workspace', async () => {
  const u = await staff('support');
  await start(u, '+91 98765 43210');
  const row = await h.db().get("SELECT workspace_id, actor_user_id, metadata_json FROM audit_logs WHERE action = 'calling.call_started' AND actor_user_id = ? ORDER BY id DESC LIMIT 1", [u.userId]);
  assert.deepEqual([row.workspace_id, row.actor_user_id, JSON.parse(row.metadata_json).numberEnding], [null, u.userId, '3210']);
  assert.ok(!row.metadata_json.includes('98765'));
});

// ------------------------------------------------------------------ call log and transcripts

const crm = (user, method, p, body) => h.api(method, `/api/v1/global-crm${p}`, { token: user?.token, body });
const audio = (user, id, track, bytes = 'fake-audio', type = 'audio/webm;codecs=opus') => h.api('POST', `/api/v1/calling/logs/${id}/audio/${track}`, { token: user.token, rawBody: bytes, headers: { 'Content-Type': type } });
const end = (user, id, body = { durationSeconds: 65, answered: true }) => api(user, 'POST', `/logs/${id}/end`, body);
const begin = async (user, extra = {}) => {
  const r = await api(user, 'POST', '/token', { to: '+91 98765 43210', ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.callLogId;
};
const person = async () => h.db().run("INSERT INTO crm_contacts (full_name, status, updated_at) VALUES ('Ann Lee', 'Customer', UTC_TIMESTAMP())").then(r => r.lastID);

test('every call is logged, with who, whom and how long, and no transcript unless asked', async () => {
  const u = await staff('sales');
  const contactId = await person();
  const id = await begin(u, { name: 'Ann', contactId });
  assert.deepEqual((await end(u, id)).data, { success: true, status: 'none' });
  const c = (await crm(u, 'GET', `/calls/${id}`)).data.call;
  assert.deepEqual([c.phone, c.name, c.contactId, c.answered, c.durationSeconds, c.transcribed, c.transcriptStatus, c.transcript], ['+919876543210', 'Ann Lee', contactId, true, 65, false, 'none', []]);
  assert.ok(c.callerName && c.startedAt && c.endedAt);
  assert.deepEqual((await crm(u, 'GET', `/contacts/${contactId}`)).data.calls.map(x => x.id), [id]);
  const r = await audio(u, id, 'agent');
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'NOT_TRANSCRIBED');
  assert.equal(telnyx.transcribed.length, 0, 'no audio leaves without the box ticked');
});

test('only an explicit true turns on transcription', async () => {
  const u = await staff('sales');
  for (const transcribe of ['true', 1, null, undefined]) {
    const id = await begin(u, { transcribe });
    assert.equal((await crm(u, 'GET', `/calls/${id}`)).data.call.transcribed, false, String(transcribe));
  }
});

test('both sides become one conversation in time order, and the audio is not stored', async () => {
  const u = await staff('support');
  const id = await begin(u, { transcribe: true });
  assert.equal((await end(u, id)).data.status, 'pending');
  telnyx.sttReply = [
    { text: 'Hello. Thanks.', segments: [{ id: 0, start: 0.5, end: 1, text: ' Hello. ' }, { id: 1, start: 6, end: 7, text: 'Thanks.' }] },
    { text: 'Hi there.', segments: [{ id: 0, start: 2, end: 3, text: 'Hi there.' }] }
  ];
  const first = await audio(u, id, 'agent');
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.status, 'pending', 'waiting for the other side');
  assert.equal((await audio(u, id, 'customer')).data.status, 'done');
  const c = (await crm(viewer, 'GET', `/calls/${id}`)).data.call;
  assert.equal(c.transcriptStatus, 'done');
  assert.deepEqual(c.transcript.map(l => [l.speaker, l.text]), [['agent', 'Hello.'], ['customer', 'Hi there.'], ['agent', 'Thanks.']]);
  const sent = telnyx.transcribed[0];
  assert.deepEqual([sent.auth, sent.model, sent.format, sent.granularity, sent.name, sent.type], [`Bearer ${KEY}`, 'openai/whisper-large-v3-turbo', 'verbose_json', 'segment', 'call.webm', 'audio/webm']);
  const cols = await h.db().all("SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'crm_call_logs' AND DATA_TYPE LIKE '%blob%'");
  assert.deepEqual(cols, [], 'nowhere to keep audio');
});

test('if Telnyx returns only text, it is kept; silence is an empty transcript, not a failure', async () => {
  const u = await staff('sales');
  const id = await begin(u, { transcribe: true });
  await end(u, id);
  telnyx.sttReply = [{ text: 'All of it.' }, { text: '   ', segments: [] }];
  await audio(u, id, 'agent');
  assert.equal((await audio(u, id, 'customer')).data.status, 'done');
  assert.deepEqual((await crm(u, 'GET', `/calls/${id}`)).data.call.transcript.map(l => l.text), ['All of it.']);
});

test('an unanswered call expects no transcript', async () => {
  const u = await staff('sales');
  const id = await begin(u, { transcribe: true });
  assert.equal((await end(u, id, { durationSeconds: 0, answered: false })).data.status, 'none');
  assert.equal((await audio(u, id, 'agent')).status, 409);
});

test('if the browser could not capture the audio, the call says so instead of waiting forever', async () => {
  const u = await staff('sales');
  const id = await begin(u, { transcribe: true });
  assert.equal((await end(u, id, { durationSeconds: 30, answered: true, audioCaptured: false })).data.status, 'failed');
  assert.equal((await audio(u, id, 'agent')).data.code, 'ALREADY_TRANSCRIBED');
});

test('a transcription failure is clear, does not leak, and leaves the call logged', async () => {
  const u = await staff('sales');
  const id = await begin(u, { transcribe: true });
  await end(u, id);
  telnyx.sttFail = true;
  const r = await audio(u, id, 'agent');
  assert.equal(r.status, 502);
  assert.equal(r.data.code, 'TRANSCRIPTION_FAILED');
  assert.ok(!JSON.stringify(r.data).includes(KEY));
  assert.equal((await crm(u, 'GET', `/calls/${id}`)).data.call.transcriptStatus, 'failed');
});

test('only the caller can add to a call, once per side, and only real audio tracks', async () => {
  const u = await staff('sales');
  const other = await staff('sales');
  const id = await begin(u, { transcribe: true });
  await end(u, id);
  assert.equal((await end(other, id)).status, 404);
  assert.equal((await audio(other, id, 'agent')).status, 404);
  assert.equal((await audio(outsider, id, 'agent')).status, 403);
  assert.equal((await audio(viewer, id, 'agent')).status, 403);
  assert.equal((await audio(u, id, 'both')).status, 400);
  assert.equal((await audio(u, id, 'agent', 'x', 'text/html')).status, 415);
  assert.equal(telnyx.transcribed.length, 0);
  telnyx.sttReply = [{ text: 'One.' }];
  assert.equal((await audio(u, id, 'agent')).status, 200);
  const again = await audio(u, id, 'agent');
  assert.equal(again.data.code, 'ALREADY_TRANSCRIBED');
  assert.equal(telnyx.transcribed.length, 1);
});

test('reading a transcript is audited, the end of a call cannot be rewritten, and bad input is refused', async () => {
  const u = await staff('sales');
  const id = await begin(u, { transcribe: true });
  await end(u, id);
  await end(u, id, { durationSeconds: 9999, answered: false });
  assert.equal((await crm(u, 'GET', `/calls/${id}`)).data.call.durationSeconds, 65);
  const row = await h.db().get("SELECT workspace_id, actor_user_id FROM audit_logs WHERE action = 'calling.transcript_viewed' AND resource_id = ? ORDER BY id DESC LIMIT 1", [String(id)]);
  assert.deepEqual([row.workspace_id, row.actor_user_id], [null, u.userId]);
  for (const body of [{ durationSeconds: -1, answered: true }, { durationSeconds: 'x', answered: true }, {}]) assert.equal((await end(u, id, body)).status, 400);
  assert.equal((await api(u, 'POST', '/token', { to: '+919876543210', contactId: 99999999 })).data.code, 'INVALID_CONTACT');
});

test('call logs need CRM access; viewers can read; a transcript can be removed by those who manage contacts', async () => {
  const u = await staff('sales');
  const id = await begin(u, { transcribe: true });
  await end(u, id);
  telnyx.sttReply = [{ text: 'Secret.' }, { text: 'Reply.' }];
  await audio(u, id, 'agent');
  await audio(u, id, 'customer');
  assert.equal((await crm(outsider, 'GET', '/calls')).status, 403);
  assert.equal((await crm(outsider, 'GET', `/calls/${id}`)).status, 403);
  assert.equal((await crm(null, 'GET', '/calls')).status, 401);
  assert.equal((await crm(viewer, 'GET', '/calls')).status, 200);
  assert.equal((await crm(viewer, 'DELETE', `/calls/${id}/transcript`)).status, 403);
  const r = await crm(u, 'DELETE', `/calls/${id}/transcript`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.call.transcript, r.data.call.transcriptStatus, r.data.call.durationSeconds], [[], 'none', 65]);
  assert.ok(!JSON.stringify(await h.db().get('SELECT * FROM crm_call_logs WHERE id = ?', [id])).includes('Secret'));
});

test('the call list searches, and lists never include what was said', async () => {
  const u = await staff('sales');
  const mark = `Zq${Date.now()}`;
  const id = await begin(u, { transcribe: true, name: mark });
  await end(u, id);
  telnyx.sttReply = [{ text: 'Private words.' }];
  await audio(u, id, 'agent');
  const r = await crm(u, 'GET', `/calls?q=${mark}`);
  assert.deepEqual([r.data.total, r.data.calls[0].id], [1, id]);
  assert.ok(!JSON.stringify(r.data).includes('Private words'));
});

test('starting calls is limited per user', async () => {
  const u = await staff('sales');
  let last;
  for (let i = 0; i < 11; i++) last = await start(u);
  assert.equal(last.status, 429);
  assert.equal((await start(sales)).status, 200, 'other users are not affected');
});
