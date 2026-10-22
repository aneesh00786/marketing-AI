require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');

const { initDatabase, get, all, run, queryTraivoMySQL } = require('./db/database');
const authService = require('./services/authService');
const telnyxService = require('./services/telnyxService');
const marketingService = require('./services/marketingService');
const videoService = require('./services/videoService');
const usageService = require('./services/usageService');
const aiEngine = require('./services/aiEngine');
const emailService = require('./services/emailService');
const voiceStatus = require('./services/voiceStatus');
const { apiGate, legacyWorkspaceOnly, requireCapability, LEGACY_WORKSPACE_ID } = require('./middleware/auth');
const { requireTelnyxSignature } = require('./lib/telnyxWebhook');
const { rateLimit } = require('./lib/rateLimit');
const { meteredResponse } = require('./lib/aiStructured');
const { resolveSelectedProduct, findProductNamedIn } = require('./lib/productContext');
const websiteExtractor = require('./services/websiteExtractor');
const socialRouter = require('./modules/social/routes');
const leadsRouter = require('./modules/leads/routes');
const leadDiscoveryRouter = require('./modules/leadDiscovery/routes');
const productsRouter = require('./modules/products/routes');
const mailRoutes = require('./modules/mail/routes');
const playbooksRouter = require('./modules/playbooks/routes');
const outreachRouter = require('./modules/outreach/routes');
const commandRouter = require('./modules/command/routes');
const abTestsRouter = require('./modules/abtests/routes');
const automationRouter = require('./modules/automation/routes');
const campaignAnalyticsRouter = require('./modules/campaignAnalytics/routes');
const budgetRouter = require('./modules/budget/routes');
const workspacesRouter = require('./modules/workspaces/routes');
const leadService = require('./modules/leads/leadService');
const strategistService = require('./modules/social/strategistService');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8000;

app.disable('x-powered-by');

// Request IDs tie API responses to audit log entries.
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);

// CORS: only the configured frontend origins may call the API from a browser.
const allowedOrigins = [process.env.FRONTEND_URL, process.env.APP_BASE_URL, ...(process.env.CORS_ORIGINS || '').split(',')]
  .map(o => (o || '').trim())
  .filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  }
}));
// Keep the raw body for webhook signature verification.
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({
  extended: true,
  limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// Prevent aggressive caching for static/API assets
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Authentication gate: every /api route requires a signed-in workspace member unless listed here.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyFn: req => `${req.ip}:${String(req.body?.email || '').toLowerCase()}`,
  message: 'Too many sign-in attempts. Please wait and try again.'
});
app.use(['/api/v1/auth/login', '/api/auth/login', '/api/v1/auth/register', '/api/auth/register'], authLimiter);
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300, keyFn: req => req.headers.authorization || req.ip }));
app.use('/api', apiGate({
  publicPaths: [
    '/api/v1/auth/login', '/api/auth/login',
    '/api/v1/auth/register', '/api/auth/register',
    '/api/status',
    // Telephony provider webhooks (carrier-originated, no user session).
    '/api/v1/telnyx/inbound', '/api/telnyx/inbound',
    '/api/v1/telnyx/dialogue', '/api/telnyx/dialogue',
    // OAuth callbacks are authenticated by single-use state; webhooks by provider signatures.
    /^\/api\/v1\/social\/oauth\/[a-z_]+\/callback$/,
    /^\/api\/v1\/social\/webhooks\/[a-z_]+$/,
    // Email unsubscribe links carry a random per-recipient token.
    /^\/api\/v1\/outreach\/unsubscribe\/[a-f0-9]{40}$/
  ],
  toolPaths: [/^\/api\/(tools\/)?(send_email|track_lead|book_appointment|business_info|get_business_info|get_briefing)$/]
}));

// Tenant-aware social media marketing module.
app.use('/api/v1/social', socialRouter);

// AI Lead Discovery (Google Places API (New)); mounted before the Leads router so its paths win.
app.use('/api/v1/leads/discovery', leadDiscoveryRouter);
// Tenant-aware Leads CRM (legacy paths kept as aliases). The voice agent's track_lead tool
// creates leads through the same validated, workspace-scoped logic.
app.use(['/api/v1/leads', '/api/leads', '/api/v1/crm/leads'], leadsRouter);
// Tenant-aware Digital Products.
app.use(['/api/v1/products', '/api/products'], productsRouter);
// Tenant-aware Mail Drafts, Mail Center and mail settings; the voice tool send_email only saves a draft.
app.use(['/api/v1/drafts', '/api/drafts'], mailRoutes.drafts);
app.use(['/api/v1/emails', '/api/emails'], mailRoutes.emails);
app.use(['/api/v1/mail', '/api/mail'], mailRoutes.settings);
app.use(mailRoutes.tools);
// Tenant-aware Business Playbooks ("AI Campaigns").
app.use(playbooksRouter);
// Tenant-aware email outreach campaigns (AI Campaigns page); unsubscribe links are public.
app.use('/api/v1/outreach', outreachRouter);
// Tenant-aware Campaign Command Center (strategy brief, audience, builder, overview).
app.use('/api/v1/command', commandRouter);
// Tenant-aware A/B tests for email sequences and social variants.
app.use('/api/v1/ab-tests', abTestsRouter);
// Tenant-aware automation workflows (rule-based; actions reuse existing modules and approvals).
app.use('/api/v1/automations', automationRouter);
// Tenant-aware AI Campaigns analytics (email + social + CRM, honest availability).
app.use('/api/v1/campaign-analytics', campaignAnalyticsRouter);
// Tenant-aware campaign budgets, actual spend, pacing, alerts and ROI (not subscription billing).
app.use('/api/v1/budgets', budgetRouter);
// The signed-in user's workspaces: list, create, switch (every workspace; before the legacy gate).
app.use(workspacesRouter);

// Voice (Mark, ElevenLabs) is available to every workspace: the agent only has client tools, which
// run in the caller's browser with the caller's own workspace session. Both routes need sign-in and
// are registered before the legacy (workspace 1 only) gate below.
// Voice readiness for the login notice (key, agent, remaining ElevenLabs credits). Read-only; never
// starts a conversation.
app.get(['/api/v1/voice/status', '/api/voice/status'], async (req, res, next) => {
  try {
    if (!req.auth) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
    res.json({ success: true, voice: await voiceStatus.getVoiceStatus({ fresh: req.query.fresh === '1' }) });
  } catch (err) {
    next(err);
  }
});

