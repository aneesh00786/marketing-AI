const { z } = require('zod');
const { run, get, all, withTransaction } = require('../../db/database');
const { audit } = require('../../lib/audit');
const { toDbDateTime } = require('../../lib/time');
const { generateStructured, untrusted } = require('../../lib/aiStructured');
const { getAdapter } = require('./providers');
const { canAccount } = require('./capabilities');
const accountService = require('./accountService');

const CATEGORIES = ['enquiry', 'lead', 'complaint', 'feedback', 'other'];
const MAX_AI_CLASSIFICATIONS_PER_SYNC = 20;

function httpError(status, message, code = 'BAD_REQUEST') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function toDb(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : toDbDateTime(d);
}

function presentThread(t) {
  return {
    id: t.id,
    socialAccountId: t.social_account_id,
    accountName: t.account_name ?? undefined,
    providerKey: t.provider_key,
    threadType: t.thread_type,
    externalObjectId: t.external_object_id,
    contentItemId: t.content_item_id,
    authorName: t.author_name,
    preview: t.preview_text,
    lastMessageAt: t.last_message_at,
    aiCategory: t.ai_category,
    aiSummary: t.ai_summary,
    status: t.status,
    assignedUserId: t.assigned_user_id,
    leadId: t.lead_id,
    createdAt: t.created_at
  };
}

