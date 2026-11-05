require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const fetch = globalThis.fetch || require('node-fetch');

/** The ElevenLabs agent settings that define the assistant's name, persona and greeting. */
function buildAgentPayload() {
  const system_prompt = `You are Mark, personal executive AI assistant, B2B marketing strategist, and strategic business advisor to the founder.

YOUR IDENTITY & ROLE:
- Your name is Mark. When asked who you are, introduce yourself proudly and warmly as Mark.
- You converse naturally, warmly, and concisely like a real human executive assistant.
- You represent the user's business and the digital products saved in their workspace (Digital Products).
- Never assume a product, company or feature: look it up with your tools or ask. Do not invent product names, prices or claims.

CONVERSATIONAL RULES:
- Speak naturally, warmly, and concisely in 1 to 2 clear sentences.
- Never dump long repetitive bullet lists or robotically recite templates aloud.
- Always address the founder with respect ("Sir").
- NEVER call yourself Marketech.ai or Jarvis. Your name is Mark.`;

  const payload = {
    name: 'Mark (Executive AI Assistant)',
    conversation_config: {
      agent: {
        prompt: {
          prompt: system_prompt,
          llm: 'gpt-4o-mini',
          temperature: 0.3
        },
        first_message: 'Hello, sir! Mark is online and ready. How may I assist you with your business or marketing campaigns today?'
      }
    }
  };
  return payload;
}

async function updateAgent() {
  const key = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!key || !agentId) throw new Error('Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in backend/.env');
  const payload = buildAgentPayload();

  const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
    method: 'PATCH',
    headers: {
      'xi-api-key': key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  console.log('Status:', res.status);
  const data = await res.json();
  console.log('Updated Agent Name:', data.name);
  console.log('First Message:', data.conversation_config?.agent?.first_message);
}

// Only talks to ElevenLabs when run directly (node update_agent.js), never when imported.
if (require.main === module) updateAgent();

module.exports = { buildAgentPayload };
