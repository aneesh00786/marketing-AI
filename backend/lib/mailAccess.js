/**
 * Who sees which mail in Mail Center.
 *
 * Owners and Admins (members.manage), and anyone given "View all mail" (mail.view_all, Members → Permissions), see
 * every draft, email and campaign in the workspace. Everyone else sees only their own:
 *   - drafts they created;
 *   - emails they sent (Compose, drafts, product emails);
 *   - received emails from people they emailed (replies to their own mail or campaigns);
 *   - everything synced from their own inbox ("My sender email" → Inbox);
 *   - campaigns they created or sent;
 *   - contact lists they created (Mail Center → Campaigns → Contact lists).
 * Mail with no recorded author (e.g. made before authors were recorded, or by an automation) is visible to the
 * first group only. Every list and every action on one item goes through these checks, on the server.
 */
const has = (ctx, cap) => !!ctx?.auth?.capabilities?.has?.(cap);
const me = ctx => Number(ctx?.auth?.userId) || 0;

function seesAllMail(ctx) {
  return has(ctx, 'members.manage') || has(ctx, 'mail.view_all') || !!ctx?.auth?.platformAccess;
}

/** SQL (and params) limiting email_drafts rows (alias a) to the person's own. */
function draftScope(ctx, a = 'd') {
  return seesAllMail(ctx) ? { sql: '1 = 1', params: [] } : { sql: `${a}.created_by_user_id = ?`, params: [me(ctx)] };
}

/** SQL limiting mail_campaigns rows (alias a) to the person's own. */
function campaignScope(ctx, a = 'c') {
  return seesAllMail(ctx) ? { sql: '1 = 1', params: [] } : { sql: `(${a}.created_by = ? OR ${a}.submitted_by = ?)`, params: [me(ctx), me(ctx)] };
}

/**
 * SQL limiting emails rows (alias a) to the person's own: what they sent, and received mail from an address they
 * emailed themselves (one-to-one or in one of their campaigns).
 */
function emailScope(ctx, a = 'e') {
  if (seesAllMail(ctx)) return { sql: '1 = 1', params: [] };
  const u = me(ctx);
  return {
    sql: `(${a}.sent_by_user_id = ? OR ${a}.mailbox_user_id = ?
      OR (${a}.sent_by_user_id IS NULL AND ${a}.sender_email IS NOT NULL AND ${a}.sender_email <> '' AND (
        LOWER(TRIM(${a}.sender_email)) IN (SELECT LOWER(TRIM(o.recipient_email)) FROM emails o WHERE o.workspace_id = ${a}.workspace_id AND o.sent_by_user_id = ? AND o.recipient_email IS NOT NULL)
        OR LOWER(TRIM(${a}.sender_email)) IN (SELECT LOWER(TRIM(r.email)) FROM mail_campaign_recipients r JOIN mail_campaigns mc ON mc.id = r.campaign_id
          WHERE mc.workspace_id = ${a}.workspace_id AND (mc.created_by = ? OR mc.submitted_by = ?)))))`,
    params: [u, u, u, u, u]
  };
}

/** SQL limiting outreach_campaigns rows (AI Campaigns, alias a) to the person's own. */
function aiCampaignScope(ctx, a = 'c') {
  return seesAllMail(ctx) ? { sql: '1 = 1', params: [] } : { sql: `(${a}.created_by = ? OR ${a}.approved_by = ?)`, params: [me(ctx), me(ctx)] };
}

/** SQL limiting mail_draft_batches rows (product email batches, alias a) to the person's own. */
function batchScope(ctx, a = 'b') {
  return seesAllMail(ctx) ? { sql: '1 = 1', params: [] } : { sql: `(${a}.created_by = ? OR ${a}.sent_by = ?)`, params: [me(ctx), me(ctx)] };
}

/** SQL limiting mail_lists rows (contact lists, alias a) to the lists the person created. */
function listScope(ctx, a = 'l') {
  return seesAllMail(ctx) ? { sql: '1 = 1', params: [] } : { sql: `${a}.created_by = ?`, params: [me(ctx)] };
}

/** Whether one campaign row is the person's to see. */
function ownsCampaign(ctx, row) {
  return seesAllMail(ctx) || [row?.created_by, row?.submitted_by].map(Number).includes(me(ctx));
}

module.exports = { seesAllMail, draftScope, campaignScope, aiCampaignScope, batchScope, emailScope, listScope, ownsCampaign };
