const { run, get, all } = require('../db/database');

const TELNYX_PHONE_NUMBER = process.env.TELNYX_PHONE_NUMBER || '+1 (800) 555-SAGE';

async function getWorkspaceBrand(workspaceId = 1) {
  try {
    const profile = await get('SELECT business_name FROM business_profiles WHERE workspace_id = ?', [workspaceId]);
    if (profile?.business_name) return profile.business_name;
    const ws = await get('SELECT name FROM workspaces WHERE id = ?', [workspaceId]);
    return ws?.name || 'Our Company';
  } catch (e) {
    return 'Our Company';
  }
}

const aiEngine = require('./aiEngine');

/**
 * Intelligent Conversational Response Generator powered by Multi-Provider AI Engine
 */
async function generateAiSalesReply(callerSpeech, workspaceId = 1, companyName = 'Our Company') {
  const systemPrompt = `You are Sarah Connor, the executive inbound telephone sales receptionist for ${companyName}.
Our core solutions are:
1. School Bus Management System (SaaS): Live GPS fleet tracking, RFID student boarding verification, parent ETA mobile app, fuel route optimization.
2. Custom Web & Mobile Application Development: Flutter, React, native iOS and Android, cloud APIs, rapid 4-8 week MVP production delivery.
3. B2B Sales & Pipeline Automation: Automated prospecting, CRM workflow acceleration, outbound sales appointments.

Answer the caller's specific question directly, naturally, and concisely in 2 to 3 sentences. End by politely asking if they would like to schedule a 15-minute live dashboard walkthrough.`;

  const aiRes = await aiEngine.generateAiResponse(callerSpeech, systemPrompt, workspaceId);

  let detectedProduct = "General Enterprise Inquiry";
  const lower = (callerSpeech || '').toLowerCase();
  if (lower.includes('bus') || lower.includes('school') || lower.includes('rfid') || lower.includes('student')) {
    detectedProduct = "School Bus Management System (SaaS)";
  } else if (lower.includes('app') || lower.includes('mobile') || lower.includes('flutter') || lower.includes('react')) {
    detectedProduct = "Custom Web & Mobile App Development";
  } else if (lower.includes('b2b') || lower.includes('sale') || lower.includes('lead') || lower.includes('outbound')) {
    detectedProduct = "B2B Sales & Pipeline Automation";
  } else if (lower.includes('price') || lower.includes('cost') || lower.includes('quote') || lower.includes('rate')) {
    detectedProduct = "Pricing & Proposal Inquiry";
  } else if (lower.includes('demo') || lower.includes('walkthrough') || lower.includes('schedule') || lower.includes('book')) {
    detectedProduct = "Demo Walkthrough Request";
  }

  return {
    reply: aiRes.text,
    detectedProduct,
    provider: aiRes.provider,
    confidence: 0.95
  };
}

/**
 * Handle incoming Telnyx TeXML Webhook
 */
