const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { run, get, all } = require('../db/database');
const aiEngine = require('./aiEngine');
const secretBox = require('../lib/secretBox');
const dns = require('dns');
const net = require('net');
const { isBlockedAddress } = require('../lib/safeFetch');
const { LEGACY_WORKSPACE_ID } = require('../middleware/auth');

const isLegacy = workspaceId => Number(workspaceId) === LEGACY_WORKSPACE_ID;
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
// Reserved / placeholder domains (RFC 2606) are never real recipients.
const PLACEHOLDER_DOMAIN_RE = /@(?:[^@]+\.)?(example\.(com|org|net)|[^@]+\.(example|test|invalid|localhost))$/i;
const isValidRecipient = v => EMAIL_RE.test(String(v || '').trim()) && !PLACEHOLDER_DOMAIN_RE.test(String(v || '').trim());

// Network timeouts (ms). TLS certificates are always verified.
const ZEPTO_TIMEOUT_MS = 20000;
const SMTP_TIMEOUTS = { connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000 };
const IMAP_TIMEOUTS = { connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000 };

// Failures before a connection was established: nothing can have been sent.
const NOT_CONNECTED_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/** True when an SMTP error leaves it unclear whether the server accepted the message. */
function smtpOutcomeUnknown(err) {
  if (!err) return false;
  if (err.responseCode) return false; // the server answered with a rejection
  if (['EAUTH', 'ECONNECTION', 'EDNS', 'EENVELOPE', 'EMESSAGE', 'ETLS'].includes(err.code)) return false;
  if (['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH PLAIN', 'AUTH LOGIN', 'AUTH XOAUTH2'].includes(err.command)) return false;
  if (NOT_CONNECTED_CODES.has(err.code)) return false;
  return true;
}

function mailError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * A provider error whose delivery outcome is unknown: the message may have been accepted before
 * the failure (timeout, dropped connection, server error). Such an email is never resent
 * automatically or retried through another provider; a person checks first.
 */
function outcomeUnknownError(message, cause) {
  const err = mailError(`Delivery outcome unknown: ${message}. It may or may not have been delivered; check before sending again.`, 502, 'MAIL_OUTCOME_UNKNOWN');
  err.outcomeUnknown = true;
  if (cause) err.cause = cause;
  return err;
}

/**
 * SMTP/IMAP hosts come from workspace settings, so they must not point at private,
 * loopback or metadata addresses (set MAIL_ALLOW_PRIVATE_HOSTS=true for a local relay).
 */
async function assertSafeMailHost(host) {
  if (process.env.MAIL_ALLOW_PRIVATE_HOSTS === 'true') return;
  const h = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (!h) throw mailError('Mail server host is missing.', 400, 'MAIL_NOT_CONFIGURED');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) {
    throw mailError('Private or internal mail hosts are not allowed.', 400, 'UNSAFE_HOST');
  }
  const addresses = net.isIP(h) ? [{ address: h }] : await dns.promises.lookup(h, { all: true }).catch(() => {
    throw mailError(`Mail server host ${h} could not be resolved.`, 400, 'MAIL_HOST_UNRESOLVED');
  });
  if (addresses.some(a => isBlockedAddress(a.address))) {
    throw mailError('Private, loopback and metadata mail hosts are not allowed.', 400, 'UNSAFE_HOST');
  }
}


/**
 * Company Mail Service (ZeptoMail / custom SMTP & IMAP). Every call is for one workspace
 * and uses only that workspace's saved settings; the .env mailbox serves the legacy
 * workspace only.
 */

async function sendZeptoMail({ to, recipientName = '', subject, html, text = '', fromAddress, fromName, replyTo, token, tracking = null }) {
  // The caller resolves the token for its own workspace; there is no shared fallback here.
  const authToken = token;
  if (!authToken) {
    throw mailError('ZeptoMail is not configured for this workspace. Add the ZeptoMail token in Mail Settings.', 503, 'MAIL_NOT_CONFIGURED');
  }
  let res;
  try {
    res = await fetch('https://api.zeptomail.com/v1.1/email', {
      method: 'POST',
      headers: {
        'Authorization': authToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: { address: fromAddress, name: fromName || fromAddress },
        to: [{ email_address: { address: to, name: recipientName || to } }],
        reply_to: [{ address: replyTo || fromAddress, name: fromName || fromAddress }],
        subject: subject,
        htmlbody: html || require('../lib/mailContent').textToHtml(text),
        // Plain-text part for clients that do not show HTML.
        textbody: text || undefined,
        // Tracked Mail Center emails: our opaque reference, and ZeptoMail's open/click tracking set
        // explicitly from the workspace policy (off unless enabled and reportable).
        ...(tracking ? { client_reference: tracking.clientReference, track_opens: !!tracking.trackOpens, track_clicks: !!tracking.trackClicks } : {})
      }),
      signal: AbortSignal.timeout(ZEPTO_TIMEOUT_MS)
    });
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    if (NOT_CONNECTED_CODES.has(code)) throw mailError(`ZeptoMail could not be reached (${code}).`, 502, 'MAIL_SEND_FAILED');
    throw outcomeUnknownError(err?.name === 'TimeoutError' ? 'ZeptoMail did not answer in time' : `the connection to ZeptoMail failed (${code || err?.message})`, err);
  }

  if (!res.ok) {
    const errText = (await res.text().catch(() => '')).slice(0, 300);
    // 5xx: ZeptoMail may have accepted the message before failing.
    if (res.status >= 500) throw outcomeUnknownError(`ZeptoMail returned HTTP ${res.status}`);
    throw mailError(`ZeptoMail API error (${res.status}): ${errText}`, 502, 'MAIL_SEND_FAILED');
  }

  // Accepted. The provider's request id is kept when present; none is invented.
  const data = await res.json().catch(() => ({}));
  return {
    messageId: data.request_id || null,
    data
  };
}

