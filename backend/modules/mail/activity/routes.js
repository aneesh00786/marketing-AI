const express = require('express');
const { z } = require('zod');
const { all } = require('../../../db/database');
const { requireCapability } = require('../../../middleware/auth');

/**
 * Mail activity for the Mail Center: chart data for the Overview and the campaign log, plus the
 * shared SQL the Inbox / Sent Mail lists use (modules/mail/routes.js). Read-only and workspace-scoped (the workspace always comes from the session). Counts come
 * from what the app recorded — emails, AI campaign sends, delivery tracking and Zoho reports —
 * nothing is estimated, and nothing here contacts a provider.
 */
const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ws = req => req.auth.workspaceId;
const sqlDate = d => d.toISOString().slice(0, 19).replace('T', ' ');
const PAGE = 50;

function badRequest(parsed) {
  const err = new Error(parsed.error.issues.map(i => `${i.path.join('.') || 'query'}: ${i.message}`).join('; '));
  err.status = 400;
  err.code = 'VALIDATION_ERROR';
  return err;
}
function parse(schema, query) {
  const r = schema.safeParse(query || {});
  if (!r.success) throw badRequest(r);
  return r.data;
}
/**
 * Delivery of one email as far as it is known, from its tracking row (t_* columns) and status:
 * not_sent, bounced, clicked, opened, delivered, accepted (handed to the mail service, no event
 * yet) or sent (no tracking for this email). Received emails have none (null).
 */
function deliveryOf(r) {
  if (r.status === 'Not Sent') return 'not_sent';
  if (r.status !== 'Sent') return null;
  if (r.t_bounced_at || r.t_delivery_status === 'bounced') return 'bounced';
  if (r.t_first_click_at) return 'clicked';
  if (r.t_first_open_at) return 'opened';
  if (r.t_delivered_at || r.t_delivery_status === 'delivered') return 'delivered';
  return r.t_delivery_status ? 'accepted' : 'sent';
}
/** deliveryOf() in SQL (emails as `e`, tracking joined as `t`), for filtering by status. */
const DELIVERY_SQL = `CASE
  WHEN e.status = 'Not Sent' THEN 'not_sent'
  WHEN e.status <> 'Sent' THEN NULL
  WHEN t.bounced_at IS NOT NULL OR t.delivery_status = 'bounced' THEN 'bounced'
  WHEN t.first_click_at IS NOT NULL THEN 'clicked'
  WHEN t.first_open_at IS NOT NULL THEN 'opened'
  WHEN t.delivered_at IS NOT NULL OR t.delivery_status = 'delivered' THEN 'delivered'
  WHEN t.delivery_status IS NOT NULL THEN 'accepted'
  ELSE 'sent' END`;
/**
 * What each email of one workspace is linked to: an AI campaign send, a Compose send request (with
 * its applied purpose) or a Mail Draft. Joined as lo / lr / ld; takes the workspace id three times.
 * Pre-grouped by email_id so a list never repeats an email.
 */
const LINKS_JOIN = `
  LEFT JOIN (SELECT email_id, COUNT(*) AS hit FROM outreach_sends WHERE workspace_id = ? AND email_id IS NOT NULL GROUP BY email_id) lo ON lo.email_id = e.id
  LEFT JOIN (SELECT email_id, COUNT(*) AS hit, MIN(applied_purpose) AS applied_purpose FROM mail_send_requests WHERE workspace_id = ? AND email_id IS NOT NULL GROUP BY email_id) lr ON lr.email_id = e.id
  LEFT JOIN (SELECT email_id, COUNT(*) AS hit FROM email_drafts WHERE workspace_id = ? AND email_id IS NOT NULL GROUP BY email_id) ld ON ld.email_id = e.id`;
/** Where a sent email came from (needs LINKS_JOIN). */
const SOURCE_SQL = `CASE WHEN lo.hit THEN 'ai_campaign' WHEN lr.hit THEN 'compose' WHEN ld.hit THEN 'draft' WHEN e.status = 'Sent' THEN 'other' ELSE NULL END`;
/**
 * Sending purpose as recorded (needs LINKS_JOIN): Compose sends store the applied purpose; Mail
 * Drafts and AI Campaigns are always marketing; anything else is not recorded (NULL).
 */
const PURPOSE_SQL = `CASE WHEN lo.hit THEN 'marketing' WHEN lr.hit THEN lr.applied_purpose WHEN ld.hit THEN 'marketing' ELSE NULL END`;
/** Tracking columns for deliveryOf(), joined as `t`. */
const TRACKING_COLUMNS = 't.delivery_status AS t_delivery_status, t.delivered_at AS t_delivered_at, t.bounced_at AS t_bounced_at, t.first_open_at AS t_first_open_at, t.first_click_at AS t_first_click_at, t.failure_reason AS t_failure_reason, t.track_opens AS t_track_opens';
const TRACKING_JOIN = 'LEFT JOIN mail_message_tracking t ON t.workspace_id = e.workspace_id AND t.email_id = e.id';

