const { z } = require('zod');
const { run, get, all } = require('../../db/database');
const { crmAudit, httpError } = require('../crm/crmAccess');

/**
 * Call logs and their transcripts. Audio is held in memory only for as long as it takes Telnyx to
 * transcribe it, and is never written anywhere. A transcript exists only when the caller ticked
 * "Transcribe this call", which the log records. Only the person who made a call can add to it.
 */
const TELNYX_TRANSCRIBE_URL = 'https://api.telnyx.com/v2/ai/audio/transcriptions';
const DEFAULT_MODEL = 'openai/whisper-large-v3-turbo'; // the default Telnyx model is English only
const TIMEOUT_MS = 120000;
const PAGE_SIZE = 25;
const AUDIO_TYPES = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4' };
const TRACKS = { agent: 'agent_segments', customer: 'customer_segments' };

const NAME_SQL = "COALESCE(NULLIF(u.display_name, ''), u.email)";
const SELECT = `SELECT l.*, ${NAME_SQL} AS caller_name, c.full_name AS contact_name
  FROM crm_call_logs l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN crm_contacts c ON c.id = l.contact_id`;

const endSchema = z.object({ durationSeconds: z.number().int().min(0).max(86400), answered: z.boolean(), audioCaptured: z.boolean().optional() }).strict();

const parse = v => { try { return JSON.parse(v) || []; } catch (err) { return []; } };
const likeOf = q => `%${String(q).slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`;

function requireId(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, 'Invalid call id.', 'VALIDATION_ERROR');
  return n;
}

function present(r) {
  return {
    id: r.id,
    phone: r.phone,
    name: r.contact_name || r.name || null,
    contactId: r.contact_id,
    callerName: r.caller_name || null,
    answered: !!r.answered,
    durationSeconds: r.duration_seconds,
    transcribed: !!r.transcribe,
    transcriptStatus: r.transcript_status,
    startedAt: r.started_at,
    endedAt: r.ended_at
  };
}

/** Both sides as one conversation, in time order. */
function conversation(r) {
  const side = (speaker, column) => parse(r[column]).map(s => ({ speaker, start: s.start, text: s.text }));
  return [...side('agent', 'agent_segments'), ...side('customer', 'customer_segments')].sort((a, b) => a.start - b.start);
}

