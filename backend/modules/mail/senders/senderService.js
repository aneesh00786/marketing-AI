/**
 * Personal sender addresses ("My sender email").
 *
 * A member adds their own address; Marketech.ai emails it a single-use link (24 hours). Clicking it proves they
 * own the mailbox, and the address becomes theirs to send from:
 * - Campaigns: the From address must be one of the person's verified addresses (Owners/Admins: any address).
 * - Compose and Mail Drafts: sent from the person's verified address. Members who are not Owners/Admins cannot
 *   send email until they have one; Owners/Admins without one keep the workspace address (Mail Settings).
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

function present(r) {
  return { id: r.id, email: r.email, name: r.display_name || null, status: r.status, verifiedAt: r.verified_at || null, lastSentAt: r.last_sent_at || null, createdAt: r.created_at };
}

function publicBase() { return (process.env.APP_BASE_URL || '').replace(/\/$/, ''); }

/** The person's addresses (verified first). */
async function mine(ctx) {
  const rows = await all("SELECT * FROM member_sender_addresses WHERE workspace_id = ? AND user_id = ? ORDER BY status = 'verified' DESC, id", [ws(ctx), me(ctx)]).catch(() => []);
  return { senders: rows.map(present), required: !isAdmin(ctx) };
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
  return { sender: present(await get('SELECT * FROM member_sender_addresses WHERE id = ?', [id])) };
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

async function remove(ctx, rawId) {
  const row = await requireMine(ctx, rawId);
  await run('DELETE FROM member_sender_addresses WHERE id = ?', [row.id]);
  await audit(ctx, 'mail.sender_removed', { resourceType: 'sender_address', resourceId: row.id, metadata: { email: row.email } });
  return { removed: true };
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

/** Whether this address is one of the person's verified addresses. */
async function ownsVerified(ctx, email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  return !!(await get("SELECT 1 AS x FROM member_sender_addresses WHERE workspace_id = ? AND user_id = ? AND email = ? AND status = 'verified'", [ws(ctx), me(ctx), e]).catch(() => null));
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
    if (!isAdmin(ctx)) throw httpError(403, `You can only send from your own verified address. ${want} is not one of them.`, 'SENDER_NOT_YOURS');
  }
  if (rows.length) return { email: rows[0].email, name: rows[0].display_name || ctx.auth.displayName || null };
  if (isAdmin(ctx)) return null;
  throw httpError(403, 'Add and verify your own email address before sending (Mail Center → My sender email).', 'SENDER_REQUIRED');
}

module.exports = { mine, add, resend, remove, verify, senderFor, ownsVerified, isAdmin, PUBLIC_DOMAINS };
