# TradeSage AI — Autonomous B2B Marketing & Sales Acceleration Platform

An enterprise-grade, AI-driven marketing and B2B sales acceleration operating system built with **Angular 18**, **Node.js (Express)**, and **MySQL**. Featuring an executive AI assistant (*Roger*), real-time product web scrapers, automated lead scoring, multi-channel campaign orchestration, and a rich HTML email studio.

---

## 🌟 Key Capabilities

### 1. 🎙️ Roger — Executive AI Assistant
- Conversational executive intelligence with real-time business context awareness.
- On-demand lead status inquiries, automated email drafting, strategy recommendations, and operational task delegation.
- Grounds recommendations in your live digital product catalog and real-world features.

### 2. 🌐 Real-Time Digital Product Management & Web Extractor
- Add and manage proprietary digital products (e.g., **ThriveWoo Smart FMCG Sales App**, **SafeTrack Bus SaaS**).
- **Live URL Extractor**: Point to any live product URL (e.g., `https://thrivewoo.com`) to extract real-time feature matrices, taglines, and descriptions on the fly.
- Strict feature fidelity without hallucinated or fabricated pricing.

### 3. 🎯 AI-Powered Leads CRM & Excel Bulk Import
- Automated lead scoring (1–100 scale), categorization (*Hot*, *Warm*, *Cold*), and actionable follow-up suggestions.
- **Excel Spreadsheet Import**: Upload customer and prospect lists in bulk via `.xlsx` or `.csv` with auto-qualification.
- One-click outreach triggers and pipeline deal tracking.

### 4. ✉️ HTML Email Studio & Custom SMTP Engine
- Connect your enterprise email via custom **SMTP / IMAP** credentials.
- Generate, rewrite, and personalize professional HTML email drafts using AI.
- **Visual HTML Sandbox**: Dual-mode rendering displaying full visual styled HTML alongside raw code with user approval workflows prior to dispatch.

### 5. 📢 Multi-Channel Campaign & Social Media Studio
- Plan, schedule, and track omni-channel campaigns across LinkedIn, Twitter/X, Instagram, and email.
- Autonomous social post generator optimized for engagement and B2B conversion.

### 6. 📞 Telnyx Voice AI Integration
- Dedicated inbound/outbound telephony DID procurement and TeXML voice assistant bindings.
- Call summaries, sentiment analysis, and automated meeting scheduling.

---

## 🏗️ Architecture & Technology Stack

```
                          ┌─────────────────────────────────────┐
                          │     Angular 18 Executive Frontend   │
                          │   (Tailwind CSS, Glassmorphism UI)  │
                          └──────────────────┬──────────────────┘
                                             │ REST API / JSON
                                             ▼
                          ┌─────────────────────────────────────┐
                          │       Node.js / Express Backend     │
                          │   (Services: AI, Scraper, Mailer)   │
                          └──────────┬──────────────────────┬───┘
                                     │                      │
             ┌───────────────────────┴──────┐        ┌──────┴──────────────────────┐
             │         MySQL Database       │        │   External Integrations     │
             │   (27 Schema Tables, DDL)    │        │  - Telnyx Voice API         │
             │     Seed Script (seed.js)    │        │  - Custom SMTP / IMAP       │
             └──────────────────────────────┘        │  - Gemini / OpenRouter AI   │
                                                     └─────────────────────────────┘
```

- **Frontend**: Angular 18 (Standalone Components, Signals, Reactive Forms, Lucide Icons)
- **Backend**: Node.js, Express, Cheerio (live web extraction), Nodemailer
- **Database**: MySQL 8.0+ (InnoDB, UTF-8 MB4) with automated migration & seeder script (`seed.js`)
- **Telephony**: Telnyx TeXML Voice Application & Webhooks

---

## 🚀 Getting Started

### Prerequisites
1. **Node.js** (v18.x or v20.x recommended)
2. **MySQL Server** (v8.0+ running on `localhost:3306`)
3. **Git**

---

### Step 1: Clone Repository
```bash
git clone https://github.com/aneesh00786/marketing-AI.git
cd marketing-AI
```

---

### Step 2: Configure Environment Variables
Navigate to the `backend` folder and copy `.env.example` to `.env`:
```bash
cd backend
copy .env.example .env
```

Ensure your MySQL connection parameters in `backend/.env` match your environment:
```env
PORT=8000
DB_CLIENT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=tradesage

# Telnyx Voice Configuration (Optional)
TELNYX_API_KEY=your_telnyx_api_key
TELNYX_PHONE_NUMBER=+1 (800) 555-SAGE
```

---

### Step 3: Initialize & Seed MySQL Database
Run the idempotent seeder to create the `tradesage` database, create all 27 tables, and seed baseline data:
```bash
# Inside backend/
npm install
npm run seed
```
*(Or directly: `node seed.js`)*

---

### Step 4: Start Backend Server
```bash
# Inside backend/
npm start
```
The API server will listen on `http://localhost:8000`.

---

### Step 5: Start Angular Frontend
Open a new terminal window:
```bash
cd frontend
npm install
npm start
```
The application will launch on `http://localhost:4200`.

---

## 📁 Repository Directory Structure

```
marketing-AI/
├── backend/
│   ├── db/
│   │   └── database.js            # Unified MySQL connection pool & SQLite fallback
│   ├── services/
│   │   ├── aiEngine.js            # Roger AI prompt pipelines & LLM handlers
│   │   ├── emailService.js        # SMTP / IMAP dispatch & retrieval
│   │   ├── marketingService.js    # Campaign & social post orchestration
│   │   └── telnyxService.js       # Voice AI call flow handlers
│   ├── seed.js                    # Complete MySQL schema creation & table seeder
│   ├── server.js                  # Express REST API application
│   ├── .env.example               # Template environment configuration
│   └── package.json
│
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── components/        # Angular 18 UI components
│   │   │   │   ├── assistant/     # Roger AI Executive chat modal
│   │   │   │   ├── campaigns/     # Campaign orchestrator
│   │   │   │   ├── leads/         # Leads CRM & Excel uploader
│   │   │   │   ├── mail/          # Visual HTML Email Studio
│   │   │   │   ├── products/      # Digital Products & Live URL scraper
│   │   │   │   └── social/        # Social media post studio
│   │   │   └── services/          # HTTP data services & state stores
│   │   └── index.html
│   ├── angular.json
│   └── package.json
│
├── .gitignore                     # Git ignore rules for node_modules, build & secrets
└── README.md                      # Platform documentation
```

---

## 🔒 Security Best Practices
- Never commit production passwords or `.env` files.
- The `seed.js` script verifies credentials and runs schema updates idempotently without dropping user data.
- User email credentials are used exclusively for direct SMTP/IMAP transport and are not shared with external third-party models.

---

## 📄 License
This project is proprietary and confidential. Built for commercial B2B growth and marketing automation.