async function createLog(ctx, { phone, name, contactId, transcribe, campaignId = null, email = null, leadId = null, leadWorkspaceId = null, followupId = null }) {
  const ins = await run(
    `INSERT INTO crm_call_logs (user_id, contact_id, phone, name, transcribe, transcript_status, campaign_id, email, lead_id, lead_workspace_id, followup_id, started_at)
     VALUES (?, ?, ?, ?, ?, 'none', ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
    [ctx.auth.userId, contactId ?? null, phone, name ? String(name).slice(0, 255) : null, transcribe ? 1 : 0,
      campaignId || null, email ? String(email).trim().toLowerCase().slice(0, 255) : null, leadId || null, leadWorkspaceId || null, followupId || null]
  );
  return ins.lastID;
}

async function requireOwnLog(ctx, rawId) {
  const row = await get('SELECT * FROM crm_call_logs WHERE id = ? AND user_id = ?', [requireId(rawId), ctx.auth.userId]);
  if (!row) throw httpError(404, 'Call not found.', 'NOT_FOUND');
  return row;
}

/** Recorded once, when the call ends. A transcript is expected only if it was asked for and answered. */
async function endLog(ctx, rawId, input) {
  const v = endSchema.parse(input || {});
  const row = await requireOwnLog(ctx, rawId);
  const wanted = row.transcribe && v.answered;
  const status = !wanted ? 'none' : v.audioCaptured === false ? 'failed' : 'pending';
  const ended = await run('UPDATE crm_call_logs SET duration_seconds = ?, answered = ?, transcript_status = ?, ended_at = UTC_TIMESTAMP() WHERE id = ? AND ended_at IS NULL', [v.durationSeconds, v.answered ? 1 : 0, status, row.id]);
  // A call made for a scheduled lead follow-up is linked to it (and completes it when answered).
  if (ended.changes && row.lead_id && row.followup_id) {
    await require('../leads/followups/activityService').linkCallToFollowup(row.lead_workspace_id, row.lead_id, row.followup_id, row.id, v.answered, row.user_id);
  }
  return { status };
}

async function transcribeAudio(buffer, contentType, apiKey) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), `call.${AUDIO_TYPES[contentType]}`);
  form.append('model', process.env.TELNYX_TRANSCRIPTION_MODEL || DEFAULT_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  let res;
  try {
    res = await fetch(TELNYX_TRANSCRIBE_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw httpError(502, 'Telnyx could not be reached, so this call was not transcribed.', 'TELNYX_UNREACHABLE');
  }
  if (!res.ok) {
    console.error(`[calling] Telnyx transcription returned HTTP ${res.status}`);
    throw httpError(502, 'Telnyx could not transcribe this call.', 'TRANSCRIPTION_FAILED');
  }
  const data = await res.json().catch(() => null);
  if (!data) throw httpError(502, 'Telnyx could not transcribe this call.', 'TRANSCRIPTION_FAILED');
  const clean = s => String(s || '').trim();
  const segments = (Array.isArray(data.segments) ? data.segments : [])
    .map(s => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: clean(s.text) })).filter(s => s.text);
  return segments.length || !clean(data.text) ? segments : [{ start: 0, end: 0, text: clean(data.text) }];
}

/** Takes one side of a finished call. The audio goes to Telnyx and is then dropped. */
async function addTrack(ctx, rawId, track, { buffer, contentType, apiKey }) {
  const column = TRACKS[track];
  if (!column) throw httpError(400, 'Unknown audio track.', 'VALIDATION_ERROR');
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!AUDIO_TYPES[type]) throw httpError(415, 'Unsupported audio format.', 'UNSUPPORTED_AUDIO');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw httpError(400, 'No audio was received.', 'VALIDATION_ERROR');
  const row = await requireOwnLog(ctx, rawId);
  if (!row.transcribe) throw httpError(409, 'This call was not set to be transcribed.', 'NOT_TRANSCRIBED');
  if (row.transcript_status !== 'pending' || row[column] !== null) throw httpError(409, 'This call has already been transcribed.', 'ALREADY_TRANSCRIBED');
  let segments;
  try {
    segments = await transcribeAudio(buffer, type, apiKey);
  } catch (err) {
    await run("UPDATE crm_call_logs SET transcript_status = 'failed' WHERE id = ?", [row.id]);
    throw err;
  }
  await run(`UPDATE crm_call_logs SET ${column} = ? WHERE id = ?`, [JSON.stringify(segments), row.id]);
  await run("UPDATE crm_call_logs SET transcript_status = 'done' WHERE id = ? AND agent_segments IS NOT NULL AND customer_segments IS NOT NULL AND transcript_status = 'pending'", [row.id]);
  await crmAudit(ctx, 'calling.transcript_added', { resourceType: 'call', resourceId: row.id, metadata: { track } });
  const fresh = await get('SELECT transcript_status FROM crm_call_logs WHERE id = ?', [row.id]);
  return { status: fresh.transcript_status };
}

async function listCalls(query = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (query.q) { where.push('(l.phone LIKE ? OR l.name LIKE ? OR c.full_name LIKE ?)'); params.push(...Array(3).fill(likeOf(query.q))); }
  if (query.contactId) { where.push('l.contact_id = ?'); params.push(requireId(query.contactId)); }
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const rows = await all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, params);
  const total = await get(`SELECT COUNT(*) AS n FROM crm_call_logs l LEFT JOIN crm_contacts c ON c.id = l.contact_id WHERE ${where.join(' AND ')}`, params);
  return { calls: rows.map(present), total: Number(total.n), page, pageSize: PAGE_SIZE };
}

async function requireCall(rawId) {
  const row = await get(`${SELECT} WHERE l.id = ?`, [requireId(rawId)]);
  if (!row) throw httpError(404, 'Call not found.', 'NOT_FOUND');
  return row;
}

/** Reading a transcript is audited: it is a record of what a customer said. */
async function getCall(ctx, rawId) {
  const row = await requireCall(rawId);
  if (row.transcribe) await crmAudit(ctx, 'calling.transcript_viewed', { resourceType: 'call', resourceId: row.id });
  return { call: { ...present(row), transcript: conversation(row) } };
}

/** Removes the text, for example when a customer asks. The log of the call stays. */
async function removeTranscript(ctx, rawId) {
  const row = await requireCall(rawId);
  await run("UPDATE crm_call_logs SET agent_segments = NULL, customer_segments = NULL, transcript_status = 'none', transcribe = 0 WHERE id = ?", [row.id]);
  await crmAudit(ctx, 'calling.transcript_removed', { resourceType: 'call', resourceId: row.id });
  return getCall(ctx, row.id);
}

module.exports = { createLog, endLog, addTrack, listCalls, getCall, removeTranscript, present, conversation, SELECT, TRACKS };
