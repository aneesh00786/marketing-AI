const crypto = require('crypto');
const { run, get } = require('../db/database');
const { audit } = require('../lib/audit');
const authService = require('./authService');

/**
 * Passwords: "forgot password" links, resetting with a link, and changing it while signed in.
 *
 * Reset links carry a random single-use token; only its SHA-256 is stored. A link expires after
 * PASSWORD_RESET_TTL_MINUTES (default 30), a new request cancels older links, and using one signs
 * the account out on every device. Asking for a link never reveals whether an account exists.
 * The email is sent with the platform workspace's mail settings (SYSTEM_MAIL_WORKSPACE_ID,
 * default LEGACY_WORKSPACE_ID) and is not saved in that workspace's Sent mail.
 */
const MIN_LENGTH = 10;
const MAX_LENGTH = 200;
const TTL_MINUTES = () => Math.min(Math.max(parseInt(process.env.PASSWORD_RESET_TTL_MINUTES || '30', 10) || 30, 5), 24 * 60);
const SYSTEM_WS = () => parseInt(process.env.SYSTEM_MAIL_WORKSPACE_ID || process.env.LEGACY_WORKSPACE_ID || '1', 10);
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;
const { authError } = authService;

function checkNewPassword(password) {
  const p = String(password || '');
  if (p.length < MIN_LENGTH) throw authError(`Password must be at least ${MIN_LENGTH} characters.`, 400, 'WEAK_PASSWORD');
  if (p.length > MAX_LENGTH) throw authError(`Password must be at most ${MAX_LENGTH} characters.`, 400, 'VALIDATION_ERROR');
  return p;
}

function appUrl() {
  return (process.env.APP_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:8000').replace(/\/$/, '');
}

/** Sends a reset link if an active account has this email. Always resolves the same way. */
async function requestReset(email, ip = null) {
  const clean = String(email || '').toLowerCase().trim().slice(0, 255);
  if (!clean) throw authError('Enter your email address.', 400, 'VALIDATION_ERROR');
  const user = await get("SELECT id, email, display_name, status FROM users WHERE email = ?", [clean]);
  if (!user || (user.status && user.status !== 'Active')) return;

  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + TTL_MINUTES() * 60000);
  await run('UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL', [user.id]);
  await run('INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
    [user.id, sha(token), expires.toISOString().replace('T', ' ').slice(0, 19), ip ? String(ip).slice(0, 64) : null]);
  await run('DELETE FROM password_resets WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 7 DAY');
  await audit({ auth: { userId: user.id, workspaceId: null } }, 'auth.password_reset_requested', { resourceType: 'user', resourceId: user.id });

  const link = `${appUrl()}/?reset=${token}`;
  const name = user.display_name || user.email;
  const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const text = `Hi ${name},\n\nSomeone (hopefully you) asked to reset your Marketech.ai password.\n\nSet a new password: ${link}\n\nThe link works once and expires in ${TTL_MINUTES()} minutes. If you did not ask for this, ignore this email; your password stays the same.`;
  const html = `<p>Hi ${esc(name)},</p><p>Someone (hopefully you) asked to reset your Marketech.ai password.</p>`
    + `<p><a href="${esc(link)}">Set a new password</a></p>`
    + `<p style="color:#64748b;font-size:13px">The link works once and expires in ${TTL_MINUTES()} minutes. If you did not ask for this, ignore this email; your password stays the same.</p>`;
  try {
    await require('./emailService').sendRealEmail(SYSTEM_WS(), { to: user.email, subject: 'Reset your Marketech.ai password', html, text, record: false });
  } catch (err) {
    console.warn(`[auth] Password reset email could not be sent (${err.code || 'error'}): ${err.message}`);
    // Local development without mail: the link is printed so the flow can still be tested.
    if (process.env.NODE_ENV !== 'production') console.warn(`[auth] Development only — password reset link for ${user.email}: ${link}`);
  }
}

/** Sets a new password with a reset link. The link is used up and every sign-in is ended. */
async function resetPassword(token, password) {
  if (!TOKEN_RE.test(String(token || ''))) throw authError('This reset link is not valid. Ask for a new one.', 400, 'RESET_INVALID');
  const p = checkNewPassword(password);
  const hash = sha(token);
  const used = await run('UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()', [hash]);
  if (used.changes !== 1) throw authError('This reset link has expired or was already used. Ask for a new one.', 400, 'RESET_INVALID');
  const row = await get('SELECT user_id FROM password_resets WHERE token_hash = ?', [hash]);
  const user = await get('SELECT id, status FROM users WHERE id = ?', [row.user_id]);
  if (!user || (user.status && user.status !== 'Active')) throw authError('This account is not active.', 403, 'ACCOUNT_INACTIVE');
  await run('UPDATE users SET password_hash = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [authService.hashPassword(p), user.id]);
  await authService.signOutEverywhere(user.id);
  await audit({ auth: { userId: user.id, workspaceId: null } }, 'auth.password_reset', { resourceType: 'user', resourceId: user.id });
  return { reset: true };
}

/** Changes the password of the signed-in user; other devices are signed out, this one gets a fresh session. */
async function changePassword(auth, currentPassword, newPassword) {
  const user = await get('SELECT * FROM users WHERE id = ?', [auth.userId]);
  if (!user) throw authError('Authentication required.', 401, 'UNAUTHENTICATED');
  if (!authService.verifyPassword(String(currentPassword || ''), user.password_hash)) throw authError('Your current password is not correct.', 400, 'WRONG_PASSWORD');
  const p = checkNewPassword(newPassword);
  if (authService.verifyPassword(p, user.password_hash)) throw authError('Choose a password different from your current one.', 400, 'SAME_PASSWORD');
  await run('UPDATE users SET password_hash = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [authService.hashPassword(p), user.id]);
  await authService.signOutEverywhere(user.id);
  await audit({ auth: { userId: user.id, workspaceId: auth.workspaceId } }, 'auth.password_changed', { resourceType: 'user', resourceId: user.id });
  const fresh = await get('SELECT * FROM users WHERE id = ?', [user.id]);
  try {
    return await authService.sessionFor(fresh, auth.workspaceId);
  } catch (err) {
    // e.g. the platform admin viewing a workspace they are not a member of: open their own.
    const own = await authService.listMemberships(fresh.id);
    if (!own.length) throw err;
    return authService.sessionFor(fresh, own[0].id);
  }
}

module.exports = { requestReset, resetPassword, changePassword, checkNewPassword, MIN_LENGTH };
