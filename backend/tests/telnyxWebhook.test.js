const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

// Telnyx TeXML webhooks (/api/telnyx/inbound, /api/telnyx/dialogue) are public: only requests with a
// valid Ed25519 signature over `${timestamp}|${rawBody}` may write call records, leads or usage, or
// call the AI. AI providers are mocked; any AI call is counted.
const db = () => h.db();
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
const other = crypto.generateKeyPairSync('ed25519');

let mock;
let aiCalls = 0;

test.before(async () => {
  await h.prepareDatabase();
  process.env.TELNYX_PUBLIC_KEY = rawPublic;
  mock = h.mockFetch([h.groqRoute(() => { aiCalls++; return 'We can help with that. Would you like a 15-minute walkthrough?'; })]);
  await h.startApp();
});
test.after(() => { mock.restore(); delete process.env.TELNYX_PUBLIC_KEY; return h.shutdown(); });

function sign(body, { key = privateKey, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const signature = crypto.sign(null, Buffer.from(`${timestamp}|${body}`), key).toString('base64');
  return { 'telnyx-signature-ed25519': signature, 'telnyx-timestamp': String(timestamp) };
}

async function post(pathName, body, headers = {}, contentType = 'application/x-www-form-urlencoded') {
  const { port } = (await h.startApp()).address();
  const res = await globalThis.__realFetch(`http://127.0.0.1:${port}${pathName}`, {
    method: 'POST', headers: { 'Content-Type': contentType, ...headers }, body
  });
  return { status: res.status, text: await res.text() };
}

async function counts() {
  const one = async sql => Number((await db().get(sql)).n);
  return {
    calls: await one('SELECT COUNT(*) AS n FROM call_records'),
    leads: await one('SELECT COUNT(*) AS n FROM leads'),
    usage: await one('SELECT COUNT(*) AS n FROM usage_ledger'),
    ai: aiCalls
  };
}

async function assertRejected(pathName, body, headers, expectedStatus, contentType) {
  const before = await counts();
  const res = await post(pathName, body, headers, contentType);
  assert.equal(res.status, expectedStatus, `${pathName}: ${res.text}`);
  assert.doesNotMatch(res.text, /<Response>/);
  assert.deepEqual(await counts(), before, 'a rejected webhook writes nothing and calls no AI');
}

const dialogueBody = new URLSearchParams({ SpeechResult: 'Tell me about the school bus system', From: '+15550001111' }).toString();
const inboundBody = new URLSearchParams({ From: '+15550002222', To: '+15550003333' }).toString();

test('a valid signature is processed (dialogue: AI reply, lead and usage recorded)', async () => {
  const before = await counts();
  const dialogue = await post('/api/v1/telnyx/dialogue', dialogueBody, sign(dialogueBody));
  assert.equal(dialogue.status, 200, dialogue.text);
  assert.match(dialogue.text, /walkthrough/);
  const after = await counts();
  assert.equal(after.leads, before.leads + 1);
  assert.equal(after.usage, before.usage + 1);
  assert.equal(after.ai, before.ai + 1);
});

test('a valid signed inbound call completes: TeXML greeting and one call record', async () => {
  const before = await counts();
  const inbound = await post('/api/telnyx/inbound', inboundBody, sign(inboundBody));
  assert.equal(inbound.status, 200, inbound.text);
  assert.match(inbound.text, /<Response>[\s\S]*<Gather[^>]*action="\/api\/telnyx\/dialogue"/);
  const after = await counts();
  assert.equal(after.calls, before.calls + 1);
  assert.equal(after.leads, before.leads, 'the greeting creates no lead');
  assert.equal(after.ai, before.ai, 'the greeting calls no AI');
  const rec = await db().get('SELECT workspace_id, direction, caller_number, status, transcript_text, started_at FROM call_records ORDER BY id DESC LIMIT 1');
  assert.equal(Number(rec.workspace_id), 1);
  assert.equal(rec.direction, 'inbound');
  assert.equal(rec.caller_number, '+15550002222');
  assert.equal(rec.status, 'In Progress');
  assert.match(rec.transcript_text, /greeting/);
  assert.ok(rec.started_at);
});

test('unsigned or badly signed inbound calls write no call record and call no AI', async () => {
  await assertRejected('/api/telnyx/inbound', inboundBody, {}, 401);
  await assertRejected('/api/v1/telnyx/inbound', inboundBody, sign(inboundBody, { key: other.privateKey }), 401);
  await assertRejected('/api/telnyx/inbound', inboundBody.replace('2222', '9999'), sign(inboundBody), 401);
});

test('missing signature headers are rejected with no writes or AI calls', async () => {
  await assertRejected('/api/telnyx/dialogue', dialogueBody, {}, 401);
  const { 'telnyx-signature-ed25519': sig } = sign(dialogueBody);
  await assertRejected('/api/telnyx/dialogue', dialogueBody, { 'telnyx-signature-ed25519': sig }, 401);
  await assertRejected('/api/telnyx/inbound', inboundBody, { 'telnyx-timestamp': String(Math.floor(Date.now() / 1000)) }, 401);
});

test('invalid signatures are rejected: wrong key, tampered body, stale timestamp', async () => {
  await assertRejected('/api/telnyx/dialogue', dialogueBody, sign(dialogueBody, { key: other.privateKey }), 401);
  const tampered = dialogueBody.replace('school', 'evil');
  await assertRejected('/api/telnyx/dialogue', tampered, sign(dialogueBody), 401);
  const old = Math.floor(Date.now() / 1000) - 3600;
  await assertRejected('/api/telnyx/inbound', inboundBody, sign(inboundBody, { timestamp: old }), 401);
  // A signature for one timestamp does not validate another.
  const good = sign(inboundBody);
  await assertRejected('/api/telnyx/inbound', inboundBody, { ...good, 'telnyx-timestamp': String(Number(good['telnyx-timestamp']) + 1) }, 401);
});

test('malformed signatures, timestamps and payloads are rejected', async () => {
  await assertRejected('/api/telnyx/dialogue', dialogueBody, { 'telnyx-signature-ed25519': 'not base64 !!', 'telnyx-timestamp': String(Math.floor(Date.now() / 1000)) }, 401);
  await assertRejected('/api/telnyx/dialogue', dialogueBody, { 'telnyx-signature-ed25519': Buffer.alloc(10).toString('base64'), 'telnyx-timestamp': String(Math.floor(Date.now() / 1000)) }, 401);
  await assertRejected('/api/telnyx/dialogue', dialogueBody, { ...sign(dialogueBody), 'telnyx-timestamp': 'yesterday' }, 401);
  // Signed but unparseable JSON never reaches the handler.
  const badJson = '{"SpeechResult": ';
  await assertRejected('/api/telnyx/dialogue', badJson, sign(badJson), 400, 'application/json');
});

test('a captured request cannot be replayed', async () => {
  const body = new URLSearchParams({ SpeechResult: 'pricing please', From: '+15550004444' }).toString();
  const headers = sign(body);
  assert.equal((await post('/api/telnyx/dialogue', body, headers)).status, 200);
  await assertRejected('/api/telnyx/dialogue', body, headers, 401);
});

test('GET is no longer accepted (query strings are not covered by the signature)', async () => {
  const before = await counts();
  const { port } = (await h.startApp()).address();
  const res = await globalThis.__realFetch(`http://127.0.0.1:${port}/api/telnyx/dialogue?SpeechResult=hi&From=1`);
  assert.notEqual(res.status, 200);
  assert.deepEqual(await counts(), before);
});

test('without TELNYX_PUBLIC_KEY (or with an invalid one) the webhooks are closed', async () => {
  const saved = process.env.TELNYX_PUBLIC_KEY;
  try {
    delete process.env.TELNYX_PUBLIC_KEY;
    await assertRejected('/api/telnyx/dialogue', dialogueBody, sign(dialogueBody), 503);
    process.env.TELNYX_PUBLIC_KEY = 'not-a-key';
    await assertRejected('/api/telnyx/inbound', inboundBody, sign(inboundBody), 503);
  } finally {
    process.env.TELNYX_PUBLIC_KEY = saved;
  }
});

test('a PEM public key is accepted too', async () => {
  const saved = process.env.TELNYX_PUBLIC_KEY;
  try {
    process.env.TELNYX_PUBLIC_KEY = publicKey.export({ format: 'pem', type: 'spki' });
    const body = new URLSearchParams({ SpeechResult: 'app development', From: '+15550005555' }).toString();
    assert.equal((await post('/api/telnyx/dialogue', body, sign(body))).status, 200);
  } finally {
    process.env.TELNYX_PUBLIC_KEY = saved;
  }
});

test('rejection logs carry no signature, key or payload', async () => {
  const lines = [];
  const orig = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    const headers = sign(dialogueBody, { key: other.privateKey });
    await post('/api/telnyx/dialogue', dialogueBody, headers);
    const logged = lines.join('\n');
    assert.match(logged, /INVALID_SIGNATURE/);
    assert.ok(!logged.includes(headers['telnyx-signature-ed25519']));
    assert.ok(!logged.includes('school bus'));
    assert.ok(!logged.includes(rawPublic));
  } finally {
    console.warn = orig;
  }
});
