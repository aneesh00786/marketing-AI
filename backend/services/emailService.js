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

async function sendZeptoMail({ to, recipientName = '', subject, html, text = '', fromAddress, fromName, replyTo, token }) {
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
        htmlbody: html || `<p>${text || ''}</p>`,
        // Plain-text part for clients that do not show HTML.
        textbody: text || undefined
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
      imap_user: process.env.IMAP_USER || 'support@thrivewoo.com',
      imap_pass: process.env.IMAP_PASS || '',
      sender_name: process.env.MAIL_FROM_NAME || 'ThriveWoo Support',
      sender_email: process.env.MAIL_FROM_ADDRESS || 'support@thrivewoo.com',
      status: 'Connected'
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
    return { code: 'MARKETING_PROVIDER_BLOCKED', message: 'Marketing emails cannot be sent through ZeptoMail: Zoho limits ZeptoMail to transactional email. Configure your own SMTP mailbox for marketing in Mail Settings, or use Email Campaigns (Zoho Campaigns).' };
  }
  if (!config.smtp_host || !config.smtp_user || !config.smtp_pass) {
    return { code: 'MARKETING_SMTP_REQUIRED', message: 'Marketing emails need an SMTP mailbox configured in Mail Settings.' };
  }
  if (!Number(config.marketing_approved)) {
    return { code: 'MARKETING_NOT_APPROVED', message: 'This SMTP mailbox is not approved for marketing email yet. An Owner or Admin must confirm in Mail Settings that the provider allows marketing email.' };
  }
  return null;
}

async function marketingDeliveryStatus(workspaceId) {
  const config = await getRawMailConfig(workspaceId);
  const problem = marketingDeliveryProblem(workspaceId, config);
  return {
    allowed: !problem,
    code: problem ? problem.code : null,
    reason: problem ? problem.message : null,
    provider: config.provider || null,
    approvedAt: config.marketing_approved_at || null
  };
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
  if (config.provider === 'zeptomail') return true;
  // Historical heuristic kept for the legacy workspace only.
  return isLegacy(workspaceId) && !!(config.sender_email && config.sender_email.includes('thrivewoo.com'));
}

