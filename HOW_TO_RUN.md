# ROGER: Executive AI Voice OS & Multi-Business CRM
### Complete Setup & Execution Guide

---

## 1. System Overview

**Roger** is an enterprise executive AI voice assistant and CRM constructed with an **Angular 17** frontend and a **Node.js / Express** backend.

### Key Capabilities Included:
1. **🎙️ Neural Voice Center (ElevenLabs Full-Duplex Voice):**
   - Hands-free conversational voice assistant (Voice: British Executive "Roger").
   - Real-time full-duplex audio stream via signed WebSocket URL.
   - Zero-credit standby protection (uses 0 ElevenLabs credits on idle).
   - Live spoken conversation transcript and real-time text command bar.
2. **💻 Windows Desktop OS Controls (Python Tools Parity):**
   - One-click launch for Calculator (`calc.exe`) and Notepad (`notepad.exe`).
   - Master system volume controls (Volume +, Volume -, Audio Mute).
   - Real-time hardware telemetry: CPU load %, RAM used/total GB, Battery status.
   - Executive briefing generator summarizing urgent emails, leads, and product inventory.
3. **👥 Leads CRM (Lead Getting):**
   - Captures and tracks prospective buyer inquiries, deal budgets, and statuses.
   - "+ Capture New Lead" modal & 1-click test simulation.
   - 1-Click "✉️ Email" action directly on any lead.
4. **📬 Email Command Center (Mail Getting & Sending):**
   - **Mail Getting (Inbox):** Urgent priority digest with read/unread tracking and incoming client replies (Apex Wholesale, Metro Academy, Horizon Beverage).
   - **Need to Send Mail (Outbox):** Dedicated email composition & dispatch modal. Live timestamping and database logging of all sent emails.
   - **Voice Email Dispatch:** Tell Roger via voice: *"Roger, send an email to Michael Chang saying..."* and Roger automatically logs and dispatches the email.
5. **📅 Scheduled Appointments & Demos:**
   - Demonstrations calendar with date, time, and service type.
   - Booking modal and 1-click test simulation.
6. **🚀 Connected Businesses & Multi-Business Marketing Engine:**
   - Multi-Business selector between **★ My Business (Traivo)** and **Connected Client Businesses** (Metro Central School Bus SaaS, Horizon Beverage Distributors, Apex Wholesale Goods, Summit Freight & Logistics).
   - Context-aware marketing generation: when asked for "My Business", it generates Traivo wholesale van sales campaigns; when asked for a client's business, it generates tailored campaigns specifically for *their* business model and target audience.
   - 1-Click **"Dispatch Campaign to Leads"** workflow.
7. **📦 Traivo MySQL Live Synchronization:**
   - Direct connection to local MySQL database `thrivewoo` (127.0.0.1:3306) with 181 active products and 57 sales orders.

---

## 2. Prerequisites

1. **Node.js:** Version 18.x or 20.x or higher installed on your computer.
   - Check by opening terminal / command prompt and typing:
     ```bash
     node -v
     ```
2. **Operating System:** Windows 10 or Windows 11 (supports full desktop controls like Calc, Notepad, volume keys, and hardware stats).
3. **(Optional) Local MySQL:** If you wish to connect your live database, MySQL 8.x running on `127.0.0.1:3306` with user `root` and database `thrivewoo`.
   - *Note:* If MySQL is not running, the system automatically uses the embedded SQLite database (`tradesage.db`), so the application runs **100% out of the box with zero configuration!**

---

## 3. How to Run (1-Click Method)

1. **Extract** the zip file into any folder on your computer.
2. **Double-click** the file named:
   ```
   start.bat
   ```
3. The script will automatically:
   - Install backend dependencies if not already present (`npm install`).
   - Launch your web browser automatically to:
     ```
     http://localhost:8000/
     ```
   - Start the Roger Executive Voice OS backend server.

---

## 4. How to Run (Manual Method)

If you prefer using the terminal / command prompt:

### Step 1: Open Terminal in the `backend` directory
```bash
cd backend
```

### Step 2: Install Dependencies (First time only)
```bash
npm install
```

### Step 3: Start the Backend Server
```bash
node server.js
```
You will see:
```
====================================================
TradeSage AI Enterprise Workforce Platform
Running on: http://localhost:8000
LAN Access: http://192.168.x.x:8000
====================================================
```

### Step 4: Open Browser
Open Google Chrome, Brave, or Microsoft Edge and navigate to:
```
http://localhost:8000/
```

---

## 5. (Optional) Rebuilding the Frontend

The project already includes the **pre-built production distribution** in `frontend/dist/frontend/browser`, so you **do not** need to install Angular or build the frontend to run the app.

However, if you edit any Angular code in `frontend/src/` and wish to rebuild:
```bash
cd frontend
npm install
npm run build
```
Once built, restart `node server.js` in the `backend` folder to serve the updated bundle.

---

## 6. Project Directory Structure

```
├── backend/                   # Node.js Express Backend
│   ├── db/                    # SQLite & MySQL Database Layer
│   │   └── database.js        # Universal database schema & migrations
│   ├── services/              # Business Logic Services
│   │   ├── desktopTools.js    # Windows Calc, Notepad, Vol, CPU/RAM tools
│   │   ├── aiEngine.js        # AI LLM response engine
│   │   ├── marketingService.js# Campaigns & content engine
│   │   └── telnyxService.js   # Telephony & TTS streaming
│   ├── server.js              # Core REST & WebSocket server
│   ├── package.json           # Backend dependencies
│   └── .env                   # ElevenLabs API credentials
│
├── frontend/                  # Angular 17 Standalone Single Page App
│   ├── src/                   # Source code
│   │   ├── app/               # Angular Components & Services
│   │   │   ├── app.component.ts   # Core executive HUD state & voice controller
│   │   │   ├── app.component.html # Dark futuristic sci-fi HUD template
│   │   │   ├── app.component.css  # Orbitron/Rajdhani glowing HUD styles
│   │   │   └── services/          # Angular API & ElevenLabs Speech services
│   │   ├── index.html         # HTML entry point
│   │   └── main.ts            # Angular bootstrapper
│   ├── dist/                  # Pre-compiled production bundle (Served by Node.js)
│   ├── angular.json           # Angular configuration
│   └── package.json           # Frontend dependencies
│
├── tradesage.db               # SQLite database with pre-seeded B2B records
├── start.bat                  # 1-Click Windows execution launcher
└── HOW_TO_RUN.md              # This execution and setup guide
```

---

## 7. Voice Assistant Testing Guide

Once the app is running in your browser:
1. Click the top blue banner or click the glowing **Voice Orb** to connect ElevenLabs.
2. Speak in English (or type into the command bar):
   - *"Roger, what are our recent client replies?"*
   - *"Roger, give me marketing ideas for my business."*
   - *"Roger, give me marketing ideas for Metro Central School District."*
   - *"Roger, send an email to Michael Chang saying our team will call him tomorrow at 2 PM."*
   - *"Roger, what are our hardware system stats?"*
3. Explore the dedicated tabs:
   - **👥 Leads CRM:** Track leads and 1-click email prospects.
   - **📬 Email Command Center:** View inbox replies and send outbound emails.
   - **📅 Appointments:** Check demo schedules.
   - **🚀 Connected Businesses & Campaigns:** Generate playbooks for any connected business and 1-click dispatch to leads.
   - **📦 Traivo MySQL:** View live 181 wholesale SKUs from MySQL `thrivewoo`.
