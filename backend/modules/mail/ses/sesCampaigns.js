const crypto = require('crypto');
/**
 * Campaigns sent with Amazon SES: write → recipients → approve → send. Marketech.ai sends each
 * email itself:
 *
 * 1. prepare: the recipients are fixed for this campaign version, one row each in
 *    mail_campaign_recipients (unique per address): people in the chosen contact lists who may get
 *    marketing email (subscribed, not stopped, with marketing consent: contacts/consent.js) and the
 *    eligible picked contacts.
 * 2. the worker (job "ses_campaign_send") sends to them in parts, at the account's sending rate:
 *    each row is claimed (queued → sending) before the SES call, so a retried job never emails anyone
 *    twice; an unclear SES reply leaves that row "unknown" and it is never resent automatically.
 *    Each email is personalized (merge tags), carries the campaign's own unsubscribe link (and the
 *    List-Unsubscribe header), and Marketech.ai's open pixel and tracked links (mail tracking).
 * 3. SES reports delivered / bounced / complaints through SNS (snsWebhook.js) into the same tracking.
 * 4. the report and per-recipient activity are read from Marketech.ai's own records.
 * A hard stop from SES (sending paused, sender not verified, configuration set missing) stops the
 * campaign with SES's reason; Send again continues with the people not yet emailed.
 */
const { run, get, all } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const { toDbDateTime } = require('../../../lib/time');
const settings = require('./sesSettings');
const ses = require('./sesClient');

const PART = Math.max(1, Number(process.env.SES_SEND_PART || 200));        // emails per job run
const PART_MS = Math.max(1000, Number(process.env.SES_SEND_PART_MS || 55000)); // time per job run
const STOP_CODES = new Set(['AccountSuspendedException', 'SendingPausedException', 'MailFromDomainNotVerifiedException', 'NotFoundException', 'AccessDeniedException',
  'UnrecognizedClientException', 'InvalidClientTokenId', 'SignatureDoesNotMatch', 'ConfigurationSetDoesNotExistException', 'ConfigurationSetSendingPausedException']);
const THROTTLE_CODES = new Set(['TooManyRequestsException', 'ThrottlingException', 'LimitExceededException']);

const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const escapeHtml = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Merge tags for one person: $[FNAME|default]$, $[LNAME|]$, $[UD:CONTACT_EMAIL]$ and {{first_name}}. (zoho_status holds the send status.) */
function personalize(text, p, { html }) {
  const val = v => (html ? escapeHtml(v) : v);
  return String(text || '')
    .replace(/\{\{\s*first_name\s*\}\}/gi, () => val(p.first_name || 'there'))
    .replace(/\{\{\s*last_name\s*\}\}/gi, () => val(p.last_name || ''))
    .replace(/\$\[(FNAME|LNAME|UD:CONTACT_EMAIL|EMAIL)(?:\|([^\]|]*))?\|?\]\$/gi, (m, tag, def) => {
      const t = tag.toUpperCase();
      const v = t === 'FNAME' ? p.first_name : t === 'LNAME' ? p.last_name : p.email;
      return val(v || def || '');
    });
}

/** Any merge tag still in a text ($[...]$): nothing may be sent with one. */
const LEFTOVER_TAG_RE = /\$\[[^\]\n]{1,80}\]\$/g;
const leftoverTags = text => [...new Set(String(text || '').match(LEFTOVER_TAG_RE) || [])];

/** The workspace's business address (business profile), for $[HF:ORGADDRESS]$; null when not set. */
async function orgAddressOf(workspaceId) {
  const r = await get("SELECT address FROM business_profiles WHERE workspace_id = ? ORDER BY id DESC LIMIT 1", [workspaceId]);
  const a = String(r?.address || '').trim();
  return a || null;
}

/** "View in browser" page of one recipient (opaque token). */
const viewUrlOf = token => (publicBase() && token ? `${publicBase()}/api/v1/mail/view/${token}` : null);

/**
 * One recipient's email as sent: the unsubscribe and "View in browser" links ($[LI:UNSUBSCRIBE]$,
 * $[LI:VIEWINBROWSER]$, as links or as text), the business address ($[HF:ORGADDRESS]$, line breaks
 * kept) and the name tags. unresolved: any merge tag still left (subject or body); nothing is sent then.
 */
