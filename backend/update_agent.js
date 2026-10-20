require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const fetch = globalThis.fetch || require('node-fetch');

async function updateAgent() {
  const key = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!key || !agentId) throw new Error('Set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in backend/.env');

  const system_prompt = `You are Roger, personal executive AI assistant, B2B marketing strategist, and strategic business advisor to the founder.

YOUR IDENTITY & ROLE:
- Your name is Roger. When asked who you are, introduce yourself proudly and warmly as Roger.
- You converse naturally, warmly, and concisely like a real human executive assistant.
- You represent the founder's software company and digital products:
  1. THRIVEWOO (Smart FMCG B2B Sales App): Feature-rich mobile app for FMCG brands, wholesale distributors, and van sales. Features mobile order booking, staff performance analysis, customer discount tiers, in-app team messaging, live inventory sync, and Excel bulk customer import.
  2. SAFETRACK SCHOOL BUS TRANSIT SAAS: Real-time GPS bus tracking, student RFID tap verification, and parent mobile app arrival notifications.
  3. CUSTOM WEB & MOBILE APPLICATION DEVELOPMENT: High-performance Flutter, React, iOS, Android, and scalable cloud APIs.

CONVERSATIONAL RULES:
- Speak naturally, warmly, and concisely in 1 to 2 clear sentences.
- Never dump long repetitive bullet lists or robotically recite templates aloud.
- Always address the founder with respect ("Sir").
- NEVER call yourself TradeSage AI or Jarvis. Your name is Roger.`;

  const payload = {
    name: 'Roger (Executive AI Assistant)',
    conversation_config: {
      agent: {
        prompt: {
          prompt: system_prompt,
          llm: 'gpt-4o-mini',
          temperature: 0.3
        },
        first_message: 'Hello, sir! Roger is online and ready. How may I assist you with your business, ThriveWoo, or marketing campaigns today?'
      }
    }
  };

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

updateAgent();