const json = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
const num = v => Number(v) || 0;

/** Emails table rows: direction from status (Sent / Not Sent / anything else was received). */
const DIRECTION_SQL = "CASE WHEN e.status = 'Sent' THEN 'sent' WHEN e.status = 'Not Sent' THEN 'not_sent' ELSE 'received' END";
const summaryQuery = z.object({ days: z.enum(['7', '30', '90']).optional() }).strict();

/** Overview charts: emails sent per day by channel, received per day, and delivery of tracked emails. */
router.get('/summary', requireCapability('mail.view'), wrap(async (req, res) => {
  const days = Number(parse(summaryQuery, req.query).days || 30);
  const today = new Date();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  const from = new Date(end.getTime() - days * 86400000);
  const range = [ws(req), sqlDate(from), sqlDate(end)];

  // Mailbox sends (Compose, drafts, other) — AI campaign sends are counted from outreach_sends below,
  // so an AI campaign email recorded in both tables is counted once.
  const mailbox = await all(
    `SELECT DATE_FORMAT(e.sent_at, '%Y-%m-%d') AS day, COUNT(*) AS n FROM emails e
     WHERE e.workspace_id = ? AND e.status = 'Sent' AND e.sent_at >= ? AND e.sent_at < ?
       AND NOT EXISTS (SELECT 1 FROM outreach_sends os WHERE os.workspace_id = e.workspace_id AND os.email_id = e.id)
     GROUP BY day`, range);
  const campaign = await all(
    `SELECT DATE_FORMAT(sent_at, '%Y-%m-%d') AS day, COUNT(*) AS n FROM outreach_sends
     WHERE workspace_id = ? AND status = 'sent' AND sent_at >= ? AND sent_at < ? GROUP BY day`, range);
  const received = await all(
    `SELECT DATE_FORMAT(e.received_at, '%Y-%m-%d') AS day, COUNT(*) AS n FROM emails e
     WHERE e.workspace_id = ? AND e.status NOT IN ('Sent', 'Not Sent') AND e.received_at >= ? AND e.received_at < ?
     GROUP BY day`, range);
  const notSent = await all(
    `SELECT COUNT(*) AS n FROM emails e WHERE e.workspace_id = ? AND e.status = 'Not Sent' AND COALESCE(e.sent_at, e.received_at) >= ? AND COALESCE(e.sent_at, e.received_at) < ?`, range);
  const failedCampaign = await all(
    `SELECT COUNT(*) AS n FROM outreach_sends WHERE workspace_id = ? AND status IN ('failed', 'needs_review') AND created_at >= ? AND created_at < ?`, range);

  const index = rows => new Map(rows.map(r => [String(r.day), num(r.n)]));
  const [m, c, rcv] = [index(mailbox), index(campaign), index(received)];
  const daily = [];
  for (let t = from.getTime(); t < end.getTime(); t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    daily.push({ date: day, mailbox: m.get(day) || 0, campaigns: c.get(day) || 0, received: rcv.get(day) || 0 });
  }

  const [t] = await all(
    `SELECT COUNT(*) AS tracked,
            SUM(delivered_at IS NOT NULL OR delivery_status = 'delivered') AS delivered,
            SUM(first_open_at IS NOT NULL) AS opened,
            SUM(first_click_at IS NOT NULL) AS clicked,
            SUM(bounced_at IS NOT NULL OR delivery_status = 'bounced') AS bounced,
            SUM(complained_at IS NOT NULL) AS complained,
            SUM(track_opens = 1) AS opensTracked,
            SUM(track_clicks = 1) AS clicksTracked
     FROM mail_message_tracking WHERE workspace_id = ? AND created_at >= ? AND created_at < ?`, range);

  const sum = (rows) => rows.reduce((a, r) => a + num(r.n), 0);
  res.json({
    success: true,
    range: { from: sqlDate(from).slice(0, 10), to: sqlDate(new Date(end - 86400000)).slice(0, 10), days },
    totals: {
      sentMailbox: sum(mailbox), sentCampaigns: sum(campaign), received: sum(received),
      notSent: num(notSent[0]?.n), campaignFailed: num(failedCampaign[0]?.n)
    },
    daily,
    delivery: {
      tracked: num(t?.tracked), delivered: num(t?.delivered), opened: num(t?.opened), clicked: num(t?.clicked),
      bounced: num(t?.bounced), complained: num(t?.complained), opensTracked: num(t?.opensTracked), clicksTracked: num(t?.clicksTracked)
    }
  });
}));

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const campaignLogQuery = z.object({
  type: z.enum(['ai', 'zoho']).optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
  page: z.coerce.number().int().min(1).max(1000).optional()
}).strict();

/** "column >= from AND column < to + 1 day" for an optional YYYY-MM-DD range (UTC). */
function dayRange(col, q) {
  const where = []; const params = [];
  if (q.from) { where.push(`${col} >= ?`); params.push(`${q.from} 00:00:00`); }
  if (q.to) { where.push(`${col} < DATE_ADD(?, INTERVAL 1 DAY)`); params.push(`${q.to} 00:00:00`); }
  return { sql: where.length ? ` AND ${where.join(' AND ')}` : '', params };
}