async function getRawMailConfig(workspaceId) {
  if (!workspaceId) throw mailError('Workspace is required.', 400, 'WORKSPACE_REQUIRED');
  let row = await get('SELECT * FROM mail_configurations WHERE workspace_id = ? LIMIT 1', [workspaceId]);
  if (!row && !isLegacy(workspaceId)) {
    // Other workspaces never inherit the server's mailbox or credentials.
    return {
      workspace_id: workspaceId, provider: null, smtp_host: null, smtp_port: 587, smtp_secure: 0, smtp_user: null, smtp_pass: '',
      imap_host: null, imap_port: 993, imap_tls: 1, imap_user: null, imap_pass: '', sender_name: null, sender_email: null,
      status: 'Not Configured', last_synced_at: null, exists: false
    };
  }
  if (!row) {
    row = {
      workspace_id: workspaceId,
      provider: 'zeptomail',
      smtp_host: process.env.SMTP_HOST || 'smtp.zeptomail.com',
      smtp_port: parseInt(process.env.SMTP_PORT || '587', 10),
      smtp_secure: 0,
      smtp_user: process.env.SMTP_USER || 'emailapikey',
      smtp_pass: process.env.SMTP_PASS || '',
      imap_host: process.env.IMAP_HOST || 'imap.zoho.com',
      imap_port: parseInt(process.env.IMAP_PORT || '993', 10),
      imap_tls: 1,
      imap_user: process.env.IMAP_USER || null,
      imap_pass: process.env.IMAP_PASS || '',
      sender_name: process.env.MAIL_FROM_NAME || null,
      sender_email: process.env.MAIL_FROM_ADDRESS || null,
      status: process.env.MAIL_FROM_ADDRESS ? 'Connected' : 'Not Configured'
    };
  }
  // Mailbox passwords are encrypted at rest; decrypt only for transport use.
  return {
    ...row,
    smtp_pass: secretBox.decrypt(row.smtp_pass),
    imap_pass: secretBox.decrypt(row.imap_pass)
  };
}

function encryptIfPossible(value) {
  if (!value || value.startsWith('[env:')) return value;
  return secretBox.isConfigured() ? secretBox.encrypt(value) : value;
}

/** ZeptoMail token: the workspace's own; the .env token only ever serves the legacy workspace. */
function zeptoToken(workspaceId, config) {
  const own = (config.smtp_pass && config.smtp_pass !== '••••••••' && !String(config.smtp_pass).startsWith('[env:')) ? config.smtp_pass : null;
  return own || (isLegacy(workspaceId) ? process.env.ZEPTOMAIL_TOKEN : null) || null;
}

/**
 * Whether this workspace may send marketing email (Product Emails), and why not. ZeptoMail is a
 * transactional-only service, so marketing never goes through it; the workspace's own SMTP mailbox
 * is used only after an Owner/Admin confirms the provider allows marketing email.
 */
function marketingDeliveryProblem(workspaceId, config) {
  if (usesZepto(workspaceId, config)) {
    return { code: 'MARKETING_PROVIDER_BLOCKED', message: 'Marketing emails cannot be sent through ZeptoMail: Zoho limits ZeptoMail to transactional email. Set up Amazon SES (Mail Center → Settings → Campaigns), or an SMTP mailbox approved for marketing (Mail Settings).' };
  }
  if (!config.smtp_host || !config.smtp_user || !config.smtp_pass) {
    return { code: 'MARKETING_SMTP_REQUIRED', message: 'Marketing emails need an SMTP mailbox configured in Mail Settings.' };
  }
  if (!Number(config.marketing_approved)) {
    return { code: 'MARKETING_NOT_APPROVED', message: 'This SMTP mailbox is not approved for marketing email yet. A workspace Owner or Admin can approve it in Mail Center → Settings → Marketing email, after confirming the provider allows marketing email.' };
  }
  return null;
}

async function marketingDeliveryStatus(workspaceId) {
  const config = await getRawMailConfig(workspaceId);
  const problem = marketingDeliveryProblem(workspaceId, config);
  // Without an approved SMTP mailbox, marketing email goes through Amazon SES when it is set up.
  const viaSes = problem ? !!(await sesForMarketing(workspaceId)) : false;
  return {
    allowed: !problem || viaSes,
    code: problem && !viaSes ? problem.code : null,
    reason: problem && !viaSes ? problem.message : null,
    provider: config.provider || null,
    marketingVia: !problem ? 'smtp' : viaSes ? 'ses' : null,
    approvedAt: config.marketing_approved_at || null
  };
}

/** Amazon SES settings when marketing email may go through SES (set up for this workspace or the server), else null. */
async function sesForMarketing(workspaceId) {
  try { return await require('../modules/mail/ses/sesSettings').sesConfig(workspaceId); } catch { return null; }
}