// ElevenLabs signed URL for a hands-free real-time voice session.
app.get(['/api/v1/voice/signed-url', '/api/signed-url', '/api/voice/signed-url'], async (req, res) => {
  try {
    if (!req.auth) return res.status(401).json({ success: false, error: 'Authentication required.', code: 'UNAUTHENTICATED' });
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const agentId = process.env.ELEVENLABS_AGENT_ID;
    if (!apiKey || !agentId) {
      return res.status(503).json({ success: false, code: 'VOICE_NOT_CONFIGURED', error: 'The voice agent is not set up: ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID is missing on the server.' });
    }

    const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(agentId)}`, {
      headers: { 'xi-api-key': apiKey }
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: `ElevenLabs API error: ${errText}` });
    }

    const data = await response.json();
    res.json({
      success: true,
      signed_url: data.signed_url,
      agentId: agentId
    });
  } catch (err) {
    console.error('Error generating ElevenLabs signed URL:', err);
    res.status(500).json({ error: err.message });
  }
});
app.post(['/api/tools/track_lead', '/api/track_lead'], requireCapability('leads.manage'), async (req, res, next) => {
  try {
    const { lead } = await leadService.createLead(req, req.body || {});
    res.json({ success: true, lead_id: lead.id, lead, message: `Lead for ${lead.name} recorded.` });
  } catch (err) {
    next(err);
  }
});

// Remaining modules are single-tenant (workspace 1) until migrated.
app.use('/api', (req, res, next) => {
  if (/^\/(v1\/)?auth\//.test(req.path)) return next();
  return legacyWorkspaceOnly()(req, res, next);
});

// Helper: Get local network IP
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ==========================================
// 1. AUTHENTICATION & WORKSPACE (SRS FR-01)
// ==========================================

// Marks the workspace where the workspace-1-only (legacy) modules work, so the UI can say so elsewhere.
function withModuleFlags(session) {
  const flag = w => (w ? { ...w, legacyModules: Number(w.id) === LEGACY_WORKSPACE_ID } : w);
  return { ...session, workspace: flag(session.workspace), workspaces: (session.workspaces || []).map(flag) };
}

app.post(['/api/v1/auth/register', '/api/auth/register'], async (req, res) => {
  try {
    const { email, password, displayName, workspaceName, industry } = req.body;
    const result = await authService.registerUser(email, password, displayName, workspaceName, industry);
    res.json({ success: true, ...withModuleFlags(result) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post(['/api/v1/auth/login', '/api/auth/login'], async (req, res) => {
  try {
    const { email, password, workspaceId } = req.body || {};
    // Optional workspaceId: the user must be an active member of it (checked by loginUser).
    const result = await authService.loginUser(email, password, workspaceId);
    res.json({ success: true, ...withModuleFlags(result) });
  } catch (err) {
    res.status(err.status === 403 || err.status === 400 ? err.status : 401).json({ success: false, code: err.code, error: err.message });
  }
});

app.get(['/api/v1/auth/me', '/api/auth/me'], async (req, res) => {
  try {
    const me = await authService.getUserMe(req.auth.userId, req.auth.workspaceId);
    res.json({ ...me, role: req.auth.role, capabilities: [...req.auth.capabilities] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/v1/auth/logout', '/api/auth/logout'], (req, res) => {
  res.json({ success: true, message: 'Logged out successfully' });
});

// ==========================================
// 2. DASHBOARD SUMMARY (SRS 4 - /app/dashboard)
// ==========================================

app.get(['/api/v1/dashboard/summary', '/api/dashboard/summary'], async (req, res) => {
  try {
    const tasksCount = await get('SELECT count(*) as count FROM tasks WHERE workspace_id = 1');
    const campaignsCount = await get('SELECT count(*) as count FROM campaigns WHERE workspace_id = 1');
    const contentDrafts = await get("SELECT count(*) as count FROM content_items WHERE workspace_id = 1 AND status = 'draft'");
    const contentApproved = await get("SELECT count(*) as count FROM content_items WHERE workspace_id = 1 AND status = 'approved'");
    const videoJobsCount = await get('SELECT count(*) as count FROM video_jobs WHERE workspace_id = 1');
    const leadsCount = await get('SELECT count(*) as count FROM leads WHERE workspace_id = 1');
    const agents = await all('SELECT * FROM agents WHERE workspace_id = 1 OR workspace_id IS NULL');
    const recentTasks = await all('SELECT * FROM tasks WHERE workspace_id = 1 ORDER BY id DESC LIMIT 5');

    res.json({
      metrics: {
        totalTasks: tasksCount?.count || 0,
        activeCampaigns: campaignsCount?.count || 0,
        pendingApprovals: contentDrafts?.count || 0,
        approvedContent: contentApproved?.count || 0,
        videoReels: videoJobsCount?.count || 0,
        leadsCaptured: leadsCount?.count || 0
      },
      agents,
      recentTasks
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. AI WORKSPACE & AGENTS (SRS 4 - /app/assistant & /app/agents)
// ==========================================

app.get(['/api/v1/agents', '/api/agents'], async (req, res) => {
  try {
    const agents = await all('SELECT * FROM agents WHERE workspace_id = 1 OR workspace_id IS NULL ORDER BY id ASC');
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/v1/assistant/chat', '/api/assistant/chat'], async (req, res) => {
  try {
    const { agentKey, message, conversationId } = req.body;
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const agent = await get('SELECT * FROM agents WHERE agent_key = ? LIMIT 1', [agentKey || 'executive_assistant']);
    const cleanMsg = (message || '').trim();
    const lower = cleanMsg.toLowerCase();

    // Fetch live B2B context from database
    const clients = await all('SELECT * FROM b2b_clients ORDER BY id DESC LIMIT 5');
    const replies = await all('SELECT * FROM client_replies ORDER BY id DESC LIMIT 5');
    const connectedBiz = await all('SELECT * FROM connected_businesses WHERE workspace_id = ? ORDER BY id ASC', [req.auth.workspaceId]);
    const traivoStats = await queryTraivoMySQL();
    const urgentEmails = await all("SELECT * FROM emails WHERE workspace_id = ? AND is_urgent = 1 AND is_read = 0 ORDER BY id DESC LIMIT 5", [req.auth.workspaceId]);
    const allLeads = await all("SELECT * FROM leads WHERE workspace_id = ? ORDER BY id DESC LIMIT 5", [req.auth.workspaceId]);
    const digitalProductsList = await all('SELECT * FROM digital_products WHERE workspace_id = ? ORDER BY id ASC', [req.auth.workspaceId]);

    let contextSnippet = `Live Business Context:
- Active Digital Products for Marketing (${digitalProductsList.length} total):
${digitalProductsList.map(p => `  * [PRODUCT] ${p.name} (URL: ${p.url}):
    Tagline: ${p.tagline}
    Description: ${p.description}
    Target Audience: ${p.target_audience}
    Features: ${p.features_json}`).join('\n')}
- Connected Businesses:
${connectedBiz.map(b => `  * ${b.business_type === 'owner' ? '[MY BUSINESS]' : '[CLIENT BUSINESS]'} ${b.name} (${b.industry}): ${b.description}`).join('\n')}
- Traivo Database: ${traivoStats.connected ? `MySQL 'thrivewoo' with ${traivoStats.totalProducts} catalog products and ${traivoStats.totalOrders} sales orders.` : 'not connected (no figures available).'}
- Recent Client Inquiries (${clients.length} total): ${clients.map(c => `${c.company_name} (Contact: ${c.contact_name}, Interest: ${c.product_interest}, Status: ${c.status})`).join('; ')}
- Recent Client Email Replies (${replies.length} total): ${replies.map(r => `${r.customer_name} from ${r.company_name}: "${r.reply_text}" [Sentiment: ${r.sentiment}]`).join('; ')}`;

    // Fast-path intelligent responses & real tool execution for live queries
    let fastReply = null;

    // 1. Sync Company Email on command
    if (lower.includes('sync') && (lower.includes('mail') || lower.includes('email') || lower.includes('inbox'))) {
      const syncRes = await emailService.syncIncomingEmails(req.auth.workspaceId);
      if (syncRes.success) {
        fastReply = `Sir, I have synchronized your company mailbox. ${syncRes.fetchedCount > 0 ? `Fetched ${syncRes.fetchedCount} new emails and completed AI urgency screening.` : 'All emails are up to date, with no new unread incoming messages.'}`;
      } else {
        fastReply = `Sir, company mailbox sync reported: ${syncRes.error}. You can verify your SMTP/IMAP credentials in Company Mail Settings.`;
      }
    }
    // 2. Draft Email on command ("when i say draft email to that person it have to do that")
    else if (lower.includes('draft') && (lower.includes('email') || lower.includes('mail'))) {
      let targetRecipient = null;
      let targetEmail = null;
      let targetTopic = '';

      // Parse "to <target> [about|regarding|for|with|saying|pitching|offering <topic>]"
      const toMatch = cleanMsg.match(/to\s+([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[a-zA-Z\s]+?)(?:\s+(?:about|regarding|for|with|saying|pitching|offering)\s+(.+))?$/i);
      if (toMatch) {
        const rawTarget = toMatch[1].trim();
        if (rawTarget.includes('@')) {
          targetEmail = rawTarget;
          targetRecipient = rawTarget.split('@')[0];
        } else {
          targetRecipient = rawTarget;
        }
        if (toMatch[2]) {
          targetTopic = toMatch[2].trim();
        }
      }

      // If no explicit target matched, search message for lead names
      if (!targetRecipient) {
        for (const l of allLeads) {
          const leadPersonName = l.name || l.contact_name;
          if ((leadPersonName && cleanMsg.toLowerCase().includes(leadPersonName.toLowerCase())) || (l.company_name && cleanMsg.toLowerCase().includes(l.company_name.toLowerCase()))) {
            targetRecipient = leadPersonName || l.company_name;
            targetEmail = l.email;
            break;
          }
        }
      }

      // If we have a name but no email, search CRM leads and B2B clients
      if (!targetEmail && targetRecipient) {
        const matchedLead = await get(
          "SELECT * FROM leads WHERE workspace_id = ? AND (LOWER(name) LIKE ? OR LOWER(company_name) LIKE ?) LIMIT 1",
          [req.auth.workspaceId, `%${targetRecipient.toLowerCase()}%`, `%${targetRecipient.toLowerCase()}%`]
        );
        if (matchedLead) {
          targetEmail = matchedLead.email;
          targetRecipient = matchedLead.name || matchedLead.company_name;
        } else {
          const matchedClient = await get(
            "SELECT * FROM b2b_clients WHERE LOWER(contact_name) LIKE ? OR LOWER(company_name) LIKE ? LIMIT 1",
            [`%${targetRecipient.toLowerCase()}%`, `%${targetRecipient.toLowerCase()}%`]
          );
          if (matchedClient) {
            targetEmail = matchedClient.email;
            targetRecipient = matchedClient.contact_name || matchedClient.company_name;
          }
        }
      }

      // Unknown addresses stay empty; the draft is completed in Mail Drafts before sending.
      targetEmail = targetEmail || '';
      targetRecipient = targetRecipient || '';

      // Only a workspace product named in the message is used; otherwise the draft stays generic.
      const targetProduct = await findProductNamedIn(req.auth.workspaceId, cleanMsg);

      const generatedDraft = await aiEngine.generateMailDraft(
        targetProduct,
        { name: targetRecipient, email: targetEmail },
        targetTopic,
        'Professional'
      );

      await run(
        `INSERT INTO email_drafts (workspace_id, product_id, product_name, recipient_email, recipient_name, subject, body_html, body_text, tone, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Professional', 'Draft', ?, ?)`,
        [
          req.auth.workspaceId,
          targetProduct ? targetProduct.id : null,
          targetProduct ? targetProduct.name : null,
          targetEmail,
          targetRecipient,
          generatedDraft.subject,
          generatedDraft.body_html,
          generatedDraft.body_text,
          now, now
        ]
      );

      const draftTo = targetRecipient ? `${targetRecipient}${targetEmail ? ` (${targetEmail})` : ''}` : (targetEmail || 'an unspecified recipient');
      const gaps = [!targetEmail && 'recipient email', !targetProduct && 'product (none named, so the draft is generic)'].filter(Boolean);
      fastReply = `Sir, I have drafted the email to ${draftTo}${targetTopic ? ` regarding "${targetTopic}"` : ''}. Subject: "${generatedDraft.subject}". It is saved in your Mail Drafts tab for your review and approval.${gaps.length ? ` Missing: ${gaps.join(', ')}.` : ''}`;
    }
    // 3. Social Media Post generation on command ("what about social media part, all these need to do the ai when i say")
    else if ((lower.includes('post') || lower.includes('tweet')) && (lower.includes('linkedin') || lower.includes('twitter') || lower.includes('instagram') || lower.includes('facebook') || lower.includes('social'))) {
      let platform = 'LinkedIn';
      if (lower.includes('twitter') || lower.includes('tweet') || lower.includes(' x ')) platform = 'Twitter';
      else if (lower.includes('instagram') || lower.includes('ig')) platform = 'Instagram';
      else if (lower.includes('facebook') || lower.includes('fb')) platform = 'Facebook';

      try {
        const namedProduct = await findProductNamedIn(req.auth.workspaceId, cleanMsg);
        const postRes = await marketingService.generateAiSocialPost(req.auth.workspaceId, {
          productId: namedProduct ? namedProduct.id : null,
          platform,
          customTopic: cleanMsg
        });
        fastReply = `Sir, I have generated a new ${platform} post${postRes.product_name ? ` for ${postRes.product_name}` : ' (no product named, so it is generic)'}: "${postRes.title}". Hook: "${postRes.caption_text.substring(0, 95)}...". Hashtags: ${postRes.hashtags}. It is saved in Social Media Marketing → Content Library as a draft for your review and approval.`;
      } catch (e) {
        fastReply = `Sir, I could not write that post: ${e.message}`;
      }
    }
    // 4. "Send email" on command: saved as a draft; sending needs approval and confirmation in Mail Drafts.
    else if (lower.includes('send email') || lower.includes('send an email') || lower.includes('mail send')) {
      const emailMatch = cleanMsg.match(/to\s+([^\s,]+@[^\s,]+|[a-zA-Z\s]+?)\s+(?:saying|about|with subject)\s+(.+)/i);
      // Only an address given in the message or an exact CRM contact match, with the user's own words.
      let recipient = null;
      let recipientName = '';
      if (emailMatch) {
        const target = emailMatch[1].trim();
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
          recipient = target;
        } else {
          const key = target.toLowerCase();
          let matches = await all("SELECT name, company_name, email FROM leads WHERE workspace_id = ? AND email IS NOT NULL AND email <> '' AND (LOWER(name) = ? OR LOWER(company_name) = ?) LIMIT 2", [req.auth.workspaceId, key, key]);
          if (!matches.length) {
            matches = (await all("SELECT contact_name AS name, company_name, email FROM b2b_clients WHERE email IS NOT NULL AND email <> '' AND (LOWER(contact_name) = ? OR LOWER(company_name) = ?) LIMIT 2", [key, key]));
          }
          if (matches.length === 1) {
            recipient = matches[0].email;
            recipientName = matches[0].name || matches[0].company_name || '';
          }
        }
      }
      const messageText = emailMatch ? emailMatch[2].trim() : '';

      if (!recipient || !messageText) {
        fastReply = `Sir, I did not send anything. ${!emailMatch ? 'Tell me who to send it to and what to say' : 'I could not find a single matching contact with an email address'}, for example: "send email to name@company.com saying ...". You can also ask me to draft the email first and send it from Mail Drafts.`;
      } else {
        const subject = messageText.split(/[.!?\n]/)[0].slice(0, 80) || messageText.slice(0, 80);
        const safeHtml = messageText.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const draftRes = await run(
          `INSERT INTO email_drafts (workspace_id, product_id, product_name, recipient_email, recipient_name, subject, body_html, body_text, tone, status, created_at, updated_at)
           VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, 'Professional', 'Draft', ?, ?)`,
          [req.auth.workspaceId, recipient, recipientName, subject,
            `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;"><p>${safeHtml}</p></div>`, messageText, now, now]
        );

        fastReply = `Sir, I have not sent it yet. I saved an email to ${recipientName ? `${recipientName} (${recipient})` : recipient} with the subject "${subject}" in Mail Drafts (draft #${draftRes.lastID}). Approve and confirm it there to send.`;
      }
    }
    // 5. Client Replies queries
    else if (lower.includes('reply') || lower.includes('replies') || lower.includes('email reply') || lower.includes('what did they say') || lower.includes('customer response')) {
      const topReplies = replies.slice(0, 2).map(r => `"${r.customer_name} from ${r.company_name} replied: '${r.reply_text}'"`).join(' Also, ');
      fastReply = replies.length ? `Sir, you have ${replies.length} recent client replies. ${topReplies}.` : 'Sir, there are no client replies recorded yet.';
    }
    // 6. Email queries (inbox, unread, urgent, read latest)
    else if (lower.includes('urgent') || lower.includes('inbox') || (lower.includes('email') && !lower.includes('send') && !lower.includes('draft')) || (lower.includes('mail') && !lower.includes('send') && !lower.includes('draft'))) {
      const allEmails = await all("SELECT * FROM emails WHERE workspace_id = ? ORDER BY id DESC LIMIT 5", [req.auth.workspaceId]);
      const unreadCountRow = await get("SELECT count(*) as count FROM emails WHERE workspace_id = ? AND is_read = 0", [req.auth.workspaceId]);
      const unreadCount = unreadCountRow?.count || 0;

      if (urgentEmails.length > 0) {
        const emailList = urgentEmails.slice(0, 3).map(e => `${e.sender || e.recipient_name} regarding '${e.subject}'`).join('; ');
        fastReply = `Sir, you have ${unreadCount} unread emails, including ${urgentEmails.length} urgent emails requiring your attention: ${emailList}. Would you like me to read the full body of any email or draft an immediate reply?`;
      } else if (allEmails.length > 0) {
        const top3 = allEmails.slice(0, 3).map(e => `${e.sender || 'Sender'}: "${e.subject}" [Priority: ${e.ai_priority || 'Normal'}]`).join(', ');
        fastReply = `Sir, your email center has ${allEmails.length} recent messages (${unreadCount} unread). Latest correspondence: ${top3}. You can ask me to draft a reply or open any message in your Email Center.`;
      } else {
        fastReply = `You have no unread emails at this time, sir. All incoming company correspondence is up to date.`;
      }
    }
    // 7. Lead queries & CRM Intelligence
    else if (lower.includes('lead') || lower.includes('client') || lower.includes('prospect') || lower.includes('crm') || lower.includes('inquir')) {
      const topLeadRows = await all("SELECT * FROM leads WHERE workspace_id = ? ORDER BY ai_score DESC, id DESC LIMIT 3", [req.auth.workspaceId]);
      if (topLeadRows.length > 0) {
        const leadSummaries = topLeadRows.map((l, i) => `${i + 1}) ${l.name || l.contact_name}${l.company_name ? ` from ${l.company_name}` : ''} (lead score: ${l.ai_score === null || l.ai_score === undefined ? 'not scored' : `${l.ai_score}/100`}${l.ai_category ? `, ${l.ai_category}` : ''}${l.ai_suggestion ? ` - ${l.ai_suggestion}` : ''})`).join('. ');
        fastReply = `Sir, you currently have ${allLeads.length} leads in your CRM. Your highest qualified leads are: ${leadSummaries}. All prospects are qualified for immediate multi-channel follow-up. Would you like me to draft an outreach email to any of them?`;
      } else {
        const topClients = clients.slice(0, 3).map(c => `${c.company_name} (${c.product_interest})`).join(', ');
        fastReply = `We currently have ${clients.length} purchasing clients in our pipeline: ${topClients}. Additionally, we have ${allLeads.length} active leads in the CRM ready for outreach.`;
      }
    }
    // 8. Marketing Ideas for connected businesses
    else if (lower.includes('marketing idea') || lower.includes('idea') || lower.includes('how to market') || lower.includes('campaign') || lower.includes('grow') || lower.includes('scale')) {
      // No canned strategies: answered by the AI below from the saved products and businesses in contextSnippet.
      fastReply = null;
    } else if (lower.includes('traivo') && (lower.includes('database') || lower.includes('product') || lower.includes('sku') || lower.includes('catalog'))) {
      fastReply = traivoStats.connected
        ? `Your Traivo B2B database is connected live to MySQL database 'thrivewoo'. It currently has ${traivoStats.totalProducts} products and ${traivoStats.totalOrders} sales orders.`
        : `Sir, the Traivo database is not reachable right now${traivoStats.error ? ` (${traivoStats.error})` : ''}, so I have no product or order counts to report.`;
    }
    // 9. Digital Product Details & Live Features Seeing ("can the ai see this details", "what are the features of thrivewoo", etc.)
    else if (
      (lower.includes('detail') && (lower.includes('see') || lower.includes('product') || lower.includes('thrivewoo') || lower.includes('feature') || lower.includes('site') || lower.includes('website') || lower.includes('url') || lower.includes('ai') || lower.includes('cant') || lower.includes("can't") || lower.includes('can ') || lower.includes('show') || lower.includes('what'))) ||
      (lower.includes('feature') && (lower.includes('product') || lower.includes('thrivewoo') || lower.includes('what are') || lower.includes('show') || lower.includes('list') || lower.includes('my') || lower.includes('see'))) ||
      (lower.includes('product') && (lower.includes('what are') || lower.includes('tell me') || lower.includes('what do i have') || lower.includes('show me') || lower.includes('details') || lower.includes('see'))) ||
      (lower.includes('what does') && (lower.includes('thrivewoo') || lower.includes('safetrack') || lower.includes('product') || lower.includes('app') || lower.includes('do')))
    ) {
      // A product named in the message, or the workspace's only product; never an arbitrary first one.
      const targetProd = (await findProductNamedIn(req.auth.workspaceId, cleanMsg)) || (digitalProductsList.length === 1 ? digitalProductsList[0] : null);
      if (targetProd) {
        let features = [];
        try { features = targetProd.features_json ? JSON.parse(targetProd.features_json) : []; } catch (e) { features = []; }
        const lines = [
          `Yes sir, these are the saved details for **${targetProd.name}**${targetProd.url ? ` (${targetProd.url})` : ''}.`,
          `📌 **Tagline:** ${targetProd.tagline || '—'}`,
          `🎯 **Target Audience:** ${targetProd.target_audience || '—'}`,
          `📋 **Features:**\n${features.length ? features.map((f, i) => `${i + 1}. ${f}`).join('\n') : '— (none saved)'}`
        ];
        fastReply = lines.join('\n\n');
      } else if (digitalProductsList.length) {
        fastReply = `Sir, you have ${digitalProductsList.length} saved products: ${digitalProductsList.map(p => p.name).join(', ')}. Which one would you like the details for?`;
      } else {
        fastReply = `Sir, you currently have no products saved in your Digital Products Hub. Enter your product's website URL there and click "Extract Features with AI" to import its details.`;
      }
    }
    // 10. Live URL Web Extraction on Chat Command
    else if (cleanMsg.match(/https?:\/\/[^\s]+/i) && (lower.includes('see') || lower.includes('extract') || lower.includes('check') || lower.includes('look') || lower.includes('detail') || lower.includes('feature') || lower.includes('get') || lower.includes('what'))) {
      const urlMatch = cleanMsg.match(/https?:\/\/[^\s]+/i);
      const targetUrl = urlMatch[0];
      try {
        const extracted = await aiEngine.extractProductFromWebpage(targetUrl, '', '', {}, { workspaceId: req.auth.workspaceId, referenceType: 'assistant_chat' });
        fastReply = [
          `Sir, I have analyzed ${targetUrl}:`,
          `**${extracted.name || '—'}**${extracted.tagline ? `\n${extracted.tagline}` : ''}`,
          `**Overview:** ${extracted.description || '—'}`,
          `**Features found on the page:**\n${(extracted.features || []).length ? extracted.features.map((f, i) => `${i + 1}. ${f}`).join('\n') : '— (none found)'}`,
          `**Target Audience:** ${extracted.target_audience || '—'}`
        ].join('\n\n');
      } catch (e) {
        fastReply = `Sir, I encountered an issue inspecting ${targetUrl}: ${e.message}`;
      }
    }

    // Social performance questions are answered from stored analytics only (never invented metrics).
    if (!fastReply && strategistService.isSocialAnalyticsQuestion(cleanMsg)) {
      try {
        const strategist = await strategistService.ask(req, cleanMsg);
        fastReply = strategist.answer;
      } catch (e) {
        console.warn('Social strategist unavailable:', e.message);
      }
    }

    let reply = fastReply;
    let provider = 'Mark Business Intelligence';

    if (!reply) {
      // Construct agent system persona prompt
      const systemInstruction = `You are Mark, an elite personal AI executive business assistant and marketing strategist to the founder.
Specialty: B2B digital product sales (the products saved in this workspace), email campaign outreach, client inquiry management, and business scaling.
${contextSnippet}

Core Rules:
- Always converse fluently and professionally in natural English.
- Answer whatever the user actually asks directly.
- Only describe products, features, customers and figures that appear in the live context. Never invent products, features, prices, metrics, customers or results; say when something is not saved.
- If asked about digital products or whether you can see product details, you CAN see all of them! Quote the exact product features, tagline, modules, and target audience from the live context.
- If asked about client inquiries or leads, cite the exact real companies, contacts, and statuses from the live context.
- If asked about client email replies, quote the real customer replies and sentiments from the live context.
- If asked for marketing ideas or business growth for Traivo or any product, provide high-ROI, actionable B2B strategies based on their real platform modules.
- If asked about Traivo database metrics, ${traivoStats.connected ? `state the exact ${traivoStats.totalProducts} products and ${traivoStats.totalOrders} orders from the live MySQL database` : 'say the Traivo database is not connected and give no figures'}.
- Keep spoken answers concise (1 to 3 spoken sentences) unless the user asks for a comprehensive breakdown.
- Do not repeat boilerplate greetings or loop.`;

      const aiResult = await meteredResponse({ workspaceId: req.auth.workspaceId, prompt: cleanMsg, system: systemInstruction, referenceType: 'assistant_chat' });
      reply = aiResult.text;
      provider = aiResult.provider;
    }

    let taskSteps = [
      { step: `Parse user intent: "${cleanMsg.substring(0, 45)}"`, status: "Done" },
      { step: `Query live B2B CRM & MySQL database`, status: "Done" },
      { step: `Synthesize executive response`, status: "Done" }
    ];

    const taskTitle = `Mark AI Assistant: "${cleanMsg.substring(0, 40)}..."`;

    // Save task record in ledger
    const taskRes = await run(
      `INSERT INTO tasks (workspace_id, agent_name, task_type, title, status, priority, input_json, result_json, steps_json, started_at, completed_at, created_at)
       VALUES (1, 'Mark (Executive Assistant)', 'ai_delegation', ?, 'Completed', 'High', ?, ?, ?, ?, ?, ?)`,
      [
        taskTitle,
        JSON.stringify({ message: cleanMsg }),
        JSON.stringify({ reply, provider }),
        JSON.stringify(taskSteps),
        now, now, now
      ]
    );

    res.json({
      success: true,
      reply,
      provider,
      agent: { name: 'Mark (Executive Assistant)', avatar_emoji: '🎙' },
      taskId: taskRes.lastID,
      taskSteps
    });
  } catch (err) {
    if (err.code === 'QUOTA_EXCEEDED') return res.status(429).json({ success: false, error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// B2B PURCHASING CLIENTS, INQUIRIES & CAMPAIGNS
// ==========================================

// 1. The ElevenLabs signed-URL endpoint is registered with the voice status route, before the
//    legacy workspace gate (voice works in every workspace).

// 2. B2B Purchasing Clients / Inquiries
app.get(['/api/v1/b2b/clients', '/api/b2b/clients'], requireCapability('leads.view'), async (req, res) => {
  try {
    const clients = await all('SELECT * FROM b2b_clients ORDER BY id DESC');
    res.json({ success: true, clients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/v1/b2b/clients', '/api/b2b/clients'], requireCapability('leads.manage'), async (req, res) => {
  try {
    const { companyName, contactName, email, phone, productInterest, inquiryDetails, dealValue } = req.body;
    if (!companyName || !email) {
      return res.status(400).json({ error: 'Company name and email are required' });
    }
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const result = await run(
      `INSERT INTO b2b_clients (workspace_id, company_name, contact_name, email, phone, product_interest, inquiry_details, estimated_deal_value, status, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'New Inquiry', ?)`,
      [
        companyName,
        contactName || 'Corporate Buyer',
        email,
        phone || '',
        productInterest || 'Traivo - B2B Sales Platform',
        inquiryDetails || 'Interested in commercial deployment',
        dealValue || '$15,000',
        now
      ]
    );

    // Auto-create initial welcome email in emails log
    await run(
      `INSERT INTO emails (workspace_id, client_id, recipient_email, recipient_name, subject, snippet, is_urgent, status, sent_at)
       VALUES (1, ?, ?, ?, ?, ?, 0, 'Sent', ?)`,
      [
        result.lastID,
        email,
        contactName || companyName,
        `Welcome to Marketech.ai: Information regarding ${productInterest || 'Traivo B2B'}`,
        `Thank you for inquiring about ${productInterest || 'Traivo B2B'}. We have prepared our executive overview...`,
        now
      ]
    );

    res.json({ success: true, clientId: result.lastID, message: 'Client inquiry registered successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Email Campaigns & Automated Dispatch
app.get(['/api/v1/b2b/campaigns', '/api/b2b/campaigns'], requireCapability('analytics.view'), async (req, res) => {
  try {
    const campaigns = await all('SELECT * FROM email_campaigns ORDER BY id DESC');
    res.json({ success: true, campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/v1/b2b/campaigns', '/api/b2b/campaigns'], requireCapability('campaigns.manage'), async (req, res) => {
  try {
    const { name, productKey, subject, templateBody, targetAudience } = req.body;
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const result = await run(
      `INSERT INTO email_campaigns (workspace_id, name, product_key, subject, template_body, target_audience, sent_count, reply_count, status, created_at)
       VALUES (1, ?, ?, ?, ?, ?, 0, 0, 'Active', ?)`,
      [name, productKey || 'traivo', subject, templateBody, targetAudience || 'Corporate Buyers', now]
    );
    res.json({ success: true, campaignId: result.lastID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retired: this route recorded emails as "Sent" without sending them. Campaign outreach now
// goes through Mail Drafts (approve + explicit confirmation) so delivery is never faked.
app.post(['/api/v1/b2b/campaigns/send', '/api/b2b/campaigns/send'], (req, res) => {
  res.status(410).json({
    success: false,
    code: 'RETIRED',
    error: 'This route no longer exists because it recorded emails as sent without sending them. Create drafts from AI Campaigns or Mail Drafts, then approve and send them there.'
  });
});

// 4. Client Replies Feed
app.get(['/api/v1/b2b/replies', '/api/b2b/replies'], requireCapability('leads.view'), async (req, res) => {
  try {
    const replies = await all('SELECT * FROM client_replies ORDER BY id DESC');
    res.json({ success: true, replies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Simplified B2B Statistics
app.get(['/api/v1/b2b/statistics', '/api/b2b/statistics'], requireCapability('analytics.view'), async (req, res) => {
  try {
    const clientsCount = await get('SELECT count(*) as c FROM b2b_clients');
    const newInquiries = await get("SELECT count(*) as c FROM b2b_clients WHERE status = 'New Inquiry'");
    const repliedCount = await get("SELECT count(*) as c FROM b2b_clients WHERE status LIKE '%Replied%'");
    const campaignsCount = await get('SELECT count(*) as c FROM email_campaigns');
    const repliesCount = await get('SELECT count(*) as c FROM client_replies');
    const traivoStats = await queryTraivoMySQL();

    res.json({
      success: true,
      statistics: {
        totalClients: clientsCount?.c || 0,
        newInquiries: newInquiries?.c || 0,
        demoRequested: repliedCount?.c || 0,
        totalCampaigns: campaignsCount?.c || 0,
        totalReplies: repliesCount?.c || 0,
        pipelineValue: null, // not tracked; never a placeholder figure
        traivoDatabase: {
          connected: traivoStats.connected,
          databaseName: 'thrivewoo',
          totalProducts: traivoStats.totalProducts,
          totalOrders: traivoStats.totalOrders,
          sampleProducts: traivoStats.sampleProducts
        }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Marketing & Growth Ideas Generator
app.get(['/api/v1/b2b/ideas', '/api/b2b/ideas'], requireCapability('analytics.view'), async (req, res) => {
  try {
    const productKey = req.query.productKey || 'traivo';
    const ideas = [
      {
        channel: 'Targeted B2B Cold Email Outreach',
        angle: 'Van Sales Efficiency & Mobile Order Booking',
        subject: 'Cut 15 hours of manual order entry for your field sales reps',
        summary: 'Target FMCG and beverage distributors. Highlight that sales reps waste 2 hours daily keying handwritten paper receipts into software. Traivo eliminates double-entry with 1-click mobile order booking.',
        conversionTip: 'Attach a 45-second phone screen recording of a sales rep generating an invoice in 10 seconds.'
      },
      {
        channel: 'LinkedIn Sales Navigator Direct Messaging',
        angle: 'Wholesale Catalog & Real-Time Stock Visibility',
        subject: 'Empowering wholesale distributors with live SKU inventory',
        summary: 'Connect with VP of Sales & Distribution Directors. Pitch how Traivo provides a 181+ item digital catalog with customer-tier pricing directly on iOS and Android.',
        conversionTip: 'Offer a 14-day free trial pilot for 3 van sales routes with zero software setup fee.'
      },
      {
        channel: 'Customer Re-engagement & Cross-Sell',
        angle: 'Automated Payment Collection & Receipt Printing',
        subject: 'Same-day cash & credit settlement on van routes',
        summary: 'Target existing trade customers with mobile thermal receipt printing and automated statement reconciliation at the point of delivery.',
        conversionTip: 'Host a 15-minute live webinar demonstration demonstrating route optimization and invoice exports.'
      }
    ];

    res.json({ success: true, productKey, ideas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Traivo MySQL Live Integration Endpoint
app.get(['/api/v1/integrations/traivo', '/api/integrations/traivo'], async (req, res) => {
  try {
    const data = await queryTraivoMySQL();
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Executive Spoken Briefing
app.get(['/api/v1/executive/briefing', '/api/executive/briefing'], async (req, res) => {
  try {
    const clients = await all('SELECT * FROM b2b_clients ORDER BY id DESC LIMIT 5');
    const replies = await all('SELECT * FROM client_replies ORDER BY id DESC LIMIT 5');
    const traivoStats = await queryTraivoMySQL();
    const urgentEmails = await get("SELECT count(*) as c FROM emails WHERE workspace_id = ? AND is_urgent = 1 AND is_read = 0", [req.auth.workspaceId]);

    res.json({
      success: true,
      briefing: {
        urgentEmailsCount: urgentEmails?.c || 0,
        totalClients: clients.length,
        traivoSkus: traivoStats.totalProducts,
        traivoOrders: traivoStats.totalOrders,
        recentInquiries: clients,
        recentReplies: replies,
        spokenSummary: `Good morning. You have ${clients.length} purchasing clients in your pipeline, ${replies.length} recent customer email replies including demo requests from Apex Wholesale and Metro Academy, and ${traivoStats.totalProducts} live products active in your Traivo database.`
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// DIGITAL PRODUCTS HUB & AI URL EXTRACTOR
// ==========================================

// 1. AI Extract features from webpage URL (Live Real-Time Web Extractor)
// Products API lives in modules/products (workspace-scoped), mounted above.

// ==========================================
// MAIL DRAFTS & USER APPROVAL WORKFLOW
// ==========================================

// Mail Drafts live in modules/mail (workspace-scoped), mounted above.

// ==========================================
// CONNECTED BUSINESSES & MULTI-BUSINESS MARKETING
// ==========================================

// Connected businesses, playbook generation and campaign drafts live in modules/playbooks
// (workspace-scoped), mounted above. Dispatch creates Mail Drafts; it never sends.

// ==========================================
// EMAILS HUB (INBOX & OUTBOUND SENDING)
// ==========================================

// Mail Center lives in modules/mail (workspace-scoped), mounted above.

// ==========================================
// LEADS & APPOINTMENTS (CRM ENGINE)
// ==========================================

// Leads CRM lives in modules/leads (workspace-scoped), mounted above.

// Appointments list & booking
app.get(['/api/v1/crm/appointments', '/api/appointments'], async (req, res) => {
  try {
    const appointments = await all('SELECT * FROM appointments ORDER BY id DESC LIMIT 50');
    res.json({ success: true, appointments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/v1/crm/appointments', '/api/appointments', '/api/tools/book_appointment', '/api/book_appointment'], async (req, res) => {
  try {
    const { customer_name, service, date, time, notes } = req.body;
    if (!customer_name || !date || !time) {
      return res.status(400).json({ error: 'Customer name, date, and time are required' });
    }
    const existing = await get('SELECT id FROM appointments WHERE date = ? AND time = ?', [date, time]);
    if (existing) {
      return res.json({
        success: false,
        message: `Sorry, the slot on ${date} at ${time} is already booked. Please choose another time.`
      });
    }
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const result = await run(
      `INSERT INTO appointments (workspace_id, customer_name, service, date, time, status, notes, created_at)
       VALUES (1, ?, ?, ?, ?, 'Confirmed', ?, ?)`,
      [customer_name, service || 'Product Demonstration', date, time, notes || '', now]
    );
    res.json({
      success: true,
      appointment_id: result.lastID,
      message: `Appointment booked successfully for ${customer_name} on ${date} at ${time} for ${service || 'Product Demonstration'}.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// DESKTOP OS SYSTEM TOOLS (PYTHON TOOLS PARITY)
// ==========================================

// Tool: Business facts & overview
app.all(['/api/tools/get_business_info', '/api/business_info'], async (req, res) => {
  try {
    const traivoStats = await queryTraivoMySQL();
    const businesses = await all('SELECT * FROM connected_businesses WHERE workspace_id = ? ORDER BY id ASC', [req.auth.workspaceId]);
    res.json({
      success: true,
      business_info: {
        flagship_product: 'Traivo - B2B Sales & Distribution Platform',
        database_sync: `MySQL thrivewoo (${traivoStats.totalProducts} active products, ${traivoStats.totalOrders} orders)`,
        connected_businesses_count: businesses.length,
        connected_businesses: businesses.map(b => b.name)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tool: Executive Briefing
app.all(['/api/tools/get_briefing'], async (req, res) => {
  try {
    const totalLeads = await get('SELECT count(*) as count FROM leads WHERE workspace_id = ?', [req.auth.workspaceId]);
    const urgentEmails = await get('SELECT count(*) as count FROM emails WHERE workspace_id = ? AND is_urgent = 1 AND is_read = 0', [req.auth.workspaceId]);
    const appointments = await all("SELECT customer_name, service, date, time FROM appointments WHERE status = 'Confirmed' ORDER BY date, time LIMIT 5");
    const traivoStats = await queryTraivoMySQL();

    res.json({
      success: true,
      total_leads: totalLeads?.count || 0,
      urgent_emails: urgentEmails?.count || 0,
      upcoming_appointments: appointments,
      traivo_products: traivoStats.totalProducts,
      message: `Good morning sir. You have ${urgentEmails?.count || 0} urgent emails, ${totalLeads?.count || 0} total leads recorded, ${appointments.length} upcoming appointments, and ${traivoStats.totalProducts} live products in your Traivo database.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Status endpoint
app.get(['/api/status'], (req, res) => {
  const lanIp = getLocalIp();
  res.json({
    status: 'online',
    agent_name: 'MARK // Executive AI Voice OS',
    voice_engine: 'ElevenLabs Conversational AI',
    agent_id: process.env.ELEVENLABS_AGENT_ID,
    lan_ip: lanIp,
    mobile_url: `http://${lanIp}:${PORT}`
  });
});

// ==========================================
// 4. TASKS ENGINE (SRS 4 - /app/tasks)
// ==========================================

app.get(['/api/v1/tasks', '/api/tasks'], async (req, res) => {
  try {
    const tasks = await all('SELECT * FROM tasks WHERE workspace_id = 1 ORDER BY id DESC LIMIT 50');
    const parsed = tasks.map(t => ({
      ...t,
      steps: t.steps_json ? JSON.parse(t.steps_json) : []
    }));
    res.json({ tasks: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. MARKETING & CONTENT (SRS 4 - /app/marketing, /app/content, /app/calendar)
// ==========================================

app.get(['/api/v1/marketing/campaigns', '/api/marketing/campaigns'], async (req, res) => {
  try {
    const campaigns = await marketingService.getCampaigns(1);
    res.json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/v1/marketing/campaigns', '/api/marketing/campaigns'], async (req, res) => {
  try {
    const campaign = await marketingService.createCampaign(1, req.body);
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(['/api/v1/content', '/api/content', '/api/marketing/content'], async (req, res) => {
  try {
    const status = req.query.status || 'all';
    const items = await marketingService.getContentItems(1, status);
    res.json({ contentItems: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/v1/marketing/generate-post', '/api/marketing/generate-post'], async (req, res) => {
  try {
    // Static product templates are no longer used; posts come from the selected product's stored details.
    const { campaignId, productId, platform, customTopic } = req.body;
    const post = await marketingService.generateAiSocialPost(req.auth.workspaceId, { campaignId: campaignId || null, productId, platform, customTopic });
    res.json({ success: true, post });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

app.post(['/api/v1/content/:id/status', '/api/content/:id/status', '/api/marketing/content/:id/status'], async (req, res) => {
  try {
    const { status } = req.body;
    const item = await marketingService.updateContentStatus(req.params.id, status, 1);
    res.json({ success: true, item });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post(['/api/v1/marketing/generate-social-post', '/api/marketing/generate-social-post'], async (req, res) => {
  try {
    const post = await marketingService.generateAiSocialPost(req.auth.workspaceId, req.body);
    res.json({ success: true, post });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

// Same capability as deleting content in the Social module.
app.delete(['/api/v1/content/:id', '/api/content/:id'], requireCapability('content.create'), async (req, res) => {
  try {
    const result = await marketingService.deleteContentItem(req.params.id, 1);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 19. COMPANY MAIL AUTHORIZATION & SMTP/IMAP
// ==========================================

// Mail settings live in modules/mail (workspace-scoped), mounted above.

// ==========================================
// 6. VIDEO STUDIO (SRS 4 - /app/video-studio)
// ==========================================

app.get(['/api/v1/videos', '/api/videos'], async (req, res) => {
  try {
    const jobs = await videoService.getVideoJobs(1);
    res.json({ videoJobs: jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/v1/videos/create', '/api/videos/create'], async (req, res) => {
  try {
    const { productKey } = req.body;
    const job = await videoService.createVideoJob(1, productKey || 'school_bus');
    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 7. TELEPHONY & VOICE (SRS 4 - /app/voice-agents & /app/voice)
// ==========================================

app.get(['/api/v1/telnyx/config', '/api/telnyx/config'], async (req, res) => {
  try {
    const numbers = await all('SELECT * FROM phone_numbers ORDER BY id ASC');
    res.json({
      phoneNumber: numbers[0]?.phone_number || telnyxService.TELNYX_PHONE_NUMBER,
      assignedAgent: numbers[0]?.assigned_agent_name || 'Sarah Connor (Telephone Sales Executive)',
      phoneNumbers: numbers
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get(['/api/v1/telnyx/voices', '/api/telnyx/voices'], (req, res) => {
  res.json({
    totalAvailableInTelnyx: 4673,
    voices: telnyxService.getCuratedVoices()
  });
});

app.post(['/api/v1/telnyx/synthesize', '/api/telnyx/synthesize'], async (req, res) => {
  try {
    const { text, voice } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }
    const audioBuffer = await telnyxService.synthesizeSpeech(text, voice);
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length
    });
    res.send(audioBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Telnyx TeXML webhooks: public, so only POSTs carrying a valid Telnyx Ed25519 signature over the
// raw body are processed (lib/telnyxWebhook.js); everything else is rejected before any work.
app.post(['/api/v1/telnyx/inbound', '/api/telnyx/inbound'], requireTelnyxSignature(), async (req, res) => {
  try {
    const from = req.body?.From || '+15550192831';
    const to = req.body?.To || telnyxService.TELNYX_PHONE_NUMBER;
    const texml = await telnyxService.handleInboundCall(from, to, 1);
    res.type('text/xml').send(texml);
  } catch (err) {
    res.status(500).type('text/plain').send('Error processing inbound call');
  }
});

app.post(['/api/v1/telnyx/dialogue', '/api/telnyx/dialogue'], requireTelnyxSignature(), async (req, res) => {
  try {
    const speechResult = req.body?.SpeechResult || '';
    const from = req.body?.From || '';
    const texml = await telnyxService.handleCallDialogue(speechResult, from, 1);
    res.type('text/xml').send(texml);
  } catch (err) {
    res.status(500).type('text/plain').send('Error processing speech dialogue');
  }
});

app.post(['/api/v1/telnyx/simulate', '/api/telnyx/simulate'], async (req, res) => {
  try {
    const { speech, callerPhone, callerName } = req.body;
    if (!speech) {
      return res.status(400).json({ error: 'Caller speech is required' });
    }
    const result = await telnyxService.simulateTelnyxCall(speech, callerPhone, callerName, 1);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(['/api/v1/telnyx/call-records', '/api/telnyx/call-records'], async (req, res) => {
  try {
    const records = await all('SELECT * FROM call_records ORDER BY id DESC LIMIT 50');
    res.json({ callRecords: records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 8. BUSINESS PROFILE & CRM (SRS 4 - /app/business-profile & Leads)
// ==========================================

// Business profile routes live in modules/workspaces (current workspace only), mounted above.


// ==========================================
// 9. BILLING & SUBSCRIPTIONS (SRS 4 - /app/billing)
// ==========================================

app.get(['/api/v1/billing/plans', '/api/billing/plans'], async (req, res) => {
  try {
    const plans = await all('SELECT * FROM plans WHERE active = 1 ORDER BY price_amount ASC');
    const parsed = plans.map(p => ({
      ...p,
      features: p.features_json ? JSON.parse(p.features_json) : []
    }));
    res.json({ plans: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(['/api/v1/billing/subscription', '/api/billing/subscription'], async (req, res) => {
  try {
    const sub = await get(
      `SELECT s.*, p.name as plan_name, p.plan_key, p.price_amount, p.credits_allowance, p.video_minutes, p.phone_minutes
       FROM subscriptions s
       JOIN plans p ON s.plan_id = p.id
       WHERE s.workspace_id = 1 ORDER BY s.id DESC LIMIT 1`
    );
    res.json({ subscription: sub });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Billing writes are disabled until real billing (payment, verified plans) exists: this route used
// to record a paid subscription without any payment. Nobody, including Owners, can change plans here.
app.post(['/api/v1/billing/change-plan', '/api/billing/change-plan'], (req, res) => {
  res.status(501).json({
    success: false,
    code: 'BILLING_NOT_AVAILABLE',
    error: 'Plan changes are not available yet. Billing has not been set up.'
  });
});

app.get(['/api/v1/usage/summary', '/api/usage/summary'], async (req, res) => {
  try {
    const summary = await usageService.getUsageSummary(1);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 10. ANGULAR CLIENT STATIC SERVING
// ==========================================

// Unknown API routes return JSON, not the SPA shell.
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: 'Not found', code: 'NOT_FOUND' });
});

// Central error handler: log details server-side, return a safe message.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[api] Unhandled error:', err);
  res.status(status).json({
    success: false,
    error: status >= 500 ? 'Internal server error' : err.message,
    code: err.code || (status >= 500 ? 'INTERNAL' : 'BAD_REQUEST')
  });
});

const ANGULAR_DIST_DIR = path.resolve(__dirname, '../frontend/dist/frontend/browser');

if (require('fs').existsSync(ANGULAR_DIST_DIR)) {
  console.log('Serving Angular frontend from:', ANGULAR_DIST_DIR);
  app.use(express.static(ANGULAR_DIST_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(ANGULAR_DIST_DIR, 'index.html'));
  });
} else {
  console.warn('⚠️ Angular production build not found at:', ANGULAR_DIST_DIR);
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.status(503).send(`
      <div style="font-family: system-ui, sans-serif; text-align: center; padding: 60px 20px; background: #0b1120; color: #e2e8f0; min-height: 100vh;">
        <h1 style="color: #00f0ff;">Mark // Marketing AI Platform</h1>
        <p style="font-size: 1.1rem; color: #94a3b8;">Frontend distribution bundle not found.</p>
        <p style="color: #64748b;">Please build the frontend by running: <code style="color: #38bdf8; background: #1e293b; padding: 4px 8px; border-radius: 4px;">npm run build</code> inside the <code style="color: #38bdf8;">frontend/</code> folder.</p>
      </div>
    `);
  });
}

// Start Server & Initialize Database
async function startServer() {
  try {
    await initDatabase();
    try {
      const { pending } = await require('./db/migrate').migrate({ statusOnly: true, log: () => {} });
      if (pending.length) {
        console.warn(`⚠️  ${pending.length} pending migration(s): ${pending.join(', ')}. Run "npm run migrate" in backend/ — Social Media Marketing needs them.`);
      }
    } catch (e) {
      console.warn('Could not check migrations:', e.message);
    }
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`====================================================`);
      console.log(`Marketech.ai — AI Marketing Workspace`);
      console.log(`Running on: http://localhost:${PORT}`);
      console.log(`LAN Access: http://${getLocalIp()}:${PORT}`);
      console.log(`Telephony Engine: Telnyx All-In-One Voice AI`);
      console.log(`====================================================`);
    });
  } catch (err) {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = app;