/**
 * Campaign log: only campaigns that have sent — AI Campaigns with at least one email sent and Zoho
 * Campaigns submitted to Zoho (or whose submission outcome is unknown and must be checked). Drafts,
 * approved-but-unsent and failed campaigns are not listed. With a date range, an AI campaign is
 * listed when it sent within the range (and "sent" counts those emails); a Zoho campaign when it was
 * submitted within the range.
 */
router.get('/campaigns', requireCapability('mail.view'), wrap(async (req, res) => {
  const q = parse(campaignLogQuery, req.query);
  const page = q.page || 1;
  const sr = dayRange('s.sent_at', q);
  const ai = q.type === 'zoho' ? [] : await all(
    `SELECT c.id, c.name, c.status, c.created_at, c.approved_at, c.completed_at, c.updated_at, c.last_error,
            (SELECT COUNT(*) FROM outreach_recipients r WHERE r.workspace_id = c.workspace_id AND r.campaign_id = c.id) AS recipients,
            (SELECT COUNT(*) FROM outreach_recipients r WHERE r.workspace_id = c.workspace_id AND r.campaign_id = c.id AND r.status = 'replied') AS replied,
            (SELECT COUNT(*) FROM outreach_recipients r WHERE r.workspace_id = c.workspace_id AND r.campaign_id = c.id AND r.status = 'bounced') AS bounced,
            (SELECT COUNT(*) FROM outreach_recipients r WHERE r.workspace_id = c.workspace_id AND r.campaign_id = c.id AND r.status = 'unsubscribed') AS unsubscribed,
            (SELECT COUNT(*) FROM outreach_sends s WHERE s.workspace_id = c.workspace_id AND s.campaign_id = c.id AND s.status = 'sent'${sr.sql}) AS sent,
            (SELECT COUNT(*) FROM outreach_sends s WHERE s.workspace_id = c.workspace_id AND s.campaign_id = c.id AND s.status IN ('failed', 'needs_review')) AS failed,
            (SELECT MIN(s.sent_at) FROM outreach_sends s WHERE s.workspace_id = c.workspace_id AND s.campaign_id = c.id AND s.status = 'sent'${sr.sql}) AS first_sent_at,
            (SELECT MAX(s.sent_at) FROM outreach_sends s WHERE s.workspace_id = c.workspace_id AND s.campaign_id = c.id AND s.status = 'sent'${sr.sql}) AS last_sent_at
     FROM outreach_campaigns c
     WHERE c.workspace_id = ?
       AND EXISTS (SELECT 1 FROM outreach_sends s WHERE s.workspace_id = c.workspace_id AND s.campaign_id = c.id AND s.status = 'sent'${sr.sql})`,
    [...sr.params, ...sr.params, ...sr.params, ws(req), ...sr.params]);
  const zr = dayRange('submitted_at', q);
  const zoho = q.type === 'ai' ? [] : await all(
    `SELECT id, name, status, zoho_status, report_json, provider_message, created_at, approved_at, submitted_at, updated_at
     FROM mail_campaigns WHERE workspace_id = ? AND status IN ('submitted', 'needs_review') AND submitted_at IS NOT NULL${zr.sql}`,
    [ws(req), ...zr.params]);

  const items = [
    ...ai.map(c => ({
      type: 'ai', id: c.id, name: c.name, status: c.status,
      createdAt: c.created_at, approvedAt: c.approved_at, startedAt: c.first_sent_at, sentAt: c.last_sent_at, lastActivityAt: c.last_sent_at,
      recipients: num(c.recipients), sent: num(c.sent), failed: num(c.failed),
      replied: num(c.replied), bounced: num(c.bounced), unsubscribed: num(c.unsubscribed), opened: null,
      note: c.last_error || null
    })),
    ...zoho.map(c => {
      const r = json(c.report_json, null) || {};
      const n = k => (r[k] === undefined || r[k] === null || r[k] === '' ? null : num(r[k]));
      return {
        type: 'zoho', id: c.id, name: c.name, status: c.status, providerStatus: c.zoho_status || null,
        createdAt: c.created_at, approvedAt: c.approved_at, startedAt: c.submitted_at, sentAt: c.submitted_at, lastActivityAt: c.submitted_at,
        recipients: null, sent: n('emails_sent_count'), failed: n('unsent_count'),
        replied: null, bounced: n('bounces_count'), unsubscribed: n('unsub_count'), opened: n('opens_count'),
        note: c.provider_message || null
      };
    })
  ].sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || '')) || b.id - a.id);

  const start = (page - 1) * PAGE;
  res.json({ success: true, page, hasMore: items.length > start + PAGE, campaigns: items.slice(start, start + PAGE) });
}));

module.exports = { router, deliveryOf, TRACKING_COLUMNS, TRACKING_JOIN, DELIVERY_SQL, LINKS_JOIN, PURPOSE_SQL, SOURCE_SQL };
