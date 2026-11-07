/**
 * Amazon SES events through Amazon SNS (configuration set → SNS topic → HTTPS subscription to
 * /api/v1/mail/t/webhooks/ses/<workspace token>). Records delivered, bounced, complaints, delays
 * and rejections in the same mail tracking as other emails; opens and clicks are tracked by
 * Marketech.ai itself, so SES open/click events are ignored (never counted twice).
 *
 * Every message is verified before anything is done with it:
 * - SNS signature (SignatureVersion 1 = SHA1, 2 = SHA256) with the certificate from SigningCertURL,
 *   which must be an https .pem on an Amazon SNS host (sns.<region>.amazonaws.com);
 * - only the topic confirmed for this workspace is accepted once one is confirmed;
 * - a SubscriptionConfirmation is confirmed by visiting its SubscribeURL (also an SNS host only).
 * Each SNS message id is handled once. A hard bounce or a complaint adds the address to the
 * workspace's stop-list, as with other providers. Nothing here sends email.
 */
const crypto = require('crypto');
const { run, get } = require('../../../db/database');
const { audit } = require('../../../lib/audit');

const SNS_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const certCache = new Map();

/** HTTPS GET of an Amazon SNS URL (certificate, subscription confirmation). Replaceable in tests. */
let fetchText = async url => {
  const { safeFetchText } = require('../../../lib/safeFetch');
  const r = await safeFetchText(url, { timeoutMs: 10000, maxBytes: 64 * 1024 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text;
};
function setFetchForTests(fn) { fetchText = fn; certCache.clear(); }

function snsUrl(raw, { pem = false } = {}) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return null; }
  if (u.protocol !== 'https:' || !SNS_HOST_RE.test(u.hostname) || u.username || u.password || u.port) return null;
  if (pem && !/\.pem$/.test(u.pathname)) return null;
  return u.toString();
}