/** Worker handler: pulls comments for one account through the official API. */
async function syncAccountInbox(job) {
  const { accountId } = JSON.parse(job.payload_json || '{}');
  const account = await accountService.getAccountRow(job.workspace_id, accountId);
  if (!account || account.status !== 'connected') return { skipped: 'account not connected' };
  if (!canAccount(account, 'comments_read')) return { skipped: 'comments_read not available' };

  const adapter = getAdapter(account.provider_key);
  try {
    const secret = await accountService.getUsableSecret(account);
    const posts = await all(
      `SELECT id, external_post_id FROM content_items WHERE workspace_id = ? AND social_account_id = ? AND status = 'published'
         AND external_post_id IS NOT NULL ORDER BY published_at DESC LIMIT 25`,
      [account.workspace_id, account.id]
    );
    const contentByExternal = new Map(posts.map(p => [p.external_post_id, p.id]));
    const threads = await adapter.listComments(account, secret, { externalObjectIds: posts.map(p => p.external_post_id) });

    let newThreads = 0;
    let newMessages = 0;
    for (const t of threads) {
      const existing = await get(
        'SELECT id FROM engagement_threads WHERE workspace_id = ? AND provider_key = ? AND external_thread_id = ?',
        [account.workspace_id, account.provider_key, t.externalThreadId]
      );
      const lastAt = toDb([t.createdAt, ...t.replies.map(r => r.createdAt)].filter(Boolean).sort().pop());
      let threadId = existing?.id;
      if (!threadId) {
        const ins = await run(
          `INSERT INTO engagement_threads (workspace_id, social_account_id, provider_key, thread_type, external_thread_id, external_object_id,
             content_item_id, author_name, author_external_id, preview_text, last_message_at, status, created_at)
           VALUES (?, ?, ?, 'comment', ?, ?, ?, ?, ?, ?, ?, 'open', UTC_TIMESTAMP())`,
          [account.workspace_id, account.id, account.provider_key, t.externalThreadId, t.externalObjectId,
            contentByExternal.get(t.externalObjectId) || null, t.authorName, t.authorId, String(t.text).slice(0, 500), lastAt]
        );
        threadId = ins.lastID;
        newThreads += 1;
      } else {
        await run('UPDATE engagement_threads SET last_message_at = GREATEST(COALESCE(last_message_at, ?), ?), updated_at = UTC_TIMESTAMP() WHERE id = ?', [lastAt, lastAt, threadId]);
      }
      const messages = [
        { externalMessageId: t.externalThreadId, authorName: t.authorName, text: t.text, createdAt: t.createdAt, fromAccount: false },
        ...t.replies
      ];
      for (const m of messages) {
        const res = await run(
          `INSERT IGNORE INTO engagement_messages (workspace_id, thread_id, direction, external_message_id, author_name, body_text, status, provider_created_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
          [account.workspace_id, threadId, m.fromAccount ? 'out' : 'in', m.externalMessageId, m.authorName, m.text || '', m.fromAccount ? 'sent' : 'received', toDb(m.createdAt)]
        );
        newMessages += res.changes;
      }
    }

    // Classify a bounded number of new, unclassified threads to control AI cost.
    const unclassified = await all(
      `SELECT id FROM engagement_threads WHERE workspace_id = ? AND social_account_id = ? AND ai_category IS NULL ORDER BY id DESC LIMIT ${MAX_AI_CLASSIFICATIONS_PER_SYNC}`,
      [account.workspace_id, account.id]
    );
    let classified = 0;
    for (const t of unclassified) {
      try {
        await analyzeThread({ auth: { workspaceId: account.workspace_id, actorType: 'worker' } }, t.id);
        classified += 1;
      } catch (e) {
        if (e.code === 'AI_UNAVAILABLE' || e.code === 'QUOTA_EXCEEDED') break;
      }
    }
    await accountService.recordAccountSuccess(account);
    return { threads: threads.length, newThreads, newMessages, classified };
  } catch (err) {
    if (['AUTH_EXPIRED', 'PERMISSION_DENIED'].includes(err.code)) {
      await accountService.recordAccountFailure(account, err);
      err.retryable = false;
    }
    throw err;
  }
}

async function listThreads(workspaceId, { status, category, accountId, limit = 100 } = {}) {
  const where = ['t.workspace_id = ?'];
  const params = [workspaceId];
  if (status && status !== 'all') { where.push('t.status = ?'); params.push(status); }
  if (category && category !== 'all') { where.push('t.ai_category = ?'); params.push(category); }
  if (accountId) { where.push('t.social_account_id = ?'); params.push(Number(accountId)); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 300);
  const rows = await all(
    `SELECT t.*, a.display_name AS account_name FROM engagement_threads t
     JOIN social_accounts a ON a.workspace_id = t.workspace_id AND a.id = t.social_account_id
     WHERE ${where.join(' AND ')} ORDER BY t.last_message_at DESC, t.id DESC LIMIT ${lim}`,
    params
  );
  return rows.map(presentThread);
}

async function requireThread(workspaceId, threadId) {
  const t = await get(
    `SELECT t.*, a.display_name AS account_name FROM engagement_threads t
     JOIN social_accounts a ON a.workspace_id = t.workspace_id AND a.id = t.social_account_id
     WHERE t.workspace_id = ? AND t.id = ?`,
    [workspaceId, threadId]
  );
  if (!t) throw httpError(404, 'Conversation not found.', 'NOT_FOUND');
  return t;
}

async function getThread(workspaceId, threadId) {
  const t = await requireThread(workspaceId, threadId);
  const messages = await all(
    'SELECT id, direction, author_name, body_text, status, ai_suggested, approved_by, sent_by, sent_at, error_message, provider_created_at, created_at FROM engagement_messages WHERE workspace_id = ? AND thread_id = ? ORDER BY COALESCE(provider_created_at, created_at) ASC, id ASC',
    [workspaceId, threadId]
  );
  const account = await accountService.getAccountRow(workspaceId, t.social_account_id);
  return {
    thread: presentThread(t),
    messages,
    canReply: !!account && account.status === 'connected' && canAccount(account, 'comments_reply')
  };
}

const AnalysisSchema = z.object({
  category: z.enum(CATEGORIES),
  summary: z.string().min(1).max(600)
});

async function analyzeThread(ctx, threadId) {
  const workspaceId = ctx.auth.workspaceId;
  const { thread, messages } = await getThread(workspaceId, threadId);
  const transcript = messages.map(m => `${m.direction === 'out' ? 'BUSINESS' : (m.author_name || 'CUSTOMER')}: ${m.body_text}`).join('\n');
  const { data } = await generateStructured({
    workspaceId,
    prompt: `Classify this social media conversation as one of: ${CATEGORIES.join(', ')}. "lead" means the person shows buying intent or asks to be contacted. Summarise it in one or two sentences.\n${untrusted('social_comments', transcript, 4000)}\nReturn {"category":"...","summary":"..."}`,
    system: 'You triage social media comments for a business.',
    schema: AnalysisSchema,
    referenceType: 'engagement_thread',
    referenceId: threadId,
    maxTokens: 300
  });
  await run('UPDATE engagement_threads SET ai_category = ?, ai_summary = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?', [data.category, data.summary, workspaceId, thread.id]);
  return { category: data.category, summary: data.summary };
}

const ReplySchema = z.object({ reply: z.string().min(1).max(1500) });

/** Creates an editable AI draft. It is never sent without explicit human approval. */
async function suggestReply(ctx, threadId, { guidance = '' } = {}) {
  const workspaceId = ctx.auth.workspaceId;
  const { thread, messages } = await getThread(workspaceId, threadId);
  const profile = await get('SELECT business_name, brand_voice FROM business_profiles WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [workspaceId]);
  const transcript = messages.filter(m => m.status !== 'draft_reply').map(m => `${m.direction === 'out' ? 'BUSINESS' : (m.author_name || 'CUSTOMER')}: ${m.body_text}`).join('\n');
  const { data } = await generateStructured({
    workspaceId,
    prompt: `Draft a short, helpful public reply from ${profile?.business_name || 'the business'} (voice: ${profile?.brand_voice || 'professional and friendly'}).
Do not promise prices, discounts, delivery dates or anything not stated. If details are needed, invite them to send a direct message or contact the team.
${guidance ? `Staff guidance: ${String(guidance).slice(0, 300)}\n` : ''}${untrusted('social_comments', transcript, 4000)}
Return {"reply":"..."}`,
    system: 'You write courteous social media replies for a business. Keep replies under 80 words.',
    schema: ReplySchema,
    referenceType: 'engagement_thread',
    referenceId: threadId,
    maxTokens: 400
  });
  const ins = await run(
    `INSERT INTO engagement_messages (workspace_id, thread_id, direction, author_name, body_text, status, ai_suggested, created_at)
     VALUES (?, ?, 'out', NULL, ?, 'draft_reply', 1, UTC_TIMESTAMP())`,
    [workspaceId, thread.id, data.reply]
  );
  await audit(ctx, 'social.inbox.reply_drafted', { resourceType: 'engagement_thread', resourceId: thread.id, metadata: { messageId: ins.lastID } });
  return { messageId: ins.lastID, text: data.reply, aiSuggested: true };
}

/** Sends a reply that a staff member has reviewed (and possibly edited). */
async function sendReply(ctx, threadId, { text, draftMessageId = null }) {
  const workspaceId = ctx.auth.workspaceId;
  const body = String(text || '').trim();
  if (!body) throw httpError(400, 'Reply text is required.');
  if (body.length > 1500) throw httpError(400, 'Reply is too long (max 1500 characters).');
  const thread = await requireThread(workspaceId, threadId);
  const account = await accountService.getAccountRow(workspaceId, thread.social_account_id);
  if (!account || account.status !== 'connected') throw httpError(409, 'The account is not connected.', 'ACCOUNT_NOT_CONNECTED');
  if (!canAccount(account, 'comments_reply')) throw httpError(409, 'Replying is not available for this account (missing permission or unsupported).', 'CAPABILITY_UNAVAILABLE');

  let messageId = draftMessageId;
  if (messageId) {
    const draft = await get("SELECT id FROM engagement_messages WHERE workspace_id = ? AND thread_id = ? AND id = ? AND status IN ('draft_reply', 'failed')", [workspaceId, threadId, messageId]);
    if (!draft) throw httpError(404, 'Draft reply not found.');
    await run("UPDATE engagement_messages SET body_text = ?, status = 'approved', approved_by = ? WHERE id = ?", [body, ctx.auth.userId, messageId]);
  } else {
    const ins = await run(
      "INSERT INTO engagement_messages (workspace_id, thread_id, direction, body_text, status, ai_suggested, approved_by, created_at) VALUES (?, ?, 'out', ?, 'approved', 0, ?, UTC_TIMESTAMP())",
      [workspaceId, threadId, body, ctx.auth.userId]
    );
    messageId = ins.lastID;
  }
  // Claim the message so a double click cannot send it twice.
  const claim = await run("UPDATE engagement_messages SET status = 'sending' WHERE id = ? AND status = 'approved'", [messageId]);
  if (claim.changes !== 1) throw httpError(409, 'This reply is already being sent.', 'IN_PROGRESS');

  try {
    const secret = await accountService.getUsableSecret(account);
    const result = await getAdapter(account.provider_key).replyToComment(account, secret, thread.external_thread_id, body, { externalObjectId: thread.external_object_id });
    await withTransaction(async (tx) => {
      await tx.run("UPDATE engagement_messages SET status = 'sent', external_message_id = ?, sent_by = ?, sent_at = UTC_TIMESTAMP(), author_name = ? WHERE id = ?", [result.externalId, ctx.auth.userId, account.display_name, messageId]);
      await tx.run('UPDATE engagement_threads SET last_message_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?', [threadId]);
    });
    await accountService.recordAccountSuccess(account);
    await audit(ctx, 'social.inbox.reply_sent', { resourceType: 'engagement_thread', resourceId: threadId, metadata: { messageId, externalId: result.externalId } });
    return { messageId, status: 'sent', externalId: result.externalId };
  } catch (err) {
    const status = err.outcomeUnknown ? 'unknown' : 'failed';
    await run('UPDATE engagement_messages SET status = ?, error_message = ? WHERE id = ?', [status, String(err.message).slice(0, 1000), messageId]);
    if (['AUTH_EXPIRED', 'PERMISSION_DENIED'].includes(err.code)) await accountService.recordAccountFailure(account, err);
    await audit(ctx, 'social.inbox.reply_failed', { resourceType: 'engagement_thread', resourceId: threadId, metadata: { messageId, code: err.code, message: err.message } });
    throw httpError(502, status === 'unknown' ? `Reply outcome unknown (${err.message}). Check the platform before resending.` : `Reply failed: ${err.message}`, err.code || 'PROVIDER_ERROR');
  }
}

async function updateThread(ctx, threadId, { status, assignedUserId }) {
  const workspaceId = ctx.auth.workspaceId;
  await requireThread(workspaceId, threadId);
  const sets = [];
  const params = [];
  if (status !== undefined) {
    if (!['open', 'resolved'].includes(status)) throw httpError(400, 'Status must be open or resolved.');
    sets.push('status = ?'); params.push(status);
  }
  if (assignedUserId !== undefined) {
    if (assignedUserId !== null) {
      const m = await get("SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'Active'", [workspaceId, assignedUserId]);
      if (!m) throw httpError(400, 'Assignee is not a member of this workspace.');
    }
    sets.push('assigned_user_id = ?'); params.push(assignedUserId);
  }
  if (sets.length) {
    await run(`UPDATE engagement_threads SET ${sets.join(', ')}, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?`, [...params, workspaceId, threadId]);
    await audit(ctx, 'social.inbox.thread_updated', { resourceType: 'engagement_thread', resourceId: threadId, metadata: { status, assignedUserId } });
  }
  return presentThread(await requireThread(workspaceId, threadId));
}

/** Links an enquiry to the existing Leads module. */
async function createLeadFromThread(ctx, threadId, { name, email, phone, notes } = {}) {
  const workspaceId = ctx.auth.workspaceId;
  const thread = await requireThread(workspaceId, threadId);
  if (thread.lead_id) return { leadId: thread.lead_id, alreadyLinked: true };
  const leadName = String(name || thread.author_name || 'Social media contact').slice(0, 255);
  const ins = await run(
    `INSERT INTO leads (workspace_id, name, email, phone, product_interest, notes, status, ai_category, ai_suggestion, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'New', ?, ?, UTC_TIMESTAMP())`,
    [workspaceId, leadName, email || null, phone || null, `Social (${thread.provider_key})`,
      `${notes ? `${notes}\n` : ''}From ${thread.account_name} comment: "${String(thread.preview_text || '').slice(0, 400)}"`,
      thread.ai_category === 'lead' ? 'Warm' : 'Cold', thread.ai_summary || null]
  );
  await run('UPDATE engagement_threads SET lead_id = ?, updated_at = UTC_TIMESTAMP() WHERE workspace_id = ? AND id = ?', [ins.lastID, workspaceId, threadId]);
  await audit(ctx, 'social.inbox.lead_created', { resourceType: 'engagement_thread', resourceId: threadId, metadata: { leadId: ins.lastID } });
  return { leadId: ins.lastID, alreadyLinked: false };
}

module.exports = {
  CATEGORIES,
  syncAccountInbox,
  listThreads,
  getThread,
  analyzeThread,
  suggestReply,
  sendReply,
  updateThread,
  createLeadFromThread
};