async function getSafeMailConfig(workspaceId) {
  const raw = await getRawMailConfig(workspaceId);
  return {
    ...raw,
    smtp_pass: raw.smtp_pass ? '••••••••' : '',
    imap_pass: raw.imap_pass ? '••••••••' : '',
    has_smtp_auth: !!(raw.smtp_user && raw.smtp_pass),
    has_imap_auth: !!(raw.imap_user && raw.imap_pass)
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
  purpose = 'transactional'
}) {
  const recipient = String(to || '').trim();
  if (!isValidRecipient(recipient)) throw mailError('A valid recipient email address is required (placeholder domains such as example.com are not accepted).', 400, 'INVALID_RECIPIENT');
  if (!String(subject || '').trim()) throw mailError('A subject is required.', 400, 'VALIDATION_ERROR');
  html = html || `<p>${String(text || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p>`;

  const config = await getRawMailConfig(workspaceId);
  const senderEmail = config.sender_email || (EMAIL_RE.test(config.smtp_user || '') ? config.smtp_user : null);
  if (!senderEmail) throw mailError('Mail is not configured for this workspace. Add a sender address in Mail Settings.', 503, 'MAIL_NOT_CONFIGURED');
  const fromAddress = config.sender_name ? `"${String(config.sender_name).replace(/"/g, '')}" <${senderEmail}>` : senderEmail;
  const plain = text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  // mailtoSelf: a mailto: to the sender address; such replies are detected by the inbox sync.
  const unsubParts = listUnsubscribe ? [listUnsubscribe.url, listUnsubscribe.mailtoSelf ? `mailto:${senderEmail}?subject=unsubscribe` : listUnsubscribe.mailto].filter(Boolean) : [];
  const unsubHeaders = unsubParts.length ? {
    'List-Unsubscribe': unsubParts.map(u => `<${u}>`).join(', '),
    ...(listUnsubscribe.url ? { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {})
  } : null;

  if (purpose === 'marketing') {
    const problem = marketingDeliveryProblem(workspaceId, config);
    if (problem) {
      const err = mailError(problem.message, 409, problem.code);
      err.marketingBlocked = true;
      throw err;
    }
  }

  let sent = false;
  let messageId = null;
  let smtpStatus = null;
  let deliveryDetails = null;
  let lastError = null;

  // 1. ZeptoMail with this workspace's token (transactional email only).
  if (purpose !== 'marketing' && usesZepto(workspaceId, config)) {
    try {
      const zeptoResult = await sendZeptoMail({
        to: recipient, recipientName, subject, html, text: plain,
        fromAddress: senderEmail,
        fromName: config.sender_name || senderEmail,
        replyTo: replyTo || senderEmail,
        token: zeptoToken(workspaceId, config)
      });
      sent = true;
      messageId = zeptoResult.messageId;
      smtpStatus = 'Sent via ZeptoMail';
      deliveryDetails = zeptoResult.data;
    } catch (zeptoErr) {
      // Possibly delivered: never fall back to SMTP, which could deliver a second copy.
      if (zeptoErr.outcomeUnknown) throw zeptoErr;
      lastError = zeptoErr;
      console.warn('ZeptoMail dispatch error:', zeptoErr.message);
    }
  }

  // 2. The workspace's SMTP server, only when nothing was sent above.
  if (!sent) {
    const transporter = config.smtp_host ? createSmtpTransporter(config) : null;
    if (transporter) {
      try {
        await assertSafeMailHost(config.smtp_host);
        const info = await transporter.sendMail({
          from: fromAddress, to: recipient, subject, text: plain, html, replyTo: replyTo || senderEmail,
          ...(unsubHeaders ? { headers: unsubHeaders } : {})
        });
        sent = true;
        messageId = info.messageId || null;
        smtpStatus = 'Sent via SMTP';
        deliveryDetails = { response: info.response, accepted: info.accepted };
      } catch (err) {
        if (smtpOutcomeUnknown(err)) throw outcomeUnknownError(`the SMTP connection failed while sending (${err.code || err.message})`, err);
        lastError = err;
        console.warn('SMTP dispatch error:', err.message);
      }
    }
  }

  if (!sent) {
    if (lastError) throw mailError(`Email was not sent: ${lastError.message}`, lastError.status === 400 ? 400 : 502, lastError.code || 'MAIL_SEND_FAILED');
    throw mailError('Email was not sent: mail is not configured for this workspace. Add SMTP or ZeptoMail settings in Mail Settings.', 503, 'MAIL_NOT_CONFIGURED');
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
    const err = mailError(`The email was accepted (${smtpStatus}) but could not be recorded. Do not send it again.`, 500, 'MAIL_SENT_NOT_RECORDED');
    err.outcomeUnknown = true;
    throw err;
  }

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

async function syncIncomingEmails(workspaceId) {
  const config = await getRawMailConfig(workspaceId);
  const isInvalidImapPass = !config.imap_pass || 
    config.imap_pass === 'demo_app_password_123' || 
    config.imap_pass.startsWith('Zoho-enczapikey');

  if (isInvalidImapPass || !config.imap_user || !config.imap_host) {
    return {
      success: false,
      isImapConfigured: false,
      error: 'Inbound sync needs IMAP settings and an app password in Mail Settings.'
    };
  }

  try {
    await assertSafeMailHost(config.imap_host);
  } catch (err) {
    return { success: false, isImapConfigured: false, error: err.message };
  }

  const client = new ImapFlow(imapClientOptions(config));

  let fetchedCount = 0;
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  try {
    await client.connect();

    // Select INBOX
    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { messages: true, unseen: true });
      const totalMessages = status.messages || 0;

      if (totalMessages > 0) {
        // Fetch up to 10 latest messages
        const startSeq = Math.max(1, totalMessages - 9);
        const range = `${startSeq}:${totalMessages}`;

        for await (let msg of client.fetch(range, { envelope: true, source: true, flags: true })) {
          const messageId = msg.envelope?.messageId || `imap_${msg.seq}_${msg.uid}`;

          // Check if already saved in emails table
          const existing = await get('SELECT id FROM emails WHERE workspace_id = ? AND message_id = ? LIMIT 1', [workspaceId, messageId]);
          if (existing) continue;

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
              is_urgent, is_read, status, message_id, smtp_status, received_at
            ) VALUES (
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?,
              ?, 0, 'Unread', ?, 'Received via IMAP', ?
            )
          `, [
            workspaceId,
            fromName,
            fromAddr,
            config.imap_user,
            config.sender_name || config.imap_user,
            subject,
            textBody,
            htmlBody,
            snippet,
            analysis.ai_summary,
            analysis.ai_priority,
            JSON.stringify(analysis.ai_replies || []),
            isUrgent,
            messageId,
            receivedAt
          ]);

          fetchedCount++;
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();

    // Update last_synced_at
    await run(
      "UPDATE mail_configurations SET last_synced_at = ?, status = 'Connected' WHERE workspace_id = ?",
      [now, workspaceId]
    );

    return {
      success: true,
      fetchedCount,
      lastSyncedAt: now,
      message: `Successfully synchronized ${fetchedCount} new emails from ${config.imap_user}`
    };
  } catch (err) {
    console.error('IMAP sync error:', err.message);
    const isAuthErr = err.authenticationFailed || 
      err.serverResponseCode === 'AUTHENTICATIONFAILED' ||
      (err.message && (err.message.includes('AUTHENTICATIONFAILED') || err.message.includes('Invalid credentials') || err.message.includes('Command failed')));

    const friendlyError = isAuthErr
      ? 'Mailbox authentication failed. Check the IMAP username and app password in Mail Settings.'
      : `IMAP connection error (${config.imap_host}): ${err.message}`;

    return {
      success: false,
      isImapConfigured: false,
      error: friendlyError
    };
  }
}

module.exports = {
  marketingDeliveryProblem,
  marketingDeliveryStatus,
  setMarketingApproval,
  smtpTransportOptions,
  imapClientOptions,
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