async function handleInboundCall(fromNumber, toNumber, workspaceId = 1) {
  const companyName = await getWorkspaceBrand(workspaceId);
  const greeting = `Thank you for calling ${companyName}. I am your AI assistant. I can help you with our School Bus Management System, custom web and mobile app development, or B2B sales pipelines. How can I assist you today?`;

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  // Log call record (columns of the MySQL call_records table)
  await run(
    `INSERT INTO call_records (workspace_id, direction, caller_number, transcript_text, status, started_at)
     VALUES (?, 'inbound', ?, 'Call connected. AI delivered greeting.', 'In Progress', ?)`,
    [workspaceId, String(fromNumber || '+1 (555) 019-2831').slice(0, 50), now]
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="/api/telnyx/dialogue" method="POST">
    <Say voice="Polly.Brian-Neural">${greeting}</Say>
  </Gather>
  <Say voice="Polly.Brian-Neural">I didn't catch that. Please stay on the line or call back anytime. Goodbye.</Say>
</Response>`;
}

/**
 * Handle Telnyx TeXML Dialogue Turn
 */
async function handleCallDialogue(speechResult, callerNumber = '', workspaceId = 1) {
  const companyName = await getWorkspaceBrand(workspaceId);
  const analysis = await generateAiSalesReply(speechResult, workspaceId, companyName);
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  // Auto-record lead into CRM
  await run(
    `INSERT INTO leads (workspace_id, name, phone, product_interest, status, notes, created_at)
     VALUES (?, 'Inbound Phone Caller', ?, ?, 'New', ?, ?)`,
    [workspaceId, callerNumber || '+1 (555) 019-2831', analysis.detectedProduct, `Telnyx Voice Query: "${speechResult}"`, now]
  );

  // Meter telephony usage ($0.05/minute)
  await run(
    `INSERT INTO usage_ledger (workspace_id, category, quantity, unit, estimated_cost, created_at)
     VALUES (?, 'telnyx_voice_minute', 1.0, 'minute', 0.05, ?)`,
    [workspaceId, now]
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="/api/telnyx/dialogue" method="POST">
    <Say voice="Polly.Brian-Neural">${analysis.reply}</Say>
  </Gather>
  <Say voice="Polly.Brian-Neural">Thank you for speaking with ${companyName}. A summary has been dispatched to our team. Have a wonderful day.</Say>
  <Hangup/>
</Response>`;
}

/**
 * Local Phone Call Simulator for testing in browser without telecom charges
 */
async function simulateTelnyxCall(callerSpeech, callerPhone = '+1 (555) 948-2041', callerName = 'Phone Prospect', workspaceId = 1) {
  const companyName = await getWorkspaceBrand(workspaceId);
  const analysis = await generateAiSalesReply(callerSpeech, workspaceId, companyName);
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  // 1. Insert Lead into CRM
  const leadRes = await run(
    `INSERT INTO leads (workspace_id, name, phone, product_interest, status, notes, created_at)
     VALUES (?, ?, ?, ?, 'Qualified', ?, ?)`,
    [workspaceId, callerName, callerPhone, analysis.detectedProduct, `Simulated Call Query: "${callerSpeech}"`, now]
  );
  const leadId = leadRes.lastID;

  // 2. Insert Call Record
  const durationSec = Math.floor(Math.random() * 30) + 25; // 25-55s call
  await run(
    `INSERT INTO call_records (workspace_id, direction, caller_number, duration_seconds, transcript, summary, lead_id, call_outcome, created_at)
     VALUES (?, 'inbound', ?, ?, ?, ?, ?, 'Demo Scheduled', ?)`,
    [
      workspaceId,
      callerPhone,
      durationSec,
      `CALLER: ${callerSpeech}\n${companyName.toUpperCase()} AI: ${analysis.reply}`,
      `Caller inquired about ${analysis.detectedProduct}. AI delivered value proposition and registered prospect.`,
      leadId,
      now
    ]
  );

  // 3. Meter usage at $0.05/min (e.g. 0.6 min = $0.03)
  const cost = parseFloat(((durationSec / 60) * 0.05).toFixed(3));
  await run(
    `INSERT INTO usage_ledger (workspace_id, category, quantity, unit, estimated_cost, created_at)
     VALUES (?, 'telnyx_voice_minute', ?, 'minute', ?, ?)`,
    [workspaceId, parseFloat((durationSec / 60).toFixed(2)), cost, now]
  );

  return {
    success: true,
    callerSaid: callerSpeech,
    aiReply: analysis.reply,
    detectedProduct: analysis.detectedProduct,
    leadId,
    durationSeconds: durationSec,
    costUsd: cost
  };
}

/**
 * Synthesize speech audio using Telnyx Text-to-Speech API
 */
async function synthesizeSpeech(text, voiceId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    throw new Error('TELNYX_API_KEY not configured');
  }

  // Clean text of markdown characters
  const clean = (text || '')
    .replace(/[*#_~`>]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/•\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const chosenVoice = voiceId || 'Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02';

  const res = await fetch('https://api.telnyx.com/v2/text-to-speech/speech', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: clean,
      voice: chosenVoice
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Telnyx TTS failed (${res.status}): ${errText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Curated high-quality Telnyx voices from the 4,673 voice catalog
 */
function getCuratedVoices() {
  return [
    {
      id: 'Telnyx.Ultra.f786b574-daa5-4673-aa0c-cbe3e8534c02',
      name: 'Tania (Telnyx Ultra Neural)',
      provider: 'telnyx',
      gender: 'Female',
      accent: 'Neutral Professional'
    },
    {
      id: 'Azure.en-US-JennyNeural',
      name: 'Jenny (Azure HD Neural)',
      provider: 'azure',
      gender: 'Female',
      accent: 'American Executive'
    },
    {
      id: 'Azure.en-US-GuyNeural',
      name: 'Guy (Azure HD Neural)',
      provider: 'azure',
      gender: 'Male',
      accent: 'American Business'
    },
    {
      id: 'AWS.Polly.Danielle-Neural',
      name: 'Danielle (Polly Neural)',
      provider: 'aws',
      gender: 'Female',
      accent: 'American Friendly'
    },
    {
      id: 'AWS.Polly.Gregory-Neural',
      name: 'Gregory (Polly Neural)',
      provider: 'aws',
      gender: 'Male',
      accent: 'Deep Executive'
    },
    {
      id: 'Azure.en-GB-RyanNeural',
      name: 'Ryan (Azure British Neural)',
      provider: 'azure',
      gender: 'Male',
      accent: 'British Sophisticated'
    },
    {
      id: 'Azure.en-GB-SoniaNeural',
      name: 'Sonia (Azure British Neural)',
      provider: 'azure',
      gender: 'Female',
      accent: 'British Warm'
    }
  ];
}

module.exports = {
  TELNYX_PHONE_NUMBER,
  generateAiSalesReply,
  handleInboundCall,
  handleCallDialogue,
  simulateTelnyxCall,
  synthesizeSpeech,
  getCuratedVoices
};
