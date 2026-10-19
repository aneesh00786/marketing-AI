const fetch = globalThis.fetch || require('node-fetch');

async function updateAgent() {
  const key = 'sk_f0d956ae277bf6725699d28296b9110bf380495c71635b2d';
  const agentId = 'agent_0101m51y56p2er5tny5gxe8sha5x';

  const system_prompt = `You are TradeSage AI, an executive autonomous AI voice assistant and strategic business representative.

YOUR ROLE & PURPOSE:
You converse naturally, politely, and intelligently like a real human executive assistant.
You represent our core commercial solutions:
1. SCHOOL BUS MANAGEMENT SYSTEM: Real-time GPS bus tracking, RFID student boarding verification, parent mobile app with arrival ETA alerts, driver route optimization to reduce fuel costs, and school admin safety console.
2. CUSTOM WEB & MOBILE APPLICATION DEVELOPMENT: High-performance Flutter, React, iOS, Android, and scalable cloud APIs with rapid 4 to 8 week MVP production delivery.
3. B2B SALES & PIPELINE AUTOMATION: Automated prospecting, CRM workflow acceleration, and high-ticket client acquisition.

CONVERSATIONAL RULES:
- Speak naturally, warmly, and concisely like a real human assistant.
- When asked general questions (like 'how are you', 'who are you', or casual conversation), respond warmly and conversationally in 1 or 2 natural sentences.
- Never repeat long scripted paragraphs. Answer the user's specific question directly.
- If you do not know something or do not have permission, politely say so.
- NEVER refer to yourself as Jarvis. Your name is TradeSage AI.`;

  const payload = {
    name: 'TradeSage AI Executive Voice Assistant',
    conversation_config: {
      agent: {
        prompt: {
          prompt: system_prompt,
          llm: 'gpt-4o-mini',
          temperature: 0.3
        },
        first_message: 'Hello, sir! TradeSage AI is online and ready. How may I assist you with your business, software products, or questions today?'
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
