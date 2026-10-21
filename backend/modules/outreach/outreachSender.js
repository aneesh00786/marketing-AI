const { run, get, all } = require('../../db/database');
const { partsInZone, zonedLocalToUtc, isValidTimeZone } = require('../../lib/time');
const emailService = require('../../services/emailService');
const { suppress } = require('./outreachService');
const automationEvents = require('../../lib/automationEvents');

const emitRecipient = (recipient, type) => recipient.lead_id && automationEvents.emit(recipient.workspace_id, type, {
  subjectType: 'lead', subjectId: recipient.lead_id, payload: { emailCampaignId: recipient.campaign_id, recipientId: recipient.id }, key: `${type}:${recipient.id}`
});

/**
 * Sends due outreach emails. Run by the worker every few seconds; safe to restart.
 * - A send row (unique per recipient + step) is written BEFORE calling the provider, so a
 *   step is never sent twice. A row left in 'sending' (crash mid-send) becomes needs_review
 *   and is never retried automatically, because the provider may have accepted it.
 * - Sending happens only inside the campaign's window (days + hours in its time zone) and
 *   within its daily limit.
 * - Replies (from the inbox sync) and unsubscribes stop the sequence for that recipient. They are
 *   checked every tick for emailed recipients, not only when their next email is due, and for
 *   REPLY_MONITOR_DAYS after the final email.
 */
const STALE_SENDING_MS = 10 * 60 * 1000;
const INBOX_SYNC_MS = 15 * 60 * 1000;
const REPLY_MONITOR_DAYS = 14;
const lastInboxSync = new Map();

const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function inWindow(campaign, now = new Date()) {
  const tz = isValidTimeZone(campaign.timezone) ? campaign.timezone : 'UTC';
  const day = WEEKDAY[new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now)];
  const { hour } = partsInZone(now, tz);
  const days = String(campaign.send_days || '').split(',').map(Number);
  return days.includes(day) && hour >= campaign.send_start_hour && hour < campaign.send_end_hour;
}

function localDayStartUtc(campaign, now = new Date()) {
  const tz = isValidTimeZone(campaign.timezone) ? campaign.timezone : 'UTC';
  const p = partsInZone(now, tz);
  const pad = n => String(n).padStart(2, '0');
  return zonedLocalToUtc(`${p.year}-${pad(p.month)}-${pad(p.day)}T00:00`, tz);
}

const dbTime = d => d.toISOString().replace('T', ' ').substring(0, 19);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render(step, recipient, campaign, senderEmail) {
  const first = String(recipient.name || '').trim().split(/\s+/)[0] || 'there';
  const fill = t => String(t)
    .replace(/\{\{\s*first_name\s*\}\}/gi, first)
    .replace(/\{\{\s*company\s*\}\}/gi, recipient.company || 'your team');
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const publicLink = /^https:\/\//i.test(base) && !/localhost|127\.0\.0\.1|\.local\b/i.test(base);
  const link = publicLink ? `${base}/api/v1/outreach/unsubscribe/${recipient.unsubscribe_token}` : null;
  const subject = fill(step.subject);
  const body = fill(step.body_text);
  const footer = `You are receiving this email from ${senderEmail}. To stop these emails, reply "unsubscribe"${link ? ` or open ${link}` : ''}.`;
  const text = `${body}\n\n--\n${footer}`;
  const html = `<div style="font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #1e293b;">${esc(body).replace(/\n/g, '<br>')}`
    + `<hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0 12px;"><p style="font-size: 12px; color: #64748b;">You are receiving this email from ${esc(senderEmail)}. To stop these emails, reply "unsubscribe"`
    + `${link ? ` or <a href="${esc(link)}">unsubscribe here</a>` : ''}.</p></div>`;
  return { subject, text, html };
}

/** A recipient address error from the provider (hard bounce at send time). */
const BOUNCE_RE = /(5\.1\.[0-9]|550|553|mailbox (unavailable|not found|does not exist)|user unknown|no such user|recipient (address )?rejected|invalid recipient|address rejected)/i;

async function heartbeat(workerId) {
  await run("INSERT INTO worker_heartbeats (worker_kind, worker_id, beat_at) VALUES ('outreach', ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE worker_id = VALUES(worker_id), beat_at = VALUES(beat_at)", [workerId]);
}

