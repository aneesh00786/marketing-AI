/**
 * Voice agent readiness: checks the ElevenLabs key, agent and remaining credits with
 * read-only API calls. It never starts a conversation. Results are cached briefly so
 * logins do not hit ElevenLabs on every page load.
 */
const CACHE_MS = 5 * 60 * 1000;
// Below this many credits a voice conversation cannot start or ends at once (about one minute of talk).
const MIN_CREDITS = parseInt(process.env.VOICE_MIN_CREDITS || '700', 10);

let cache = null;

async function readJson(res) {
  try { return await res.json(); } catch (e) { return {}; }
}

async function checkVoiceStatus() {
  const key = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!key || !agentId) {
    return { available: false, status: 'not_configured', message: 'The voice agent is not set up: no ElevenLabs API key or agent ID is configured.' };
  }
  const headers = { 'xi-api-key': key };

  const agent = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`, { headers });
  if (agent.status === 401 || agent.status === 403) {
    const body = await readJson(agent);
    const missing = body?.detail?.status === 'missing_permissions';
    return {
      available: false,
      status: missing ? 'key_permissions' : 'invalid_key',
      message: missing
        ? 'The ElevenLabs API key does not have permission to use voice agents (ElevenLabs Agents: Read & Write).'
        : 'The ElevenLabs API key was rejected.'
    };
  }
  if (agent.status === 404) {
    return { available: false, status: 'agent_not_found', message: 'The configured voice agent was not found in this ElevenLabs account.' };
  }
  if (!agent.ok) {
    return { available: null, status: 'unknown', message: `ElevenLabs did not answer the readiness check (${agent.status}).` };
  }

  const sub = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers });
  if (!sub.ok) {
    // The key may not be allowed to read the balance; the agent itself is reachable.
    return { available: null, status: 'unknown', message: 'Voice credits could not be checked with this API key.' };
  }
  const s = await readJson(sub);
  const used = Number(s.character_count);
  const limit = Number(s.character_limit);
  const remaining = Number.isFinite(used) && Number.isFinite(limit) ? Math.max(0, limit - used) : null;
  const resetsAt = s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null;
  if (remaining !== null && remaining < MIN_CREDITS) {
    return {
      available: false,
      status: 'no_credits',
      message: 'There are no voice credits left on the ElevenLabs account, so the voice agent cannot start a conversation.',
      remainingCredits: remaining,
      creditLimit: limit,
      plan: s.tier || null,
      resetsAt
    };
  }
  return { available: true, status: 'ok', message: 'Voice agent is ready.', remainingCredits: remaining, creditLimit: limit, plan: s.tier || null, resetsAt };
}

async function getVoiceStatus({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value;
  try {
    value = await checkVoiceStatus();
  } catch (err) {
    value = { available: null, status: 'unknown', message: `Voice readiness could not be checked: ${err.message}` };
  }
  value.checkedAt = new Date().toISOString();
  cache = { at: Date.now(), value };
  return value;
}

function clearVoiceStatusCache() {
  cache = null;
}

module.exports = { getVoiceStatus, clearVoiceStatusCache, MIN_CREDITS };
