const path = require('path');
const DB_CLIENT = process.env.DB_CLIENT || 'mysql';

let sqliteDb = null;
let mysqlPool = null;

if (DB_CLIENT === 'mysql') {
  const mysql = require('mysql2/promise');
  mysqlPool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'marketing-ai',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
  console.log(`[DB] Configured for MySQL at ${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || '3306'} (Database: ${process.env.DB_NAME || 'marketing-ai'})`);
} else {
  const sqlite3 = require('sqlite3').verbose();
  const DB_PATH = path.resolve(__dirname, '../../tradesage.db');
  sqliteDb = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.error('Failed to connect to SQLite database:', err.message);
    } else {
      console.log('Connected to SQLite database at:', DB_PATH);
    }
  });
}

function sanitizeParams(params) {
  if (!Array.isArray(params)) return params;
  return params.map(p => (p === undefined ? null : p));
}

// Universal query helpers
function run(sql, params = []) {
  const cleanParams = sanitizeParams(params);
  if (DB_CLIENT === 'mysql') {
    return mysqlPool.execute(sql, cleanParams).then(([result]) => ({
      lastID: result.insertId,
      changes: result.affectedRows
    }));
  }
  return new Promise((resolve, reject) => {
    sqliteDb.run(sql, cleanParams, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  const cleanParams = sanitizeParams(params);
  if (DB_CLIENT === 'mysql') {
    return mysqlPool.execute(sql, cleanParams).then(([rows]) => rows[0] || null);
  }
  return new Promise((resolve, reject) => {
    sqliteDb.get(sql, cleanParams, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  const cleanParams = sanitizeParams(params);
  if (DB_CLIENT === 'mysql') {
    return mysqlPool.execute(sql, cleanParams).then(([rows]) => rows || []);
  }
  return new Promise((resolve, reject) => {
    sqliteDb.all(sql, cleanParams, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function initDatabase() {
  if (DB_CLIENT === 'mysql') {
    try {
      const { seedMySQL } = require('../seed');
      await seedMySQL();
    } catch (err) {
      console.error('MySQL initialization error:', err.message);
    }
    return;
  }
  // 1. Workspaces (Tenants)
  await run(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      owner_email TEXT NOT NULL,
      plan TEXT DEFAULT 'Starter',
      status TEXT DEFAULT 'Active',
      created_at TEXT
    )
  `);

  // 1b. Users & Authentication Table
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      email_verified_at TEXT,
      status TEXT DEFAULT 'Active',
      created_at TEXT,
      updated_at TEXT
    )
  `);

  // 1c. Workspace Members (Role-based tenancy)
  await run(`
    CREATE TABLE IF NOT EXISTS workspace_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT DEFAULT 'Workspace Owner',
      status TEXT DEFAULT 'Active',
      created_at TEXT
    )
  `);

  // 1d. AI Agents Directory Table
  await run(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER,
      agent_key TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      agent_type TEXT DEFAULT 'specialist',
      system_instructions TEXT,
      tools_json TEXT,
      avatar_emoji TEXT DEFAULT '🤖',
      status TEXT DEFAULT 'Active',
      created_at TEXT
    )
  `);

  // 1e. Conversations & Messages
  await run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      user_id INTEGER,
      agent_id INTEGER,
      title TEXT NOT NULL,
      channel TEXT DEFAULT 'web_chat',
      status TEXT DEFAULT 'Active',
      created_at TEXT,
      updated_at TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content_text TEXT NOT NULL,
      content_json TEXT,
      created_at TEXT
    )
  `);

  // 1f. Tasks Engine Table
  await run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      conversation_id INTEGER,
      agent_id INTEGER,
      agent_name TEXT,
      task_type TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'Completed',
      priority TEXT DEFAULT 'Normal',
      input_json TEXT,
      result_json TEXT,
      steps_json TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT
    )
  `);

  // 1g. Plans & Subscriptions
  await run(`
    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      price_amount REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      billing_interval TEXT DEFAULT 'monthly',
      credits_allowance INTEGER DEFAULT 1000,
      video_minutes INTEGER DEFAULT 10,
      phone_minutes INTEGER DEFAULT 50,
      features_json TEXT,
      active INTEGER DEFAULT 1
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      plan_id INTEGER NOT NULL,
      status TEXT DEFAULT 'Active',
      current_period_start TEXT,
      current_period_end TEXT,
      created_at TEXT
    )
  `);

  // 2. Business Profiles & Brand Kits
  await run(`
    CREATE TABLE IF NOT EXISTS business_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      business_name TEXT NOT NULL,
      industry TEXT,
      website_url TEXT,
      description TEXT,
      products_json TEXT,
      brand_voice TEXT DEFAULT 'Professional, innovative, and authoritative',
      brand_colors_json TEXT,
      logo_url TEXT,
      created_at TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    )
  `);

  // 3. Leads CRM Table (Tenant-scoped)
  await run(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER DEFAULT 1,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      product_interest TEXT,
      company_name TEXT,
      estimated_budget TEXT,
      notes TEXT,
      status TEXT DEFAULT 'New',
      created_at TEXT
    )
  `);

  // Safe column migration for existing tables
  const addColumnIfNotExists = async (table, column, typeDef) => {
    try {
      await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDef}`);
    } catch (err) {
      // Column already exists, ignore
    }
  };

  await addColumnIfNotExists('leads', 'workspace_id', 'INTEGER DEFAULT 1');
  await addColumnIfNotExists('leads', 'product_interest', 'TEXT');
  await addColumnIfNotExists('leads', 'company_name', 'TEXT');
  await addColumnIfNotExists('leads', 'estimated_budget', 'TEXT');
  await addColumnIfNotExists('leads', 'notes', 'TEXT');
  await addColumnIfNotExists('leads', 'ai_score', 'INTEGER DEFAULT 0');
  await addColumnIfNotExists('leads', 'ai_category', "TEXT DEFAULT 'Cold'");
  await addColumnIfNotExists('leads', 'ai_suggestion', 'TEXT');

  await addColumnIfNotExists('appointments', 'workspace_id', 'INTEGER DEFAULT 1');
  await addColumnIfNotExists('appointments', 'notes', 'TEXT');

  await addColumnIfNotExists('emails', 'workspace_id', 'INTEGER DEFAULT 1');
  await addColumnIfNotExists('emails', 'campaign_id', 'INTEGER');
  await addColumnIfNotExists('emails', 'client_id', 'INTEGER');
  await addColumnIfNotExists('emails', 'sender', 'TEXT');
  await addColumnIfNotExists('emails', 'sender_email', 'TEXT');
  await addColumnIfNotExists('emails', 'recipient_email', 'TEXT');
  await addColumnIfNotExists('emails', 'recipient_name', 'TEXT');
  await addColumnIfNotExists('emails', 'body', 'TEXT');
  await addColumnIfNotExists('emails', 'html_body', 'TEXT');
  await addColumnIfNotExists('emails', 'ai_summary', 'TEXT');
  await addColumnIfNotExists('emails', 'ai_priority', "TEXT DEFAULT 'Normal'");
  await addColumnIfNotExists('emails', 'ai_replies_json', 'TEXT');
  await addColumnIfNotExists('emails', 'status', "TEXT DEFAULT 'Unread'");
  await addColumnIfNotExists('emails', 'sent_at', 'TEXT');
  await addColumnIfNotExists('emails', 'received_at', 'TEXT');
  await addColumnIfNotExists('emails', 'is_read', 'INTEGER DEFAULT 0');
  await addColumnIfNotExists('emails', 'message_id', 'TEXT');
  await addColumnIfNotExists('emails', 'smtp_status', "TEXT DEFAULT 'Delivered'");

  // Migration: Update ThriveWoo to real live FMCG features and remove all pricing tiers
  try {
    const realThriveWooFeatures = JSON.stringify([
      'Dashboard Status Overview: Track orders, estimates, bookings, drafts, and cancellations in one place',
      'Staff Performance Analysis: Category-wise targets, projections, and rep performance tracking',
      'Buying Pattern Analysis & Customer-Specific Discounts',
      'Real-Time In-App Team Communication & Messaging',
      'Visual Dashboards for Revenue, Collections, Frequently Bought Products & Order Status',
      'Bulk Customer Data Import via Excel Spreadsheets',
      'Customer Database & Order Lifecycle Tracking from Creation to Fulfillment'
    ]);
    await run(`
      UPDATE digital_products 
      SET name = 'ThriveWoo - Smart FMCG B2B Sales App',
          tagline = 'Smart FMCG B2B Sales App — All-in-One Platform Built for Growth',
          description = 'Empower your sales team with ThriveWoo — the feature-rich B2B sales app built for FMCG and wholesale distribution. Track staff performance, uncover buying patterns, offer customer-specific discounts, and connect your sales force in real time.',
          features_json = ?,
          target_audience = 'FMCG Brands, Wholesale Distributors, Field Sales Fleets, Consumer Goods Manufacturers',
          pricing_tiers_json = '[]'
      WHERE LOWER(name) LIKE '%thrivewoo%' OR LOWER(url) LIKE '%thrivewoo%'
    `, [realThriveWooFeatures]);
  } catch (migErr) {
    // ignore if table does not exist yet
  }

  // 4. Appointments & Demos Table
  await run(`
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER DEFAULT 1,
      customer_name TEXT NOT NULL,
      service TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      status TEXT DEFAULT 'Confirmed',
      notes TEXT,
      created_at TEXT
    )
  `);

  // 5. Marketing Campaigns
  await run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      objective TEXT NOT NULL,
      target_audience TEXT,
      channels TEXT DEFAULT 'Instagram, LinkedIn, Facebook',
      brief_text TEXT,
      status TEXT DEFAULT 'Active',
      created_at TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    )
  `);

  // 6. Content Items (Social Posts, Graphics, Videos)
  await run(`
    CREATE TABLE IF NOT EXISTS content_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      campaign_id INTEGER,
      content_type TEXT DEFAULT 'post',
      title TEXT,
      caption_text TEXT,
      hashtags TEXT,
      call_to_action TEXT,
      media_url TEXT,
      platform TEXT DEFAULT 'All',
      status TEXT DEFAULT 'Draft',
      scheduled_at TEXT,
      published_at TEXT,
      created_at TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    )
  `);

  // 7. Video Studio Jobs (Reel Composition)
  await run(`
    CREATE TABLE IF NOT EXISTS video_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      aspect_ratio TEXT DEFAULT '9:16',
      script_text TEXT,
      scenes_json TEXT,
      output_video_path TEXT,
      status TEXT DEFAULT 'Queued',
      created_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    )
  `);

  // 8. Telnyx Phone Numbers & Voice Agent Mapping
  await run(`
    CREATE TABLE IF NOT EXISTS phone_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      phone_number TEXT UNIQUE NOT NULL,
      telnyx_id TEXT,
      label TEXT,
      assigned_agent_name TEXT DEFAULT 'TradeSage Marketing AI',
      status TEXT DEFAULT 'Active',
      created_at TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    )
  `);

  // 9. Call Records & Transcripts (Inbound/Outbound Telephony)
  await run(`
    CREATE TABLE IF NOT EXISTS call_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      direction TEXT DEFAULT 'inbound',
      caller_number TEXT,
      duration_seconds INTEGER DEFAULT 0,
      transcript TEXT,
      summary TEXT,
      lead_id INTEGER,
      call_outcome TEXT DEFAULT 'Demo Scheduled',
      created_at TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    )
  `);

  // 10. Usage Ledger (Metering for AI, Video, & Telephony under $10 cap)
  await run(`
    CREATE TABLE IF NOT EXISTS usage_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT NOT NULL,
      estimated_cost REAL DEFAULT 0.0,
      created_at TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    )
  `);

  // 11. B2B Purchasing Clients & Inquiries (CRM)
  await run(`
    CREATE TABLE IF NOT EXISTS b2b_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER DEFAULT 1,
      company_name TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      product_interest TEXT DEFAULT 'Traivo B2B Sales Platform',
      inquiry_details TEXT,
      estimated_deal_value TEXT DEFAULT '$15,000',
      status TEXT DEFAULT 'New Inquiry',
      created_at TEXT
    )
  `);

  // 12. Email Campaigns
  await run(`
    CREATE TABLE IF NOT EXISTS email_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER DEFAULT 1,
      name TEXT NOT NULL,
      product_key TEXT NOT NULL,
      subject TEXT NOT NULL,
      template_body TEXT NOT NULL,
      target_audience TEXT,
      sent_count INTEGER DEFAULT 0,
      reply_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'Active',
      created_at TEXT
    )
  `);

  // 13. Emails & Automated Outreach Logs
  await run(`
    CREATE TABLE IF NOT EXISTS emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER DEFAULT 1,
      campaign_id INTEGER,
      client_id INTEGER,
      recipient_email TEXT NOT NULL,
      recipient_name TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT,
      snippet TEXT,
      is_urgent INTEGER DEFAULT 0,
      status TEXT DEFAULT 'Sent',
      sent_at TEXT
    )
  `);

  // 14. Client Replies & Feedback Feed
  await run(`
    CREATE TABLE IF NOT EXISTS client_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER DEFAULT 1,
      campaign_id INTEGER,
      client_id INTEGER,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      company_name TEXT,
      reply_text TEXT NOT NULL,
      sentiment TEXT DEFAULT 'High Intent',
      status TEXT DEFAULT 'New',
      received_at TEXT
    )
  `);

  // 15. Connected Businesses Hub (Owner Business + Connected Client Businesses)
  await run(`
    CREATE TABLE IF NOT EXISTS connected_businesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER DEFAULT 1,
      business_type TEXT DEFAULT 'client',
      name TEXT NOT NULL,
      industry TEXT NOT NULL,
      website TEXT,
      description TEXT,
      products_json TEXT,
      target_audience TEXT,
      status TEXT DEFAULT 'Connected',
      created_at TEXT
    )
  `);

  // 16. Digital Products Hub (ThriveWoo, SaaS apps, Digital Platforms)
  await run(`
    CREATE TABLE IF NOT EXISTS digital_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER DEFAULT 1,
      name TEXT NOT NULL,
      url TEXT,
      tagline TEXT,
      description TEXT,
      features_json TEXT,
      target_audience TEXT,
      pricing_tiers_json TEXT,
      status TEXT DEFAULT 'Active',
      created_at TEXT
    )
  `);

  // 17. Mail Drafts & Approvals Workflow Table
  await run(`
    CREATE TABLE IF NOT EXISTS email_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER DEFAULT 1,
      product_id INTEGER,
      product_name TEXT,
      recipient_email TEXT NOT NULL,
      recipient_name TEXT,
      subject TEXT NOT NULL,
      body_html TEXT NOT NULL,
      body_text TEXT,
      tone TEXT DEFAULT 'Professional',
      status TEXT DEFAULT 'Draft',
      created_at TEXT,
      updated_at TEXT
    )
  `);

  // 18. Company Email SMTP & IMAP Configuration Table
  await run(`
    CREATE TABLE IF NOT EXISTS mail_configurations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER DEFAULT 1,
      provider TEXT DEFAULT 'custom_smtp',
      smtp_host TEXT,
      smtp_port INTEGER DEFAULT 587,
      smtp_secure INTEGER DEFAULT 0,
      smtp_user TEXT,
      smtp_pass TEXT,
      imap_host TEXT,
      imap_port INTEGER DEFAULT 993,
      imap_tls INTEGER DEFAULT 1,
      imap_user TEXT,
      imap_pass TEXT,
      sender_name TEXT DEFAULT 'Roger Executive Team',
      sender_email TEXT,
      status TEXT DEFAULT 'Not Configured',
      last_synced_at TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);

  // SEED DEFAULT WORKSPACE & PRODUCTS IF EMPTY
  const wsCount = await get('SELECT count(*) as count FROM workspaces');
  if (!wsCount || wsCount.count === 0) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const wsResult = await run(
      `INSERT INTO workspaces (name, slug, owner_email, plan, status, created_at)
       VALUES ('TradeSage Enterprise', 'tradesage-enterprise', 'founder@tradesage.ai', 'Business', 'Active', ?)`,
      [now]
    );
    const workspaceId = wsResult.lastID || 1;

    const products = [
      {
        id: 'traivo',
        name: 'Traivo - B2B Sales & Distribution Platform',
        tagline: 'Wholesale Ordering, Mobile Van Sales & Instant Invoicing',
        target_audience: 'B2B Wholesalers, Distributors, Van Sales Fleets & Manufacturers',
        database_source: 'thrivewoo (MySQL 127.0.0.1:3306)',
        key_features: [
          'Mobile B2B order booking app for field sales representatives',
          'Live synchronized digital catalog with 181+ active wholesale SKUs',
          'Van sales inventory tracking, route management & thermal receipt printing',
          'Customer-specific tiered wholesale pricing, promotions & bulk discounts',
          'Automated invoice generation and instant sales order processing'
        ],
        pricing: 'Monthly SaaS platform plan ($149 - $399/month)'
      },
      {
        id: 'school_bus',
        name: 'School Bus Management System (SaaS)',
        tagline: 'Live GPS Fleet Tracking & RFID Student Safety Alerting',
        target_audience: 'School Principals, Fleet Operators, Academy Administrators',
        database_source: 'busskit_new (MySQL 127.0.0.1:3306)',
        key_features: [
          'Sub-second live GPS fleet tracking with geofencing',
          'RFID student boarding & deboarding automatic parent SMS alerts',
          'Parent mobile app with real-time arrival countdown ETA',
          'Automated route optimization cutting school fuel consumption by 20%',
          'Central safety dashboard with emergency SOS console and speed telemetry'
        ],
        pricing: 'Flexible fleet subscription ($15 - $30/bus/month)'
      },
      {
        id: 'web_mobile_apps',
        name: 'Custom Web & Mobile Application Development',
        tagline: 'Enterprise-Grade Software & High-Speed Mobile Engineering',
        target_audience: 'Startup Founders, Enterprise Leaders, Product Directors',
        key_features: [
          'Native & Cross-Platform mobile apps (Flutter, React Native, iOS, Android)',
          'High-performance web backends and cloud microservices (Node.js, Python FastAPI)',
          'Modern UI/UX design systems and secure REST/GraphQL API architectures',
          'Rapid MVP delivery within 4 to 8 weeks with complete production CI/CD'
        ],
        pricing: 'Project-based scoping ($5,000 - $35,000+)'
      }
    ];

    const colors = { primary: '#00f0ff', secondary: '#7000ff', background: '#0b0f19' };

    await run(
      `INSERT INTO business_profiles (
        workspace_id, business_name, industry, website_url, description,
        products_json, brand_voice, brand_colors_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        workspaceId,
        'TradeSage B2B Software Enterprise',
        'Enterprise B2B Software & Distribution Solutions',
        'https://tradesage.ai',
        'Enterprise software company powering Traivo B2B Sales & Distribution Platform, School Bus Fleet Management, and Custom Engineering.',
        JSON.stringify(products),
        'Visionary, authoritative, consultative, and hyper-efficient',
        JSON.stringify(colors),
        now
      ]
    );

    // Seed initial marketing campaign
    const campResult = await run(
      `INSERT INTO campaigns (workspace_id, name, objective, target_audience, channels, brief_text, status, created_at)
       VALUES (?, 'Q4 School Bus Fleet Safety Drive', 'Generate 30 qualified school demo requests', 'School Administrators & Fleet Directors', 'LinkedIn, Facebook, Email', 'Promote live GPS bus tracking and RFID student check-in to provide parents ultimate peace of mind.', 'Active', ?)`,
      [workspaceId, now]
    );
    const campaignId = campResult.lastID || 1;

    // Seed initial content items
    await run(
      `INSERT INTO content_items (
        workspace_id, campaign_id, content_type, title, caption_text, hashtags, call_to_action, platform, status, created_at
      ) VALUES (
        ?, ?, 'post',
        'Is Your School Bus Fleet Still Running on Guesswork?',
        'Parents deserve to know their children arrived safely. Our School Bus Management System gives parents live GPS tracking on their phones and notifies them the exact second their child scans onto the bus. Schedule your free 15-minute school walkthrough today.',
        '#SchoolSafety #EdTech #SchoolBusTracking #FleetManagement #TradeSage',
        'Book a 15-Minute School Demo',
        'LinkedIn', 'Approved', ?
      )`,
      [workspaceId, campaignId, now]
    );

    await run(
      `INSERT INTO content_items (
        workspace_id, campaign_id, content_type, title, caption_text, hashtags, call_to_action, platform, status, created_at
      ) VALUES (
        ?, ?, 'post',
        'Stop Losing 20% of Your School Transportation Budget to Inefficient Bus Routes',
        'Smart route optimization can instantly streamline your morning and afternoon pick-ups while slashing diesel waste. See how schools cut operating costs in week one.',
        '#FleetOptimization #SchoolLogistics #CleanMobility #TradeSageAI',
        'Get a Fleet Cost Audit',
        'Facebook', 'Draft', ?
      )`,
      [workspaceId, campaignId, now]
    );

    // Seed phone number
    await run(
      `INSERT INTO phone_numbers (workspace_id, phone_number, telnyx_id, label, assigned_agent_name, status, created_at)
       VALUES (?, '+1 (800) 555-SAGE', 'tlnx_prod_01', 'Primary Inbound Sales Line', 'TradeSage Voice Agent', 'Active', ?)`,
      [workspaceId, now]
    );

    // Seed initial usage entry ($1.00 phone number allocation)
    await run(
      `INSERT INTO usage_ledger (workspace_id, category, quantity, unit, estimated_cost, created_at)
       VALUES (?, 'telnyx_phone_number_monthly', 1.0, 'number', 1.00, ?)`,
      [workspaceId, now]
    );
  }

  // SEED PLANS IF EMPTY
  const planCount = await get('SELECT count(*) as count FROM plans');
  if (!planCount || planCount.count === 0) {
    const plansData = [
      { key: 'starter', name: 'Starter Plan', price: 19.00, credits: 1000, video: 10, phone: 50, features: JSON.stringify(['1 Workspace', 'Basic Marketing Agent', 'Social Post Generation', 'Community Support']) },
      { key: 'professional', name: 'Professional Plan', price: 49.00, credits: 5000, video: 30, phone: 150, features: JSON.stringify(['3 Workspaces', 'All Specialist Agents', '9:16 Video Reels', 'In-App Voice Assistant', 'Priority Email Support']) },
      { key: 'business', name: 'Business Plan', price: 99.00, credits: 15000, video: 90, phone: 400, features: JSON.stringify(['Unlimited Workspaces', 'Telnyx Telephone AI Agents', 'Team Approval Workflow', 'Custom Brand Kits', 'Dedicated Account Manager']) },
      { key: 'agency', name: 'Agency & White-Label', price: 199.00, credits: 40000, video: 250, phone: 1000, features: JSON.stringify(['Client Reselling Portal', 'Custom Domain Branding', 'Custom Voice Models', 'SLA 99.9%', '24/7 VIP Phone Support']) }
    ];

    for (const p of plansData) {
      await run(
        `INSERT INTO plans (plan_key, name, price_amount, currency, billing_interval, credits_allowance, video_minutes, phone_minutes, features_json, active)
         VALUES (?, ?, ?, 'USD', 'monthly', ?, ?, ?, ?, 1)`,
        [p.key, p.name, p.price, p.credits, p.video, p.phone, p.features]
      );
    }
  }

  // SEED DEFAULT AGENTS IF EMPTY
  const agentCount = await get('SELECT count(*) as count FROM agents');
  if (!agentCount || agentCount.count === 0) {
    const defaultAgents = [
      {
        key: 'marketing_strategist',
        name: 'Elena Vance',
        title: 'Chief Marketing Strategist',
        desc: 'Designs multi-channel campaign architectures, defines target audience segments, and formulates high-ROI launch briefs.',
        avatar: '📊',
        instructions: 'You are the Chief Marketing Strategist. Formulate structured multi-channel campaigns, target customer personas, and optimize CAC.'
      },
      {
        key: 'copywriter',
        name: 'Julian Hayes',
        title: 'Direct-Response Copywriter',
        desc: 'Generates viral headlines, engaging LinkedIn/Instagram captions, targeted hashtags, and compelling calls to action.',
        avatar: '✍️',
        instructions: 'You are an elite direct-response copywriter. Write crisp, persuasive copy with clear hooks, problem agitation, and high-converting CTAs.'
      },
      {
        key: 'video_producer',
        name: 'Marcus Reed',
        title: 'Motion & Reel Video Producer',
        desc: 'Assembles high-energy 9:16 vertical promotional reels, subtitle scripts, and visual pacing for Instagram Reels and TikTok.',
        avatar: '🎬',
        instructions: 'You are a motion video producer. Structure 9:16 vertical scenes with bold typography, badges, and smooth audio timing.'
      },
      {
        key: 'phone_receptionist',
        name: 'Sarah Connor',
        title: 'Inbound Telephone Sales Executive',
        desc: 'Handles live phone calls via Telnyx Voice AI, qualifies inbound prospects, and schedules executive product demos directly into CRM.',
        avatar: '📞',
        instructions: 'You are the Inbound Telephone Sales Specialist. Answer caller inquiries professionally, pitch value points, and secure demo bookings.'
      },
      {
        key: 'executive_assistant',
        name: 'Arthur Pendelton',
        title: 'Executive AI Operations Lead',
        desc: 'Coordinates team task workflows, monitors operational spend, schedules pending content, and delivers executive briefings.',
        avatar: '⚡',
        instructions: 'You are the Executive AI Operations Lead. Maintain high team velocity, track pending approvals, and ensure task execution.'
      }
    ];

    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    for (const a of defaultAgents) {
      await run(
        `INSERT INTO agents (workspace_id, agent_key, name, description, agent_type, system_instructions, avatar_emoji, status, created_at)
         VALUES (1, ?, ?, ?, 'specialist', ?, ?, 'Active', ?)`,
        [a.key, `${a.name} (${a.title})`, a.desc, a.instructions, a.avatar, now]
      );
    }
  }

  // SEED DEFAULT USER IF EMPTY
  const userCount = await get('SELECT count(*) as count FROM users');
  if (!userCount || userCount.count === 0) {
    const crypto = require('crypto');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync('admin123', salt, 64).toString('hex');
    const passHash = `${salt}:${hash}`;
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const userRes = await run(
      `INSERT INTO users (email, password_hash, display_name, email_verified_at, status, created_at, updated_at)
       VALUES ('admin@tradesage.ai', ?, 'Alex Mercer', ?, 'Active', ?, ?)`,
      [passHash, now, now, now]
    );
    const userId = userRes.lastID || 1;

    await run(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at)
       VALUES (1, ?, 'Workspace Owner', 'Active', ?)`,
      [userId, now]
    );

    // Seed default subscription
    const proPlan = await get('SELECT id FROM plans WHERE plan_key = ?', ['professional']);
    await run(
      `INSERT INTO subscriptions (workspace_id, plan_id, status, current_period_start, current_period_end, created_at)
       VALUES (1, ?, 'Active', ?, date(?, '+30 days'), ?)`,
      [proPlan?.id || 2, now, now, now]
    );

    // Seed sample task
    await run(
      `INSERT INTO tasks (workspace_id, agent_name, task_type, title, status, priority, input_json, result_json, steps_json, started_at, completed_at, created_at)
       VALUES (1, 'Roger (Executive Business Assistant)', 'content_generation', 'Formulate Q4 Traivo B2B Wholesale Outreach Strategy', 'Completed', 'High',
       '{"product":"traivo","channels":["B2B Direct Email","LinkedIn"]}', '{"campaign":"Active","replies_received":3}',
       '[{"step":"Identify wholesale distributors","status":"Done"},{"step":"Compose value proposition & van sales hooks","status":"Done"},{"step":"Track incoming client inquiries & replies","status":"Done"}]',
       ?, ?, ?)`,
      [now, now, now]
    );
  }

  // SEED B2B PURCHASING CLIENT INQUIRIES IF EMPTY
  const clientCount = await get('SELECT count(*) as count FROM b2b_clients');
  if (!clientCount || clientCount.count === 0) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const initialClients = [
      {
        company: 'Apex Wholesale Goods LLC',
        contact: 'Michael Chang (Director of Distribution)',
        email: 'm.chang@apexwholesale.com',
        phone: '+1 (555) 304-1928',
        product: 'Traivo - B2B Sales & Distribution Platform',
        inquiry: 'Need mobile order booking for 14 sales reps doing field van sales and warehouse delivery. Require barcode scanning and mobile invoice receipts.',
        dealValue: '$18,000/yr',
        status: 'Replied / Demo Requested'
      },
      {
        company: 'Horizon Beverage Distributors',
        contact: 'Lisa Ray (Operations Lead)',
        email: 'lisa@horizonbev.com',
        phone: '+1 (555) 781-9920',
        product: 'Traivo - B2B Sales & Distribution Platform',
        inquiry: 'Looking to replace handwritten order pads with a real-time digital catalog app for our 200+ beverage and snack SKUs.',
        dealValue: '$14,500/yr',
        status: 'Email Sent'
      },
      {
        company: 'Metro Central School District',
        contact: 'Dr. Robert Hastings (Fleet Director)',
        email: 'r.hastings@metroacademy.org',
        phone: '+1 (555) 832-1940',
        product: 'School Bus Management System (SaaS)',
        inquiry: 'Need live GPS tracking and RFID student check-in alerts for our fleet of 22 buses. School board has approved safety grant budget.',
        dealValue: '$24,000/yr',
        status: 'Replied / Demo Requested'
      },
      {
        company: 'Summit Freight & Logistics',
        contact: 'Marcus Vance (VP of Technology)',
        email: 'mvance@summitlog.com',
        phone: '+1 (555) 670-3310',
        product: 'Custom Web & Mobile Application Development',
        inquiry: 'Need custom dispatcher dashboard and iOS/Android driver manifest app connected to our central SQL database.',
        dealValue: '$32,000',
        status: 'New Inquiry'
      }
    ];

    for (const c of initialClients) {
      await run(
        `INSERT INTO b2b_clients (workspace_id, company_name, contact_name, email, phone, product_interest, inquiry_details, estimated_deal_value, status, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.company, c.contact, c.email, c.phone, c.product, c.inquiry, c.dealValue, c.status, now]
      );
    }
  }

  // SEED EMAIL CAMPAIGNS IF EMPTY
  const campaignCount = await get('SELECT count(*) as count FROM email_campaigns');
  if (!campaignCount || campaignCount.count === 0) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    await run(
      `INSERT INTO email_campaigns (workspace_id, name, product_key, subject, template_body, target_audience, sent_count, reply_count, status, created_at)
       VALUES (1, 'Traivo B2B Wholesale Acceleration Campaign', 'traivo',
       'Automate Field Sales & Wholesale Order Booking with Traivo',
       'Hi {{contact_name}},\n\nManaging field sales and van orders on paper or outdated spreadsheets slows down delivery and creates costly fulfillment errors.\n\nTraivo gives your field sales reps a lightning-fast mobile order app with real-time wholesale catalog access, customer-specific pricing, and instant invoice generation.\n\nWould you have 10 minutes this week for a quick live walkthrough for {{company_name}}?\n\nBest regards,\nRoger\nExecutive Team, TradeSage B2B',
       'Wholesale Distributors, FMCG & Van Sales Fleets', 48, 6, 'Active', ?)`,
      [now]
    );

    await run(
      `INSERT INTO email_campaigns (workspace_id, name, product_key, subject, template_body, target_audience, sent_count, reply_count, status, created_at)
       VALUES (1, 'Q4 School Bus Fleet Safety & Parent App Drive', 'school_bus',
       'Provide Parents Live GPS Bus Tracking & Student Boarding Alerts',
       'Dear {{contact_name}},\n\nStudent safety during daily commutes is a top priority for parents. Our School Bus Management System delivers instant RFID boarding SMS alerts and a parent mobile app with real-time arrival countdowns.\n\nWe would love to share a 15-minute school safety demonstration.\n\nSincerely,\nRoger\nTradeSage Safety Team',
       'Academy Administrators & School Fleet Directors', 35, 4, 'Active', ?)`,
      [now]
    );
  }

  // SEED CLIENT REPLIES IF EMPTY
  const replyCount = await get('SELECT count(*) as count FROM client_replies');
  if (!replyCount || replyCount.count === 0) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const initialReplies = [
      {
        customer_name: 'Michael Chang',
        customer_email: 'm.chang@apexwholesale.com',
        company_name: 'Apex Wholesale Goods LLC',
        reply_text: 'We watched the Traivo demonstration video. We have 14 sales reps in the field doing wholesale order booking and invoice printing. Can we schedule a demo call tomorrow at 2 PM?',
        sentiment: 'High Intent / Demo Booked',
        status: 'New'
      },
      {
        customer_name: 'Dr. Robert Hastings',
        customer_email: 'r.hastings@metroacademy.org',
        company_name: 'Metro Central School District',
        reply_text: 'Our school board reviewed the student RFID safety feature and approved funding for 22 buses. When can our transportation team test the parent mobile app and live dashboard?',
        sentiment: 'High Intent / Demo Booked',
        status: 'New'
      },
      {
        customer_name: 'Lisa Ray',
        customer_email: 'lisa@horizonbev.com',
        company_name: 'Horizon Beverage Distributors',
        reply_text: 'Could you clarify the pricing tier if our product catalog exceeds 200 SKUs? Also, does Traivo sync directly with our warehouse inventory database?',
        sentiment: 'Pricing & Tech Inquiry',
        status: 'Replied'
      }
    ];

    for (const r of initialReplies) {
      await run(
        `INSERT INTO client_replies (workspace_id, campaign_id, client_id, customer_name, customer_email, company_name, reply_text, sentiment, status, received_at)
         VALUES (1, 1, 1, ?, ?, ?, ?, ?, ?, ?)`,
        [r.customer_name, r.customer_email, r.company_name, r.reply_text, r.sentiment, r.status, now]
      );
    }
  }

  // SEED CONNECTED BUSINESSES (Owner Traivo + Client Businesses) IF EMPTY
  const bizCount = await get('SELECT count(*) as count FROM connected_businesses');
  if (!bizCount || bizCount.count === 0) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const initialBusinesses = [
      {
        business_type: 'owner',
        name: 'Traivo - B2B Sales & Distribution Platform',
        industry: 'B2B Wholesale & FMCG Distribution Software',
        website: 'https://traivo.ai',
        description: 'All-in-one mobile order booking, van sales invoicing, real-time inventory sync, and digital catalog app for FMCG, beverage, and wholesale distributors. Connected live to MySQL database thrivewoo (181 active products, 57 orders).',
        products_json: JSON.stringify([
          'Mobile Van Sales & Order Booking App',
          'Live Wholesale Catalog (181 SKUs Synced to MySQL thrivewoo)',
          'Bluetooth Thermal Receipt & Invoice Printing',
          'Real-time Warehouse Inventory Sync & Delivery Reconciliation'
        ]),
        target_audience: 'FMCG Distributors, Beverage Wholesalers, Food Distribution Fleets, Route Sales Managers'
      },
      {
        business_type: 'client',
        name: 'Metro Central School District',
        industry: 'Education & School Fleet Transportation',
        website: 'https://metroacademy.org',
        description: 'Public school district operating a fleet of 22 school buses with approved student safety grant funding.',
        products_json: JSON.stringify([
          'School Bus Fleet Management SaaS',
          'Sub-second Live GPS Tracking & Geofencing',
          'RFID Student Boarding Verification',
          'Parent Arrival Notification Mobile App',
          'Emergency SOS Driver Console'
        ]),
        target_audience: 'School Superintendents, Transportation Directors, School Boards, Safety Committees, Parents'
      },
      {
        business_type: 'client',
        name: 'Horizon Beverage Distributors',
        industry: 'Beverage & Snack Wholesale Distribution',
        website: 'https://horizonbev.com',
        description: 'Regional beverage distributor distributing 200+ beverage and snack SKUs across 12 delivery routes.',
        products_json: JSON.stringify([
          'Digital Beverage Order Catalog',
          'Retailer Self-Serve Restocking Portal',
          'Multi-Tier Wholesale Pricing Engine',
          'Delivery Route Batch Fulfillment'
        ]),
        target_audience: 'Convenience Stores, Supermarkets, Restaurants, Bar & Cafe Managers'
      },
      {
        business_type: 'client',
        name: 'Apex Wholesale Goods LLC',
        industry: 'General Wholesale Trade & Field Van Sales',
        website: 'https://apexwholesale.com',
        description: 'Wholesale distributor with 14 field sales reps taking orders across commercial territories.',
        products_json: JSON.stringify([
          'Field Order Booking App',
          'Mobile Receipt & Invoice Printing',
          'Barcode Scanning Order Terminal'
        ]),
        target_audience: 'Retail Store Owners, Wholesale Buyers, Bodega Operators'
      },
      {
        business_type: 'client',
        name: 'Summit Freight & Logistics',
        industry: 'Freight Logistics & Fleet Operations',
        website: 'https://summitlog.com',
        description: 'Regional freight carrier managing line-haul logistics, driver manifests, and proof-of-delivery.',
        products_json: JSON.stringify([
          'Central Dispatcher Operations Console',
          'Driver Mobile Manifest App',
          'Electronic Proof of Delivery (ePOD)'
        ]),
        target_audience: 'Commercial Shippers, 3PL Freight Brokers, Fleet Dispatchers'
      }
    ];

    for (const b of initialBusinesses) {
      await run(
        `INSERT INTO connected_businesses (workspace_id, business_type, name, industry, website, description, products_json, target_audience, status, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'Connected', ?)`,
        [b.business_type, b.name, b.industry, b.website, b.description, b.products_json, b.target_audience, now]
      );
    }
  }

  // SEED DIGITAL PRODUCTS IF EMPTY (ThriveWoo Flagship SaaS)
  const productCount = await get('SELECT count(*) as count FROM digital_products');
  if (!productCount || productCount.count === 0) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const initialDigitalProducts = [
      {
        name: 'ThriveWoo - Smart FMCG B2B Sales App',
        url: 'https://thrivewoo.com',
        tagline: 'Smart FMCG B2B Sales App — All-in-One Platform Built for Growth',
        description: 'Empower your sales team with ThriveWoo — the feature-rich B2B sales app built for FMCG and wholesale distribution. Track staff performance, uncover buying patterns, offer customer-specific discounts, and connect your sales force in real time.',
        features: [
          'Dashboard Status Overview: Track orders, estimates, bookings, drafts, and cancellations in one place',
          'Staff Performance Analysis: Category-wise targets, projections, and rep performance tracking',
          'Buying Pattern Analysis & Customer-Specific Discounts',
          'Real-Time In-App Team Communication & Messaging',
          'Visual Dashboards for Revenue, Collections, Frequently Bought Products & Order Status',
          'Bulk Customer Data Import via Excel Spreadsheets',
          'Customer Database & Order Lifecycle Tracking from Creation to Fulfillment'
        ],
        target_audience: 'FMCG Brands, Wholesale Distributors, Field Sales Fleets, Consumer Goods Manufacturers',
        pricing: []
      },
      {
        name: 'SafeTrack School Bus Management SaaS',
        url: 'https://safetrack-bus.io',
        tagline: 'Live GPS Telemetry, RFID Student Boarding & Dynamic Parent ETA Alerting',
        description: 'Autonomous school transportation intelligence software featuring sub-second bus GPS tracking, student RFID tap verification, parent ETA arrival countdowns, and automated route fuel optimization.',
        features: [
          'Sub-second Live GPS Fleet Tracking & Geofencing Alerts',
          'Student RFID Tap-On Boarding Verification & Instant Parent SMS',
          'Parent Companion Mobile App with Live Bus ETA Countdown',
          'AI Route Optimization Slashing Fleet Fuel Waste by 20%',
          'Central Safety Dashboard with Emergency SOS Telemetry'
        ],
        target_audience: 'School Districts, Academy Fleet Directors, Transportation Supervisors, School Boards',
        pricing: [
          { tier: 'Per Bus Fleet', price: '$18/bus/month', desc: 'Full GPS, RFID & Parent Mobile App' },
          { tier: 'District License', price: '$499/mo', desc: 'Unlimited fleet size, custom school branding & SLA' }
        ]
      },
      {
        name: 'TradeSage AI Marketing & Executive Voice OS',
        url: 'https://tradesage.ai',
        tagline: 'Autonomous AI Telephony, Lead Qualification, Visual Email Outreach & Campaign Engine',
        description: 'Executive AI operating system combining Telnyx inbound voice receptionists, intelligent lead qualification scoring, visual HTML outreach emails, and human-in-the-loop approved draft automations.',
        features: [
          'Telnyx Real-Time Autonomous Voice Receptionist & Lead Qualifier',
          'AI Lead Scoring (0-100) & Actionable Categorization (Hot/Warm/Cold)',
          'Visual HTML Outreach Email Dispatcher with Real Page Rendering',
          'Multi-Tone AI Email Drafts with Safe User Approval Safeguards',
          'Multi-Provider LLM Integration (Telnyx Fast Llama 3.1, Groq, Gemini)'
        ],
        target_audience: 'B2B Sales Teams, SaaS Founders, Digital Marketing Agencies, Commercial Operations',
        pricing: [
          { tier: 'Professional', price: '$49/mo', desc: '5,000 AI credits, 150 phone mins, full CRM' },
          { tier: 'Business', price: '$99/mo', desc: '15,000 AI credits, unlimited campaigns & Telnyx numbers' },
          { tier: 'White-Label Agency', price: '$199/mo', desc: 'Reseller portal, custom domain & voice models' }
        ]
      }
    ];

    for (const p of initialDigitalProducts) {
      await run(
        `INSERT INTO digital_products (workspace_id, name, url, tagline, description, features_json, target_audience, pricing_tiers_json, status, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'Active', ?)`,
        [
          p.name,
          p.url,
          p.tagline,
          p.description,
          JSON.stringify(p.features),
          p.target_audience,
          JSON.stringify(p.pricing),
          now
        ]
      );
    }
  }

  // SEED SAMPLE DRAFTS IF EMPTY
  const draftCount = await get('SELECT count(*) as count FROM email_drafts');
  if (!draftCount || draftCount.count === 0) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const sampleHtml = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.06);">
  <div style="background: linear-gradient(135deg, #0ea5e9 0%, #3b82f6 100%); padding: 32px 28px; text-align: center; color: #ffffff;">
    <h1 style="margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">ThriveWoo B2B Platform</h1>
    <p style="margin: 8px 0 0; font-size: 14px; opacity: 0.95;">Wholesale Ordering & Mobile Field Sales for WooCommerce</p>
  </div>
  <div style="padding: 32px 28px; color: #1e293b; line-height: 1.6;">
    <p style="font-size: 16px; margin-top: 0;">Hi Michael,</p>
    <p style="font-size: 15px; color: #475569;">Managing wholesale orders and van deliveries manually slows down your distribution and creates costly fulfillment discrepancies.</p>
    <div style="background: #f8fafc; border-left: 4px solid #0ea5e9; padding: 16px; margin: 20px 0; border-radius: 4px;">
      <strong style="color: #0f172a; font-size: 14px;">With ThriveWoo, your team unlocks:</strong>
      <ul style="margin: 8px 0 0; padding-left: 20px; font-size: 14px; color: #334155;">
        <li>Mobile field sales order booking app for field reps</li>
        <li>Customer-tier wholesale pricing & bulk volume matrix</li>
        <li>Multi-warehouse live inventory sync & automated invoice PDF generation</li>
      </ul>
    </div>
    <p style="font-size: 15px; color: #475569;">Would you have 10 minutes this Thursday for a live demonstration tailored for Apex Wholesale Goods?</p>
    <div style="text-align: center; margin: 28px 0;">
      <a href="https://thrivewoo.com" style="background: #0ea5e9; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block;">Schedule 15-Min Live Demo &rarr;</a>
    </div>
    <p style="font-size: 13px; color: #64748b; margin-bottom: 0;">Best regards,<br><strong style="color: #0f172a;">Executive Team</strong><br>ThriveWoo Operations</p>
  </div>
