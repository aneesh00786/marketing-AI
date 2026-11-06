/**
 * Email delivery, open and click tracking for individual emails sent from Mail Center (drafts and
 * Compose). AI Campaigns sequences are not tracked in this phase.
 *
 * Status model (mail_message_tracking.delivery_status), by precedence so out-of-order events can
 * never move it backwards:
 *   queued (0) < accepted / unknown (1) < deferred: soft bounce (2) < delivered (3) < failed (4) < bounced: hard bounce (5)
 * "accepted" means the provider (ZeptoMail or the SMTP server) took the message; only a provider
 * delivery event makes it "delivered". Opens, clicks and complaints are recorded alongside and never
 * change the delivery status. "unknown" mirrors an unknown send outcome; tracking never resolves it.
 *
 * Tracking only records. It never sends, resends, approves or changes a draft or campaign. The one
 * side effect is the approved safeguard: a verified ZeptoMail hard bounce or spam complaint adds the
 * address to this workspace's suppression list (idempotent, audited).
 */
const { run, get, all } = require('../../../db/database');
const { audit } = require('../../../lib/audit');
const links = require('./links');

const STATUS = {
  queued: { rank: 0 },
  accepted: { rank: 1 },
  unknown: { rank: 1 },
  deferred: { rank: 2 },
  delivered: { rank: 3 },
  failed: { rank: 4 },
  bounced: { rank: 5 }
};
const EVENT_STATUS = { accepted: 'accepted', soft_bounce: 'deferred', delivered: 'delivered', failed: 'failed', hard_bounce: 'bounced' };
const EVENT_TYPES = new Set(['queued', 'accepted', 'unknown', 'delivered', 'soft_bounce', 'hard_bounce', 'failed', 'opened', 'clicked', 'complaint']);

const RETENTION_DAYS = () => Math.max(30, parseInt(process.env.MAIL_TRACKING_RETENTION_DAYS || '395', 10) || 395);

