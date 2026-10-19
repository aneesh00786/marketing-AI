const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { run, get, all } = require('../db/database');
const aiEngine = require('./aiEngine');

/**
 * Enterprise Company Mail Service
 * Handles live SMTP email dispatch and IMAP incoming email synchronization
 */

async function getRawMailConfig(workspaceId = 1) {
  let row = await get('SELECT * FROM mail_configurations WHERE workspace_id = ? LIMIT 1', [workspaceId]);
  if (!row) {
    row = {
      workspace_id: workspaceId,
      provider: 'custom_smtp',
      smtp_host: process.env.SMTP_HOST || 'smtp.gmail.com',
      smtp_port: parseInt(process.env.SMTP_PORT || '587', 10),
      smtp_secure: process.env.SMTP_SECURE === 'true' ? 1 : 0,
      smtp_user: process.env.SMTP_USER || '',
      smtp_pass: process.env.SMTP_PASS || '',
      imap_host: process.env.IMAP_HOST || 'imap.gmail.com',
      imap_port: parseInt(process.env.IMAP_PORT || '993', 10),
      imap_tls: process.env.IMAP_TLS === 'false' ? 0 : 1,
      imap_user: process.env.IMAP_USER || process.env.SMTP_USER || '',
      imap_pass: process.env.IMAP_PASS || process.env.SMTP_PASS || '',
      sender_name: process.env.MAIL_FROM_NAME || 'Roger Executive Team',
      sender_email: process.env.MAIL_FROM_ADDRESS || process.env.SMTP_USER || 'executive@thrivewoo.com',
      status: (process.env.SMTP_USER && process.env.SMTP_PASS) ? 'Connected' : 'Not Configured'
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
  const fromAddress = `"${config.sender_name || 'Executive Team'}" <${config.sender_email || config.smtp_user || 'executive@thrivewoo.com'}>`;
  const snippet = (text || html.replace(/<[^>]+>/g, '')).substring(0, 120);

  let messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  let smtpStatus = 'Delivered';
  let isRealSmtp = false;
  let deliveryDetails = null;

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
  if (!config.imap_user || !config.imap_pass || !config.imap_host) {
    return {
      success: false,
      error: 'Company IMAP credentials not configured. Please enter IMAP host and credentials in Company Mail Settings.'
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
    console.error('IMAP sync error:', err);
    return {
      success: false,
      error: `IMAP connection error (${config.imap_host}): ${err.message}`
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