async function recoverStale() {
  const cutoff = dbTime(new Date(Date.now() - STALE_SENDING_MS));
  const stale = await all("SELECT id, recipient_id, workspace_id FROM outreach_sends WHERE status = 'sending' AND created_at < ?", [cutoff]);
  for (const s of stale) {
    await run("UPDATE outreach_sends SET status = 'needs_review', error = 'The worker stopped during this send; it may or may not have been delivered.' WHERE id = ? AND status = 'sending'", [s.id]);
    await run("UPDATE outreach_recipients SET status = 'needs_review', next_send_at = NULL, last_error = 'Delivery of the last email is unknown; check the mailbox before continuing.', updated_at = UTC_TIMESTAMP() WHERE id = ? AND workspace_id = ?", [s.recipient_id, s.workspace_id]);
  }
  return stale.length;
}

/** Reply or unsubscribe-by-reply from this address since the first email (needs the inbox sync). */
async function replyState(recipient) {
  if (!recipient.first_sent_at) return null;
  const reply = await get(
    `SELECT subject, body FROM emails WHERE workspace_id = ? AND LOWER(sender_email) = LOWER(?) AND smtp_status LIKE 'Received%' AND received_at > ? ORDER BY id DESC LIMIT 1`,
    [recipient.workspace_id, recipient.email, recipient.first_sent_at]
  );
  if (!reply) return null;
  return /\bunsubscribe\b|\bremove me\b|\bstop emailing\b/i.test(`${reply.subject} ${reply.body}`) ? 'unsubscribed' : 'replied';
}

async function syncInboxes(workspaceIds) {
  for (const wsId of [...new Set(workspaceIds)]) {
    if (Date.now() - (lastInboxSync.get(wsId) || 0) < INBOX_SYNC_MS) continue;
    lastInboxSync.set(wsId, Date.now());
    try { await emailService.syncIncomingEmails(wsId); } catch (e) { /* IMAP not configured or unreachable: replies are detected once it works */ }
  }
}

// Recipients whose replies are still monitored: emailed and active, or completed within the window.
const MONITORED = `r.first_sent_at IS NOT NULL AND c.status IN ('running', 'paused', 'completed')
  AND (r.status = 'active' OR (r.status = 'completed' AND r.last_sent_at >= UTC_TIMESTAMP() - INTERVAL ${REPLY_MONITOR_DAYS} DAY))`;

/**
 * Records replies without waiting for the next send. Only recipients with an inbound email
 * since their first email are loaded, and the status update is conditional, so each reply is
 * recorded (and its event emitted) once. Replies to a completed sequence count only when they
 * arrive within REPLY_MONITOR_DAYS of the final email.
 */
async function detectReplies({ limit = 200 } = {}) {
  const candidates = await all(
    `SELECT r.* FROM outreach_recipients r JOIN outreach_campaigns c ON c.id = r.campaign_id
     WHERE ${MONITORED}
       AND EXISTS (SELECT 1 FROM emails e WHERE e.workspace_id = r.workspace_id AND LOWER(e.sender_email) = LOWER(r.email) AND e.smtp_status LIKE 'Received%'
                   AND e.received_at > r.first_sent_at AND (r.status = 'active' OR e.received_at <= r.last_sent_at + INTERVAL ${REPLY_MONITOR_DAYS} DAY))
     ORDER BY r.id LIMIT ${limit}`
  );
  let recorded = 0;
  for (const recipient of candidates) {
    const state = await replyState(recipient);
    if (!state) continue;
    const u = await run("UPDATE outreach_recipients SET status = ?, next_send_at = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ? AND status IN ('active', 'completed')", [state, recipient.id]);
    if (!u.changes) continue;
    if (state === 'unsubscribed') await suppress(recipient.workspace_id, recipient.email, 'unsubscribed', 'reply');
    await emitRecipient(recipient, state === 'unsubscribed' ? 'email.unsubscribed' : 'email.replied');
    recorded++;
  }
  return recorded;
}