function publicBase() {
  return (process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
}

/** Pixels and click links must be reachable by recipients: a public https base URL (http only in tests). */
function publicBaseOk() {
  const base = publicBase();
  if (/^https:\/\//i.test(base)) return true;
  return process.env.NODE_ENV === 'test' && process.env.MAIL_TRACKING_ALLOW_HTTP === '1' && /^http:\/\//i.test(base);
}

const sqlTime = d => new Date(d).toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
const clean = (v, max) => {
  if (v === null || v === undefined) return null;
  // Plain text only: no markup, control characters or email addresses in stored explanations.
  const s = String(v).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g, '[address]').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

// ---------------------------------------------------------------- policy

async function workspacePolicy(workspaceId) {
  const row = await get('SELECT track_opens, track_clicks FROM mail_configurations WHERE workspace_id = ? LIMIT 1', [workspaceId]);
  return { opens: !!row?.track_opens, clicks: !!row?.track_clicks };
}

/** The ZeptoMail webhook is usable only when the server allows it and the workspace enabled it with a key. */
function zeptoWebhooksAllowed() {
  return process.env.ZEPTOMAIL_WEBHOOKS_ENABLED === '1';
}

async function zeptoWebhookActive(workspaceId) {
  if (!zeptoWebhooksAllowed()) return false;
  const row = await get("SELECT enabled, secret_ciphertext FROM mail_webhook_endpoints WHERE workspace_id = ? AND provider = 'zeptomail'", [workspaceId]);
  return !!(row && row.enabled && row.secret_ciphertext);
}

// ---------------------------------------------------------------- sending

/**
 * Starts tracking one outgoing email (status "queued"). consentOk=false (e.g. a product email to a
 * lead without granted consent) turns opens and clicks off; delivery outcomes are always recorded.
 * Returns a handle used by the send path, or null if tracking could not be started (the send goes
 * ahead untracked).
 */
async function begin(workspaceId, { draftId = null, consentOk = true, opens: forceOpens, clicks: forceClicks } = {}) {
  try {
    // Campaigns (Amazon SES) always report opens and clicks; other emails follow the workspace policy.
    const policy = typeof forceOpens === 'boolean' ? { opens: forceOpens, clicks: !!forceClicks } : await workspacePolicy(workspaceId);
    const opens = policy.opens && consentOk;
    const clicks = policy.clicks && consentOk;
    const token = links.newToken();
    const ins = await run(
      `INSERT INTO mail_message_tracking (workspace_id, draft_id, tracking_token, track_opens, track_clicks, delivery_status, status_rank, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', 0, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [workspaceId, draftId, token, opens ? 1 : 0, clicks ? 1 : 0]
    );
    const id = ins.lastID;
    await recordEvent(workspaceId, id, { type: 'queued', source: 'app', occurredAt: new Date(), basis: `${token}|queued` });
    const zeptoActive = await zeptoWebhookActive(workspaceId);
    return handle({ id, workspaceId, token, opens, clicks, zeptoActive });
  } catch (err) {
    console.error('[mail-tracking] could not start tracking:', err.message);
    return null;
  }
}

function handle(t) {
  return {
    id: t.id,
    token: t.token,
    /** ZeptoMail tracks opens/clicks itself; only worth enabling when its webhook can report them. */
    zeptoOptions() {
      return { clientReference: t.token, trackOpens: t.opens && t.zeptoActive, trackClicks: t.clicks && t.zeptoActive };
    },
    /** SMTP: our own pixel and click links, when enabled and reachable by recipients. */
    async instrumentSmtp(html) {
      if ((!t.opens && !t.clicks) || !publicBaseOk()) return html;
      try {
        const base = publicBase();
        let out = html;
        if (t.clicks) {
          const r = links.rewriteLinks(out, { clickUrl: token => `${base}/api/v1/mail/t/c/${token}`, ownOrigin: new URL(base).origin });
          for (const l of r.links) {
            await run('INSERT INTO mail_tracked_links (workspace_id, tracking_id, link_token, url, url_hash, position, created_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
              [t.workspaceId, t.id, l.token, l.url, links.sha256(l.url), l.position]);
          }
          out = r.html;
        }
        if (t.opens) out = links.addPixel(out, `${base}/api/v1/mail/t/o/${t.token}.gif`);
        return out;
      } catch (err) {
        console.error('[mail-tracking] could not add tracking to the email:', err.message);
        return html;
      }
    },
    async accepted({ provider, messageId, emailId }) {
      await settle(t, async () => {
        await run('UPDATE mail_message_tracking SET provider = ?, provider_message_id = ?, email_id = ?, accepted_at = COALESCE(accepted_at, UTC_TIMESTAMP()), updated_at = UTC_TIMESTAMP() WHERE id = ?',
          [provider, messageId ? String(messageId).slice(0, 255) : null, emailId || null, t.id]);
        await recordEvent(t.workspaceId, t.id, { type: 'accepted', source: provider, occurredAt: new Date(), basis: `${t.token}|accepted` });
      });
    },
    async failed(code, message) {
      await settle(t, () => recordEvent(t.workspaceId, t.id, { type: 'failed', source: 'app', occurredAt: new Date(), basis: `${t.token}|failed`, detailCode: code, detail: message }));
    },
    async unknown(code) {
      await settle(t, () => recordEvent(t.workspaceId, t.id, { type: 'unknown', source: 'app', occurredAt: new Date(), basis: `${t.token}|unknown`, detailCode: code, detail: 'The send outcome is unknown; the email may or may not have been delivered.' }));
    }
  };
}

async function settle(t, fn) {
  try { await fn(); } catch (err) { console.error('[mail-tracking] could not record the send result:', err.message); }
}

// ---------------------------------------------------------------- events

/**
 * Records one event (deduplicated by `basis`) and updates the summary. Returns
 * { duplicate: true } for a repeat, otherwise { applied: true, eventId }.
 */
async function recordEvent(workspaceId, trackingId, ev) {
  if (!EVENT_TYPES.has(ev.type)) throw new Error(`Unknown mail event type ${ev.type}`);
  const occurred = ev.occurredAt instanceof Date && !isNaN(ev.occurredAt) ? ev.occurredAt : new Date();
  const dedupeKey = links.sha256(`${workspaceId}|${ev.source}|${ev.basis}`);
  let ins;
  try {
    ins = await run(
      `INSERT INTO mail_events (workspace_id, tracking_id, source, event_type, occurred_at, received_at, provider_event_id, dedupe_key, link_id, detail_code, detail, client_hint, outcome)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, 'applied')`,
      [workspaceId, trackingId, ev.source, ev.type, sqlTime(occurred), ev.providerEventId ? String(ev.providerEventId).slice(0, 128) : null, dedupeKey,
        ev.linkId || null, clean(ev.detailCode, 64), clean(ev.detail, 255), ev.clientHint || null]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' || /UNIQUE|Duplicate/i.test(err.message)) return { duplicate: true };
    throw err;
  }
  if (trackingId) await applyToSummary(trackingId, ev.type, occurred, ev);
  return { applied: true, eventId: ins.lastID };
}

async function applyToSummary(trackingId, type, occurred, ev) {
  const at = sqlTime(occurred);
  const status = type === 'unknown' ? 'unknown' : EVENT_STATUS[type];
  if (status) {
    const rank = STATUS[status].rank;
    const isFailure = status === 'failed' || status === 'bounced' || status === 'deferred';
    // Higher precedence wins; for the same precedence, the later event wins. Never moves backwards.
    await run(
      `UPDATE mail_message_tracking SET delivery_status = ?, status_rank = ?, status_event_at = ?,
         failure_code = ${isFailure ? '?' : 'failure_code'}, failure_reason = ${isFailure ? '?' : 'failure_reason'}, updated_at = UTC_TIMESTAMP()
       WHERE id = ? AND (status_rank < ? OR (status_rank = ? AND (status_event_at IS NULL OR status_event_at <= ?)))`,
      [status, rank, at, ...(isFailure ? [clean(ev.detailCode, 64), clean(ev.detail, 255)] : []), trackingId, rank, rank, at]
    );
  }
  if (type === 'delivered') await run('UPDATE mail_message_tracking SET delivered_at = LEAST(COALESCE(delivered_at, ?), ?) WHERE id = ?', [at, at, trackingId]);
  if (type === 'hard_bounce') await run('UPDATE mail_message_tracking SET bounced_at = LEAST(COALESCE(bounced_at, ?), ?) WHERE id = ?', [at, at, trackingId]);
  if (type === 'complaint') await run('UPDATE mail_message_tracking SET complained_at = LEAST(COALESCE(complained_at, ?), ?) WHERE id = ?', [at, at, trackingId]);
  if (type === 'opened') {
    await run(`UPDATE mail_message_tracking SET open_events = open_events + 1, first_open_at = LEAST(COALESCE(first_open_at, ?), ?),
      last_open_at = GREATEST(COALESCE(last_open_at, ?), ?), updated_at = UTC_TIMESTAMP() WHERE id = ?`, [at, at, at, at, trackingId]);
  }
  if (type === 'clicked') {
    await run(`UPDATE mail_message_tracking SET click_events = click_events + 1, first_click_at = LEAST(COALESCE(first_click_at, ?), ?),
      last_click_at = GREATEST(COALESCE(last_click_at, ?), ?), updated_at = UTC_TIMESTAMP() WHERE id = ?`, [at, at, at, at, trackingId]);
    if (ev.linkId) {
      await run(`UPDATE mail_tracked_links SET click_events = click_events + 1, first_click_at = LEAST(COALESCE(first_click_at, ?), ?),
        last_click_at = GREATEST(COALESCE(last_click_at, ?), ?) WHERE id = ? AND tracking_id = ?`, [at, at, at, at, ev.linkId, trackingId]);
    }
  }
}

/** Open pixel hit. Hits within the same minute count once (image proxies and reloads repeat them). */
async function recordOpen(token, userAgent) {
  // Only SMTP emails carry our pixel. A ZeptoMail email's token is its client_reference at ZeptoMail,
  // so it must not be usable to record opens here.
  // Amazon SES campaign emails carry the same pixel (Marketech.ai tracks their opens itself).
  const t = await get("SELECT id, workspace_id, track_opens FROM mail_message_tracking WHERE tracking_token = ? AND provider IN ('smtp', 'ses')", [token]);
  if (!t || !t.track_opens) return { recorded: false };
  const now = new Date();
  const r = await recordEvent(t.workspace_id, t.id, { type: 'opened', source: 'smtp_pixel', occurredAt: now, basis: `${token}|open|${Math.floor(now.getTime() / 60000)}`, clientHint: links.clientHint(userAgent) });
  return { recorded: !!r.applied };
}

/** Click on a tracked link: returns the stored destination (or null), recording the click once per 10 seconds. */
async function recordClick(linkToken, userAgent, { record = true } = {}) {
  const l = await get(`SELECT l.id, l.url, l.workspace_id, l.tracking_id, t.track_clicks FROM mail_tracked_links l
    JOIN mail_message_tracking t ON t.id = l.tracking_id AND t.workspace_id = l.workspace_id WHERE l.link_token = ?`, [linkToken]);
  if (!l) return null;
  const target = links.safeRedirectTarget(l.url);
  if (!target) return null;
  if (l.track_clicks && record) {
    const now = new Date();
    await recordEvent(l.workspace_id, l.tracking_id, { type: 'clicked', source: 'smtp_link', occurredAt: now, linkId: l.id, basis: `${linkToken}|click|${Math.floor(now.getTime() / 10000)}`, clientHint: links.clientHint(userAgent), detail: links.displayUrl(l.url) });
  }
  return target;
}

/**
 * Suppresses the recipient after a verified hard bounce or spam complaint (approved safeguard).
 * Idempotent: an address already on the list is left as is and not audited again.
 */
async function suppressRecipient(workspaceId, trackingId, reason) {
  const row = await get(`SELECT e.recipient_email FROM mail_message_tracking t JOIN emails e ON e.id = t.email_id AND e.workspace_id = t.workspace_id
    WHERE t.id = ? AND t.workspace_id = ?`, [trackingId, workspaceId]);
  const email = String(row?.recipient_email || '').trim().toLowerCase();
  if (!email) return { suppressed: false };
  const r = await run('INSERT IGNORE INTO email_suppressions (workspace_id, email, reason, source, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
    [workspaceId, email, reason, 'zeptomail_webhook']);
  if (r.changes) {
    await audit({ workspaceId, userId: null, actorType: 'provider' }, 'mail.recipient_suppressed', { resourceType: 'mail_tracking', resourceId: trackingId, metadata: { reason, source: 'zeptomail_webhook' } });
  }
  return { suppressed: !!r.changes };
}

// ---------------------------------------------------------------- reading

const CAPABILITIES = {
  zeptomail: {
    delivery: 'provider_webhook',
    opens: 'first_open_only',
    clicks: 'per_link',
    note: 'ZeptoMail reports delivery, bounces, the first open and link clicks through its webhook.'
  },
  smtp: {
    delivery: 'not_supported',
    opens: 'pixel',
    clicks: 'per_link',
    note: 'Your SMTP server only confirms that it accepted the email. It does not report delivery or bounces.'
  }
};

async function summary(workspaceId, trackingRow) {
  const t = trackingRow;
  const provider = t.provider || null;
  const caps = CAPABILITIES[provider] || null;
  const zeptoActive = provider === 'zeptomail' ? await zeptoWebhookActive(workspaceId) : false;
  const events = await all(`SELECT event_type, source, occurred_at, detail_code, detail, client_hint FROM mail_events
    WHERE workspace_id = ? AND tracking_id = ? ORDER BY occurred_at ASC, id ASC LIMIT 200`, [workspaceId, t.id]);
  const linkRows = await all('SELECT url, position, click_events, first_click_at, last_click_at FROM mail_tracked_links WHERE workspace_id = ? AND tracking_id = ? ORDER BY position', [workspaceId, t.id]);

  // Opens/clicks: "on" only if they were enabled for this email AND the provider path can report them.
  const opensMode = !t.track_opens ? 'off' : provider === 'zeptomail' ? (zeptoActive ? 'provider' : 'not_reported') : provider === 'smtp' ? 'pixel' : 'off';
  const clicksMode = !t.track_clicks ? 'off' : provider === 'zeptomail' ? (zeptoActive ? 'provider' : 'not_reported') : provider === 'smtp' ? 'links' : 'off';
  const zeptoClicks = provider === 'zeptomail' ? events.filter(e => e.event_type === 'clicked') : [];

  return {
    tracked: true,
    provider,
    capabilities: caps,
    deliveryReporting: provider === 'zeptomail' ? (zeptoActive ? 'provider_webhook' : 'webhook_not_connected') : provider === 'smtp' ? 'not_supported' : 'unknown',
    deliveryStatus: t.delivery_status,
    queuedAt: t.created_at,
    acceptedAt: t.accepted_at,
    deliveredAt: t.delivered_at,
    bouncedAt: t.bounced_at,
    complainedAt: t.complained_at,
    // A reason belongs to the current state only (e.g. a soft bounce later delivered keeps it in history only).
    failure: ['deferred', 'failed', 'bounced'].includes(t.delivery_status) && (t.failure_code || t.failure_reason) ? { code: t.failure_code, reason: t.failure_reason } : null,
    opens: {
      mode: opensMode,
      firstAt: t.first_open_at,
      lastAt: t.last_open_at,
      // ZeptoMail only reports the first open, so a total is not available there.
      totalEvents: opensMode === 'pixel' ? t.open_events : null,
      uniqueOpened: t.open_events > 0
    },
    clicks: {
      mode: clicksMode,
      totalEvents: clicksMode === 'off' || clicksMode === 'not_reported' ? null : t.click_events,
      firstAt: t.first_click_at,
      lastAt: t.last_click_at,
      links: provider === 'smtp'
        ? linkRows.map(l => ({ url: links.displayUrl(l.url), clicks: l.click_events, firstAt: l.first_click_at, lastAt: l.last_click_at }))
        : zeptoClicks.map(e => ({ url: e.detail || '', clicks: 1, firstAt: e.occurred_at, lastAt: e.occurred_at }))
    },
    events: events.map(e => ({ type: e.event_type, source: e.source, occurredAt: e.occurred_at, code: e.detail_code, detail: e.detail, clientHint: e.client_hint }))
  };
}

async function forEmail(workspaceId, emailId) {
  const t = await get('SELECT * FROM mail_message_tracking WHERE workspace_id = ? AND email_id = ? ORDER BY id DESC LIMIT 1', [workspaceId, emailId]);
  return t ? summary(workspaceId, t) : { tracked: false };
}

async function forDraft(workspaceId, draftId) {
  const t = await get('SELECT * FROM mail_message_tracking WHERE workspace_id = ? AND draft_id = ? ORDER BY id DESC LIMIT 1', [workspaceId, draftId]);
  return t ? summary(workspaceId, t) : { tracked: false };
}

// ---------------------------------------------------------------- retention

/** Deletes events and tracked links past the retention period. Summary rows (counts and dates) stay. */
async function purgeExpired(now = new Date()) {
  const cutoff = sqlTime(new Date(now.getTime() - RETENTION_DAYS() * 86400000));
  const ev = await run('DELETE FROM mail_events WHERE received_at < ?', [cutoff]);
  const ln = await run('DELETE FROM mail_tracked_links WHERE created_at < ?', [cutoff]);
  return { events: ev.changes || 0, links: ln.changes || 0 };
}

let retentionTimer = null;
function startRetention() {
  if (retentionTimer) return;
  const tick = () => purgeExpired().catch(err => console.error('[mail-tracking] retention purge failed:', err.message));
  retentionTimer = setInterval(tick, 6 * 3600 * 1000);
  retentionTimer.unref?.();
  setTimeout(tick, 60 * 1000).unref?.();
}

module.exports = {
  begin, recordEvent, recordOpen, recordClick, suppressRecipient, forEmail, forDraft, summary,
  workspacePolicy, zeptoWebhooksAllowed, zeptoWebhookActive, publicBaseOk, purgeExpired, startRetention,
  STATUS, RETENTION_DAYS
};