</div>`;

    await run(
      `INSERT INTO email_drafts (workspace_id, product_id, product_name, recipient_email, recipient_name, subject, body_html, body_text, tone, status, created_at, updated_at)
       VALUES (1, 1, 'ThriveWoo B2B Wholesale Platform', 'm.chang@apexwholesale.com', 'Michael Chang', 'Accelerate Field Sales & Wholesale Ordering with ThriveWoo', ?, 'Hi Michael, managing wholesale orders manually slows down distribution. With ThriveWoo, your team gets mobile field sales, customer tier pricing, and live inventory sync.', 'Professional', 'Draft', ?, ?)`,
      [sampleHtml, now, now]
    );
  }

  // SEED MAIL CONFIGURATION IF EMPTY
  const mailConfigCount = await get('SELECT count(*) as count FROM mail_configurations WHERE workspace_id = 1');
  if (!mailConfigCount || mailConfigCount.count === 0) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    await run(`
      INSERT INTO mail_configurations (
        workspace_id, provider, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass,
        imap_host, imap_port, imap_tls, imap_user, imap_pass,
        sender_name, sender_email, status, created_at, updated_at
      ) VALUES (
        1, 'custom_smtp', 'smtp.gmail.com', 587, 0, '', '',
        'imap.gmail.com', 993, 1, '', '',
        'Executive Team', 'info@example.com', 'Not Configured', ?, ?
      )
    `, [now, now]);
  }

  console.log('TradeSage B2B Assistant Database initialized and seeded successfully.');
}

// MySQL Live Integration Helper for Traivo (thrivewoo)
let traivoPool = null;
function getTraivoPool() {
  if (!traivoPool) {
    try {
      const mysql = require('mysql2/promise');
      traivoPool = mysql.createPool({
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        password: '',
        database: 'thrivewoo',
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0
      });
    } catch (e) {
      console.warn('MySQL pool initialization warning:', e.message);
    }
  }
  return traivoPool;
}

async function queryTraivoMySQL() {
  try {
    const pool = getTraivoPool();
    if (!pool) return { connected: false, message: 'MySQL driver unavailable', totalProducts: 181, totalOrders: 57 };
    const [productsCount] = await pool.query('SELECT count(*) as count FROM products');
    const [ordersCount] = await pool.query('SELECT count(*) as count FROM sales_orders');
    const [sampleProducts] = await pool.query('SELECT id, name, category_id, base_sell_price FROM products LIMIT 6');
    return {
      connected: true,
      database: 'thrivewoo',
      totalProducts: productsCount[0]?.count || 181,
      totalOrders: ordersCount[0]?.count || 57,
      sampleProducts: sampleProducts || []
    };
  } catch (err) {
    return {
      connected: false,
      database: 'thrivewoo',
      error: err.message,
      totalProducts: 181,
      totalOrders: 57,
      sampleProducts: [
        { id: 1, name: 'Traivo Wholesale B2B SKU #101', base_sell_price: '45.00' },
        { id: 2, name: 'Traivo Bulk Distribution Case #204', base_sell_price: '120.00' }
      ]
    };
  }
}

module.exports = {
  db: sqliteDb,
  sqliteDb,
  mysqlPool,
  run,
  get,
  all,
  initDatabase,
  queryTraivoMySQL
};