async function claim(recipient, step, workerId) {
  try {
    const r = await run(
      "INSERT INTO outreach_sends (workspace_id, campaign_id, recipient_id, step_id, step_order, status, worker_id, created_at) VALUES (?, ?, ?, ?, ?, 'sending', ?, UTC_TIMESTAMP())",
      [recipient.workspace_id, recipient.campaign_id, recipient.id, step.id, step.step_order, workerId]
    );
    return r.lastID;
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    // Only an explicitly retried failure may be claimed again.
    const retry = await run("UPDATE outreach_sends SET status = 'sending', error = NULL, worker_id = ?, created_at = UTC_TIMESTAMP() WHERE recipient_id = ? AND step_id = ? AND status = 'retry'", [workerId, recipient.id, step.id]);
    if (!retry.changes) return null;
    return (await get('SELECT id FROM outreach_sends WHERE recipient_id = ? AND step_id = ?', [recipient.id, step.id])).id;
  }
}

async function finishCampaignIfDone(campaign) {
  const left = await get("SELECT COUNT(*) AS n FROM outreach_recipients WHERE campaign_id = ? AND status IN ('pending', 'active', 'needs_review')", [campaign.id]);
  if (Number(left.n) === 0) {
    await run("UPDATE outreach_campaigns SET status = 'completed', completed_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'running'", [campaign.id]);
  }
}

async function sendOne(campaign, recipient, workerId) {
  const state = await replyState(recipient);
  if (state === 'unsubscribed') { await suppress(recipient.workspace_id, recipient.email, 'unsubscribed', 'reply'); await emitRecipient(recipient, 'email.unsubscribed'); return 'unsubscribed'; }
  if (state === 'replied') {
    await run("UPDATE outreach_recipients SET status = 'replied', next_send_at = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?", [recipient.id]);
    await emitRecipient(recipient, 'email.replied');
    return 'replied';
  }
  const suppressed = await get('SELECT reason FROM email_suppressions WHERE workspace_id = ? AND email = ?', [recipient.workspace_id, String(recipient.email).toLowerCase()]);
  if (suppressed) {
    await run("UPDATE outreach_recipients SET status = 'suppressed', next_send_at = NULL, last_error = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?", [`Suppressed: ${suppressed.reason}`, recipient.id]);
    return 'suppressed';
  }
  const steps = await all('SELECT * FROM outreach_steps WHERE campaign_id = ? ORDER BY step_order', [campaign.id]);
  const step = steps.find(s => s.step_order === recipient.next_step_order);
  if (!step) {
    await run("UPDATE outreach_recipients SET status = 'completed', next_send_at = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?", [recipient.id]);
    await emitRecipient(recipient, 'email.sequence_completed');
    return 'completed';
  }
  const sendId = await claim(recipient, step, workerId);
  if (!sendId) return 'skipped';

  // A/B test: the tested step uses the recipient's variant while the test runs, the declared
  // winner after it concludes, and the original (A) otherwise. The send records the variant.
  let content = step;
  let variantLabel = null;
  const test = await get("SELECT status, step_order, winner_label FROM ab_tests WHERE workspace_id = ? AND outreach_campaign_id = ? AND kind = 'email' AND status IN ('running', 'concluded') ORDER BY id DESC LIMIT 1", [recipient.workspace_id, campaign.id]);
  if (test && test.step_order === step.step_order) {
    variantLabel = test.status === 'running' ? (recipient.variant_label || 'A') : (test.winner_label || 'A');
    if (variantLabel === 'B') {
      const b = await get("SELECT subject, body_text FROM outreach_step_variants WHERE campaign_id = ? AND step_order = ? AND label = 'B'", [campaign.id, step.step_order]);
      if (b) content = { ...step, subject: b.subject, body_text: b.body_text };
      else variantLabel = 'A';
    }
    await run('UPDATE outreach_sends SET variant_label = ? WHERE id = ?', [variantLabel, sendId]);
  }

  const cfg = await emailService.getRawMailConfig(recipient.workspace_id);
  const sender = cfg.sender_email || cfg.smtp_user || 'our team';
  const msg = render(content, recipient, campaign, sender);
  try {
    const res = await emailService.sendRealEmail(recipient.workspace_id, { to: recipient.email, recipientName: recipient.name || '', subject: msg.subject, html: msg.html, text: msg.text, campaignId: null });
    await run("UPDATE outreach_sends SET status = 'sent', email_id = ?, provider_message_id = ?, sent_at = UTC_TIMESTAMP() WHERE id = ?", [res.emailId, String(res.messageId || '').slice(0, 255), sendId]);
    const next = steps.find(s => s.step_order === step.step_order + 1);
    const nextAt = next ? dbTime(new Date(Date.now() + next.delay_days * 86400000)) : null;
    await run(
      `UPDATE outreach_recipients SET status = ?, next_step_order = ?, next_send_at = ?, first_sent_at = COALESCE(first_sent_at, UTC_TIMESTAMP()), last_sent_at = UTC_TIMESTAMP(), last_error = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?`,
      [next ? 'active' : 'completed', step.step_order + 1, nextAt, recipient.id]
    );
    if (!next) await emitRecipient(recipient, 'email.sequence_completed');
    return 'sent';
  } catch (err) {
    const message = String(err.message || 'Send failed').slice(0, 500);
    await run("UPDATE outreach_sends SET status = 'failed', error = ? WHERE id = ?", [message, sendId]);
    if (err.code === 'MAIL_NOT_CONFIGURED') {
      // Nothing can be sent for this workspace: pause the whole campaign with the reason.
      await run("UPDATE outreach_sends SET status = 'retry' WHERE id = ?", [sendId]);
      await run("UPDATE outreach_campaigns SET status = 'paused', last_error = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?", [message, campaign.id]);
      return 'paused';
    }
    if (BOUNCE_RE.test(message) || err.code === 'INVALID_RECIPIENT') {
      await suppress(recipient.workspace_id, recipient.email, 'bounced', 'send_error');
      await run("UPDATE outreach_recipients SET status = 'bounced', next_send_at = NULL, last_error = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?", [message, recipient.id]);
      return 'bounced';
    }
    await run("UPDATE outreach_recipients SET status = 'failed', next_send_at = NULL, last_error = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?", [message, recipient.id]);
    return 'failed';
  }
}

