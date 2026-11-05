const { audit } = require('../../lib/audit');
const { get } = require('../../db/database');
const logs = require('./callLogService');

/**
 * Browser calling through Telnyx WebRTC. The browser asks for a short-lived token and places the
 * call itself, over the user's microphone and speakers. Every call is logged. Audio is never
 * stored; a call is transcribed only if the caller ticks the box (see callLogService.js).
 *
 * A token can dial any number on the company's Telnyx account, so access follows the CRM grant
 * (crm.manage), not workspace roles: anyone who registers owns a workspace. The Telnyx key never
 * leaves the server. Calling has its own settings (TELNYX_WEBRTC_*), so it cannot switch on the
 * other Telnyx features, which use TELNYX_API_KEY.
 */
const TELNYX_API = 'https://api.telnyx.com/v2';
const TIMEOUT_MS = 15000;
const CREDENTIAL_TTL_MS = 2 * 60 * 60 * 1000;

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

const settings = () => ({
  apiKey: process.env.TELNYX_WEBRTC_API_KEY || '',
  connectionId: process.env.TELNYX_WEBRTC_CONNECTION_ID || '',
  callerId: process.env.TELNYX_CALLER_ID || '',
  callerName: process.env.TELNYX_CALLER_NAME || ''
});

const isConfigured = () => {
  const s = settings();
  return !!(s.apiKey && s.connectionId && s.callerId);
};

/** "+91 98765-43210" becomes "+919876543210"; null unless it is a complete international number. */
function normalizeNumber(value) {
  const digits = String(value || '').replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(digits) ? digits : null;
}

async function telnyxPost(path, apiKey, body) {
  let res;
  try {
    res = await fetch(`${TELNYX_API}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    throw httpError(502, 'Telnyx could not be reached. Try again.', 'TELNYX_UNREACHABLE');
  }
  const text = await res.text();
  if (!res.ok) {
    console.error(`[calling] Telnyx ${path.split('/').slice(0, 2).join('/')} returned HTTP ${res.status}`);
    throw httpError(502, 'Telnyx refused the call setup. Check the calling settings.', 'TELNYX_REFUSED');
  }
  try { return JSON.parse(text); } catch (err) { return text; }
}

/**
 * A credential that expires by itself (none are left behind on the account) and a token for it.
 * The destination is checked and audited here; only its last digits are stored.
 */
async function startSession(ctx, { to, name, contactId, transcribe, campaignId, email } = {}) {
  if (!isConfigured()) throw httpError(503, 'Calling is not set up on this server.', 'CALLING_NOT_CONFIGURED');
  const destination = normalizeNumber(to);
  if (!destination) throw httpError(400, 'Enter the full number with its country code, like +91 98765 43210.', 'INVALID_NUMBER');
  if (contactId !== undefined && contactId !== null && !(await get('SELECT 1 AS x FROM crm_contacts WHERE id = ?', [Number(contactId) || 0]))) {
    throw httpError(400, 'Choose an existing contact.', 'INVALID_CONTACT');
  }
  // A follow-up call from a campaign's results: the campaign must be in the caller's workspace.
  let campaign = null;
  if (campaignId !== undefined && campaignId !== null) {
    campaign = await get('SELECT id FROM mail_campaigns WHERE id = ? AND workspace_id = ?', [Number(campaignId) || 0, ctx.auth.workspaceId || 0]);
    if (!campaign) throw httpError(400, 'Choose an existing campaign.', 'INVALID_CAMPAIGN');
  }
  const followEmail = typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && email.trim().length <= 255 ? email.trim() : null;
  const s = settings();
  const credential = await telnyxPost('/telephony_credentials', s.apiKey, {
    connection_id: s.connectionId,
    name: `Marketech user ${ctx.auth.userId} ${Date.now()}`,
    expires_at: new Date(Date.now() + CREDENTIAL_TTL_MS).toISOString()
  });
  const credentialId = credential?.data?.id;
  if (!credentialId) throw httpError(502, 'Telnyx did not create the call credential.', 'TELNYX_BAD_RESPONSE');
  const tokenRes = await telnyxPost(`/telephony_credentials/${encodeURIComponent(credentialId)}/token`, s.apiKey);
  const token = typeof tokenRes === 'string' ? tokenRes : tokenRes?.data?.token || tokenRes?.token;
  if (!token) throw httpError(502, 'Telnyx did not return a call token.', 'TELNYX_BAD_RESPONSE');
  const callLogId = await logs.createLog(ctx, { phone: destination, name, contactId, transcribe: transcribe === true, campaignId: campaign ? campaign.id : null, email: followEmail });
  await audit({ auth: { ...ctx.auth, workspaceId: null }, requestId: ctx.requestId, ip: ctx.ip }, 'calling.call_started', {
    resourceType: 'call', resourceId: callLogId, metadata: { numberEnding: destination.slice(-4), transcribe: transcribe === true }
  });
  return { token, destination, callerId: s.callerId, callerName: s.callerName || null, callLogId };
}

const addTrack = (ctx, id, track, audio) => logs.addTrack(ctx, id, track, { ...audio, apiKey: settings().apiKey });

module.exports = { isConfigured, normalizeNumber, startSession, addTrack };
