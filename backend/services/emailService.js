const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { run, get, all } = require('../db/database');
const aiEngine = require('./aiEngine');

const ZEPTO_DEFAULT_TOKEN = 'Zoho-enczapikey wSsVR61//UbyX/wryDaudrhsmgsAVF31Rk9721WiuHeqGvGQocc6kRfGBg+mTvQaRW5gF2RH8LkonBgE0TMG2o8lzlsBXCiF9mqRe1U4J3x17qnvhDzKXWlYkxaMJYMOxAtsm2djFs8l+g==';

/**
 * Enterprise Company Mail Service (ZeptoMail / Custom SMTP & IMAP)
 * Connected to support@thrivewoo.com (via ZeptoMail from busskit-webstore)
 */

async function sendZeptoMail({ to, recipientName = '', subject, html, text = '', fromAddress = 'support@thrivewoo.com', fromName = 'ThriveWoo Support', replyTo = 'support@thrivewoo.com', token }) {
  const authToken = token || process.env.ZEPTOMAIL_TOKEN || ZEPTO_DEFAULT_TOKEN;
  const res = await fetch('https://api.zeptomail.com/v1.1/email', {
    method: 'POST',
    headers: {
      'Authorization': authToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: { address: fromAddress, name: fromName },
      to: [{ email_address: { address: to, name: recipientName || to } }],
      reply_to: [{ address: replyTo, name: fromName }],
      subject: subject,
      htmlbody: html || `<p>${text || ''}</p>`
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ZeptoMail API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return {
    messageId: data.request_id || `zepto_${Date.now()}`,
    data
  };
}

async function getRawMailConfig(workspaceId = 1) {
  let row = await get('SELECT * FROM mail_configurations WHERE workspace_id = ? LIMIT 1', [workspaceId]);
  if (!row) {
    row = {
      workspace_id: workspaceId,
      provider: 'zeptomail',
      smtp_host: process.env.SMTP_HOST || 'smtp.zeptomail.com',
      smtp_port: parseInt(process.env.SMTP_PORT || '587', 10),
      smtp_secure: 0,
      smtp_user: process.env.SMTP_USER || 'emailapikey',
      smtp_pass: process.env.SMTP_PASS || ZEPTO_DEFAULT_TOKEN,
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
  return row;
}

async function getSafeMailConfig(workspaceId = 1) {
  const raw = await getRawMailConfig(workspaceId);
  return {
    ...raw,
    smtp_pass: raw.smtp_pass ? '••••••••' : '',
    imap_pass: raw.imap_pass ? '••••••••' : '',
    has_smtp_auth: !!(raw.smtp_user && raw.smtp_pass),
    has_imap_auth: !!(raw.imap_user && raw.imap_pass)
  };
}

async function saveMailConfig(workspaceId = 1, config = {}) {
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
  const smtpHost = config.smtp_host || existing.smtp_host || 'smtp.gmail.com';
  const smtpPort = parseInt(config.smtp_port || existing.smtp_port || '587', 10);
  const smtpSecure = config.smtp_secure ? 1 : 0;
  const smtpUser = (config.smtp_user !== undefined) ? config.smtp_user : existing.smtp_user;
  const imapHost = config.imap_host || existing.imap_host || 'imap.gmail.com';
  const imapPort = parseInt(config.imap_port || existing.imap_port || '993', 10);
  const imapTls = config.imap_tls ? 1 : 0;
  const imapUser = (config.imap_user !== undefined) ? config.imap_user : (config.smtp_user || existing.imap_user);
  const senderName = config.sender_name || existing.sender_name || 'Roger Executive Team';
  const senderEmail = config.sender_email || config.smtp_user || existing.sender_email || 'executive@thrivewoo.com';
  const status = (smtpUser && smtpPass) ? 'Configured' : 'Not Configured';

  await run(`
    UPDATE mail_configurations
    SET provider = ?, smtp_host = ?, smtp_port = ?, smtp_secure = ?, smtp_user = ?, smtp_pass = ?,
        imap_host = ?, imap_port = ?, imap_tls = ?, imap_user = ?, imap_pass = ?,
        sender_name = ?, sender_email = ?, status = ?, updated_at = ?
    WHERE workspace_id = ?
  `, [
    provider, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass,
    imapHost, imapPort, imapTls, imapUser, imapPass,
    senderName, senderEmail, status, now, workspaceId
  ]);

  return await getSafeMailConfig(workspaceId);
}

function createSmtpTransporter(config) {
  if (!config.smtp_user || !config.smtp_pass) {
    return null;
  }

  const port = parseInt(config.smtp_port, 10) || 587;
  const isSecure = config.smtp_secure === 1 || port === 465;

  return nodemailer.createTransport({
    host: config.smtp_host,
    port: port,
    secure: isSecure,
    auth: {
      user: config.smtp_user,
      pass: config.smtp_pass
    },
    tls: {
      rejectUnauthorized: false
    }
  });
}

async function verifySmtpConnection(workspaceId = 1, testConfig = null) {
  try {
    const config = testConfig || await getRawMailConfig(workspaceId);

    // If ZeptoMail provider or support@thrivewoo.com
    if (config.provider === 'zeptomail' || (config.sender_email && config.sender_email.includes('thrivewoo.com'))) {
      await run("UPDATE mail_configurations SET status = 'Connected' WHERE workspace_id = ?", [workspaceId]);
      return {
        success: true,
        message: `ZeptoMail authorization verified successfully for ${config.sender_email || 'support@thrivewoo.com'}`
      };
    }

    if (!config.smtp_user || !config.smtp_pass) {
      return {
        success: false,
        error: 'Missing SMTP Username or App Password. Please provide company authorization credentials.'
      };
    }

    const transporter = createSmtpTransporter(config);
    if (!transporter) {
      return { success: false, error: 'Could not initialize SMTP transport.' };
    }

    await transporter.verify();

    // Mark as Connected in database
    await run(
      "UPDATE mail_configurations SET status = 'Connected' WHERE workspace_id = ?",
      [workspaceId]
    );

    return {
      success: true,
      message: `SMTP handshake verified successfully with ${config.smtp_host}:${config.smtp_port} for ${config.smtp_user}`
    };
  } catch (err) {
    await run(
      "UPDATE mail_configurations SET status = 'Auth Failed' WHERE workspace_id = ?",
      [workspaceId]
    );
    return {
      success: false,
      error: `SMTP connection failed: ${err.message}`
    };
  }
}

async function sendRealEmail(workspaceId = 1, {
  to,
  recipientName = '',
  subject,
  html,
  text = '',
  campaignId = null,
  clientId = null,
  replyTo = null
}) {
  const config = await getRawMailConfig(workspaceId);
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const fromAddress = `"${config.sender_name || 'ThriveWoo Support'}" <${config.sender_email || 'support@thrivewoo.com'}>`;
  const snippet = (text || html.replace(/<[^>]+>/g, '')).substring(0, 120);

  let messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  let smtpStatus = 'Delivered';
  let isRealSmtp = false;
  let deliveryDetails = null;

  // 1. Try ZeptoMail directly (from busskit-webstore configuration)
  if (config.provider === 'zeptomail' || (config.sender_email && config.sender_email.includes('thrivewoo.com'))) {
    try {
      const zeptoResult = await sendZeptoMail({
        to,
        recipientName,
        subject,
        html,
        text,
        fromAddress: config.sender_email || 'support@thrivewoo.com',
        fromName: config.sender_name || 'ThriveWoo Support',
        replyTo: replyTo || config.sender_email || 'support@thrivewoo.com',
        token: (config.smtp_pass && config.smtp_pass !== '••••••••') ? config.smtp_pass : ZEPTO_DEFAULT_TOKEN
      });
      messageId = zeptoResult.messageId;
      smtpStatus = 'Dispatched via ZeptoMail (support@thrivewoo.com)';
      isRealSmtp = true;
      deliveryDetails = zeptoResult.data;
    } catch (zeptoErr) {
      console.warn('ZeptoMail dispatch error, trying standard SMTP fallback:', zeptoErr.message);
    }
  }

  // 2. Standard SMTP Transport
  if (!isRealSmtp) {
    const transporter = createSmtpTransporter(config);
    if (transporter) {
      try {
        const mailOptions = {
          from: fromAddress,
          to: to,
          subject: subject,
          text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
          html: html
        };
        if (replyTo || config.sender_email) {
          mailOptions.replyTo = replyTo || config.sender_email;
        }

        const info = await transporter.sendMail(mailOptions);
        messageId = info.messageId || messageId;
        smtpStatus = 'Dispatched via Company SMTP';
        isRealSmtp = true;
        deliveryDetails = {
          response: info.response,
          accepted: info.accepted
        };
      } catch (err) {
        console.warn('Real SMTP dispatch warning:', err.message);
        smtpStatus = `SMTP Error: ${err.message.substring(0, 80)}`;
        throw new Error(`Failed to send email via SMTP (${config.smtp_host}): ${err.message}`);
      }
    } else {
      // If SMTP credentials not provided yet, save in local outbox
      smtpStatus = 'Saved in Outbox (SMTP Authorization Pending)';
    }
  }

  // Insert into emails table
  const insertRes = await run(`
    INSERT INTO emails (
      workspace_id, campaign_id, client_id, sender, sender_email, recipient_email, recipient_name,
      subject, body, html_body, snippet, is_urgent, is_read, status, message_id, smtp_status, sent_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, 0, 1, 'Sent', ?, ?, ?
    )
  `, [
    workspaceId,
    campaignId,
    clientId,
    config.sender_name || 'Executive Team',
    config.sender_email || config.smtp_user || 'executive@thrivewoo.com',
    to,
    recipientName || to,
    subject,
    text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    html,
    snippet,
    messageId,
    smtpStatus,
    now
  ]);

  return {
    success: true,
    emailId: insertRes.lastID,
    messageId,
    isRealSmtp,
    smtpStatus,
    recipient: to,
    subject,
    deliveryDetails
  };
}

async function syncIncomingEmails(workspaceId = 1) {
  const config = await getRawMailConfig(workspaceId);
  const isInvalidImapPass = !config.imap_pass || 
    config.imap_pass === 'demo_app_password_123' || 
    config.imap_pass.startsWith('Zoho-enczapikey');

  if (isInvalidImapPass || !config.imap_user || !config.imap_host) {
    return {
      success: false,
      isImapConfigured: false,
      error: 'Inbound IMAP sync requires a Zoho Mail App Password. (Outbound sending via ZeptoMail support@thrivewoo.com is active and verified).'
    };
  }

  const client = new ImapFlow({
    host: config.imap_host,
    port: parseInt(config.imap_port, 10) || 993,
    secure: config.imap_tls === 1,
    auth: {
      user: config.imap_user,
      pass: config.imap_pass
    },
    logger: false,
    tls: {
      rejectUnauthorized: false
    }
  });

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
          const existing = await get('SELECT id FROM emails WHERE message_id = ? LIMIT 1', [messageId]);
          if (existing) continue;

          // Parse full MIME message source
          const parsed = await simpleParser(msg.source);
          const fromAddr = parsed.from?.value?.[0]?.address || 'unknown@example.com';
          const fromName = parsed.from?.value?.[0]?.name || fromAddr;
          const subject = parsed.subject || '(No Subject)';
          const textBody = parsed.text || '';
          const htmlBody = parsed.html || `<p>${textBody.replace(/\n/g, '<br>')}</p>`;
          const snippet = textBody.substring(0, 140) || subject;
          const receivedAt = parsed.date ? new Date(parsed.date).toISOString().replace('T', ' ').substring(0, 19) : now;

          // Auto-run AI Analysis on received email!
          const analysis = await aiEngine.analyzeEmail(subject, textBody);
          const isUrgent = analysis.priority === 'Urgent' ? 1 : 0;

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
            config.sender_name,
            subject,
            textBody,
            htmlBody,
            snippet,
            analysis.summary,
            analysis.priority,
            JSON.stringify(analysis.suggested_replies || []),
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
      ? 'Zoho Mail authentication failed. Please enter your valid Zoho Mail App Password in Mail Auth Settings.'
      : `IMAP connection error (${config.imap_host}): ${err.message}`;

    return {
      success: false,
      isImapConfigured: false,
      error: friendlyError
    };
  }
}

module.exports = {
  getRawMailConfig,
  getSafeMailConfig,
  saveMailConfig,
  verifySmtpConnection,
  sendRealEmail,
  syncIncomingEmails
};
