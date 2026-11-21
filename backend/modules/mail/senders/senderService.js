/**
 * Personal sender addresses ("My sender email").
 *
 * A member adds their own address; Marketech.ai emails it a single-use link (24 hours). Clicking it proves they
 * own the mailbox, and the address becomes theirs to send from:
 * - Campaigns: the From address must be one of the person's verified addresses (or, when an Owner/Admin sends a
 *   member's campaign, one of that member's).
 * - Compose and Mail Drafts: sent from the person's verified address. Nobody, Owners/Admins included, sends email
 *   without one (product email batches and system emails keep the workspace address).
 * Confirming the mailbox is Marketech.ai's own check; Amazon SES (and ZeptoMail) must also allow the address or
 * its domain, which is shown per address (sesReady) and can be requested from AWS (requestAws).
 * One address belongs to one member of the workspace. Public mailbox domains (Gmail, Yahoo...) are refused:
 * they fail email authentication when sent through Amazon SES or ZeptoMail.
 */
const crypto = require('crypto');
const { z } = require('zod');
const { run, get, all } = require('../../../db/database');
const { audit } = require('../../../lib/audit');

const PUBLIC_DOMAINS = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|gmx|yandex|proton|protonmail|mail|zoho|rediffmail)\.[a-z.]+$/i;
const EMAIL_RE = /^[^\s@"<>,;]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
const TOKEN_HOURS = 24;
const ws = ctx => ctx.auth.workspaceId;
const me = ctx => Number(ctx.auth.userId);
const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const isAdmin = ctx => !!ctx?.auth?.capabilities?.has?.('members.manage');

function httpError(status, message, code) { return Object.assign(new Error(message), { status, code }); }

/** The address's own inbox (IMAP), never the password. */
function presentInbox(r) {
  if (!r.imap_host || !r.imap_pass) return { connected: false };
  return { connected: true, host: r.imap_host, port: r.imap_port || 993, tls: Number(r.imap_tls) !== 0, login: r.email,
    status: r.imap_status || 'connected', error: r.imap_error || null, lastSyncedAt: r.imap_synced_at || null };
}

function present(r, ses = undefined) {
  return { id: r.id, email: r.email, name: r.display_name || null, status: r.status, verifiedAt: r.verified_at || null, lastSentAt: r.last_sent_at || null, createdAt: r.created_at,
    inbox: presentInbox(r), ...(ses !== undefined ? { ses } : {}) };
}

/**
 * Whether Amazon SES may send from this address (it, or its domain, verified in the AWS account):
 * { ready: true|false, identity } or null when SES is not set up or could not be asked.
 */
async function sesStatus(workspaceId, email) {
  const cfg = await require('../ses/sesSettings').sesConfig(workspaceId).catch(() => null);
  if (!cfg) return null;
  try {
    const v = await require('../ses/sesClient').identityVerified(cfg, email);
    return { ready: !!v.verified, identity: v.identity || null };
  } catch { return null; }
}

function publicBase() { return (process.env.APP_BASE_URL || '').replace(/\/$/, ''); }

/** The person's addresses (verified first). */
async function mine(ctx) {
  const rows = await all("SELECT * FROM member_sender_addresses WHERE workspace_id = ? AND user_id = ? ORDER BY status = 'verified' DESC, id", [ws(ctx), me(ctx)]).catch(() => []);
  const out = [];
  for (const r of rows) out.push(present(r, await sesStatus(ws(ctx), r.email)));
  // Everyone needs their own confirmed address to send Compose emails and campaigns.
  return { senders: out, required: true };
}

/** Emails the single-use link that proves the person owns the address. */
async function sendLink(ctx, row) {
  const token = crypto.randomBytes(32).toString('hex');
  await run(`UPDATE member_sender_addresses SET token_hash = ?, token_expires_at = UTC_TIMESTAMP() + INTERVAL ${TOKEN_HOURS} HOUR, last_sent_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = ?`, [hash(token), row.id]);
  const base = publicBase();
  if (!base) throw httpError(503, 'The app address (APP_BASE_URL) is not set on the server, so a verification link cannot be sent.', 'APP_BASE_URL_MISSING');
  const link = `${base}/api/v1/mail/senders/verify/${token}`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const who = ctx.auth.displayName || ctx.auth.email || 'A member';
  await require('../../../services/emailService').sendRealEmail(ws(ctx), {
    to: row.email,
    subject: 'Confirm your sender email address',
    text: `${who} added ${row.email} as their sender address in Marketech.ai.\n\nOpen this link to confirm it (valid for ${TOKEN_HOURS} hours):\n${link}\n\nIf you did not ask for this, ignore this email: nothing will be sent from this address.`,
    html: `<p>${esc(who)} added <b>${esc(row.email)}</b> as their sender address in Marketech.ai.</p><p><a href="${esc(link)}">Confirm this address</a> (valid for ${TOKEN_HOURS} hours).</p><p style="color:#64748b;font-size:12px">If you did not ask for this, ignore this email: nothing will be sent from this address.</p>`,
    purpose: 'transactional',
    record: false
  });
}

const addSchema = z.object({ email: z.string().trim().toLowerCase().max(255), name: z.string().trim().max(100).optional().nullable() }).strict();

/** Adds an address for the person and emails the confirmation link. */
async function add(ctx, input) {
  const v = addSchema.parse(input || {});
  if (!EMAIL_RE.test(v.email)) throw httpError(400, 'Enter a full email address, e.g. anita@yourcompany.com.', 'VALIDATION_ERROR');
  if (PUBLIC_DOMAINS.test(v.email)) throw httpError(400, 'Use your company address: Gmail, Yahoo, Outlook and other public mailboxes fail email authentication when sent from Marketech.ai.', 'PUBLIC_DOMAIN');
  const taken = await get('SELECT id, user_id, status FROM member_sender_addresses WHERE workspace_id = ? AND email = ?', [ws(ctx), v.email]);
  if (taken && Number(taken.user_id) !== me(ctx)) throw httpError(409, 'Another member already uses this address.', 'SENDER_TAKEN');
  let id = taken?.id;
  if (!taken) {
    id = (await run('INSERT INTO member_sender_addresses (workspace_id, user_id, email, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, \'pending\', UTC_TIMESTAMP(), UTC_TIMESTAMP())',
      [ws(ctx), me(ctx), v.email, v.name || null])).lastID;
  } else if (v.name !== undefined) {
    await run('UPDATE member_sender_addresses SET display_name = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [v.name || null, id]);
  }
  const row = await get('SELECT * FROM member_sender_addresses WHERE id = ?', [id]);
  if (row.status !== 'verified') await sendLink(ctx, row);
  await audit(ctx, 'mail.sender_added', { resourceType: 'sender_address', resourceId: id, metadata: { email: v.email, linkSent: row.status !== 'verified' } });
  const fresh = await get('SELECT * FROM member_sender_addresses WHERE id = ?', [id]);
  return { sender: present(fresh, await sesStatus(ws(ctx), fresh.email)) };
}

async function requireMine(ctx, rawId) {
  const row = await get('SELECT * FROM member_sender_addresses WHERE id = ? AND workspace_id = ? AND user_id = ?', [Number(rawId) || 0, ws(ctx), me(ctx)]);
  if (!row) throw httpError(404, 'Address not found.', 'NOT_FOUND');
  return row;
}

/** Sends the link again (at most once a minute). */
async function resend(ctx, rawId) {
  const row = await requireMine(ctx, rawId);
  if (row.status === 'verified') throw httpError(409, 'This address is already verified.', 'ALREADY_VERIFIED');
  const recent = await get('SELECT (last_sent_at > UTC_TIMESTAMP() - INTERVAL 60 SECOND) AS r FROM member_sender_addresses WHERE id = ?', [row.id]);
  if (Number(recent?.r)) throw httpError(429, 'A link was just sent. Wait a minute before sending another.', 'TOO_SOON');
  await sendLink(ctx, row);
  return { sender: present(await get('SELECT * FROM member_sender_addresses WHERE id = ?', [row.id])) };
}

/**
 * Asks Amazon SES to verify this address (AWS emails it its own link). Only for an address confirmed here first,
 * and only when SES cannot already send from it (its domain is not verified).
 */
async function requestAws(ctx, rawId) {
  const row = await requireMine(ctx, rawId);
  if (row.status !== 'verified') throw httpError(409, 'Confirm the address in Marketech.ai first (open the link we emailed).', 'NOT_VERIFIED');
  const cfg = await require('../ses/sesSettings').sesConfig(ws(ctx)).catch(() => null);
  if (!cfg) throw httpError(409, 'Amazon SES is not set up for this workspace.', 'SES_NOT_CONFIGURED');
  const ses = require('../ses/sesClient');
  if ((await ses.identityVerified(cfg, row.email)).verified) return { sender: present(row, { ready: true }), message: 'Amazon SES can already send from this address.' };
  try {
    const r = await ses.createEmailIdentity(cfg, row.email);
    await audit(ctx, 'mail.sender_aws_requested', { resourceType: 'sender_address', resourceId: row.id, metadata: { email: row.email, existed: r.existed } });
    return { sender: present(row, { ready: false }), message: r.existed
      ? `Amazon SES is already waiting for ${row.email} to be confirmed: open the email from Amazon Web Services in that mailbox.`
      : `Amazon Web Services emailed a confirmation link to ${row.email}. Open it (within 24 hours); then campaigns can be sent from this address.` };
  } catch (err) {
    if (err.providerCode === 'AccessDeniedException') throw httpError(403, 'The AWS key in use may not create identities (needs ses:CreateEmailIdentity). Ask your AWS admin to verify the address or its domain in the SES console.', 'AWS_ACCESS_DENIED');
    throw httpError(err.status && err.status < 500 ? err.status : 502, err.message || 'Amazon SES could not be asked.', err.code || 'SES_ERROR');
  }
}

async function remove(ctx, rawId) {
  const row = await requireMine(ctx, rawId);
  await run('DELETE FROM member_sender_addresses WHERE id = ?', [row.id]);
  await audit(ctx, 'mail.sender_removed', { resourceType: 'sender_address', resourceId: row.id, metadata: { email: row.email } });
  return { removed: true };
}

const inboxSchema = z.object({
  host: z.string().trim().toLowerCase().min(3).max(255).regex(/^[a-z0-9.-]+$/, 'Enter the IMAP server name, e.g. imap.zoho.com.'),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  tls: z.boolean().optional(),
  password: z.string().min(1, 'Enter the mailbox password or app password.').max(500)
}).strict();

/**
 * Connects the inbox (IMAP) of the person's own verified sender address. The login is always that same address,
 * so replies to what they send are read from it. The settings are saved only after a successful sign-in.
 */
async function setInbox(ctx, rawId, input) {
  const row = await requireMine(ctx, rawId);
  if (row.status !== 'verified') throw httpError(409, 'Confirm the address first (open the link we emailed), then connect its inbox.', 'NOT_VERIFIED');
  const v = inboxSchema.parse(input || {});
  const box = { imap_host: v.host, imap_port: v.port || 993, imap_tls: v.tls === false ? 0 : 1, imap_user: row.email, imap_pass: v.password };
  const mail = require('../../../services/emailService');
  try {
    await mail.testImapLogin(box);
  } catch (err) {
    if (err.code === 'UNSAFE_HOST' || err.code === 'MAIL_HOST_UNRESOLVED') throw httpError(400, err.message, err.code);
    throw httpError(400, `Could not sign in to ${row.email}: ${mail.imapErrorText(err, v.host, 'this form')}`, 'INBOX_LOGIN_FAILED');
  }
  const secretBox = require('../../../lib/secretBox');
  if (!secretBox.isConfigured()) throw httpError(503, 'The server has no encryption key set, so the inbox password cannot be stored safely.', 'ENCRYPTION_NOT_CONFIGURED');
  await run("UPDATE member_sender_addresses SET imap_host = ?, imap_port = ?, imap_tls = ?, imap_pass = ?, imap_status = 'connected', imap_error = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?",
    [box.imap_host, box.imap_port, box.imap_tls, secretBox.encrypt(v.password), row.id]);
  await audit(ctx, 'mail.sender_inbox_connected', { resourceType: 'sender_address', resourceId: row.id, metadata: { email: row.email, host: box.imap_host } });
  // First sync right away (a failure is shown on the address, the connection stays saved).
  await mail.syncMemberInboxes(ws(ctx), { userId: me(ctx) }).catch(() => null);
  return { sender: present(await get('SELECT * FROM member_sender_addresses WHERE id = ?', [row.id])) };
}

async function removeInbox(ctx, rawId) {
  const row = await requireMine(ctx, rawId);
  await run('UPDATE member_sender_addresses SET imap_host = NULL, imap_port = NULL, imap_pass = NULL, imap_status = NULL, imap_error = NULL, imap_synced_at = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?', [row.id]);
  await audit(ctx, 'mail.sender_inbox_removed', { resourceType: 'sender_address', resourceId: row.id, metadata: { email: row.email } });
  return { sender: present(await get('SELECT * FROM member_sender_addresses WHERE id = ?', [row.id])) };
}

/** Syncs the person's own inboxes now. */
async function syncMyInboxes(ctx) {
  const r = await require('../../../services/emailService').syncMemberInboxes(ws(ctx), { userId: me(ctx) });
  await require('../productEmails/service').detectUnsubscribeReplies({ workspaceId: ws(ctx) }).catch(() => null);
  return { ...r, ...(await mine(ctx)) };
}

/** The link in the email (no sign-in needed: the single-use token is the proof). */
async function verify(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return { ok: false, reason: 'This link is not valid.' };
  const row = await get('SELECT *, (token_expires_at < UTC_TIMESTAMP()) AS expired FROM member_sender_addresses WHERE token_hash = ?', [hash(token)]);
  if (!row) return { ok: false, reason: 'This link is not valid or was already used.' };
  if (Number(row.expired)) return { ok: false, reason: 'This link has expired. Send a new one from Marketech.ai.' };
  await run("UPDATE member_sender_addresses SET status = 'verified', verified_at = UTC_TIMESTAMP(), token_hash = NULL, token_expires_at = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?", [row.id]);
  await audit({ auth: { workspaceId: row.workspace_id, userId: row.user_id } }, 'mail.sender_verified', { resourceType: 'sender_address', resourceId: row.id, metadata: { email: row.email } });
  return { ok: true, email: row.email };
}

/** Whether this address is a verified sender address of one of these members (default: the person). */
async function ownsVerified(ctx, email, userIds = null) {
  const e = String(email || '').trim().toLowerCase();
  const ids = (userIds || [me(ctx)]).map(Number).filter(Boolean);
  if (!e || !ids.length) return false;
  return !!(await get(`SELECT 1 AS x FROM member_sender_addresses WHERE workspace_id = ? AND user_id IN (${ids.map(() => '?').join(',')}) AND email = ? AND status = 'verified'`, [ws(ctx), ...ids, e]).catch(() => null));
}

/**
 * The address the person sends from (Compose, drafts): the one they chose, or their first verified one.
 * Members who are not Owners/Admins must have one; Owners/Admins without one get null (the workspace address).
 */
async function senderFor(ctx, preferred = null) {
  const rows = await all("SELECT email, display_name FROM member_sender_addresses WHERE workspace_id = ? AND user_id = ? AND status = 'verified' ORDER BY id", [ws(ctx), me(ctx)]).catch(() => []);
  const want = String(preferred || '').trim().toLowerCase();
  if (want) {
    const r = rows.find(x => x.email === want);
    if (r) return { email: r.email, name: r.display_name || ctx.auth.displayName || null };
    throw httpError(403, `You can only send from your own verified address. ${want} is not one of them.`, 'SENDER_NOT_YOURS');
  }
  if (rows.length) return { email: rows[0].email, name: rows[0].display_name || ctx.auth.displayName || null };
  throw httpError(403, 'Add and confirm your own email address before sending (Mail Center → My sender email).', 'SENDER_REQUIRED');
}

module.exports = { mine, add, resend, remove, requestAws, verify, setInbox, removeInbox, syncMyInboxes, senderFor, ownsVerified, isAdmin, sesStatus, PUBLIC_DOMAINS };