/** One worker tick. Returns how many recipients were processed. */
async function processOutreach(workerId, { maxPerTick = 20, now = new Date() } = {}) {
  await heartbeat(workerId);
  await recoverStale();
  const monitored = await all(`SELECT DISTINCT r.workspace_id FROM outreach_recipients r JOIN outreach_campaigns c ON c.id = r.campaign_id WHERE ${MONITORED}`);
  if (monitored.length) {
    await syncInboxes(monitored.map(m => m.workspace_id));
    await detectReplies();
  }
  const campaigns = await all("SELECT * FROM outreach_campaigns WHERE status = 'running'");
  if (!campaigns.length) return 0;

  let processed = 0;
  for (const campaign of campaigns) {
    if (processed >= maxPerTick) break;
    if (!inWindow(campaign, now)) continue;
    const today = await get(
      "SELECT COUNT(*) AS n FROM outreach_sends WHERE campaign_id = ? AND status IN ('sent', 'sending', 'needs_review') AND created_at >= ?",
      [campaign.id, dbTime(localDayStartUtc(campaign, now))]
    );
    let room = Math.min(campaign.daily_limit - Number(today.n), maxPerTick - processed);
    if (room <= 0) continue;
    const due = await all(
      `SELECT * FROM outreach_recipients WHERE campaign_id = ? AND status = 'active' AND next_send_at IS NOT NULL AND next_send_at <= UTC_TIMESTAMP() ORDER BY next_send_at, id LIMIT ${Math.max(1, room)}`,
      [campaign.id]
    );
    for (const recipient of due) {
      const fresh = await get("SELECT status FROM outreach_campaigns WHERE id = ?", [campaign.id]);
      if (!fresh || fresh.status !== 'running') break;
      const outcome = await sendOne(campaign, recipient, workerId);
      processed++;
      if (outcome === 'paused') break;
      if (outcome === 'sent' && --room <= 0) break;
    }
    await finishCampaignIfDone(campaign);
  }
  return processed;
}

module.exports = { processOutreach, inWindow, render, recoverStale, detectReplies, REPLY_MONITOR_DAYS };
