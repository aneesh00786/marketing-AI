const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// The assistant is called Mark. No real ElevenLabs or AI request is made: fetch is mocked
// and unmatched requests fail.
let W1;

test.before(async () => {
  await h.prepareDatabase();
  W1 = await h.addMember(1, 'Workspace Owner');
});
test.after(() => h.shutdown());

test('built-in replies introduce the assistant as Mark and answer to the new name', () => {
  const { generateDynamicContextualReply } = require('../services/aiEngine');
  for (const q of ['hello mark', 'Hi Mark!', 'hello']) {
    const reply = generateDynamicContextualReply(q);
    assert.match(reply, /Mark is online/, q);
    assert.doesNotMatch(reply, /Roger/, q);
  }
  for (const q of ['who are you', "what's your name", 'what is your name']) {
    assert.match(generateDynamicContextualReply(q), /^I am Mark,/, q);
  }
});

test('chat persona and agent label use Mark', async () => {
  let system = '';
  const mock = h.mockFetch([h.groqRoute(b => { system = b.messages.find(m => m.role === 'system')?.content || ''; return 'Happy to help.'; })]);
  let r;
  try {
    r = await h.api('POST', '/api/v1/assistant/chat', { token: W1.token, body: { message: 'Mark, summarise my week in one line' } });
  } finally { mock.restore(); }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.agent.name, 'Mark (Executive Assistant)');
  assert.match(system, /You are Mark,/);
  assert.doesNotMatch(system, /Roger/);
  const task = await h.db().get('SELECT agent_name FROM tasks WHERE id = ?', [r.data.taskId]);
  assert.equal(task.agent_name, 'Mark (Executive Assistant)');
});

test('ElevenLabs agent settings name the agent Mark', () => {
  const p = require('../update_agent').buildAgentPayload();
  assert.equal(p.name, 'Mark (Executive AI Assistant)');
  assert.match(p.conversation_config.agent.first_message, /Mark is online/);
  assert.match(p.conversation_config.agent.prompt.prompt, /Your name is Mark/);
  assert.doesNotMatch(JSON.stringify(p), /Roger/);
});

test('status reports Mark; voice sessions still use the existing signed-URL flow', async () => {
  const status = await h.api('GET', '/api/status');
  assert.match(status.data.agent_name, /^MARK \/\//);

  const saved = { key: process.env.ELEVENLABS_API_KEY, agent: process.env.ELEVENLABS_AGENT_ID };
  process.env.ELEVENLABS_API_KEY = 'test-xi-key';
  process.env.ELEVENLABS_AGENT_ID = 'agent_test_123';
  const calls = [];
  const mock = h.mockFetch([{
    match: u => u.startsWith('https://api.elevenlabs.io/v1/convai/conversation/get_signed_url'),
    respond: (url, init) => { calls.push({ url, key: init.headers['xi-api-key'] }); return h.json(200, { signed_url: 'wss://example.invalid/convai?token=abc' }); }
  }]);
  let r;
  try {
    r = await h.api('GET', '/api/v1/voice/signed-url', { token: W1.token });
  } finally {
    mock.restore();
    process.env.ELEVENLABS_API_KEY = saved.key;
    process.env.ELEVENLABS_AGENT_ID = saved.agent;
  }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.signed_url, 'wss://example.invalid/convai?token=abc');
  assert.equal(r.data.agentId, 'agent_test_123');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /agent_id=agent_test_123$/, 'same agent id, renamed only in its settings');
  assert.equal(calls[0].key, 'test-xi-key');
});

test('voice readiness check reports missing credits, bad keys and setup gaps without starting a call', async () => {
  const voiceStatus = require('../services/voiceStatus');
  const saved = { key: process.env.ELEVENLABS_API_KEY, agent: process.env.ELEVENLABS_AGENT_ID };
  process.env.ELEVENLABS_API_KEY = 'test-xi-key';
  process.env.ELEVENLABS_AGENT_ID = 'agent_test_123';
  const scenario = { agent: () => h.json(200, { agent_id: 'agent_test_123' }), sub: () => h.json(200, { tier: 'free', character_count: 9883, character_limit: 10000, next_character_count_reset_unix: 1794775260 }) };
  const calls = [];
  const mock = h.mockFetch([
    { match: u => u.startsWith('https://api.elevenlabs.io/v1/convai/agents/'), respond: u => { calls.push(u); return scenario.agent(); } },
    { match: u => u === 'https://api.elevenlabs.io/v1/user/subscription', respond: u => { calls.push(u); return scenario.sub(); } }
  ]);
  const check = async () => (await h.api('GET', '/api/v1/voice/status?fresh=1', { token: W1.token })).data.voice;
  try {
    const empty = await check();
    assert.equal(empty.available, false);
    assert.equal(empty.status, 'no_credits');
    assert.equal(empty.remainingCredits, 117);
    assert.equal(empty.resetsAt, new Date(1794775260 * 1000).toISOString());

    scenario.sub = () => h.json(200, { tier: 'starter', character_count: 1000, character_limit: 30000 });
    const ok = await check();
    assert.equal(ok.available, true);
    assert.equal(ok.remainingCredits, 29000);

    scenario.agent = () => h.json(401, { detail: { status: 'missing_permissions', message: 'missing convai_read' } });
    assert.equal((await check()).status, 'key_permissions');
    scenario.agent = () => h.json(404, { detail: 'not found' });
    assert.equal((await check()).status, 'agent_not_found');

    // ElevenLabs unreachable: unknown, so the app shows no notice rather than a false alarm.
    scenario.agent = () => new Error('network down');
    const unknown = await check();
    assert.equal(unknown.available, null);

    process.env.ELEVENLABS_AGENT_ID = '';
    const missing = await check();
    assert.equal(missing.status, 'not_configured');
  } finally {
    mock.restore();
    process.env.ELEVENLABS_API_KEY = saved.key;
    process.env.ELEVENLABS_AGENT_ID = saved.agent;
    voiceStatus.clearVoiceStatusCache();
  }
  assert.ok(calls.every(u => !/get_signed_url|conversation/.test(u)), 'never opens a conversation');
  assert.equal((await h.api('GET', '/api/v1/voice/status')).status, 401);
});

