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
const { apiGate, legacyWorkspaceOnly, requireCapability } = require('./middleware/auth');
const { rateLimit } = require('./lib/rateLimit');
const { resolveSelectedProduct, findProductNamedIn } = require('./lib/productContext');
const websiteExtractor = require('./services/websiteExtractor');
const socialRouter = require('./modules/social/routes');
const leadsRouter = require('./modules/leads/routes');
const productsRouter = require('./modules/products/routes');
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
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

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
    /^\/api\/v1\/social\/webhooks\/[a-z_]+$/
  ],
  toolPaths: [/^\/api\/(tools\/)?(send_email|track_lead|book_appointment|business_info|get_business_info|get_briefing)$/]
}));

// Tenant-aware social media marketing module.
app.use('/api/v1/social', socialRouter);

// Tenant-aware Leads CRM (legacy paths kept as aliases). The voice agent's track_lead tool
// creates leads through the same validated, workspace-scoped logic.
app.use(['/api/v1/leads', '/api/leads', '/api/v1/crm/leads'], leadsRouter);
// Tenant-aware Digital Products.
app.use(['/api/v1/products', '/api/products'], productsRouter);
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

app.post(['/api/v1/auth/register', '/api/auth/register'], async (req, res) => {
  try {
    const { email, password, displayName, workspaceName, industry } = req.body;
    const result = await authService.registerUser(email, password, displayName, workspaceName, industry);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post(['/api/v1/auth/login', '/api/auth/login'], async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await authService.loginUser(email, password);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
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
    const connectedBiz = await all('SELECT * FROM connected_businesses ORDER BY id ASC');
    const traivoStats = await queryTraivoMySQL();
    const urgentEmails = await all("SELECT * FROM emails WHERE is_urgent = 1 AND is_read = 0 ORDER BY id DESC LIMIT 5");
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
- Flagship Traivo Database: MySQL 'thrivewoo' with ${traivoStats.totalProducts} catalog products and ${traivoStats.totalOrders} sales orders.
- Recent Client Inquiries (${clients.length} total): ${clients.map(c => `${c.company_name} (Contact: ${c.contact_name}, Interest: ${c.product_interest}, Status: ${c.status})`).join('; ')}
- Recent Client Email Replies (${replies.length} total): ${replies.map(r => `${r.customer_name} from ${r.company_name}: "${r.reply_text}" [Sentiment: ${r.sentiment}]`).join('; ')}`;

    // Fast-path intelligent responses & real tool execution for live queries
    let fastReply = null;

    // 1. Sync Company Email on command
    if (lower.includes('sync') && (lower.includes('mail') || lower.includes('email') || lower.includes('inbox'))) {
      const syncRes = await emailService.syncIncomingEmails(1);
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
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'Professional', 'Draft', ?, ?)`,
        [
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
    // 4. Send Email on command via real company SMTP
    else if (lower.includes('send email') || lower.includes('send an email') || lower.includes('mail send')) {
      const emailMatch = cleanMsg.match(/to\s+([^\s,]+@[^\s,]+|[a-zA-Z\s]+?)\s+(?:saying|about|with subject)\s+(.+)/i);
      // Sends only to an address given in the message or an exact CRM contact match, with the user's own words.
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
        const sendRes = await emailService.sendRealEmail(1, {
          to: recipient,
          recipientName,
          subject,
          html: `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6;"><p>${safeHtml}</p></div>`,
          text: messageText
        });

        fastReply = `I have sent the email to ${recipientName ? `${recipientName} (${recipient})` : recipient} with the subject "${subject}". Status: ${sendRes.smtpStatus}. It is recorded in your outbound email digest, sir.`;
      }
    }
    // 5. Client Replies queries
    else if (lower.includes('reply') || lower.includes('replies') || lower.includes('email reply') || lower.includes('what did they say') || lower.includes('customer response')) {
      const topReplies = replies.slice(0, 2).map(r => `"${r.customer_name} from ${r.company_name} replied: '${r.reply_text}'"`).join(' Also, ');
      fastReply = replies.length ? `Sir, you have ${replies.length} recent client replies. ${topReplies}.` : 'Sir, there are no client replies recorded yet.';
    }
    // 6. Email queries (inbox, unread, urgent, read latest)
    else if (lower.includes('urgent') || lower.includes('inbox') || (lower.includes('email') && !lower.includes('send') && !lower.includes('draft')) || (lower.includes('mail') && !lower.includes('send') && !lower.includes('draft'))) {
      const allEmails = await all("SELECT * FROM emails ORDER BY id DESC LIMIT 5");
      const unreadCountRow = await get("SELECT count(*) as count FROM emails WHERE is_read = 0");
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
      fastReply = `Your Traivo B2B database is connected live to MySQL database 'thrivewoo'. It currently has ${traivoStats.totalProducts} active wholesale products and ${traivoStats.totalOrders} processed sales orders.`;
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
        const extracted = await aiEngine.extractProductFromWebpage(targetUrl);
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
    let provider = 'Roger Business Intelligence';

    if (!reply) {
      // Construct agent system persona prompt
      const systemInstruction = `You are Roger, an elite personal AI executive business assistant and marketing strategist to the founder.
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
- If asked about Traivo database metrics, state the exact ${traivoStats.totalProducts} products and ${traivoStats.totalOrders} orders from the live MySQL database.
- Keep spoken answers concise (1 to 3 spoken sentences) unless the user asks for a comprehensive breakdown.
- Do not repeat boilerplate greetings or loop.`;

      const aiResult = await aiEngine.generateAiResponse(cleanMsg, systemInstruction, 1);
      reply = aiResult.text;
      provider = aiResult.provider;
    }

    let taskSteps = [
      { step: `Parse user intent: "${cleanMsg.substring(0, 45)}"`, status: "Done" },
      { step: `Query live B2B CRM & MySQL database`, status: "Done" },
      { step: `Synthesize executive response`, status: "Done" }
    ];

    const taskTitle = `Roger AI Assistant: "${cleanMsg.substring(0, 40)}..."`;

    // Save task record in ledger
    const taskRes = await run(
      `INSERT INTO tasks (workspace_id, agent_name, task_type, title, status, priority, input_json, result_json, steps_json, started_at, completed_at, created_at)
       VALUES (1, 'Roger (Executive Assistant)', 'ai_delegation', ?, 'Completed', 'High', ?, ?, ?, ?, ?, ?)`,
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
      agent: { name: 'Roger (Executive Assistant)', avatar_emoji: '🎙' },
      taskId: taskRes.lastID,
      taskSteps
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// B2B PURCHASING CLIENTS, INQUIRIES & CAMPAIGNS
// ==========================================

// 1. ElevenLabs Signed URL Endpoint for hands-free real-time voice
app.get(['/api/v1/voice/signed-url', '/api/signed-url', '/api/voice/signed-url'], async (req, res) => {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const agentId = process.env.ELEVENLABS_AGENT_ID;
    
    const response = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`, {
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

// 2. B2B Purchasing Clients / Inquiries
app.get(['/api/v1/b2b/clients', '/api/b2b/clients'], async (req, res) => {
  try {
    const clients = await all('SELECT * FROM b2b_clients ORDER BY id DESC');
    res.json({ success: true, clients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/v1/b2b/clients', '/api/b2b/clients'], async (req, res) => {
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
        `Welcome to TradeSage: Information regarding ${productInterest || 'Traivo B2B'}`,
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
app.get(['/api/v1/b2b/campaigns', '/api/b2b/campaigns'], async (req, res) => {
  try {
    const campaigns = await all('SELECT * FROM email_campaigns ORDER BY id DESC');
    res.json({ success: true, campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/v1/b2b/campaigns', '/api/b2b/campaigns'], async (req, res) => {
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

app.post(['/api/v1/b2b/campaigns/send', '/api/b2b/campaigns/send'], async (req, res) => {
  try {
    const { campaignId, clientId } = req.body;
    const campaign = await get('SELECT * FROM email_campaigns WHERE id = ?', [campaignId || 1]);
    const client = await get('SELECT * FROM b2b_clients WHERE id = ?', [clientId || 1]);
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    if (campaign && client) {
      const emailBody = (campaign.template_body || '')
        .replace('{{contact_name}}', client.contact_name)
        .replace('{{company_name}}', client.company_name);

      await run(
        `INSERT INTO emails (workspace_id, campaign_id, client_id, recipient_email, recipient_name, subject, body, snippet, status, sent_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'Sent', ?)`,
        [
          campaign.id,
          client.id,
          client.email,
          client.contact_name,
          campaign.subject,
          emailBody,
          `Campaign outreach sent to ${client.company_name}`,
          now
        ]
      );

      await run('UPDATE email_campaigns SET sent_count = sent_count + 1 WHERE id = ?', [campaign.id]);
      await run("UPDATE b2b_clients SET status = 'Email Sent' WHERE id = ?", [client.id]);
    }

    res.json({ success: true, message: `Automated campaign email dispatched to ${client?.company_name || 'client'}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Client Replies Feed
app.get(['/api/v1/b2b/replies', '/api/b2b/replies'], async (req, res) => {
  try {
    const replies = await all('SELECT * FROM client_replies ORDER BY id DESC');
    res.json({ success: true, replies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Simplified B2B Statistics
app.get(['/api/v1/b2b/statistics', '/api/b2b/statistics'], async (req, res) => {
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
        pipelineValue: '$88,500',
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
app.get(['/api/v1/b2b/ideas', '/api/b2b/ideas'], async (req, res) => {
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
    const urgentEmails = await get("SELECT count(*) as c FROM emails WHERE is_urgent = 1 AND is_read = 0");

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

// 1. Get all email drafts
app.get(['/api/v1/drafts', '/api/drafts'], async (req, res) => {
  try {
    const drafts = await all('SELECT * FROM email_drafts ORDER BY id DESC');
    res.json({ success: true, drafts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Generate a new email draft with AI
app.post(['/api/v1/drafts/generate', '/api/drafts/generate'], async (req, res) => {
  try {
    const { productId, recipientName, recipientEmail, goal, tone } = req.body;

    // Only the explicitly selected product of this workspace; malformed or foreign ids are rejected.
    const product = await resolveSelectedProduct(req.auth.workspaceId, productId);

    const recipient = { name: recipientName, email: recipientEmail };
    const draftContent = await aiEngine.generateMailDraft(product, recipient, goal, tone || 'Professional');

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const result = await run(
      `INSERT INTO email_drafts (workspace_id, product_id, product_name, recipient_email, recipient_name, subject, body_html, body_text, tone, status, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?, ?)`,
      [
        product?.id || null,
        product?.name || null,
        recipientEmail || '',
        recipientName || '',
        draftContent.subject,
        draftContent.body_html,
        draftContent.body_text,
        draftContent.tone,
        now, now
      ]
    );

    const created = await get('SELECT * FROM email_drafts WHERE id = ?', [result.lastID]);
    const missing = draftContent.missing_context || [];
    res.json({
      success: true,
      draft: created,
      missing_context: missing,
      message: missing.includes('product')
        ? 'Draft created without product context: no product was selected, so it contains no product details or links. Review before sending.'
        : 'Email draft created. Awaiting your approval before sending.'
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

// 3. AI Rewrite an email draft
app.post(['/api/v1/drafts/:id/rewrite', '/api/drafts/:id/rewrite'], async (req, res) => {
  try {
    const { instruction } = req.body;
    const draft = await get('SELECT * FROM email_drafts WHERE id = ? AND workspace_id = ?', [req.params.id, req.auth.workspaceId]);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    const rewritten = await aiEngine.rewriteMailDraft(draft, instruction || 'More Professional', req.auth.workspaceId);
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    await run(
      `UPDATE email_drafts SET subject = ?, body_html = ?, body_text = ?, tone = ?, updated_at = ? WHERE id = ?`,
      [rewritten.subject, rewritten.body_html, rewritten.body_text, rewritten.tone, now, draft.id]
    );

    const updated = await get('SELECT * FROM email_drafts WHERE id = ?', [draft.id]);
    res.json({ success: true, draft: updated, message: `Draft rewritten to be "${instruction}".` });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

// 4. User Approve draft
app.put(['/api/v1/drafts/:id/approve', '/api/drafts/:id/approve'], async (req, res) => {
  try {
    const draft = await get('SELECT * FROM email_drafts WHERE id = ?', [req.params.id]);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    await run(`UPDATE email_drafts SET status = 'Approved', updated_at = ? WHERE id = ?`, [now, draft.id]);

    const updated = await get('SELECT * FROM email_drafts WHERE id = ?', [draft.id]);
    res.json({ success: true, draft: updated, message: 'Draft approved. Ready for dispatch.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Send approved draft (Dispatches visual HTML email via Company SMTP)
app.post(['/api/v1/drafts/:id/send', '/api/drafts/:id/send'], async (req, res) => {
  try {
    const draft = await get('SELECT * FROM email_drafts WHERE id = ?', [req.params.id]);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    if (!draft.recipient_email) return res.status(400).json({ error: 'This draft has no recipient email address. Add one before sending.' });

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    // Dispatch via real company SMTP
    const sendResult = await emailService.sendRealEmail(1, {
      to: draft.recipient_email,
      recipientName: draft.recipient_name || '',
      subject: draft.subject,
      html: draft.body_html,
      text: draft.body_text
    });

    // Update draft status to Sent
    await run(`UPDATE email_drafts SET status = 'Sent', updated_at = ? WHERE id = ?`, [now, draft.id]);

    res.json({
      success: true,
      sendResult,
      message: `Email draft dispatched to ${draft.recipient_email || 'recipient'} successfully (${sendResult.smtpStatus}).`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Delete draft
app.delete(['/api/v1/drafts/:id', '/api/drafts/:id'], async (req, res) => {
  try {
    await run('DELETE FROM email_drafts WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Email draft deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// CONNECTED BUSINESSES & MULTI-BUSINESS MARKETING
// ==========================================

// 1. Get all connected businesses
app.get(['/api/v1/businesses/connected', '/api/businesses/connected'], async (req, res) => {
  try {
    const list = await all("SELECT * FROM connected_businesses ORDER BY CASE WHEN business_type = 'owner' THEN 0 ELSE 1 END, id ASC");
    const parsed = list.map(b => ({
      ...b,
      products: b.products_json ? JSON.parse(b.products_json) : []
    }));
    res.json({ success: true, businesses: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Connect a new client business
app.post(['/api/v1/businesses/connected', '/api/businesses/connected'], async (req, res) => {
  try {
    const { name, industry, website, description, products, target_audience, business_type } = req.body;
    if (!name || !industry) {
      return res.status(400).json({ error: 'Business name and industry are required' });
    }
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const result = await run(
      `INSERT INTO connected_businesses (workspace_id, business_type, name, industry, website, description, products_json, target_audience, status, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'Connected', ?)`,
      [
        business_type || 'client',
        name,
        industry,
        website || '',
        description || '',
        JSON.stringify(products || []),
        target_audience || '',
        now
      ]
    );
    res.json({ success: true, businessId: result.lastID, message: `Connected business "${name}" successfully registered.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Generate tailored campaign & marketing ideas for ANY chosen business
app.post(['/api/v1/marketing/generate-ideas', '/api/marketing/generate-ideas'], async (req, res) => {
  try {
    const { businessId, businessName } = req.body;
    let biz = null;
    if (businessId) {
      biz = await get('SELECT * FROM connected_businesses WHERE id = ?', [businessId]);
    } else if (businessName) {
      biz = await get('SELECT * FROM connected_businesses WHERE name LIKE ?', [`%${businessName}%`]);
    }
    if (!biz) {
      biz = await get("SELECT * FROM connected_businesses WHERE business_type = 'owner' LIMIT 1");
    }

    const traivoStats = await queryTraivoMySQL();
    const isOwner = biz?.business_type === 'owner' || (biz?.name && biz.name.toLowerCase().includes('traivo'));
    const isSchoolBus = biz?.name && (biz.name.toLowerCase().includes('metro') || biz.name.toLowerCase().includes('school'));
    const isBeverage = biz?.name && (biz.name.toLowerCase().includes('horizon') || biz.name.toLowerCase().includes('beverage'));

    let ideas = [];
    if (isOwner) {
      ideas = [
        {
          channel: 'Targeted FMCG & Beverage Wholesale Cold Outreach',
          angle: 'Eliminate 15 Hours of Manual Van Sales Double-Entry',
          subject: 'Cut order-entry delays by 80% for your route sales team',
          summary: `Target beverage and FMCG distributors with sales reps on van routes. Pitch Traivo's mobile order booking app with your catalog of ${traivoStats.totalProducts} live SKUs and Bluetooth thermal invoice printing.`,
          conversionTip: 'Offer a 14-day free pilot for 3 van sales reps with instant mobile invoice receipt printing.'
        },
        {
          channel: 'LinkedIn Sales Navigator Direct Messaging',
          angle: 'Real-Time Catalog Restocking & Direct Store Delivery',
          subject: 'Digital ordering portal for your wholesale buyers',
          summary: 'Connect with VP of Sales & Distribution Directors. Pitch how Traivo empowers retail accounts to restock directly from iOS/Android with live pricing and order tracking.',
          conversionTip: 'Attach a 45-second screen recording showing a rep taking an order in under 15 seconds.'
        },
        {
          channel: 'Warehouse Inventory Reconciliation Playbook',
          angle: 'Zero Order Discrepancies on Van Delivery Routes',
          subject: 'Eliminate missing stock & route reconciliation errors',
          summary: 'Highlight how Traivo synchronizes field sales transactions directly into central SQL databases, eliminating end-of-day paperwork bottlenecks.',
          conversionTip: 'Provide a free 1-page ROI calculator showing monthly fuel and labor savings.'
        }
      ];
    } else if (isSchoolBus) {
      ideas = [
        {
          channel: 'Superintendent & School Board Direct Safety Pitch',
          angle: 'State Safety Grant Funded RFID Student Bus Tracking',
          subject: 'Student safety bus tracking & automated parent SMS alerts',
          summary: 'Target school superintendents and transportation directors. Pitch the 22-bus RFID student boarding verification and live GPS parent arrival countdown app.',
          conversionTip: 'Provide an approved grant application template showing how state safety grants fund 100% of deployment costs.'
        },
        {
          channel: 'Parent-Teacher Association (PTA) Safety Demonstration',
          angle: 'Eliminate Missing Child Commute Anxiety',
          subject: 'Instant boarding confirmation for parents when child enters bus',
          summary: 'Present the parent mobile app showing real-time bus location ETA. Show school administrators how this eliminates 90% of morning phone calls to school dispatch.',
          conversionTip: 'Run a 2-route pilot during back-to-school week to collect parent testimonials.'
        },
        {
          channel: 'Fleet Route Optimization & Fuel Reduction',
          angle: 'Cut School Transportation Fuel Burn by 20%',
          subject: 'Route optimization and bus fleet fuel efficiency',
          summary: 'Pitch route optimization algorithms that eliminate duplicate stops and reduce driver overtime expenses.',
          conversionTip: 'Offer a free transportation route audit for up to 25 school buses.'
        }
      ];
    } else if (isBeverage) {
      ideas = [
        {
          channel: 'Convenience Store & Bodega Self-Serve Portal',
          angle: '24/7 Digital Beverage Restock Ordering',
          subject: 'Order beverage refills directly from your mobile phone',
          summary: 'Give retail accounts a seamless mobile ordering app for 200+ beverage and snack SKUs with customer-specific pricing and repeat order buttons.',
          conversionTip: 'Offer $50 off the first digital restock order to drive app adoption.'
        },
        {
          channel: 'Route Batch Fulfillment for Fast Delivery',
          angle: 'Automate Pallet Packing & Delivery Manifests',
          subject: 'Next-day fulfillment for high-volume beverage accounts',
          summary: 'Group morning delivery manifests automatically by route, reducing truck turnaround time and out-of-stock complaints.',
          conversionTip: 'Demonstrate automated invoice exports to warehouse dispatch.'
        }
      ];
    } else {
      ideas = [
        {
          channel: 'High-Intent Cold Email Campaign',
          angle: `Growth & Automation for ${biz?.name || 'Client Business'}`,
          subject: `Accelerate commercial operations for ${biz?.name || 'Client Business'}`,
          summary: `Tailored outbound campaign focusing on ${biz?.target_audience || 'decision makers'}. Emphasizes ${biz?.description || 'commercial scalability and modern automation'}.`,
          conversionTip: 'Offer a complimentary 15-minute strategy call and tailored deployment roadmap.'
        },
        {
          channel: 'Targeted LinkedIn Direct Outreach',
          angle: 'Decision-Maker Value Proposition',
          subject: `Solving operational bottlenecks for ${biz?.name || 'Client Business'}`,
          summary: `Reach out to industry leaders in ${biz?.industry || 'the sector'} with relevant case studies and ROI metrics.`,
          conversionTip: 'Share a 1-page executive briefing detailing measurable efficiency gains.'
        }
      ];
    }

    res.json({
      success: true,
      business: biz,
      ideas
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Dispatch Campaign Email to Leads
app.post(['/api/v1/marketing/dispatch-campaign', '/api/marketing/dispatch-campaign'], async (req, res) => {
  try {
    const { businessId, subject, body, leadIds } = req.body;
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    let targetLeads = [];
    if (leadIds && leadIds.length > 0) {
      const placeholders = leadIds.map(() => '?').join(',');
      targetLeads = await all(`SELECT * FROM leads WHERE workspace_id = ? AND id IN (${placeholders})`, [req.auth.workspaceId, ...leadIds]);
    } else {
      targetLeads = await all('SELECT * FROM leads WHERE workspace_id = ? ORDER BY id DESC LIMIT 5', [req.auth.workspaceId]);
    }

    let sentCount = 0;
    for (const lead of targetLeads) {
      if (lead.email) {
        await run(
          `INSERT INTO emails (workspace_id, recipient_email, recipient_name, subject, body, snippet, is_urgent, is_read, status, sent_at, received_at)
           VALUES (1, ?, ?, ?, ?, ?, 0, 1, 'Sent', ?, ?)`,
          [
            lead.email,
            lead.name,
            subject || 'Exclusive Business Partnership & Demonstration',
            body || 'Hello, we would love to share our latest product capabilities with your team.',
            (body || '').substring(0, 80),
            now, now
          ]
        );
        sentCount++;
      }
    }

    res.json({
      success: true,
      sentCount,
      message: `Dispatched campaign emails to ${sentCount} leads successfully.`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// EMAILS HUB (INBOX & OUTBOUND SENDING)
// ==========================================

// Get all emails (Inbox + Sent)
app.get(['/api/v1/emails', '/api/emails'], async (req, res) => {
  try {
    const emails = await all('SELECT * FROM emails ORDER BY is_urgent DESC, id DESC LIMIT 50');
    const parsed = emails.map(e => ({
      ...e,
      ai_replies: e.ai_replies_json ? JSON.parse(e.ai_replies_json) : []
    }));
    res.json({ success: true, emails: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send an outbound email (Text or HTML via Company SMTP)
app.post(['/api/v1/emails/send', '/api/emails/send', '/api/tools/send_email', '/api/send_email'], async (req, res) => {
  try {
    const { recipient_email, recipient_name, subject, body, html_body } = req.body;
    if (!recipient_email || !subject) {
      return res.status(400).json({ error: 'recipient_email and subject are required' });
    }

    const sendRes = await emailService.sendRealEmail(1, {
      to: recipient_email,
      recipientName: recipient_name || recipient_email,
      subject,
      html: html_body || `<div style="font-family: sans-serif; padding: 20px;"><p>${body || ''}</p></div>`,
      text: body || ''
    });

    res.json({
      success: true,
      emailId: sendRes.emailId,
      messageId: sendRes.messageId,
      smtpStatus: sendRes.smtpStatus,
      message: `Email sent to ${recipient_email} regarding '${subject}' successfully (${sendRes.smtpStatus}).`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send visual HTML email explicitly via Company SMTP
app.post(['/api/v1/emails/send-html', '/api/emails/send-html'], async (req, res) => {
  try {
    const { recipient_email, recipient_name, subject, html_body, body_text } = req.body;
    if (!recipient_email || !subject || !html_body) {
      return res.status(400).json({ error: 'recipient_email, subject, and html_body are required' });
    }

    const sendRes = await emailService.sendRealEmail(1, {
      to: recipient_email,
      recipientName: recipient_name || recipient_email,
      subject,
      html: html_body,
      text: body_text || ''
    });

    res.json({
      success: true,
      emailId: sendRes.emailId,
      messageId: sendRes.messageId,
      smtpStatus: sendRes.smtpStatus,
      message: `Visual HTML email dispatched to ${recipient_email} successfully (${sendRes.smtpStatus}).`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI Analyze Email (Summary, Priority, 1-Click Smart Replies)
app.post(['/api/v1/emails/:id/ai-analyze', '/api/emails/:id/ai-analyze'], async (req, res) => {
  try {
    const email = await get('SELECT * FROM emails WHERE id = ?', [req.params.id]);
    if (!email) return res.status(404).json({ error: 'Email not found' });

    // No product is assumed for inbox replies; replies stay generic unless the email itself says more.
    const analysis = await aiEngine.analyzeEmail(email, null);

    await run(
      `UPDATE emails SET ai_summary = ?, ai_priority = ?, ai_replies_json = ? WHERE id = ?`,
      [analysis.ai_summary, analysis.ai_priority, JSON.stringify(analysis.ai_replies), email.id]
    );

    res.json({
      success: true,
      emailId: email.id,
      summary: analysis.ai_summary,
      priority: analysis.ai_priority,
      smartReplies: analysis.ai_replies
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tool: Get emails summary (spoken format)
app.all(['/api/tools/get_emails', '/api/get_emails'], async (req, res) => {
  try {
    const emails = await all('SELECT * FROM emails ORDER BY is_urgent DESC, id DESC LIMIT 20');
    const urgentEmails = emails.filter(e => e.is_urgent === 1 && (e.is_read === 0 || e.status === 'Unread'));
    let speechText = '';
    if (urgentEmails.length > 0) {
      const details = urgentEmails.map(e => `${e.sender || e.recipient_name} regarding '${e.subject}'`).join('; ');
      speechText = `Sir, you have ${urgentEmails.length} urgent emails requiring your attention: ${details}.`;
    } else {
      speechText = `Sir, you have ${emails.length} total emails in your records, and none are marked urgent.`;
    }
    res.json({
      success: true,
      total_emails: emails.length,
      urgent_count: urgentEmails.length,
      emails,
      spoken_summary: speechText
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    const businesses = await all('SELECT * FROM connected_businesses ORDER BY id ASC');
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
    const urgentEmails = await get('SELECT count(*) as count FROM emails WHERE is_urgent = 1 AND is_read = 0');
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
    agent_name: 'ROGER // Executive AI Voice OS',
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

app.delete(['/api/v1/content/:id', '/api/content/:id'], async (req, res) => {
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

app.get(['/api/v1/mail/config', '/api/mail/config'], async (req, res) => {
  try {
    const config = await emailService.getSafeMailConfig(1);
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/v1/mail/config', '/api/mail/config'], async (req, res) => {
  try {
    const config = await emailService.saveMailConfig(1, req.body);
    res.json({ success: true, config, message: 'Company mail authorization settings saved successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/v1/mail/test-smtp', '/api/mail/test-smtp'], async (req, res) => {
  try {
    const result = await emailService.verifySmtpConnection(1, req.body.config || null);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post(['/api/v1/mail/sync', '/api/mail/sync'], async (req, res) => {
  try {
    const result = await emailService.syncIncomingEmails(1);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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

app.all(['/api/v1/telnyx/inbound', '/api/telnyx/inbound'], async (req, res) => {
  try {
    const from = req.body?.From || req.query?.From || '+15550192831';
    const to = req.body?.To || req.query?.To || telnyxService.TELNYX_PHONE_NUMBER;
    const texml = await telnyxService.handleInboundCall(from, to, 1);
    res.type('text/xml').send(texml);
  } catch (err) {
    res.status(500).type('text/plain').send('Error processing inbound call');
  }
});

app.all(['/api/v1/telnyx/dialogue', '/api/telnyx/dialogue'], async (req, res) => {
  try {
    const speechResult = req.body?.SpeechResult || req.query?.SpeechResult || '';
    const from = req.body?.From || req.query?.From || '';
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

app.get(['/api/v1/business-profile', '/api/business-profile', '/api/workspaces/current'], async (req, res) => {
  try {
    const ws = await get('SELECT * FROM workspaces ORDER BY id ASC LIMIT 1');
    const profile = await get('SELECT * FROM business_profiles WHERE workspace_id = ?', [ws?.id || 1]);
    if (profile && profile.products_json) {
      profile.products = JSON.parse(profile.products_json);
    }
    res.json({ workspace: ws, businessProfile: profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put(['/api/v1/business-profile', '/api/business-profile'], async (req, res) => {
  try {
    const { businessName, industry, websiteUrl, description, brandVoice, products } = req.body;
    await run(
      `UPDATE business_profiles SET
        business_name = ?, industry = ?, website_url = ?, description = ?, brand_voice = ?, products_json = ?
       WHERE workspace_id = 1`,
      [businessName, industry, websiteUrl, description, brandVoice, JSON.stringify(products || [])]
    );
    res.json({ success: true, message: 'Business profile updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.post(['/api/v1/billing/change-plan', '/api/billing/change-plan'], async (req, res) => {
  try {
    const { planKey } = req.body;
    const plan = await get('SELECT id, name FROM plans WHERE plan_key = ?', [planKey]);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    await run(
      `INSERT INTO subscriptions (workspace_id, plan_id, status, current_period_start, current_period_end, created_at)
       VALUES (1, ?, 'Active', ?, date(?, '+30 days'), ?)`,
      [plan.id, now, now, now]
    );

    res.json({ success: true, message: `Upgraded to ${plan.name} successfully` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
        <h1 style="color: #00f0ff;">Roger // Marketing AI Platform</h1>
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
      console.log(`TradeSage AI Enterprise Workforce Platform`);
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