function renderFor(row, r, { orgAddress = null, unsubscribeUrl = null, viewUrl = null } = {}) {
  let html = String(row.html_content || '');
  const linkTag = (names, url) => {
    if (!url) return;
    const re = new RegExp(`href\\s*=\\s*(["'])\\$\\[LI:(?:${names})\\]\\$\\1`, 'gi');
    html = html.replace(re, (_m, q) => `href=${q}${escapeHtml(url)}${q}`)
      .replace(new RegExp(`\\$\\[LI:(?:${names})\\]\\$`, 'gi'), escapeHtml(url));
  };
  linkTag('UNSUBSCRIBE|ORG_OPTOUT', unsubscribeUrl);
  linkTag('VIEWINBROWSER', viewUrl);
  if (orgAddress) html = html.replace(/\$\[HF:ORGADDRESS\]\$/gi, () => escapeHtml(orgAddress).replace(/\r?\n/g, '<br />'));
  html = personalize(html, r, { html: true });
  const subject = personalize(row.subject, r, { html: false }).replace(/[\r\n]+/g, ' ').slice(0, 255);
  return { html, subject, unresolved: [...new Set([...leftoverTags(subject), ...leftoverTags(html)])] };
}

const textOf = html => String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h\d|li|tr)>/gi, '\n')
  .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();

/** Builds the MIME message (nodemailer's composer: correct encoding of names, subjects and parts). */
function buildRaw({ from, to, subject, html, unsubscribeUrl }) {
  const MailComposer = require('nodemailer/lib/mail-composer');
  return new Promise((resolve, reject) => {
    new MailComposer({
      from, to, subject, html, text: textOf(html),
      headers: unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}
    }).compile().build((err, buf) => (err ? reject(err) : resolve(buf)));
  });
}

