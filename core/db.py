import sqlite3
import os
import json
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "tradesage.db")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()
    
    # 1. Workspaces (Tenants)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        owner_email TEXT NOT NULL,
        plan TEXT DEFAULT 'Starter',
        status TEXT DEFAULT 'Active',
        created_at TEXT
    )
    """)
    
    # 2. Business Profiles & Brand Kits
    cursor.execute("""
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
    """)

    # 3. Leads CRM Table (Tenant-scoped)
    cursor.execute("""
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
    """)
    
    # 4. Appointments & Demos Table
    cursor.execute("""
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
    """)

    # 5. Marketing Campaigns
    cursor.execute("""
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
    """)

    # 6. Content Items (Social Posts, Graphics, Videos)
    cursor.execute("""
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
    """)

    # 7. Video Studio Jobs (FFmpeg Composition)
    cursor.execute("""
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
    """)

    # 8. Telnyx Phone Numbers & Voice Agent Mapping
    cursor.execute("""
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
    """)

    # 9. Call Records & Transcripts (Inbound/Outbound Telephony)
    cursor.execute("""
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
    """)

    # 10. Usage Ledger (Metering for AI, Video, & Telephony)
    cursor.execute("""
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
    """)

    # 11. Legacy Business Info (Kept for backwards compatibility)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS business_info (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL
    )
    """)

    # 12. Inbox Emails
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER DEFAULT 1,
        sender_name TEXT NOT NULL,
        sender_email TEXT NOT NULL,
        subject TEXT NOT NULL,
        snippet TEXT NOT NULL,
        is_urgent INTEGER DEFAULT 0,
        status TEXT DEFAULT 'Unread',
        received_at TEXT
    )
    """)

    # SEED DEFAULT WORKSPACE & BUSINESS PROFILE IF NOT PRESENT
    cursor.execute("SELECT count(*) as count FROM workspaces")
    if cursor.fetchone()["count"] == 0:
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cursor.execute("""
        INSERT INTO workspaces (name, slug, owner_email, plan, status, created_at)
        VALUES ('TradeSage Enterprise', 'tradesage-enterprise', 'founder@tradesage.ai', 'Business', 'Active', ?)
        """, (now,))
        workspace_id = cursor.lastrowid

        products = [
            {
                "id": "school_bus",
                "name": "School Bus Management System (SaaS)",
                "target_audience": "School Principals, Transportation Managers, Academy Fleet Owners",
                "key_features": [
                    "Live GPS bus fleet tracking with sub-second accuracy",
                    "RFID student boarding verification with instant parent SMS/app alerts",
                    "Parent mobile app showing live bus location & arrival ETA",
                    "Automated route optimization cutting school fuel costs by 20%",
                    "School safety dashboard with speed alerts & emergency SOS console"
                ],
                "pricing": "Custom quotation per bus fleet ($15 - $30/bus/month)"
            },
            {
                "id": "web_mobile_apps",
                "name": "Custom Web & Mobile Application Development",
                "target_audience": "Startup Founders, Enterprise Leaders, Product Managers",
                "key_features": [
                    "Native & Cross-Platform mobile apps (Flutter, React Native, iOS, Android)",
                    "Modern scalable web applications (React, Next.js, Node.js, Python FastAPI)",
                    "Enterprise UI/UX design, cloud architecture, and secure REST/GraphQL APIs",
                    "Rapid MVP prototyping & production deployment within 4-8 weeks"
                ],
                "pricing": "Project-based scoping ($5,000 - $35,000+)"
            },
            {
                "id": "b2b_sales",
                "name": "B2B Sales & Pipeline Automation",
                "target_audience": "B2B Companies, Agencies, Corporate Sales Teams",
                "key_features": [
                    "Automated AI lead prospecting, scraping, and email/voice follow-ups",
                    "CRM workflow integrations & automated appointment booking",
                    "High-ticket outbound sales pipeline acceleration"
                ],
                "pricing": "Monthly retainer ($1,500 - $3,500/month)"
            }
        ]

        colors = {"primary": "#00f0ff", "secondary": "#7000ff", "background": "#0b0f19"}

        cursor.execute("""
        INSERT INTO business_profiles (
            workspace_id, business_name, industry, website_url, description,
            products_json, brand_voice, brand_colors_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            workspace_id,
            "TradeSage AI & Enterprise Software",
            "Software & B2B Solutions",
            "https://tradesage.ai",
            "Next-generation enterprise software agency specializing in School Bus Fleet Management, Custom Web/Mobile Engineering, and B2B Sales Automation.",
            json.dumps(products),
            "Professional, visionary, authoritative, and helpful",
            json.dumps(colors),
            now
        ))

        # Seed sample marketing campaign
        cursor.execute("""
        INSERT INTO campaigns (workspace_id, name, objective, target_audience, channels, brief_text, status, created_at)
        VALUES (?, 'Q4 School Bus Safety Drive', 'Generate 30 qualified school demo requests', 'School Administrators', 'LinkedIn, Facebook', 'Highlight parent peace-of-mind with live GPS and student RFID check-in notifications.', 'Active', ?)
        """, (workspace_id, now))

        # Seed sample social content
        cursor.execute("""
        INSERT INTO content_items (
            workspace_id, campaign_id, content_type, title, caption_text, hashtags, call_to_action, platform, status, created_at
        ) VALUES (
            ?, 1, 'post',
            'Is Your School Bus Fleet Still Running on Guesswork?',
            'Parents deserve to know their children arrived safely. Our School Bus Management System gives parents live GPS tracking on their phones and notifies them the second their child scans onto the bus. Schedule your free 15-minute school walkthrough today.',
            '#SchoolSafety #EdTech #SchoolBusTracking #FleetManagement',
            'Book a 15-Minute Live Demo',
            'LinkedIn', 'Approved', ?
        )
        """, (workspace_id, now))

    conn.commit()
    conn.close()

if __name__ == "__main__":
    init_db()
    print("TradeSage AI multi-tenant database initialized successfully at:", DB_PATH)