/** The text SNS signs, for the message type (documented field order). */
function stringToSign(m) {
  const keys = m.Type === 'Notification'
    ? ['Message', 'MessageId', ...(m.Subject !== undefined && m.Subject !== null ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
    : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.map(k => `${k}\n${m[k]}\n`).join('');
}

async function verifySignature(m) {
  const certUrl = snsUrl(m.SigningCertURL || m.SigningCertUrl, { pem: true });
  if (!certUrl || !m.Signature) return false;
  const algo = String(m.SignatureVersion) === '2' ? 'RSA-SHA256' : String(m.SignatureVersion) === '1' ? 'RSA-SHA1' : null;
  if (!algo) return false;
  let cert = certCache.get(certUrl);
  if (!cert) {
    cert = await fetchText(certUrl);
    if (!/BEGIN (CERTIFICATE|PUBLIC KEY)/.test(cert)) return false;
    certCache.set(certUrl, cert);
  }
  try {
    return crypto.createVerify(algo).update(stringToSign(m), 'utf8').verify(cert, String(m.Signature), 'base64');
  } catch {
    return false;
  }
}

const SES_TYPE = {
  Delivery: 'delivered', Bounce: null, Complaint: 'complaint', Reject: 'failed', RenderingFailure: 'failed', DeliveryDelay: 'soft_bounce'
};

/** One SES event (event publishing "eventType", or identity notifications "notificationType"). */
async function applySesEvent(workspaceId, ev, snsMessageId) {
  const kind = ev.eventType || ev.notificationType;
  const messageId = ev.mail?.messageId;
  if (!kind || !messageId) return { ignored: 'not an SES event' };
  // SES's own open and click tracking (if turned on in the configuration set) is not counted:
  // Marketech.ai tracks opens and clicks itself, so counting both would double them. It is noted, so
  // Settings can say to turn it off.
  if (kind === 'Open' || kind === 'Click') {
    await run('UPDATE mail_delivery_settings SET ses_engagement_seen_at = UTC_TIMESTAMP() WHERE workspace_id = ?', [workspaceId]).catch(() => null);
    return { ignored: kind };
  }
  if (['Send', 'Subscription', 'AmazonSnsSubscriptionSucceeded'].includes(kind)) return { ignored: kind };
  const t = await get("SELECT id, workspace_id FROM mail_message_tracking WHERE workspace_id = ? AND provider = 'ses' AND provider_message_id = ?", [workspaceId, String(messageId).slice(0, 255)]);
  if (!t) return { ignored: 'unknown message' };
  const tracking = require('../tracking/trackingService');
  let type = SES_TYPE[kind];
  let detailCode = null;
  let detail = null;
  let occurred = ev.mail?.timestamp;
  if (kind === 'Bounce') {
    const permanent = ev.bounce?.bounceType === 'Permanent';
    type = permanent ? 'hard_bounce' : 'soft_bounce';
    detailCode = [ev.bounce?.bounceType, ev.bounce?.bounceSubType].filter(Boolean).join('/').slice(0, 64) || null;
    detail = String(ev.bounce?.bouncedRecipients?.[0]?.diagnosticCode || '').slice(0, 255) || null;
    occurred = ev.bounce?.timestamp || occurred;
  } else if (kind === 'Complaint') {
    detailCode = ev.complaint?.complaintFeedbackType || null;
    occurred = ev.complaint?.timestamp || occurred;
  } else if (kind === 'Delivery') {
    occurred = ev.delivery?.timestamp || occurred;
  } else if (kind === 'DeliveryDelay') {
    detailCode = ev.deliveryDelay?.delayType || null;
    occurred = ev.deliveryDelay?.timestamp || occurred;
  } else if (kind === 'Reject') {
    detail = String(ev.reject?.reason || '').slice(0, 255) || null;
  } else if (kind === 'RenderingFailure') {
    detail = String(ev.failure?.errorMessage || '').slice(0, 255) || null;
  }
  if (!type) return { ignored: kind };
  const at = new Date(occurred || Date.now());
  const r = await tracking.recordEvent(workspaceId, t.id, {
    type, source: 'ses', occurredAt: isNaN(at) ? new Date() : at, providerEventId: snsMessageId,
    basis: `${messageId}|${kind}|${occurred || ''}`, detailCode, detail
  });
  // The approved safeguard: a hard bounce or a complaint stops further marketing email to the address.
  if (r.applied && (type === 'hard_bounce' || type === 'complaint')) await suppress(workspaceId, t.id, type === 'complaint' ? 'complaint' : 'bounced');
  // An address that keeps soft-bouncing (3 times in 30 days, never delivered since) is stopped too.
  if (r.applied && type === 'soft_bounce' && kind === 'Bounce') {
    const rec = await get('SELECT r.email FROM mail_campaign_recipients r JOIN mail_message_tracking t ON t.campaign_recipient_id = r.id WHERE t.id = ? AND r.workspace_id = ?', [t.id, workspaceId]);
    const n = rec ? await get(`SELECT SUM(e.event_type = 'soft_bounce') AS soft, SUM(t2.delivered_at IS NOT NULL AND t2.delivered_at > e.occurred_at) AS later
      FROM mail_campaign_recipients r JOIN mail_message_tracking t2 ON t2.campaign_recipient_id = r.id JOIN mail_events e ON e.tracking_id = t2.id AND e.source = 'ses'
      WHERE r.workspace_id = ? AND r.email = ? AND e.event_type = 'soft_bounce' AND e.detail_code LIKE 'Transient%' AND e.occurred_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY`, [workspaceId, rec.email]) : null;
    if (Number(n?.soft) >= 3 && !Number(n?.later)) await suppress(workspaceId, t.id, 'soft_bounced');
  }
  return { applied: !!r.applied, type };
}

async function suppress(workspaceId, trackingId, reason) {
  const rec = await get('SELECT r.email FROM mail_campaign_recipients r JOIN mail_message_tracking t ON t.campaign_recipient_id = r.id WHERE t.id = ? AND r.workspace_id = ?', [trackingId, workspaceId]);
  const email = String(rec?.email || '').trim().toLowerCase();
  if (!email) return;
  const ins = await run('INSERT IGNORE INTO email_suppressions (workspace_id, email, reason, source, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())', [workspaceId, email, reason, 'ses_sns']);
  if (ins.changes) await audit({ workspaceId, userId: null, actorType: 'provider' }, 'mail.recipient_suppressed', { resourceType: 'mail_tracking', resourceId: trackingId, metadata: { reason, source: 'ses_sns' } });
}

/**
 * Handles one POST from SNS. Returns { status, body } for the route. Unknown workspace token or a bad
 * signature: 404 / 403 (nothing recorded).
 */
async function handle(token, rawBody) {
  if (!/^[a-f0-9]{32}$/.test(String(token || ''))) return { status: 404, body: 'Not found' };
  const settings = await get('SELECT workspace_id, ses_sns_topic_arn FROM mail_delivery_settings WHERE sns_token = ?', [token]);
  if (!settings) return { status: 404, body: 'Not found' };
  let m;
  try { m = JSON.parse(String(rawBody || '')); } catch { return { status: 400, body: 'Bad request' }; }
  if (!m || typeof m !== 'object' || !m.Type || !m.MessageId || !m.TopicArn) return { status: 400, body: 'Bad request' };
  const refuse = (status, body) => {
    console.warn(`[ses-sns] ${JSON.stringify({ refused: body, workspaceId: settings.workspace_id, type: m.Type, topicArn: String(m.TopicArn).slice(0, 255), confirmedTopicArn: settings.ses_sns_topic_arn || null })}`);
    return { status, body };
  };
  if (!(await verifySignature(m).catch(() => false))) return refuse(403, 'Signature not valid');
  const ts = Date.parse(m.Timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_AGE_MS) return refuse(403, 'Too old');
  if (settings.ses_sns_topic_arn && settings.ses_sns_topic_arn !== m.TopicArn) return refuse(403, 'Unknown topic');
  const workspaceId = settings.workspace_id;

  if (m.Type === 'SubscriptionConfirmation') {
    const url = snsUrl(m.SubscribeURL);
    if (!url) return { status: 400, body: 'Bad subscribe URL' };
    await fetchText(url);
    await run('UPDATE mail_delivery_settings SET ses_sns_topic_arn = ? WHERE workspace_id = ? AND (ses_sns_topic_arn IS NULL OR ses_sns_topic_arn = ?)', [String(m.TopicArn).slice(0, 255), workspaceId, m.TopicArn]);
    await audit({ workspaceId, userId: null, actorType: 'provider' }, 'mail.ses_sns_confirmed', { resourceType: 'mail_provider', resourceId: 'ses', metadata: { topicArn: String(m.TopicArn).slice(0, 255) } });
    return { status: 200, body: 'Confirmed' };
  }
  if (m.Type === 'UnsubscribeConfirmation') return { status: 200, body: 'OK' };
  if (m.Type !== 'Notification') return { status: 400, body: 'Bad request' };

  // Each SNS message once (SNS may deliver it again).
  const dup = await run('INSERT IGNORE INTO mail_ses_notifications (workspace_id, sns_message_id, received_at) VALUES (?, ?, UTC_TIMESTAMP())', [workspaceId, String(m.MessageId).slice(0, 100)]);
  if (!dup.changes) return { status: 200, body: 'Already handled' };
  let ev;
  try { ev = JSON.parse(m.Message); } catch { return { status: 200, body: 'Ignored' }; }
  const r = await applySesEvent(workspaceId, ev, m.MessageId);
  console.info(`[ses-sns] ${JSON.stringify({ workspaceId, event: ev.eventType || ev.notificationType || null, applied: !!r.applied })}`);
  await run('UPDATE mail_ses_notifications SET event_type = ? WHERE workspace_id = ? AND sns_message_id = ?', [String(ev.eventType || ev.notificationType || '').slice(0, 30) || null, workspaceId, String(m.MessageId).slice(0, 100)]);
  return { status: 200, body: r.applied ? 'Recorded' : 'Ignored' };
}

module.exports = { handle, verifySignature, stringToSign, applySesEvent, snsUrl, setFetchForTests };
