/**
 * TradeSage AI - MySQL Database Migration & Seeder
 * Creates the database, all 26 schema tables with MySQL syntax, and seeds initial data.
 * Run directly via: node backend/seed.js or npm run seed
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const mysql = require('mysql2/promise');

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'tradesage';

async function seedMySQL() {
  console.log('====================================================');
  console.log('🚀 Marketech.ai - MySQL Database Migration & Seeder');
  console.log(`Connecting to MySQL at ${DB_HOST}:${DB_PORT} as ${DB_USER}...`);
  console.log('====================================================');

  // Step 1: Connect to server without database and create database if not exists
  let serverConn;
  try {
    serverConn = await mysql.createConnection({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD
    });
    console.log(`✓ Connected to MySQL server successfully.`);
    await serverConn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`✓ Database '${DB_NAME}' created or verified.`);
    await serverConn.end();
  } catch (err) {
    console.error(`❌ Failed to connect to MySQL server:`, err.message);
    process.exit(1);
  }

  // Step 2: Connect to specific database
  const pool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
  });

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  console.log('\n--- CREATING TABLES ---');

  const tables = [
    // 1. workspaces
    `CREATE TABLE IF NOT EXISTS workspaces (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(191) UNIQUE NOT NULL,
      owner_email VARCHAR(255) NOT NULL,
      plan VARCHAR(100) DEFAULT 'Starter',
      status VARCHAR(50) DEFAULT 'Active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 2. users
    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(191) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      email_verified_at DATETIME NULL,
      status VARCHAR(50) DEFAULT 'Active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 3. workspace_members
    `CREATE TABLE IF NOT EXISTS workspace_members (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      user_id INT NOT NULL,
      role VARCHAR(100) DEFAULT 'Workspace Owner',
      status VARCHAR(50) DEFAULT 'Active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 4. agents
    `CREATE TABLE IF NOT EXISTS agents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT DEFAULT 1,
      agent_key VARCHAR(100) NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      agent_type VARCHAR(50) DEFAULT 'specialist',
      system_instructions TEXT,
      tools_json LONGTEXT,
      avatar_emoji VARCHAR(20) DEFAULT '🤖',
      status VARCHAR(50) DEFAULT 'Active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 5. conversations
    `CREATE TABLE IF NOT EXISTS conversations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      user_id INT NULL,
      agent_id INT NULL,
      title VARCHAR(255) NOT NULL,
      channel VARCHAR(50) DEFAULT 'web_chat',
      status VARCHAR(50) DEFAULT 'Active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 6. conversation_messages
    `CREATE TABLE IF NOT EXISTS conversation_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      conversation_id INT NOT NULL,
      role VARCHAR(50) NOT NULL,
      content_text LONGTEXT NOT NULL,
      tokens_used INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 7. tasks
    `CREATE TABLE IF NOT EXISTS tasks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL DEFAULT 1,
      conversation_id INT NULL,
      user_id INT NULL,
      agent_id INT NULL,
      agent_name VARCHAR(255) NULL,
      task_type VARCHAR(100) NOT NULL DEFAULT 'ai_delegation',
      title VARCHAR(255) NOT NULL,
      description TEXT NULL,
      status VARCHAR(50) DEFAULT 'Completed',
      priority VARCHAR(50) DEFAULT 'Normal',
      input_json LONGTEXT NULL,
      result_json LONGTEXT NULL,
      steps_json LONGTEXT NULL,
      due_date DATETIME NULL,
      result_summary TEXT NULL,
      started_at DATETIME NULL,
      completed_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 8. task_steps
    `CREATE TABLE IF NOT EXISTS task_steps (
      id INT AUTO_INCREMENT PRIMARY KEY,
      task_id INT NOT NULL,
      step_index INT NOT NULL,
      title VARCHAR(255) NOT NULL,
      status VARCHAR(50) DEFAULT 'Pending',
      output_log TEXT,
      started_at DATETIME NULL,
      finished_at DATETIME NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 9. plans
    `CREATE TABLE IF NOT EXISTS plans (
      id INT AUTO_INCREMENT PRIMARY KEY,
      plan_key VARCHAR(100) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      price_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      monthly_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      currency VARCHAR(10) DEFAULT 'USD',
      billing_interval VARCHAR(50) DEFAULT 'monthly',
      credits_allowance INT DEFAULT 1000,
      video_minutes INT DEFAULT 10,
      phone_minutes INT DEFAULT 50,
      features_json LONGTEXT,
      max_users INT DEFAULT 1,
      max_ai_tokens_monthly INT DEFAULT 100000,
      max_phone_minutes_monthly INT DEFAULT 60,
      active TINYINT DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 10. subscriptions
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      plan_id INT NOT NULL,
      status VARCHAR(50) DEFAULT 'Active',
      current_period_start DATETIME NULL,
      current_period_end DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 11. business_profiles
    `CREATE TABLE IF NOT EXISTS business_profiles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      business_name VARCHAR(255) NOT NULL,
      industry VARCHAR(150),
      website_url VARCHAR(255),
      description TEXT,
      products_json LONGTEXT,
      brand_voice VARCHAR(255) DEFAULT 'Professional, innovative, and authoritative',
      brand_colors_json TEXT,
      logo_url VARCHAR(255),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 12. leads
    `CREATE TABLE IF NOT EXISTS leads (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT DEFAULT 1,
      name VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      email VARCHAR(255),
      product_interest VARCHAR(255),
      company_name VARCHAR(255),
      estimated_budget VARCHAR(100),
      notes TEXT,
      status VARCHAR(50) DEFAULT 'New',
      ai_score INT DEFAULT 0,
      ai_category VARCHAR(50) DEFAULT 'Cold',
      ai_suggestion TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 13. appointments
    `CREATE TABLE IF NOT EXISTS appointments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT DEFAULT 1,
      customer_name VARCHAR(255) NULL,
      contact_name VARCHAR(255) NULL,
      phone VARCHAR(50) NULL,
      service VARCHAR(255) NULL,
      service_requested VARCHAR(255) NULL,
      date VARCHAR(100) NULL,
      time VARCHAR(100) NULL,
      appointment_time VARCHAR(100) NULL,
      status VARCHAR(50) DEFAULT 'Confirmed',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 14. campaigns
    `CREATE TABLE IF NOT EXISTS campaigns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL DEFAULT 1,
      name VARCHAR(255) NOT NULL,
      objective VARCHAR(255) NULL,
      campaign_type VARCHAR(100) DEFAULT 'Omnichannel Growth',
      channels VARCHAR(255) DEFAULT 'Instagram, LinkedIn, Facebook',
      brief_text TEXT NULL,
      status VARCHAR(50) DEFAULT 'Active',
      target_audience TEXT,
      target_leads_count INT DEFAULT 0,
      budget DECIMAL(10,2) DEFAULT 0.00,
      scheduled_at DATETIME NULL,
      completed_at DATETIME NULL,
      results_json LONGTEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 15. content_items
    `CREATE TABLE IF NOT EXISTS content_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL DEFAULT 1,
      campaign_id INT NULL,
      title VARCHAR(255) NULL,
      platform VARCHAR(50) DEFAULT 'All',
      content_type VARCHAR(50) DEFAULT 'post',
      caption_text TEXT NULL,
      hashtags TEXT NULL,
      call_to_action TEXT NULL,
      media_url VARCHAR(255) NULL,
      body_text LONGTEXT NULL,
      media_urls_json LONGTEXT NULL,
      status VARCHAR(50) DEFAULT 'Draft',
      scheduled_at DATETIME NULL,
      published_at DATETIME NULL,
      engagement_metrics_json LONGTEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 16. video_jobs
    `CREATE TABLE IF NOT EXISTS video_jobs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      campaign_id INT NULL,
      title VARCHAR(255) NOT NULL,
      prompt_script TEXT NOT NULL,
      style_preset VARCHAR(100) DEFAULT 'Photorealistic Executive',
      aspect_ratio VARCHAR(20) DEFAULT '16:9',
      status VARCHAR(50) DEFAULT 'Queued',
      video_url VARCHAR(255),
      duration_seconds INT DEFAULT 15,
      cost_usd DECIMAL(10,4) DEFAULT 0.0000,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 17. phone_numbers
    `CREATE TABLE IF NOT EXISTS phone_numbers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      phone_number VARCHAR(50) UNIQUE NOT NULL,
      friendly_name VARCHAR(150),
      country_code VARCHAR(10) DEFAULT 'US',
      provider VARCHAR(50) DEFAULT 'telnyx',
      assigned_agent_id INT NULL,
      webhook_url VARCHAR(255),
      monthly_cost_usd DECIMAL(10,2) DEFAULT 1.00,
      status VARCHAR(50) DEFAULT 'Active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 18. call_records
    `CREATE TABLE IF NOT EXISTS call_records (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      phone_number_id INT NULL,
      agent_id INT NULL,
      caller_number VARCHAR(50) NOT NULL,
      caller_name VARCHAR(150),
      direction VARCHAR(20) DEFAULT 'inbound',
      duration_seconds INT DEFAULT 0,
      status VARCHAR(50) DEFAULT 'Completed',
      call_recording_url VARCHAR(255),
      transcript_text LONGTEXT,
      sentiment VARCHAR(50) DEFAULT 'Neutral',
      ai_summary TEXT,
      cost_usd DECIMAL(10,4) DEFAULT 0.0000,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 19. usage_ledger
    `CREATE TABLE IF NOT EXISTS usage_ledger (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT NOT NULL,
      category VARCHAR(100) NOT NULL DEFAULT 'general',
      quantity DECIMAL(10,2) NOT NULL DEFAULT 1.00,
      unit VARCHAR(50) DEFAULT 'unit',
      estimated_cost DECIMAL(10,4) NOT NULL DEFAULT 0.0000,
      metric_type VARCHAR(100) NULL,
      units_consumed DECIMAL(10,2) NULL,
      cost_usd DECIMAL(10,4) NULL,
      reference_type VARCHAR(100),
      reference_id INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 20. b2b_clients
    `CREATE TABLE IF NOT EXISTS b2b_clients (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT DEFAULT 1,
      company_name VARCHAR(255) NOT NULL,
      contact_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(50),
      product_interest VARCHAR(255) NOT NULL,
      inquiry_details TEXT,
      estimated_deal_value VARCHAR(100) DEFAULT '$15,000',
      lead_score INT DEFAULT 50,
      status VARCHAR(50) DEFAULT 'New Inquiry',
      last_contact DATETIME DEFAULT CURRENT_TIMESTAMP,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 21. email_campaigns
    `CREATE TABLE IF NOT EXISTS email_campaigns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT DEFAULT 1,
      name VARCHAR(255) NOT NULL,
      campaign_name VARCHAR(255) NULL,
      product_key VARCHAR(100) DEFAULT 'thrivewoo',
      target_audience VARCHAR(255) NOT NULL,
      template_id VARCHAR(100) DEFAULT 'executive_intro',
      template_body LONGTEXT NULL,
      subject VARCHAR(255) NOT NULL,
      sent_count INT DEFAULT 0,
      reply_count INT DEFAULT 0,
      open_rate DECIMAL(5,2) DEFAULT 0.00,
      reply_rate DECIMAL(5,2) DEFAULT 0.00,
      status VARCHAR(50) DEFAULT 'Active',
      scheduled_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 22. emails
    `CREATE TABLE IF NOT EXISTS emails (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT DEFAULT 1,
      campaign_id INT NULL,
      client_id INT NULL,
      sender VARCHAR(255),
      sender_email VARCHAR(255),
      recipient_email VARCHAR(255) NOT NULL,
      recipient_name VARCHAR(255),
      subject VARCHAR(255) NOT NULL,
      body LONGTEXT NULL,
      snippet TEXT NULL,
      html_body LONGTEXT NULL,
      ai_summary TEXT,
      ai_priority VARCHAR(50) DEFAULT 'Normal',
      ai_replies_json TEXT,
      status VARCHAR(50) DEFAULT 'Sent',
      sent_at DATETIME NULL,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_read TINYINT DEFAULT 0,
      is_urgent TINYINT DEFAULT 0,
      message_id VARCHAR(255) NULL,
      smtp_status VARCHAR(50) DEFAULT 'Delivered'
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 23. client_replies
    `CREATE TABLE IF NOT EXISTS client_replies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT DEFAULT 1,
      campaign_id INT NULL,
      client_id INT NULL,
      customer_name VARCHAR(255) NOT NULL,
      customer_email VARCHAR(255) NULL,
      company_name VARCHAR(255) NOT NULL,
      reply_text TEXT NOT NULL,
      sentiment VARCHAR(50) DEFAULT 'Positive',
      status VARCHAR(50) DEFAULT 'New',
      date VARCHAR(50),
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 24. connected_businesses
    `CREATE TABLE IF NOT EXISTS connected_businesses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT DEFAULT 1,
      name VARCHAR(255) NOT NULL,
      industry VARCHAR(150),
      business_type VARCHAR(50) DEFAULT 'client',
      website VARCHAR(255) NULL,
      description TEXT,
      products_json LONGTEXT,
      target_audience TEXT,
      status VARCHAR(50) DEFAULT 'Connected',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 25. digital_products (ThriveWoo Flagship & User Products with real features, NO pricing)
    `CREATE TABLE IF NOT EXISTS digital_products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT DEFAULT 1,
      name VARCHAR(255) NOT NULL,
      url VARCHAR(255) NOT NULL,
      tagline VARCHAR(255),
      description TEXT,
      features_json LONGTEXT,
      target_audience TEXT,
      pricing_tiers_json LONGTEXT,
      status VARCHAR(50) DEFAULT 'Active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 26. email_drafts
    `CREATE TABLE IF NOT EXISTS email_drafts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT DEFAULT 1,
      product_id INT NULL,
      lead_id INT NULL,
      product_name VARCHAR(255) NULL,
      recipient_name VARCHAR(255) NOT NULL,
      recipient_email VARCHAR(255) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      body LONGTEXT NULL,
      body_html LONGTEXT NULL,
      body_text LONGTEXT NULL,
      tone VARCHAR(100) DEFAULT 'Professional',
      angle VARCHAR(150),
      status VARCHAR(50) DEFAULT 'Draft',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // 27. mail_configurations
    `CREATE TABLE IF NOT EXISTS mail_configurations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workspace_id INT DEFAULT 1 UNIQUE,
      provider VARCHAR(100) DEFAULT 'custom_smtp',
      smtp_host VARCHAR(255),
      smtp_port INT DEFAULT 587,
      smtp_secure TINYINT DEFAULT 0,
      smtp_user VARCHAR(255),
      smtp_pass VARCHAR(255),
      imap_host VARCHAR(255),
      imap_port INT DEFAULT 993,
      imap_tls TINYINT DEFAULT 1,
      imap_user VARCHAR(255),
      imap_pass VARCHAR(255),
      sender_name VARCHAR(255) DEFAULT 'TradeSage Executive Team',
      sender_email VARCHAR(255) DEFAULT 'outreach@tradesage.ai',
      status VARCHAR(50) DEFAULT 'Active',
      last_synced_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  ];

  for (const sql of tables) {
    try {
      await pool.query(sql);
      const match = sql.match(/CREATE TABLE IF NOT EXISTS ([a-z0-9_]+)/i);
      if (match) console.log(`✓ Table '${match[1]}' created or ready.`);
    } catch (e) {
      console.error(`Error creating table:`, e.message);
    }
  }

  console.log('\n--- VERIFYING & SYNCHRONIZING SCHEMA COLUMNS ---');
  // Helper to ensure all required columns exist even on existing database tables
  async function ensureColumn(tableName, columnName, columnDef) {
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [DB_NAME, tableName, columnName]
    );
    if (cols.length === 0) {
      await pool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${columnDef}`);
      console.log(`✓ Added column '${columnName}' to '${tableName}'.`);
    }
  }

  // Schema synchronization for all endpoints
  await ensureColumn('tasks', 'conversation_id', 'INT NULL');
  await ensureColumn('tasks', 'agent_name', 'VARCHAR(255) NULL');
  await ensureColumn('tasks', 'task_type', "VARCHAR(100) NOT NULL DEFAULT 'ai_delegation'");
  await ensureColumn('tasks', 'input_json', 'LONGTEXT NULL');
  await ensureColumn('tasks', 'result_json', 'LONGTEXT NULL');
  await ensureColumn('tasks', 'steps_json', 'LONGTEXT NULL');
  await ensureColumn('tasks', 'started_at', 'DATETIME NULL');

  await ensureColumn('appointments', 'customer_name', 'VARCHAR(255) NULL');
  await ensureColumn('appointments', 'service', 'VARCHAR(255) NULL');
  await ensureColumn('appointments', 'date', 'VARCHAR(100) NULL');
  await ensureColumn('appointments', 'time', 'VARCHAR(100) NULL');

  await ensureColumn('email_drafts', 'product_name', 'VARCHAR(255) NULL');
  await ensureColumn('email_drafts', 'body_html', 'LONGTEXT NULL');
  await ensureColumn('email_drafts', 'body_text', 'LONGTEXT NULL');
  await ensureColumn('email_drafts', 'tone', "VARCHAR(100) DEFAULT 'Professional'");

  await ensureColumn('b2b_clients', 'inquiry_details', 'TEXT NULL');
  await ensureColumn('b2b_clients', 'estimated_deal_value', "VARCHAR(100) DEFAULT '$15,000'");

  await ensureColumn('email_campaigns', 'name', 'VARCHAR(255) NULL');
  await ensureColumn('email_campaigns', 'product_key', "VARCHAR(100) DEFAULT 'thrivewoo'");
  await ensureColumn('email_campaigns', 'template_body', 'LONGTEXT NULL');
  await ensureColumn('email_campaigns', 'reply_count', 'INT DEFAULT 0');

  await ensureColumn('emails', 'snippet', 'TEXT NULL');

  await ensureColumn('connected_businesses', 'website', 'VARCHAR(255) NULL');
  await ensureColumn('connected_businesses', 'target_audience', 'TEXT NULL');
  await ensureColumn('connected_businesses', 'status', "VARCHAR(50) DEFAULT 'Connected'");

  await ensureColumn('campaigns', 'objective', 'VARCHAR(255) NULL');
  await ensureColumn('campaigns', 'channels', "VARCHAR(255) DEFAULT 'Instagram, LinkedIn, Facebook'");
  await ensureColumn('campaigns', 'brief_text', 'TEXT NULL');

  await ensureColumn('content_items', 'caption_text', 'TEXT NULL');
  await ensureColumn('content_items', 'hashtags', 'TEXT NULL');
  await ensureColumn('content_items', 'call_to_action', 'TEXT NULL');
  await ensureColumn('content_items', 'media_url', 'VARCHAR(255) NULL');

  await ensureColumn('plans', 'price_amount', 'DECIMAL(10,2) DEFAULT 0.00');
  await ensureColumn('plans', 'currency', "VARCHAR(10) DEFAULT 'USD'");
  await ensureColumn('plans', 'billing_interval', "VARCHAR(50) DEFAULT 'monthly'");
  await ensureColumn('plans', 'credits_allowance', 'INT DEFAULT 1000');
  await ensureColumn('plans', 'video_minutes', 'INT DEFAULT 10');
  await ensureColumn('plans', 'phone_minutes', 'INT DEFAULT 50');
  await ensureColumn('plans', 'features_json', 'LONGTEXT NULL');

  await ensureColumn('client_replies', 'campaign_id', 'INT NULL');
  await ensureColumn('client_replies', 'customer_email', 'VARCHAR(255) NULL');

  await ensureColumn('usage_ledger', 'category', "VARCHAR(100) NOT NULL DEFAULT 'general'");
  await ensureColumn('usage_ledger', 'quantity', "DECIMAL(10,2) NOT NULL DEFAULT 1.00");
  await ensureColumn('usage_ledger', 'unit', "VARCHAR(50) NOT NULL DEFAULT 'unit'");
  await ensureColumn('usage_ledger', 'estimated_cost', "DECIMAL(10,4) NOT NULL DEFAULT 0.0000");
  await ensureColumn('usage_ledger', 'created_at', "DATETIME DEFAULT CURRENT_TIMESTAMP");

  await ensureColumn('email_drafts', 'html_body', 'LONGTEXT NULL');
  await ensureColumn('email_drafts', 'body_html', 'LONGTEXT NULL');

  console.log('\n--- SEEDING FOUNDATIONAL RECORDS ---');

  // Seed Helper: Only insert if table is empty
  async function seedIfEmpty(tableName, insertSql, rows) {
    const [countResult] = await pool.query(`SELECT COUNT(*) as count FROM \`${tableName}\``);
    const count = countResult[0]?.count || 0;
    if (count === 0) {
      for (const r of rows) {
        await pool.query(insertSql, r);
      }
      console.log(`✓ Seeded ${rows.length} rows into '${tableName}'.`);
    } else {
      console.log(`ℹ Table '${tableName}' already contains ${count} rows (skipped).`);
    }
  }

  // 1. Workspaces
  await seedIfEmpty(
    'workspaces',
    'INSERT INTO workspaces (id, name, slug, owner_email, plan, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [[1, 'Executive HQ', 'executive-hq', 'founder@tradesage.ai', 'Enterprise', 'Active', now]]
  );

  // 2. Users
  await seedIfEmpty(
    'users',
    'INSERT INTO users (id, email, password_hash, display_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [[1, 'admin@tradesage.ai', '$2a$10$hashedPasswordPlaceholderForLocalDevOnly', 'Executive Admin', 'Active', now]]
  );

  // 3. Workspace Members
  await seedIfEmpty(
    'workspace_members',
    'INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at) VALUES (?, ?, ?, ?, ?)',
    [[1, 1, 'Workspace Owner', 'Active', now]]
  );

  // 4. Agents (Mark Executive AI Assistant)
  await seedIfEmpty(
    'agents',
    'INSERT INTO agents (workspace_id, agent_key, name, description, agent_type, system_instructions, avatar_emoji, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [[
      1,
      'executive_assistant',
      'Mark',
      'Personal AI Executive Business Assistant & Marketing Strategist',
      'executive',
      'You are Mark, personal executive AI assistant for B2B growth and marketing.',
      '🎙️',
      'Active',
      now
    ]]
  );

  // 5. Digital Products (ThriveWoo with Real FMCG features, NO pricing)
  const thriveWooRealFeatures = JSON.stringify([
    'Dashboard Status Overview: Track orders, estimates, bookings, drafts, and cancellations in one place',
    'Staff Performance Analysis: Category-wise targets, projections, and rep performance tracking',
    'Buying Pattern Analysis & Customer-Specific Discounts',
    'Real-Time In-App Team Communication & Messaging',
    'Visual Dashboards for Revenue, Collections, Frequently Bought Products & Order Status',
    'Bulk Customer Data Import via Excel Spreadsheets',
    'Customer Database & Order Lifecycle Tracking from Creation to Fulfillment'
  ]);

  const safeTrackFeatures = JSON.stringify([
    'Sub-second Live GPS Fleet Tracking & Geofencing Alerts',
    'Student RFID Tap-On Boarding Verification & Instant Parent SMS',
    'Parent Companion Mobile App with Live Bus ETA Countdown',
    'AI Route Optimization Slashing Fleet Fuel Waste by 20%',
    'Central Safety Dashboard with Emergency SOS Telemetry'
  ]);

  await seedIfEmpty(
    'digital_products',
    'INSERT INTO digital_products (id, workspace_id, name, url, tagline, description, features_json, target_audience, pricing_tiers_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      [
        1,
        1,
        'ThriveWoo - Smart FMCG B2B Sales App',
        'https://thrivewoo.com',
        'Smart FMCG B2B Sales App — All-in-One Platform Built for Growth',
        'Empower your sales team with ThriveWoo — the feature-rich B2B sales app built for FMCG and wholesale distribution. Track staff performance, uncover buying patterns, offer customer-specific discounts, and connect your sales force in real time.',
        thriveWooRealFeatures,
        'FMCG Brands, Wholesale Distributors, Field Sales Fleets, Consumer Goods Manufacturers',
        '[]',
        'Active',
        now
      ],
      [
        2,
        1,
        'SafeTrack School Bus Management SaaS',
        'https://safetrack-bus.io',
        'Live GPS Telemetry, RFID Student Boarding & Dynamic Parent ETA Alerting',
        'Autonomous school transportation intelligence software featuring sub-second bus GPS tracking, student RFID tap verification, and parent ETA arrival countdowns.',
        safeTrackFeatures,
        'School Districts, Academy Fleet Directors, Transportation Supervisors, School Boards',
        '[]',
        'Active',
        now
      ]
    ]
  );

  // 6. Connected Businesses
  await seedIfEmpty(
    'connected_businesses',
    'INSERT INTO connected_businesses (id, workspace_id, name, industry, business_type, description, products_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      [1, 1, 'ThriveWoo B2B Platform', 'FMCG & Wholesale Commerce', 'owner', 'My flagship digital product for field sales ordering and customer pricing.', JSON.stringify(['Mobile Van Sales App', 'Live Stock Sync', 'Bulk Customer Import']), now],
      [2, 1, 'Metro Central School District', 'Education & Student Transit', 'client', 'Regional school transit department managing 22 daily bus routes.', JSON.stringify(['School Bus Tracking', 'Parent Arrival Alerts']), now],
      [3, 1, 'Horizon Beverage Distributors', 'Food & Beverage Wholesale', 'client', 'Regional cold beverage distributor with 200+ fast-moving SKU catalog.', JSON.stringify(['Beverage Restocking Portal', 'Case Volume Pricing']), now],
      [4, 1, 'Apex Wholesale Goods', 'Commercial Goods & Sundries', 'client', 'Regional wholesale distributor with 14 field sales reps taking daily orders.', JSON.stringify(['Rep Order Booking', 'Warehouse Sync']), now],
      [5, 1, 'Summit Freight & Logistics', 'Transportation & Cold Chain', 'client', 'Multi-axle refrigerated freight carrier servicing regional distribution centers.', JSON.stringify(['ePOD Driver Manifest', 'Dispatch Telemetry']), now]
    ]
  );

  // 7. Leads CRM
  await seedIfEmpty(
    'leads',
    'INSERT INTO leads (workspace_id, name, phone, email, product_interest, company_name, estimated_budget, notes, status, ai_score, ai_category, ai_suggestion, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      [1, 'Elena Rostova', '+61 411 902 341', 'elena.rostova@metrotrade.com.au', 'ThriveWoo FMCG Sales App', 'Metro Trade Wholesale', '$28,000', 'Requested demo of van sales and staff target tracking for 18 reps.', 'New', 98, 'Hot', 'Dispatch immediate VIP Demo invite and video walkthrough.', now],
      [1, 'Marcus Vance', '+1 (415) 890-2134', 'marcus.v@summitdist.com', 'ThriveWoo Customer Discounts', 'Summit Distribution Fleets', '$15,000', 'Wants to replace paper order books with mobile ordering.', 'Qualified', 88, 'Hot', 'Follow up with customer discount tier documentation.', now],
      [1, 'Sarah Jenkins', '+1 (312) 445-9801', 'sjenkins@midwestbeverage.com', 'ThriveWoo Bulk Excel Import', 'Midwest Beverage Hub', '$12,000', 'Needs bulk Excel customer onboarding for 400 wholesale accounts.', 'Demo Scheduled', 82, 'Warm', 'Confirm live screen demo of Excel customer upload.', now],
      [1, 'David Kalu', '+44 20 7946 0912', 'd.kalu@britannialogistics.co.uk', 'SafeTrack RFID Tracking', 'Britannia Academy Transit', '$35,000', 'Auditing parent mobile app and sub-second GPS telemetry.', 'New', 94, 'Hot', 'Offer 14-day live route pilot for 3 school buses.', now],
      [1, 'Chloe Bennett', '+61 2 9876 5432', 'c.bennett@pacificoast.com.au', 'ThriveWoo Order Status Dashboard', 'Pacific Coast Foods', '$9,500', 'Tracking bookings, drafts, and cancellations across 3 warehouses.', 'Contacted', 72, 'Warm', 'Send executive PDF overview of dashboard metrics.', now]
    ]
  );

  // 8. B2B Purchasing Clients
  await seedIfEmpty(
    'b2b_clients',
    'INSERT INTO b2b_clients (workspace_id, company_name, contact_name, email, phone, product_interest, lead_score, status, last_contact, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      [1, 'Metro Central School District', 'Dr. Arthur Hastings', 'hastings@metrodistrict.edu', '+1 (555) 349-1102', 'SafeTrack 22-Bus License', 95, 'Demo Scheduled', now, 'State funding approved for student RFID safety.', now],
      [1, 'Horizon Beverage Distributors', 'Lisa Raymond', 'lisa.r@horizonbeverage.com', '+1 (555) 782-9014', 'ThriveWoo 200+ SKU Catalog Sync', 90, 'Proposal Sent', now, 'Ready to automate route sales order entry.', now],
      [1, 'Apex Wholesale Goods', 'Michael Chang', 'mchang@apexwholesale.com', '+1 (555) 902-8311', 'ThriveWoo 14 Sales Rep Licenses', 92, 'Hot Prospect', now, 'Wants Bluetooth invoice printing for van sales reps.', now],
      [1, 'Summit Freight & Logistics', 'Vance Sterling', 'vance@summitfreight.com', '+1 (555) 601-3829', 'Dispatcher Manifest App', 84, 'In Negotiation', now, 'Testing electronic Proof of Delivery (ePOD).', now]
    ]
  );

  // 9. Client Replies
  await seedIfEmpty(
    'client_replies',
    'INSERT INTO client_replies (workspace_id, client_id, customer_name, company_name, reply_text, sentiment, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      [1, 3, 'Michael Chang', 'Apex Wholesale Goods', 'We want to test ThriveWoo with our 14 reps on van routes next Tuesday. Please send the link.', 'Positive', 'Today 09:42', now],
      [1, 1, 'Dr. Arthur Hastings', 'Metro Central School District', 'The school board approved the grant for 22 buses. Ready to review the SLA agreement.', 'Positive', 'Yesterday 16:15', now],
      [1, 2, 'Lisa Raymond', 'Horizon Beverage Distributors', 'Can ThriveWoo handle customer-specific discounts for our top 40 restaurant accounts?', 'Curious', 'Oct 17, 11:30', now]
    ]
  );

  // 10. Emails (Inbound & Outbound with visual HTML)
  await seedIfEmpty(
    'emails',
    'INSERT INTO emails (workspace_id, client_id, sender, sender_email, recipient_email, recipient_name, subject, body, html_body, ai_summary, ai_priority, ai_replies_json, status, sent_at, received_at, is_read, is_urgent, message_id, smtp_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      [
        1,
        3,
        'Michael Chang',
        'mchang@apexwholesale.com',
        'executive@tradesage.ai',
        'Executive Founder',
        'Live Walkthrough for Apex Wholesale 14 Sales Reps',
        'Hi Roger, we have 14 van sales reps currently using paper slips. Can we schedule a walkthrough for ThriveWoo next Tuesday at 10 AM?',
        `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6; color: #1e293b;">
          <h2 style="color: #0284c7; margin-top: 0;">Van Sales Demo Request</h2>
          <p>Hi Roger,</p>
          <p>We have <strong>14 van sales reps</strong> currently taking handwritten orders on paper slips. This creates double-entry errors every evening.</p>
          <p>Can we schedule a 15-minute screen demonstration for ThriveWoo next Tuesday at 10 AM?</p>
          <p>Best regards,<br><strong>Michael Chang</strong><br>Apex Wholesale Goods</p>
        </div>`,
        'Michael Chang requested a 15-minute ThriveWoo van sales demonstration for 14 sales reps next Tuesday.',
        'Urgent',
        JSON.stringify(['Confirm Tuesday 10 AM Demo', 'Send 3-Minute Video Walkthrough', 'Request Rep Count Details']),
        'Unread',
        null,
        now,
        0,
        1,
        `<msg-${Date.now()}-1@apexwholesale.com>`,
        'Delivered'
      ],
      [
        1,
        1,
        'Dr. Arthur Hastings',
        'hastings@metrodistrict.edu',
        'executive@tradesage.ai',
        'Executive Founder',
        'Board Approval for SafeTrack 22 Bus Pilot',
        'Great news! The school board approved funding for our 22 bus safety upgrade. Please send the pilot agreement.',
        `<div style="font-family: sans-serif; padding: 20px; line-height: 1.6; color: #1e293b;">
          <h2 style="color: #0284c7; margin-top: 0;">SafeTrack Fleet Approval</h2>
          <p>Dear Roger,</p>
          <p>The school board unanimously approved funding for our <strong>22-bus RFID fleet deployment</strong>.</p>
          <p>Please send over the pilot onboarding agreement so we can schedule driver training.</p>
          <p>Sincerely,<br><strong>Dr. Arthur Hastings</strong><br>Superintendent, Metro District</p>
        </div>`,
        'Dr. Hastings confirmed school board approval for 22-bus SafeTrack rollout. Needs onboarding agreement.',
        'Urgent',
        JSON.stringify(['Send SafeTrack Agreement', 'Schedule Driver Onboarding', 'Share RFID Hardware Specs']),
        'Unread',
        null,
        now,
        0,
        1,
        `<msg-${Date.now()}-2@metrodistrict.edu>`,
        'Delivered'
      ]
    ]
  );

  // 11. Email Drafts
  await seedIfEmpty(
    'email_drafts',
    'INSERT INTO email_drafts (workspace_id, product_id, lead_id, recipient_name, recipient_email, subject, body, body_html, angle, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      [
        1,
        1,
        1,
        'Michael Chang',
        'mchang@apexwholesale.com',
        'Empower Your 14 Sales Reps with ThriveWoo B2B Mobile Ordering',
        'Hi Michael,\n\nManaging wholesale orders and van deliveries manually slows down distribution and creates double-entry discrepancies.\n\nThriveWoo gives your 14 sales reps live order booking, staff target tracking, and customer-specific discounts right on their phones.\n\nAre you available for a 15-minute demo this Tuesday at 10 AM?\n\nBest regards,\nExecutive Team',
        `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.06);">
          <div style="background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); padding: 32px 28px; text-align: center; color: #ffffff;">
            <h1 style="margin: 0; font-size: 24px; font-weight: 700;">ThriveWoo - Smart FMCG B2B Sales App</h1>
            <p style="margin: 8px 0 0; font-size: 14px; opacity: 0.95;">Mobile Field Sales Ordering & Staff Performance Tracking</p>
          </div>
          <div style="padding: 32px 28px; color: #1e293b; line-height: 1.6;">
            <p style="font-size: 16px; margin-top: 0;">Hi Michael,</p>
            <p style="font-size: 15px; color: #475569;">Managing wholesale orders and van deliveries manually slows down your distribution and creates costly fulfillment discrepancies.</p>
            <div style="background: #f8fafc; border-left: 4px solid #0284c7; padding: 16px 20px; margin: 24px 0; border-radius: 0 8px 8px 0;">
              <h3 style="margin: 0 0 10px; font-size: 15px; color: #0284c7;">Built for High-Growth Field Sales:</h3>
              <ul style="margin: 0; padding-left: 18px; color: #334155; font-size: 14px;">
                <li>Mobile Field Sales Order Booking & Bluetooth Receipt Printing</li>
                <li>Staff Performance Analysis & Category-Wise Target Tracking</li>
                <li>Buying Pattern Analysis & Customer-Specific Discounts</li>
                <li>Real-Time In-App Team Communication & Order Status Dashboard</li>
              </ul>
            </div>
            <p style="font-size: 15px; color: #475569;">Would you have 15 minutes this Tuesday at 10 AM for a live screen walkthrough tailored to Apex Wholesale?</p>
            <div style="text-align: center; margin: 32px 0 16px;">
              <a href="https://thrivewoo.com" style="background: #0284c7; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 15px; display: inline-block;">Confirm Demo Walkthrough</a>
            </div>
            <p style="font-size: 13px; color: #94a3b8; text-align: center; margin-top: 24px;">Marketech.ai</p>
          </div>
        </div>`,
        'Van Sales Order Booking & Staff Targets',
        'Approved',
        now
      ]
    ]
  );

  // 12. Social Media Posts
  await seedIfEmpty(
    'content_items',
    'INSERT INTO content_items (workspace_id, campaign_id, title, platform, content_type, body_text, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      [
        1,
        null,
        'Field Sales Reps: Stop Writing Paper Order Slips',
        'linkedin',
        'social_post',
        'If your FMCG field sales reps are still using paper slips to take retail store orders, you are losing 12-15 hours every week in double entry.\n\nWith ThriveWoo:\n1. Reps book orders on mobile in under 20 seconds\n2. Real-time in-app team messaging prevents delivery mixups\n3. Warehouse dashboards show live revenue and collections instantly\n\nBuilt specifically for FMCG and wholesale distribution.\n\nBook a live screen demonstration today: https://thrivewoo.com\n\n#FMCG #B2BSales #Distribution #Wholesale #FieldSales #SalesAutomation',
        'Approved',
        now
      ],
      [
        1,
        null,
        'Mobile Wholesale in 20 Seconds',
        'twitter',
        'social_post',
        'Still managing van sales on carbon copy slips?\n\nEmpower your reps with ThriveWoo: mobile order booking, staff target tracking, and customer discount tiers.\n\n👉 Demo at https://thrivewoo.com\n\n#B2BSales #FMCG #Wholesale',
        'Approved',
        now
      ]
    ]
  );

  // 13. Mail Configuration (ZeptoMail from busskit-webstore)
  await seedIfEmpty(
    'mail_configurations',
    'INSERT INTO mail_configurations (workspace_id, provider, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, imap_host, imap_port, imap_tls, imap_user, imap_pass, sender_name, sender_email, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [[
      1,
      'zeptomail',
      'smtp.zeptomail.com',
      587,
      0,
      'emailapikey',
      process.env.ZEPTOMAIL_TOKEN ? '[env:ZEPTOMAIL_TOKEN]' : '',
      'imap.zoho.com',
      993,
      1,
      'support@thrivewoo.com',
      '',
      'ThriveWoo Support',
      'support@thrivewoo.com',
      'Connected',
      now
    ]]
  );

  // 14. Appointments
  await seedIfEmpty(
    'appointments',
    'INSERT INTO appointments (workspace_id, contact_name, phone, appointment_time, service_requested, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      [1, 'Michael Chang', '+1 (555) 902-8311', 'Tuesday 10:00 AM', 'ThriveWoo 14-Rep Van Sales Walkthrough', 'Confirmed', 'Apex Wholesale Goods team meeting on Zoom.', now],
      [1, 'Dr. Arthur Hastings', '+1 (555) 349-1102', 'Wednesday 2:30 PM', 'SafeTrack 22-Bus District Deployment', 'Scheduled', 'Review grant funding and parent mobile app rollout.', now]
    ]
  );

  console.log('\n====================================================');
  console.log(`🎉 SUCCESS: MySQL Database '${DB_NAME}' initialized and seeded!`);
  console.log('All 26 tables and seed records are active in MySQL.');
  console.log('====================================================');
  await pool.end();
}

if (require.main === module) {
  seedMySQL().then(() => process.exit(0)).catch(e => {
    console.error('Fatal Seeder Error:', e);
    process.exit(1);
  });
}

module.exports = { seedMySQL };