/** The people this campaign version goes to, written once (unique per address). Returns the count. */
async function prepare(ctx, row) {
  const workspaceId = row.workspace_id;
  const contactsSvc = require('../campaigns/campaignContacts');
  const upload = require('../contacts/recipients');
  const people = new Map();
  const add = (p) => {
    const email = String(p.email || '').trim().toLowerCase();
    // Only well-formed addresses (a malformed one can only bounce and hurt the sender's reputation).
    if (!email || people.has(email) || !/^[^\s@"<>,;]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(email)) return;
    const n = contactsSvc.greetingName({ name: p.name || [p.first_name, p.last_name].filter(Boolean).join(' '), company: p.company }) || {};
    people.set(email, { email, first_name: (n.first || '').slice(0, 100) || null, last_name: (n.last || '').slice(0, 100) || null, contact_id: p.contact_id || null, lead_id: p.lead_id || null });
  };
  for (const listId of parse(row.mail_list_ids_json, [])) {
    for (const c of await upload.reachable(workspaceId, listId)) add({ ...c, contact_id: c.id });
  }
  for (const c of (await contactsSvc.assess(workspaceId, row.id)).filter(c => c.eligible)) add({ email: c.email, name: c.name, company: c.company, lead_id: c.leadId });
  const list = [...people.values()];
  for (let i = 0; i < list.length; i += 200) {
    const part = list.slice(i, i + 200);
    await run(`INSERT IGNORE INTO mail_campaign_recipients (workspace_id, campaign_id, version, email, first_name, last_name, contact_id, lead_id, view_token, status, created_at, updated_at)
      VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', UTC_TIMESTAMP(), UTC_TIMESTAMP())").join(', ')}`,
    part.flatMap(p => [workspaceId, row.id, row.version, p.email, p.first_name, p.last_name, p.contact_id, p.lead_id, crypto.randomBytes(16).toString('hex')]));
  }
  const n = await get('SELECT COUNT(*) AS n FROM mail_campaign_recipients WHERE campaign_id = ? AND version = ?', [row.id, row.version]);
  return Number(n?.n) || 0;
}

/** Starts (or continues) sending: recipients fixed, then the worker job. */
async function start(ctx, row) {
  // Send again: people SES refused outright (nothing was sent to them) are tried again. Anyone
  // already sent, with an unclear outcome ("unknown") or mid-send is never emailed again.
  await run(`UPDATE mail_campaign_recipients SET status = 'queued', error_code = NULL, error = NULL, updated_at = UTC_TIMESTAMP()
    WHERE campaign_id = ? AND version = ? AND status = 'failed'`, [row.id, row.version]);
  const total = await prepare(ctx, row);
  if (!total) {
    const err = Object.assign(new Error('Nobody in this campaign can get marketing email (no consent, unsubscribed or bounced), so nothing was sent. Choose other recipients.'), { status: 400, code: 'NO_RECIPIENTS' });
    throw err;
  }
  await run(`UPDATE mail_campaigns SET status = 'submitting', submit_stage = 'ses_send', provider = 'ses', zoho_status = 'Sending', upload_total = ?,
    upload_done = (SELECT COUNT(*) FROM mail_campaign_recipients r WHERE r.campaign_id = mail_campaigns.id AND r.version = mail_campaigns.version AND r.status <> 'queued'),
    provider_code = NULL, provider_message = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [total, row.id]);
  await enqueue(row, 0);
  await audit(ctx, 'mail.campaign_ses_started', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { recipients: total } });
  await kick(row.workspace_id, row.id);
}

async function enqueue(row, part, runAt = new Date()) {
  await require('../../social/jobsService').enqueue(row.workspace_id, 'ses_campaign_send', { campaignId: row.id, version: row.version, part },
    { idempotencyKey: `ses_campaign_send:${row.id}:${row.version}:${part}:${Date.now()}`, runAt, maxAttempts: 1 });
}

/** Runs the queued job right away, unless tests run it explicitly. */
async function kick(workspaceId, campaignId) {
  if (process.env.SES_SEND_INLINE === '0') return false;
  const job = await get(`SELECT * FROM background_jobs WHERE workspace_id = ? AND job_type = 'ses_campaign_send' AND status = 'queued' AND run_at <= UTC_TIMESTAMP()
    AND JSON_EXTRACT(payload_json, '$.campaignId') = ? ORDER BY id DESC LIMIT 1`, [workspaceId, Number(campaignId)]);
  if (!job) return false;
  const claim = await run("UPDATE background_jobs SET status = 'running', locked_by = 'api', locked_at = UTC_TIMESTAMP(), attempt_count = attempt_count + 1 WHERE id = ? AND status = 'queued'", [job.id]);
  if (!claim.changes) return false;
  const jobs = require('../../social/jobsService');
  setImmediate(async () => {
    try { await jobs.complete(job.id, await runSendJob(job)); } catch (err) { await jobs.fail({ ...job, max_attempts: 0 }, err).catch(() => null); }
  });
  return true;
}

function publicBase() {
  return (process.env.APP_BASE_URL || '').replace(/\/$/, '');
}

/**
 * The sender of a campaign email: only the campaign's own From address (checked as verified in SES at
 * approval). Never the signed-in user's address, never a Reply-To. No Reply-To is set: replies go to From.
 */
function senderOf(row) {
  const email = String(row.from_email || '').trim();
  const name = String(row.from_name || '').replace(/["\\\r\n]/g, '').trim();
  return { email, header: name ? `"${name}" <${email}>` : email, replyTo: null };
}

/** One log line about what is sent to SES (no keys, no secrets, no recipient lists). */
function logSend(event, row, sender, extra = {}) {
  console.info(`[ses] ${JSON.stringify({ event, workspaceId: row.workspace_id, campaignId: row.id, configuredFrom: row.from_email || null,
    sesFrom: sender.email, replyTo: sender.replyTo, operation: 'SESv2 SendEmail (Raw, POST /v2/email/outbound-emails)', ...extra })}`);
}

/** SES's "not verified" refusal, said plainly: a listed address that is not the sender is a recipient (SES sandbox). */
function explainNotVerified(message, senderEmail) {
  const m = /identities failed the check in region ([A-Z0-9-]+):\s*(.+)$/i.exec(String(message || ''));
  if (!m) return message;
  const sender = senderEmail.toLowerCase();
  const domain = sender.split('@')[1] || '';
  const ids = m[2].split(/[,\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
  const recipients = ids.filter(id => id !== sender && id !== domain);
  if (!recipients.length) return message;
  return `${message} (${recipients.join(', ')} is the recipient, not the sender ${senderEmail}: the SES account is in the sandbox in ${m[1].toLowerCase()}, so every recipient must be verified there too. Request production access in the SES console to email anyone.)`;
}

/** One email: personalized, own unsubscribe link, tracking, sent through SES. */
const unsubscribeUrlOf = (unsubToken, email) => (publicBase() ? `${publicBase()}/api/v1/mail/unsubscribe/c/${unsubToken}?e=${encodeURIComponent(email)}` : null);

async function sendOne(cfg, row, r, unsubToken, orgAddress) {
  const tracking = require('../tracking/trackingService');
  const unsubscribeUrl = unsubscribeUrlOf(unsubToken, r.email);
  if (!r.view_token) {
    r.view_token = crypto.randomBytes(16).toString('hex');
    await run('UPDATE mail_campaign_recipients SET view_token = ? WHERE id = ? AND view_token IS NULL', [r.view_token, r.id]);
  }
  const rendered = renderFor(row, r, { orgAddress, unsubscribeUrl, viewUrl: viewUrlOf(r.view_token) });
  // A merge tag left in the final email would show as $[...]$: this person is not emailed.
  if (rendered.unresolved.length) {
    const msg = `Not sent: merge tag(s) could not be filled in: ${rendered.unresolved.slice(0, 5).join(', ')}`;
    await run("UPDATE mail_campaign_recipients SET status = 'failed', error_code = 'UNRESOLVED_TAGS', error = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?", [msg.slice(0, 255), r.id]);
    return { ok: false, err: Object.assign(new Error(msg), { code: 'UNRESOLVED_TAGS', providerCode: 'UNRESOLVED_TAGS' }) };
  }
  let html = rendered.html;
  const subject = rendered.subject;
  const t = await tracking.begin(row.workspace_id, { consentOk: true, opens: true, clicks: true });
  if (t) {
    await run('UPDATE mail_message_tracking SET campaign_id = ?, campaign_recipient_id = ? WHERE id = ?', [row.id, r.id, t.id]);
    await run('UPDATE mail_campaign_recipients SET tracking_id = ? WHERE id = ?', [t.id, r.id]);
    html = await t.instrumentSmtp(html);
  }
  const sender = senderOf(row);
  const raw = await buildRaw({ from: sender.header, to: r.email, subject, html, unsubscribeUrl });
  try {
    const res = await ses.sendRaw(cfg, { from: sender.email, to: r.email, raw, configurationSet: cfg.configurationSet,
      tags: { marketech_workspace: row.workspace_id, marketech_campaign: row.id, marketech_recipient: r.id } });
    await run("UPDATE mail_campaign_recipients SET status = 'sent', provider_message_id = ?, sent_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?", [res.messageId, r.id]);
    if (t) await t.accepted({ provider: 'ses', messageId: res.messageId });
    return { ok: true };
  } catch (err) {
    logSend('send_failed', row, sender, { recipientId: r.id, providerCode: err.providerCode || err.code || null, error: String(err.message || '').slice(0, 300) });
    const status = err.outcomeUnknown ? 'unknown' : 'failed';
    await run('UPDATE mail_campaign_recipients SET status = ?, error_code = ?, error = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?',
      [status, String(err.providerCode || err.code || 'ERROR').slice(0, 64), String(err.message || '').slice(0, 255), r.id]);
    if (t) await (err.outcomeUnknown ? t.unknown(String(err.code || 'SES_OUTCOME_UNKNOWN')) : t.failed(String(err.providerCode || err.code || 'ERROR'), String(err.message || '').slice(0, 255)));
    return { ok: false, err };
  }
}

/** Worker job: sends one part, then queues the next part (or finishes the campaign). */
async function runSendJob(job) {
  const { campaignId, version, part = 0 } = JSON.parse(job.payload_json || '{}');
  const row = await get('SELECT * FROM mail_campaigns WHERE id = ? AND workspace_id = ?', [campaignId, job.workspace_id]);
  if (!row || row.status !== 'submitting' || row.submit_stage !== 'ses_send' || row.version !== version) return { skipped: true };
  const svc = require('../campaigns/campaignService');
  const cfg = await settings.sesConfig(row.workspace_id);
  if (!cfg) return stop(row, 'SES_NOT_CONFIGURED', 'Amazon SES is not set up (Mail Settings → Campaigns). Nothing more was sent.');
  const perSecond = Math.max(1, Math.min(500, cfg.maxPerSecond || 1));
  const gap = Math.ceil(1000 / perSecond);
  const unsubToken = svc.unsubscribeTokenOf(row);
  const orgAddress = await orgAddressOf(row.workspace_id);
  logSend('send_part', row, senderOf(row), { part, region: cfg.region, configurationSet: cfg.configurationSet || null });
  // Deliverability: paused while bounces or complaints are at the level where SES pauses accounts;
  // a new sender domain sends only today's warm-up allowance and continues by itself later.
  const allow = await require('./deliverability').allowance(row);
  if (allow.blocked) return stop(row, 'HEALTH_PAUSE', `${allow.health.message} Send again continues with the people not yet emailed.`);
  if (allow.remaining === 0) {
    const at = allow.warmup.resumeAt;
    await run("UPDATE mail_campaigns SET zoho_status = 'Paused (warm-up)', provider_message = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?",
      [`Warm-up: ${allow.warmup.domain} may send ${allow.warmup.cap} emails a day on day ${allow.warmup.day}, and ${allow.warmup.sentLast24h} went out in the last 24 hours. The rest are sent automatically from ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC.`.slice(0, 500), row.id]);
    await progress(row);
    await enqueue(row, part + 1, at);
    return { warmup: true, resumeAt: at.toISOString() };
  }
  if (row.zoho_status !== 'Sending') await run("UPDATE mail_campaigns SET zoho_status = 'Sending', provider_message = NULL WHERE id = ?", [row.id]);
  const limit = allow.remaining === null ? PART : Math.min(PART, allow.remaining);
  const started = Date.now();
  let sent = 0;
  while (sent < limit && Date.now() - started < PART_MS) {
    const r = await get("SELECT * FROM mail_campaign_recipients WHERE campaign_id = ? AND version = ? AND status = 'queued' ORDER BY id LIMIT 1", [row.id, row.version]);
    if (!r) break;
    // Claimed first: whatever happens next, this person is never emailed twice.
    const claim = await run("UPDATE mail_campaign_recipients SET status = 'sending', updated_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'queued'", [r.id]);
    if (!claim.changes) continue;
    // Stopped since it was chosen (unsubscribed, bounced, consent withdrawn): not emailed.
    const stopped = await get(`SELECT 1 AS x FROM email_suppressions WHERE workspace_id = ? AND email = ?
      UNION SELECT 1 FROM leads WHERE workspace_id = ? AND LOWER(TRIM(email)) = ? AND marketing_consent = 'withdrawn' LIMIT 1`, [row.workspace_id, r.email, row.workspace_id, r.email]);
    if (stopped) { await run("UPDATE mail_campaign_recipients SET status = 'skipped', error = 'Unsubscribed, bounced or consent withdrawn before sending' WHERE id = ?", [r.id]); continue; }
    const t0 = Date.now();
    const res = await sendOne(cfg, row, r, unsubToken, orgAddress);
    sent++;
    if (!res.ok) {
      const code = String(res.err.providerCode || '');
      if (THROTTLE_CODES.has(code)) {
        // SES asked to slow down: this person is put back and the rest continue in a minute.
        await run("UPDATE mail_campaign_recipients SET status = 'queued', error_code = NULL, error = NULL WHERE id = ? AND status = 'failed'", [r.id]);
        await progress(row);
        await enqueue(row, part + 1, new Date(Date.now() + 60000));
        return { throttled: true, sent };
      }
      // The email itself cannot be completed (e.g. no business address): stop before emailing anyone else.
      if (code === 'UNRESOLVED_TAGS') return stop(row, 'UNRESOLVED_TAGS', `${res.err.message}. Fix the email (or add your business address in Mail Settings → Campaigns), then Send again.`);
      if (STOP_CODES.has(code) || res.err.code === 'SES_UNREACHABLE') {
        await run("UPDATE mail_campaign_recipients SET status = 'queued', error_code = NULL, error = NULL WHERE id = ? AND status = 'failed'", [r.id]);
        return stop(row, code || res.err.code, `${res.err.message} Nothing more was sent; Send again continues with the people not yet emailed.`);
      }
    }
    const wait = gap - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }
  await progress(row);
  const left = await get("SELECT COUNT(*) AS n FROM mail_campaign_recipients WHERE campaign_id = ? AND version = ? AND status = 'queued'", [row.id, row.version]);
  if (Number(left?.n)) { await enqueue(row, part + 1); await kick(row.workspace_id, row.id); return { continued: true, sent }; }
  await finish(row);
  return { done: true, sent };
}

async function progress(row) {
  await run(`UPDATE mail_campaigns SET upload_done = (SELECT COUNT(*) FROM mail_campaign_recipients r WHERE r.campaign_id = ? AND r.version = ? AND r.status <> 'queued'), updated_at = UTC_TIMESTAMP() WHERE id = ?`,
    [row.id, row.version, row.id]);
}

async function finish(row) {
  const c = await counts(row);
  // Sent only when SES accepted at least one email; otherwise not sent, with the reason.
  if (!c.sent && !c.unknown) {
    const first = await get("SELECT error FROM mail_campaign_recipients WHERE campaign_id = ? AND version = ? AND status = 'failed' ORDER BY id LIMIT 1", [row.id, row.version]);
    return stop(row, 'SES_NONE_SENT', `Amazon SES did not accept any of the emails${first?.error ? `: ${explainNotVerified(first.error, senderOf(row).email)}` : '.'}`);
  }
  await run(`UPDATE mail_campaigns SET status = 'submitted', submit_stage = NULL, zoho_status = 'Sent', submitted_at = COALESCE(submitted_at, UTC_TIMESTAMP()),
    provider_code = NULL, provider_message = ?, report_json = ?, last_checked_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?`,
  [c.failed || c.unknown ? `Sent with Amazon SES to ${c.sent}; ${c.failed} not accepted by SES${c.unknown ? `, ${c.unknown} unclear (not resent)` : ''}.` : `Sent with Amazon SES to ${c.sent}.`,
    JSON.stringify(await report(row)), row.id]);
  await audit({ workspaceId: row.workspace_id, userId: row.submitted_by, actorType: 'worker' }, 'mail.campaign_submitted', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { provider: 'ses', sent: c.sent, failed: c.failed, unknown: c.unknown } });
}

async function stop(row, code, message) {
  await progress(row);
  await run("UPDATE mail_campaigns SET status = 'failed', submit_stage = 'ses_send', zoho_status = NULL, provider_code = ?, provider_message = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?",
    [String(code || 'SES_ERROR').slice(0, 20), String(message).slice(0, 500), row.id]);
  await audit({ workspaceId: row.workspace_id, userId: row.submitted_by, actorType: 'worker' }, 'mail.campaign_submit_failed', { resourceType: 'mail_campaign', resourceId: row.id, metadata: { provider: 'ses', code } });
  return { stopped: true, code };
}

async function counts(row) {
  const rows = await all('SELECT status, COUNT(*) AS n FROM mail_campaign_recipients WHERE campaign_id = ? AND version = ? GROUP BY status', [row.id, row.version]);
  const by = Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
  return { total: rows.reduce((n, r) => n + Number(r.n), 0), queued: (by.queued || 0) + (by.sending || 0), sent: by.sent || 0, failed: by.failed || 0, unknown: by.unknown || 0, skipped: by.skipped || 0 };
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

/** The campaign's figures (sent, delivered, opened, clicked, bounced, unsubscribed, complaints). */
async function report(row) {
  const c = await counts(row);
  const t = await get(`SELECT
      SUM(t.delivered_at IS NOT NULL) AS delivered, SUM(t.first_open_at IS NOT NULL) AS opened, SUM(t.first_click_at IS NOT NULL) AS clicked,
      SUM(t.delivery_status = 'bounced') AS hard, SUM(t.delivery_status = 'deferred') AS soft, SUM(t.complained_at IS NOT NULL) AS complaints,
      SUM(COALESCE(t.open_events, 0)) AS open_events, SUM(COALESCE(t.click_events, 0)) AS click_events
    FROM mail_campaign_recipients r JOIN mail_message_tracking t ON t.id = r.tracking_id
    WHERE r.campaign_id = ? AND r.version = ? AND r.status IN ('sent', 'unknown')`, [row.id, row.version]);
  const unsub = await get(`SELECT COUNT(*) AS n FROM mail_campaign_recipients r JOIN email_suppressions s ON s.workspace_id = r.workspace_id AND s.email = r.email
    WHERE r.campaign_id = ? AND r.version = ? AND r.status = 'sent' AND s.reason = 'unsubscribed' AND s.created_at >= r.sent_at`, [row.id, row.version]);
  const n = k => Number(t?.[k]) || 0;
  const sent = c.sent;
  const out = {
    provider: 'ses',
    recipients_count: c.total,
    emails_sent_count: sent,
    delivered_count: n('delivered'), delivered_percent: pct(n('delivered'), sent),
    opens_count: n('opened'), open_percent: pct(n('opened'), sent), unopened: Math.max(0, sent - n('opened')), unopened_percent: pct(Math.max(0, sent - n('opened')), sent),
    unique_clicks_count: n('clicked'), unique_clicked_percent: pct(n('clicked'), sent),
    bounces_count: n('hard') + n('soft'), bounce_percent: pct(n('hard') + n('soft'), sent), hardbounce_count: n('hard'), softbounce_count: n('soft'),
    unsub_count: Number(unsub?.n) || 0, unsubscribe_percent: pct(Number(unsub?.n) || 0, sent),
    spams_count: n('complaints'), spam_percent: pct(n('complaints'), sent), complaints_count: n('complaints'),
    unsent_count: c.failed + c.skipped,
    open_events: n('open_events'), click_events: n('click_events')
  };
  if (c.queued) out.pending = true;
  return out;
}

/** Per-recipient activity, from Marketech.ai's records. */
const ACTIVITY_SQL = {
  sent: "r.status = 'sent'",
  opened: 't.first_open_at IS NOT NULL',
  unopened: "r.status = 'sent' AND t.first_open_at IS NULL",
  clicked: 't.first_click_at IS NOT NULL',
  hard_bounced: "t.delivery_status = 'bounced'",
  soft_bounced: "t.delivery_status = 'deferred'",
  unsubscribed: "EXISTS (SELECT 1 FROM email_suppressions s WHERE s.workspace_id = r.workspace_id AND s.email = r.email AND s.reason = 'unsubscribed' AND s.created_at >= r.sent_at)",
  spam: 't.complained_at IS NOT NULL',
  delivered: 't.delivered_at IS NOT NULL',
  failed: "r.status IN ('failed', 'unknown', 'skipped')"
};
async function activity(row, activityName, page, pageSize) {
  const where = ACTIVITY_SQL[activityName];
  if (!where) return null;
  const rows = await all(`SELECT r.email, r.first_name, r.last_name, r.status, r.error, r.sent_at, t.delivery_status, t.delivered_at, t.open_events, t.click_events,
      t.last_open_at, t.last_click_at, t.failure_reason
    FROM mail_campaign_recipients r LEFT JOIN mail_message_tracking t ON t.id = r.tracking_id
    WHERE r.campaign_id = ? AND r.version = ? AND ${where} ORDER BY r.id LIMIT ${pageSize + 1} OFFSET ${(page - 1) * pageSize}`, [row.id, row.version]);
  const iso = v => (v ? new Date(v).toISOString() : null);
  return {
    recipients: rows.slice(0, pageSize).map(x => ({
      email: x.email, name: [x.first_name, x.last_name].filter(Boolean).join(' ') || null,
      status: x.status === 'sent' ? (x.delivery_status === 'accepted' ? 'sent' : x.delivery_status) : x.status,
      sentAt: iso(x.sent_at), deliveredAt: iso(x.delivered_at),
      opens: x.open_events ?? null, clicks: x.click_events ?? null, lastOpenedAt: iso(x.last_open_at), lastClickedAt: iso(x.last_click_at),
      reason: x.error || x.failure_reason || null
    })),
    hasMore: rows.length > pageSize
  };
}

/**
 * The public "View in browser" page of one recipient: their email as sent (name, address, unsubscribe
 * link), without the open pixel (viewing it is not an open). Null when the token is unknown, or the
 * campaign has changed or been deleted since.
 */
async function viewPage(token) {
  if (!/^[a-f0-9]{32}$/.test(String(token || ''))) return null;
  const r = await get('SELECT * FROM mail_campaign_recipients WHERE view_token = ?', [token]);
  if (!r) return null;
  const row = await get('SELECT * FROM mail_campaigns WHERE id = ? AND workspace_id = ?', [r.campaign_id, r.workspace_id]);
  if (!row || row.version !== r.version) return null;
  const svc = require('../campaigns/campaignService');
  const rendered = renderFor(row, r, { orgAddress: await orgAddressOf(row.workspace_id), unsubscribeUrl: unsubscribeUrlOf(svc.unsubscribeTokenOf(row), r.email), viewUrl: viewUrlOf(token) });
  return { html: rendered.html, subject: rendered.subject };
}

module.exports = { senderOf, explainNotVerified, prepare, start, runSendJob, kick, report, activity, counts, personalize, renderFor, orgAddressOf, viewPage, leftoverTags, buildRaw, ACTIVITY_SQL };