/** Sends one email through Amazon SES (raw MIME, so List-Unsubscribe headers and tracking are kept). */
async function sendViaSes(cfg, { fromAddress, senderEmail, to, subject, html, text, replyTo, headers }) {
  const ses = require('../modules/mail/ses/sesClient');
  const v = await ses.identityVerified(cfg, senderEmail);
  if (!v.verified) {
    throw mailError(`Not sent: the sender ${senderEmail} is not verified in Amazon SES. Verify this address or its domain in the SES console (region ${cfg.region}), or change the sender address in Mail Settings.`, 409, 'SES_SENDER_NOT_VERIFIED');
  }
  const MailComposer = require('nodemailer/lib/mail-composer');
  const raw = await new Promise((resolve, reject) => {
    new MailComposer({ from: fromAddress, to, subject, html, text, replyTo, ...(headers ? { headers } : {}) })
      .compile().build((err, buf) => (err ? reject(err) : resolve(buf)));
  });
  return ses.sendRaw(cfg, { from: senderEmail, to, raw, configurationSet: cfg.configurationSet || null, tags: { source: 'mail_center' } });
}

/** Owner/Admin confirmation that the SMTP mailbox may be used for marketing (or withdrawal of it). */
async function setMarketingApproval(workspaceId, { approved, userId, note }) {
  const config = await getRawMailConfig(workspaceId);
  if (config.exists === false || !(await get('SELECT id FROM mail_configurations WHERE workspace_id = ?', [workspaceId]))) {
    throw mailError('Save your mail settings first.', 400, 'MAIL_NOT_CONFIGURED');
  }
  if (approved) {
    const p = marketingDeliveryProblem(workspaceId, { ...config, marketing_approved: 1 });
    if (p) throw mailError(p.message, 409, p.code);
  }
  await run(
    'UPDATE mail_configurations SET marketing_approved = ?, marketing_approved_by = ?, marketing_approved_at = ?, marketing_approval_note = ? WHERE workspace_id = ?',
    approved ? [1, userId, new Date().toISOString().replace('T', ' ').substring(0, 19), note ? String(note).slice(0, 255) : null, workspaceId] : [0, null, null, null, workspaceId]
  );
  return marketingDeliveryStatus(workspaceId);
}

function usesZepto(workspaceId, config) {
  return config.provider === 'zeptomail';
}

const PLACEHOLDER_HOST = /(^|\.)(invalid|example|test|localhost)$|(^|\.)example\.(com|net|org)$/i;
function imapConfigured(raw) {
  const host = String(raw.imap_host || '').trim();
  return !!(host && !PLACEHOLDER_HOST.test(host) && raw.imap_user && raw.imap_pass);
}

async function getSafeMailConfig(workspaceId) {
  const raw = await getRawMailConfig(workspaceId);
  return {
    ...raw,
    smtp_pass: raw.smtp_pass ? '••••••••' : '',
    imap_pass: raw.imap_pass ? '••••••••' : '',
    has_smtp_auth: !!(raw.smtp_user && raw.smtp_pass),
    // Replies are set up only with a real server, a login and a password: sample values (reserved
    // .invalid/.example hosts, e.g. from the demo seed) do not count.
    has_imap_auth: imapConfigured(raw)
  };
}