test('voice works in every workspace: readiness and signed URL for any signed-in member', async () => {
  // Regression: these routes sat behind the workspace-1-only gate, so other workspaces (e.g. the
  // demo workspace) got 403 MODULE_NOT_TENANT_AWARE and could never start a voice session.
  const other = await h.createWorkspace({ name: 'Voice elsewhere' });
  const member = await h.addMember(other.workspaceId, 'Member');
  const voiceStatus = require('../services/voiceStatus');
  const saved = { key: process.env.ELEVENLABS_API_KEY, agent: process.env.ELEVENLABS_AGENT_ID };
  process.env.ELEVENLABS_API_KEY = 'test-xi-key';
  process.env.ELEVENLABS_AGENT_ID = 'agent_test_123';
  const calls = [];
  const mock = h.mockFetch([
    { match: u => u.startsWith('https://api.elevenlabs.io/v1/convai/agents/'), respond: u => { calls.push(u); return h.json(200, { agent_id: 'agent_test_123' }); } },
    { match: u => u.startsWith('https://api.elevenlabs.io/v1/user/subscription'), respond: u => { calls.push(u); return h.json(200, { tier: 'starter', character_count: 1000, character_limit: 30000 }); } },
    { match: u => u.startsWith('https://api.elevenlabs.io/v1/convai/conversation/get_signed_url'), respond: u => { calls.push(u); return h.json(200, { signed_url: 'wss://example.invalid/convai?token=abc' }); } }
  ]);
  try {
    voiceStatus.clearVoiceStatusCache();
    for (const who of [other, member]) {
      const status = await h.api('GET', '/api/v1/voice/status?fresh=1', { token: who.token });
      assert.equal(status.status, 200);
      assert.equal(status.data.voice.available, true);
      assert.equal(status.data.voice.status, 'ok');
      const url = await h.api('GET', '/api/v1/voice/signed-url', { token: who.token });
      assert.equal(url.status, 200, JSON.stringify(url.data));
      assert.equal(url.data.signed_url, 'wss://example.invalid/convai?token=abc');
    }
    assert.equal(calls.filter(u => /get_signed_url\?agent_id=agent_test_123$/.test(u)).length, 2);
    // Sign-in is still required.
    assert.equal((await h.api('GET', '/api/v1/voice/signed-url')).status, 401);
    // Legacy modules stay workspace-1 only.
    assert.equal((await h.api('GET', '/api/appointments', { token: other.token })).status, 403);
  } finally {
    mock.restore();
    process.env.ELEVENLABS_API_KEY = saved.key;
    process.env.ELEVENLABS_AGENT_ID = saved.agent;
    voiceStatus.clearVoiceStatusCache();
  }
});

test('missing voice configuration is reported clearly; ElevenLabs is not called with an undefined agent', async () => {
  const saved = { key: process.env.ELEVENLABS_API_KEY, agent: process.env.ELEVENLABS_AGENT_ID };
  const calls = [];
  const mock = h.mockFetch([{ match: u => u.startsWith('https://api.elevenlabs.io/'), respond: u => { calls.push(u); return h.json(200, {}); } }]);
  try {
    for (const [key, agent] of [['test-xi-key', ''], ['', 'agent_test_123']]) {
      process.env.ELEVENLABS_API_KEY = key;
      process.env.ELEVENLABS_AGENT_ID = agent;
      const r = await h.api('GET', '/api/v1/voice/signed-url', { token: W1.token });
      assert.equal(r.status, 503);
      assert.equal(r.data.code, 'VOICE_NOT_CONFIGURED');
      assert.match(r.data.error, /ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID/);
    }
  } finally {
    mock.restore();
    process.env.ELEVENLABS_API_KEY = saved.key;
    process.env.ELEVENLABS_AGENT_ID = saved.agent;
  }
  assert.equal(calls.length, 0);
});