async function saveMailConfig(workspaceId, config = {}) {
  const existing = await getRawMailConfig(workspaceId);
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  // Preserve existing password if placeholder '••••••••' was submitted
  const smtpPass = (config.smtp_pass && config.smtp_pass !== '••••••••') 
    ? config.smtp_pass 
    : (existing.smtp_pass || '');

  const imapPass = (config.imap_pass && config.imap_pass !== '••••••••') 
    ? config.imap_pass 
    : (existing.imap_pass || '');

  const provider = config.provider || existing.provider || 'custom_smtp';
  const smtpHost = config.smtp_host || existing.smtp_host || null;
  const smtpPort = parseInt(config.smtp_port || existing.smtp_port || '587', 10);
  const smtpSecure = config.smtp_secure ? 1 : 0;
  const smtpUser = (config.smtp_user !== undefined) ? config.smtp_user : existing.smtp_user;
  const imapHost = config.imap_host || existing.imap_host || null;
  const imapPort = parseInt(config.imap_port || existing.imap_port || '993', 10);
  const imapTls = config.imap_tls ? 1 : 0;
  const imapUser = (config.imap_user !== undefined) ? config.imap_user : (config.smtp_user || existing.imap_user);
  const senderName = config.sender_name || existing.sender_name || null;
  // No invented sender: an explicit address, or the SMTP login when it is an address.
  const senderEmail = config.sender_email || existing.sender_email || (EMAIL_RE.test(smtpUser || '') ? smtpUser : null);
  const hasTransport = provider === 'zeptomail' ? !!smtpPass : !!(smtpUser && smtpPass);
  const status = hasTransport ? 'Configured' : 'Not Configured';

  const params = [
    provider, smtpHost, smtpPort, smtpSecure, smtpUser, encryptIfPossible(smtpPass),
    imapHost, imapPort, imapTls, imapUser, encryptIfPossible(imapPass),
    senderName, senderEmail, status, now
  ];
  const row = await get('SELECT id FROM mail_configurations WHERE workspace_id = ? LIMIT 1', [workspaceId]);
  if (row) {
    // Marketing approval belongs to one sending account: a different provider/server/login/sender clears it.
    const changed = ['provider', 'smtp_host', 'smtp_user', 'sender_email'].some((k, i) => String(existing[k] || '') !== String([provider, smtpHost, smtpUser, senderEmail][i] || ''));
    if (changed) {
      await run('UPDATE mail_configurations SET marketing_approved = 0, marketing_approved_by = NULL, marketing_approved_at = NULL, marketing_approval_note = NULL WHERE workspace_id = ?', [workspaceId]);
    }
    await run(`
      UPDATE mail_configurations
      SET provider = ?, smtp_host = ?, smtp_port = ?, smtp_secure = ?, smtp_user = ?, smtp_pass = ?,
          imap_host = ?, imap_port = ?, imap_tls = ?, imap_user = ?, imap_pass = ?,
          sender_name = ?, sender_email = ?, status = ?, updated_at = ?
      WHERE workspace_id = ?
    `, [...params, workspaceId]);
  } else {
    await run(`
      INSERT INTO mail_configurations (provider, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass,
        imap_host, imap_port, imap_tls, imap_user, imap_pass, sender_name, sender_email, status, updated_at, created_at, workspace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [...params, now, workspaceId]);
  }

  return await getSafeMailConfig(workspaceId);
}

function createSmtpTransporter(config) {
  if (!config.smtp_user || !config.smtp_pass) {
    return null;
  }

  const port = parseInt(config.smtp_port, 10) || 587;
  const isSecure = config.smtp_secure === 1 || port === 465;

  return nodemailer.createTransport(smtpTransportOptions(config, port, isSecure));
}

/** SMTP options: certificates are verified, TLS 1.2+, bounded timeouts. */
function smtpTransportOptions(config, port = parseInt(config.smtp_port, 10) || 587, isSecure = config.smtp_secure === 1 || port === 465) {
  return {
    host: config.smtp_host,
    port,
    secure: isSecure,
    auth: {
      user: config.smtp_user,
      pass: config.smtp_pass
    },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    ...SMTP_TIMEOUTS
  };
}

/** IMAP options: certificates are verified, TLS 1.2+, bounded timeouts. */
function imapClientOptions(config) {
  return {
    host: config.imap_host,
    port: parseInt(config.imap_port, 10) || 993,
    secure: config.imap_tls === 1,
    auth: {
      user: config.imap_user,
      pass: config.imap_pass
    },
    logger: false,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    ...IMAP_TIMEOUTS
  };
}

/**
 * Checks the workspace's saved settings, optionally overlaid with unsaved form values.
 * Saved passwords are used when the form sends the mask; nothing falls back to another
 * workspace or to the server's mailbox (except the legacy workspace's .env defaults).
 */
async function verifySmtpConnection(workspaceId, testConfig = null) {
  const saved = await getRawMailConfig(workspaceId);
  const config = { ...saved };
  if (testConfig && typeof testConfig === 'object') {
    for (const k of ['provider', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'sender_email', 'sender_name']) {
      if (testConfig[k] !== undefined && testConfig[k] !== null && testConfig[k] !== '') config[k] = testConfig[k];
    }
    if (testConfig.smtp_pass && testConfig.smtp_pass !== '••••••••') config.smtp_pass = testConfig.smtp_pass;
  }
  const setStatus = status => (saved.exists === false ? null : run('UPDATE mail_configurations SET status = ? WHERE workspace_id = ?', [status, workspaceId]));

  if (usesZepto(workspaceId, config)) {
    if (!zeptoToken(workspaceId, config)) {
      return { success: false, error: 'No ZeptoMail token is saved for this workspace.' };
    }
    // ZeptoMail has no credential check that does not send mail, so this is not claimed as verified.
    return {
      success: true,
      verified: false,
      message: `A ZeptoMail token is saved for ${config.sender_email || 'this workspace'}. Delivery is confirmed on the first send.`
    };
  }

  if (!config.smtp_user || !config.smtp_pass) {
    return { success: false, error: 'Missing SMTP Username or App Password. Please provide company authorization credentials.' };
  }

  try {
    await assertSafeMailHost(config.smtp_host);
    const transporter = createSmtpTransporter(config);
    if (!transporter) return { success: false, error: 'Could not initialize SMTP transport.' };
    await transporter.verify();
    await setStatus('Connected');
    return {
      success: true,
      verified: true,
      message: `SMTP handshake verified successfully with ${config.smtp_host}:${config.smtp_port} for ${config.smtp_user}`
    };
  } catch (err) {
    await setStatus('Auth Failed');
    return { success: false, error: err.code === 'UNSAFE_HOST' || err.code === 'MAIL_HOST_UNRESOLVED' ? err.message : `SMTP connection failed: ${err.message}` };
  }
}

/**
 * Sends one email with the workspace's own mail settings and records it as Sent.
 * Throws (and records nothing) when the recipient is invalid, mail is not configured,
 * or the provider rejects the message; there is no "saved in outbox" success.
 */
async function sendRealEmail(workspaceId, {
  to,
  recipientName = '',
  subject,
  html,
  text = '',
  campaignId = null,
  clientId = null,
  replyTo = null,
  // Marketing emails: { url, mailto } for List-Unsubscribe; url (https) also enables RFC 8058 one-click.
  listUnsubscribe = null,
  // 'marketing': never through ZeptoMail, only an SMTP mailbox approved for marketing (no fallback).
  purpose = 'transactional',
  // Mail Center sends opt in: { draftId?, consentOk? }. Tracking only records; it never changes how or whether the email is sent.
  track = null,
  // Who may receive it (lib/mailSuppression.js). Marketing email is always checked as marketing;
  // a caller may only make a transactional send stricter, never a marketing one looser.
  suppressionPolicy = null,
  // false: not saved in the workspace's Sent mail (e.g. password reset links, which only the recipient may see).
  record = true,
  // A member's own verified sender address ({ email, name }; modules/mail/senders). ZeptoMail and Amazon SES send
  // from it; an SMTP mailbox can only send as itself, so it keeps its address with this name and Reply-To.
  from = null
}) {
  const recipient = String(to || '').trim();
  if (!isValidRecipient(recipient)) throw mailError('A valid recipient email address is required (placeholder domains such as example.com are not accepted).', 400, 'INVALID_RECIPIENT');
  const policy = purpose === 'marketing' || suppressionPolicy === 'marketing' ? 'marketing' : 'transactional';
  const blocked = await require('../lib/mailSuppression').suppressionBlock(workspaceId, recipient, policy);
  if (blocked) {
    const err = mailError(`Not sent: ${blocked.message}`, 409, 'RECIPIENT_SUPPRESSED');
    err.suppressionReason = blocked.reason;
    throw err;
  }
  if (!String(subject || '').trim()) throw mailError('A subject is required.', 400, 'VALIDATION_ERROR');
  // Plain text keeps its paragraphs and line breaks in the HTML part.
  html = html || require('../lib/mailContent').textToHtml(text);

  const config = await getRawMailConfig(workspaceId);
  const mailboxEmail = config.sender_email || (EMAIL_RE.test(config.smtp_user || '') ? config.smtp_user : null);
  const own = from && EMAIL_RE.test(String(from.email || '')) ? { email: String(from.email).trim().toLowerCase(), name: String(from.name || '').replace(/["\r\n]/g, '').trim() || null } : null;
  const senderEmail = own ? own.email : mailboxEmail;
  if (!senderEmail || !mailboxEmail) throw mailError('Mail is not configured for this workspace. Add a sender address in Mail Settings.', 503, 'MAIL_NOT_CONFIGURED');
  const senderName = own ? (own.name || config.sender_name || null) : (config.sender_name || null);
  const fromAddress = senderName ? `"${String(senderName).replace(/"/g, '')}" <${senderEmail}>` : senderEmail;
  // SMTP mailboxes send only as themselves. A member's own address must be the From address, so an SMTP mailbox
  // with a different address never sends it (ZeptoMail or Amazon SES do, or the email is refused).
  const smtpCanSendOwn = !own || own.email === String(mailboxEmail).trim().toLowerCase();
  const ownNotSendable = why => {
    const err = mailError(`Not sent: your emails are sent only from your sender address ${own.email}, and ${why} Nothing was sent from another address.`, 409, 'SENDER_NOT_SENDABLE');
    err.marketingBlocked = purpose === 'marketing';
    return err;
  };
  if (own && !replyTo) replyTo = own.email;
  const plain = text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  // mailtoSelf: a mailto: to the sender address; such replies are detected by the inbox sync.
  const unsubParts = listUnsubscribe ? [listUnsubscribe.url, listUnsubscribe.mailtoSelf ? `mailto:${mailboxEmail}?subject=unsubscribe` : listUnsubscribe.mailto].filter(Boolean) : [];
  const unsubHeaders = unsubParts.length ? {
    'List-Unsubscribe': unsubParts.map(u => `<${u}>`).join(', '),
    ...(listUnsubscribe.url ? { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {})
  } : null;

  // Marketing: an SMTP mailbox approved for marketing, otherwise Amazon SES when it is set up (never ZeptoMail).
  let marketingSes = null;
  if (purpose === 'marketing' && !smtpCanSendOwn) {
    // The SMTP mailbox cannot send as the member: only Amazon SES can.
    marketingSes = await sesForMarketing(workspaceId);
    if (!marketingSes) throw ownNotSendable('marketing email from it needs Amazon SES, which is not set up for this workspace (Mail Settings → Amazon SES).');
  } else if (purpose === 'marketing') {
    const problem = marketingDeliveryProblem(workspaceId, config);
    if (problem) {
      marketingSes = await sesForMarketing(workspaceId);
      if (!marketingSes) {
        const err = mailError(problem.message, 409, problem.code);
        err.marketingBlocked = true;
        throw err;
      }
    }
  }

  let sent = false;
  let messageId = null;
  let smtpStatus = null;
  let deliveryDetails = null;
  let lastError = null;
  let provider = null;
  const tracker = track ? await require('../modules/mail/tracking/trackingService').begin(workspaceId, track) : null;

  // 1. ZeptoMail with this workspace's token (transactional email only).
  if (purpose !== 'marketing' && usesZepto(workspaceId, config)) {
    try {
      const zeptoResult = await sendZeptoMail({
        to: recipient, recipientName, subject, html, text: plain,
        fromAddress: senderEmail,
        fromName: senderName || senderEmail,
        replyTo: replyTo || senderEmail,
        token: zeptoToken(workspaceId, config),
        tracking: tracker ? tracker.zeptoOptions() : null
      });
      sent = true;
      provider = 'zeptomail';
      messageId = zeptoResult.messageId;
      smtpStatus = 'Sent via ZeptoMail';
      deliveryDetails = zeptoResult.data;
    } catch (zeptoErr) {
      // Possibly delivered: never fall back to SMTP, which could deliver a second copy.
      if (zeptoErr.outcomeUnknown) {
        if (tracker) await tracker.unknown(zeptoErr.code);
        throw zeptoErr;
      }
      lastError = zeptoErr;
      console.warn('ZeptoMail dispatch error:', zeptoErr.message);
    }
  }

  // 1b. Marketing email without an approved SMTP mailbox: Amazon SES (no fallback to anything else).
  if (marketingSes) {
    try {
      const sesHtml = tracker ? await tracker.instrumentSmtp(html) : html;
      const r = await sendViaSes(marketingSes, { fromAddress, senderEmail, to: recipient, subject, html: sesHtml, text: plain, replyTo: replyTo || senderEmail, headers: unsubHeaders });
      sent = true;
      provider = 'ses';
      messageId = r.messageId;
      smtpStatus = 'Sent via Amazon SES';
      deliveryDetails = { messageId: r.messageId };
    } catch (err) {
      if (err.outcomeUnknown) {
        if (tracker) await tracker.unknown(err.code || 'SES_OUTCOME_UNKNOWN');
        throw err;
      }
      if (tracker) await tracker.failed(err.code || 'SES_ERROR', 'The email was not sent.');
      if (err.code === 'SES_SENDER_NOT_VERIFIED') throw err;
      throw mailError(`Email was not sent: ${err.message}`, err.status === 400 ? 400 : 502, err.code || 'MAIL_SEND_FAILED');
    }
  }

  // 1c. Transactional email from a member's own address that ZeptoMail did not send: Amazon SES when set up,
  // never the SMTP mailbox (it would send from the workspace address instead).
  if (!sent && !smtpCanSendOwn && purpose !== 'marketing') {
    const sesCfg = await sesForMarketing(workspaceId);
    if (!sesCfg) {
      if (tracker) await tracker.failed('SENDER_NOT_SENDABLE', 'The email was not sent.');
      throw ownNotSendable(lastError
        ? `ZeptoMail could not send from it (${lastError.message}). Check that the address or its domain is added in ZeptoMail.`
        : 'this workspace has no ZeptoMail or Amazon SES set up to send from it (Mail Settings).');
    }
    try {
      const sesHtml = tracker ? await tracker.instrumentSmtp(html) : html;
      const r = await sendViaSes(sesCfg, { fromAddress, senderEmail, to: recipient, subject, html: sesHtml, text: plain, replyTo: replyTo || senderEmail, headers: unsubHeaders });
      sent = true;
      provider = 'ses';
      messageId = r.messageId;
      smtpStatus = 'Sent via Amazon SES';
      deliveryDetails = { messageId: r.messageId };
    } catch (err) {
      if (err.outcomeUnknown) {
        if (tracker) await tracker.unknown(err.code || 'SES_OUTCOME_UNKNOWN');
        throw err;
      }
      if (tracker) await tracker.failed(err.code || 'SES_ERROR', 'The email was not sent.');
      if (err.code === 'SES_SENDER_NOT_VERIFIED') throw err;
      throw mailError(`Email was not sent: ${err.message}`, err.status === 400 ? 400 : 502, err.code || 'MAIL_SEND_FAILED');
    }
  }

  // 2. The workspace's SMTP server, only when nothing was sent above (and it can send as the From address).
  if (!sent && smtpCanSendOwn) {
    const transporter = config.smtp_host ? createSmtpTransporter(config) : null;
    if (transporter) {
      try {
        await assertSafeMailHost(config.smtp_host);
        const smtpHtml = tracker ? await tracker.instrumentSmtp(html) : html;
        const info = await transporter.sendMail({
          from: fromAddress, to: recipient, subject, text: plain, html: smtpHtml, replyTo: replyTo || senderEmail,
          ...(unsubHeaders ? { headers: unsubHeaders } : {})
        });
        sent = true;
        provider = 'smtp';
        messageId = info.messageId || null;
        smtpStatus = 'Sent via SMTP';
        deliveryDetails = { response: info.response, accepted: info.accepted };
      } catch (err) {
        if (smtpOutcomeUnknown(err)) {
          const unknownErr = outcomeUnknownError(`the SMTP connection failed while sending (${err.code || err.message})`, err);
          if (tracker) await tracker.unknown(unknownErr.code);
          throw unknownErr;
        }
        lastError = err;
        console.warn('SMTP dispatch error:', err.message);
      }
    }
  }

  if (!sent) {
    if (tracker) await tracker.failed(lastError?.code || 'MAIL_NOT_CONFIGURED', lastError ? 'The email was not sent.' : 'Mail is not configured for this workspace.');
    if (lastError) throw mailError(`Email was not sent: ${lastError.message}`, lastError.status === 400 ? 400 : 502, lastError.code || 'MAIL_SEND_FAILED');
    throw mailError('Email was not sent: mail is not configured for this workspace. Add SMTP or ZeptoMail settings in Mail Settings.', 503, 'MAIL_NOT_CONFIGURED');
  }

  if (!record) {
    if (tracker) await tracker.accepted({ provider, messageId, emailId: null });
    return { success: true, emailId: null, messageId, isRealSmtp: true, smtpStatus, recipient, subject, deliveryDetails };
  }

  let insertRes;
  try {
    insertRes = await run(`
    INSERT INTO emails (
      workspace_id, campaign_id, client_id, sender, sender_email, recipient_email, recipient_name,
      subject, body, html_body, snippet, is_urgent, is_read, status, message_id, smtp_status, sent_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, 0, 1, 'Sent', ?, ?, ?
    )
  `, [
    workspaceId, campaignId, clientId, config.sender_name || senderEmail, senderEmail, recipient, recipientName || recipient,
    subject, plain, html, plain.substring(0, 120), messageId, smtpStatus, now
  ]);
  } catch (dbErr) {
    // Delivered but not recorded: callers must not send it again.
    console.error('Email sent but not recorded:', dbErr.message);
    if (tracker) await tracker.accepted({ provider, messageId, emailId: null });
    const err = mailError(`The email was accepted (${smtpStatus}) but could not be recorded. Do not send it again.`, 500, 'MAIL_SENT_NOT_RECORDED');
    err.outcomeUnknown = true;
    throw err;
  }

  if (tracker) await tracker.accepted({ provider, messageId, emailId: insertRes.lastID });

  return {
    success: true,
    emailId: insertRes.lastID,
    messageId,
    isRealSmtp: true,
    smtpStatus,
    recipient,
    subject,
    deliveryDetails
  };
}

/** A mailbox to read over IMAP: the workspace mailbox, or a member's own inbox (mailboxUserId). */
function imapBox(cfg) {
  return { imap_host: cfg.imap_host, imap_port: cfg.imap_port, imap_tls: cfg.imap_tls, imap_user: cfg.imap_user, imap_pass: cfg.imap_pass };
}

/** What to tell the person when an IMAP login or sync fails (the server's own reply says more than err.message). */
function imapErrorText(err, host, where = 'Mail Settings') {
  const fullErr = String(err.response || err.responseText || err.message || '');
  const isImapDisabled = /enable IMAP|IMAP access is disabled|contact your administrator/i.test(fullErr);
  const isAuthErr = err.authenticationFailed ||
    err.serverResponseCode === 'AUTHENTICATIONFAILED' ||
    fullErr.includes('AUTHENTICATIONFAILED') || fullErr.includes('Invalid credentials') || fullErr.includes('Command failed');
  if (isImapDisabled) return 'IMAP access is turned off for this mailbox. In Zoho Mail, open Settings > Mail Accounts > IMAP Access and turn it on, then sync again.';
  if (isAuthErr) return `Mailbox authentication failed. Check the IMAP username and app password in ${where}.`;
  return `IMAP connection error (${host}): ${err.message}`;
}

/** Signs in to a mailbox and out again: proves the settings work before they are saved. */
async function testImapLogin(box) {
  await assertSafeMailHost(box.imap_host);
  const client = new ImapFlow(imapClientOptions(box));
  await client.connect();
  await client.logout().catch(() => null);
}

/**
 * Reads the latest messages of one mailbox into the workspace's received mail (each once, by Message-ID).
 * mailboxUserId: the member whose own inbox it is (they see what is synced from it).
 */
async function syncMailbox(workspaceId, box, { recipientName = null, mailboxUserId = null } = {}) {
  await assertSafeMailHost(box.imap_host);
  const client = new ImapFlow(imapClientOptions(box));
  let fetchedCount = 0;
  let skipped = 0;
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  await client.connect();
  try {
    // Select INBOX
    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { messages: true, unseen: true });
      const totalMessages = status.messages || 0;

      if (totalMessages > 0) {
        // The latest messages (newest last); each is saved once, so a longer window only re-checks known ones.
        const startSeq = Math.max(1, totalMessages - (SYNC_WINDOW - 1));
        const range = `${startSeq}:${totalMessages}`;

        // Fetched first, then saved one by one: a message that cannot be saved is skipped, not the ones after it.
        const fetched = [];
        for await (let msg of client.fetch(range, { envelope: true, source: true, flags: true })) fetched.push(msg);
        for (const msg of fetched) {
          const messageId = msg.envelope?.messageId || `imap_${box.imap_user}_${msg.uid}`;

          // Already received (a sent email with the same Message-ID, e.g. sent from here to this mailbox, is not).
          const existing = await get(`SELECT id, mailbox_user_id FROM emails WHERE workspace_id = ? AND message_id = ? AND status NOT IN ('Sent', 'Not Sent') LIMIT 1`, [workspaceId, messageId]);
          if (existing) {
            // Also in this member's own inbox (first synced from the workspace mailbox): theirs to see too.
            if (mailboxUserId && !existing.mailbox_user_id) await run('UPDATE emails SET mailbox_user_id = ? WHERE id = ?', [mailboxUserId, existing.id]).catch(() => null);
            continue;
          }
          try {
            // Parse full MIME message source
            const parsed = await simpleParser(msg.source);
            const fromAddr = parsed.from?.value?.[0]?.address || null;
            const fromName = parsed.from?.value?.[0]?.name || fromAddr || '(unknown sender)';
            const subject = parsed.subject || '(No Subject)';
            const textBody = parsed.text || '';
            const htmlBody = parsed.html || `<p>${textBody.replace(/\n/g, '<br>')}</p>`;
            const snippet = textBody.substring(0, 140) || subject;
            const receivedAt = parsed.date ? new Date(parsed.date).toISOString().replace('T', ' ').substring(0, 19) : now;

            // Auto-run AI Analysis on received email!
            // Metered to the workspace that owns this mailbox; past the quota it keeps the non-AI summary.
            const analysis = await aiEngine.analyzeEmail({ subject, body: textBody, sender: fromName }, null, { workspaceId, referenceType: 'email_sync', fallbackOnQuota: true });
            const isUrgent = analysis.ai_priority === 'Urgent' ? 1 : 0;

            await run(`
              INSERT INTO emails (
                workspace_id, sender, sender_email, recipient_email, recipient_name,
                subject, body, html_body, snippet, ai_summary, ai_priority, ai_replies_json,
                is_urgent, is_read, status, message_id, smtp_status, received_at, mailbox_user_id
              ) VALUES (
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?,
                ?, 0, 'Unread', ?, 'Received via IMAP', ?, ?
              )
            `, [
              workspaceId,
              fromName,
              fromAddr,
              box.imap_user,
              recipientName || box.imap_user,
              subject,
              textBody,
              htmlBody,
              snippet,
              analysis.ai_summary,
              analysis.ai_priority,
              JSON.stringify(analysis.ai_replies || []),
              isUrgent,
              messageId,
              receivedAt,
              mailboxUserId
            ]);

            fetchedCount++;
          } catch (err) {
            skipped++;
            console.warn(`IMAP sync: message ${messageId} in ${box.imap_user} was not saved:`, err.message);
          }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    await client.logout().catch(() => null);
    throw err;
  }
  return { fetchedCount, skipped, syncedAt: now };
}

/** How many of a mailbox's latest messages each sync looks at. */
const SYNC_WINDOW = 30;

/** Workspaces with a mailbox to read: the workspace mailbox (IMAP), or a member's own inbox. */
async function inboxWorkspaces() {
  const rows = await all(`SELECT workspace_id FROM mail_configurations WHERE imap_host IS NOT NULL AND imap_host <> '' AND imap_user IS NOT NULL AND imap_pass IS NOT NULL AND imap_pass <> ''
    UNION SELECT workspace_id FROM member_sender_addresses WHERE status = 'verified' AND imap_host IS NOT NULL AND imap_pass IS NOT NULL`).catch(() => []);
  return rows.map(r => Number(r.workspace_id)).filter(Boolean);
}

/**
 * Members' own inboxes ("My sender email" → Inbox), each with its own login (the sender address itself).
 * A failure is recorded on that address and does not stop the others. userId: only that member's.
 */
async function syncMemberInboxes(workspaceId, { userId = null } = {}) {
  const rows = await all(
    `SELECT id, user_id, email, display_name, imap_host, imap_port, imap_tls, imap_pass FROM member_sender_addresses
     WHERE workspace_id = ? AND status = 'verified' AND imap_host IS NOT NULL AND imap_pass IS NOT NULL${userId ? ' AND user_id = ?' : ''}`,
    userId ? [workspaceId, Number(userId)] : [workspaceId]).catch(() => []);
  const out = { inboxes: rows.length, synced: 0, failed: 0, fetchedCount: 0 };
  for (const r of rows) {
    let pass;
    try { pass = secretBox.decrypt(r.imap_pass); } catch { pass = null; }
    const box = { imap_host: r.imap_host, imap_port: r.imap_port || 993, imap_tls: Number(r.imap_tls) === 0 ? 0 : 1, imap_user: r.email, imap_pass: pass };
    try {
      if (!pass) throw mailError('The saved inbox password cannot be read. Connect the inbox again.', 409, 'INBOX_PASSWORD_UNREADABLE');
      const res = await syncMailbox(workspaceId, box, { recipientName: r.display_name || null, mailboxUserId: r.user_id });
      out.synced++; out.fetchedCount += res.fetchedCount;
      await run("UPDATE member_sender_addresses SET imap_status = 'connected', imap_error = NULL, imap_synced_at = UTC_TIMESTAMP() WHERE id = ?", [r.id]);
    } catch (err) {
      out.failed++;
      const msg = err.code === 'INBOX_PASSWORD_UNREADABLE' || err.code === 'UNSAFE_HOST' ? err.message : imapErrorText(err, r.imap_host, 'My sender email → Inbox');
      await run("UPDATE member_sender_addresses SET imap_status = 'error', imap_error = ? WHERE id = ?", [String(msg).slice(0, 500), r.id]).catch(() => null);
    }
  }
  return out;
}

async function syncIncomingEmails(workspaceId) {
  // Members' own inboxes are synced whether or not the workspace mailbox is set up.
  const members = await syncMemberInboxes(workspaceId).catch(() => ({ inboxes: 0, synced: 0, failed: 0, fetchedCount: 0 }));
  const memberNote = members.inboxes ? ` Members' inboxes: ${members.synced} synced${members.failed ? `, ${members.failed} with an error` : ''} (${members.fetchedCount} new).` : '';
  const config = await getRawMailConfig(workspaceId);
  const isInvalidImapPass = !config.imap_pass || 
    config.imap_pass === 'demo_app_password_123' || 
    config.imap_pass.startsWith('Zoho-enczapikey');

  if (isInvalidImapPass || !config.imap_user || !config.imap_host) {
    if (members.synced) return { success: true, fetchedCount: members.fetchedCount, memberInboxes: members, message: `The workspace mailbox has no IMAP settings.${memberNote}` };
    return {
      success: false,
      isImapConfigured: false,
      memberInboxes: members,
      error: 'Inbound sync needs IMAP settings and an app password in Mail Settings.'
    };
  }

  try {
    await assertSafeMailHost(config.imap_host);
  } catch (err) {
    return { success: false, isImapConfigured: false, memberInboxes: members, error: err.message };
  }

  try {
    const { fetchedCount, syncedAt: now } = await syncMailbox(workspaceId, imapBox(config), { recipientName: config.sender_name || config.imap_user });

    // Update last_synced_at
    await run(
      "UPDATE mail_configurations SET last_synced_at = ?, status = 'Connected' WHERE workspace_id = ?",
      [now, workspaceId]
    );

    return {
      success: true,
      fetchedCount: fetchedCount + members.fetchedCount,
      lastSyncedAt: now,
      memberInboxes: members,
      message: `Successfully synchronized ${fetchedCount} new emails from ${config.imap_user}.${memberNote}`
    };
  } catch (err) {
    console.error('IMAP sync error:', err.message);
    return {
      success: false,
      isImapConfigured: false,
      memberInboxes: members,
      error: imapErrorText(err, config.imap_host)
    };
  }
}

module.exports = {
  marketingDeliveryProblem,
  marketingDeliveryStatus,
  setMarketingApproval,
  smtpTransportOptions,
  imapClientOptions,
  testImapLogin,
  imapErrorText,
  syncMemberInboxes,
  inboxWorkspaces,
  smtpOutcomeUnknown,
  EMAIL_RE,
  isValidRecipient,
  getRawMailConfig,
  getSafeMailConfig,
  saveMailConfig,
  verifySmtpConnection,
  sendRealEmail,
  syncIncomingEmails
};
