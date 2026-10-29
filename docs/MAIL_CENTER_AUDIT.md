# Mail Center audit and UI redesign

Date: 2026-10-29. Local only: nothing deployed, pushed or sent.

Mail Center is one page (`currentRoute = 'emails'`, component `MailCenterComponent`) with tabs held in
`mailSection`. There are no separate Angular routes: tabs are opened by clicking them, by
`navigate('emails', <section>)` from elsewhere in the app, or by the deep link
`/?view=mail&section=<key>` (also `?view=drafts` and the Zoho return `section=zoho`). Every API call
is workspace-scoped on the server and checked against the member's capabilities (`mail.view`,
`mail.compose`, `mail.send`, `mail.send_transactional`, `mail.configure`).

How this was checked:
- **Code review:** every component and its API calls were read.
- **Automated tests:** the backend and frontend suites were run.
- **Real-app run:** the built app ran against a disposable database (`mt_rehearsal_ui`, with demo
  workspace sample data) with provider keys blank and all outbound network blocked. Headless Chrome
  clicked through every tab, took screenshots at 1440, 1280, 768 and 390 px and in dark mode, and
  ran 49 scripted checks. Every confirm dialog was answered "Cancel" unless a step said otherwise,
  and the run asserts that no request ever tried to send mail.

## Tabs and screens found

| Tab / screen | Component | Main API | Who can act |
|---|---|---|---|
| Overview | `mail-center` + `mail-activity-charts` | `GET /mail/activity/summary`, drafts list, `GET /emails/inbox?read=unread` | `mail.view` |
| Inbox | `mail-inbox` | `GET /emails/inbox`, `GET /emails/:id`, `PUT /emails/:id/read`, `POST /mail/sync`, `POST /emails/:id/ai-analyze` | view: `mail.view`; sync/AI: `mail.compose` |
| Sent Mail | `mail-sent` (+ `email-tracking`) | `GET /emails/sent`, `GET /emails/:id`, `GET /mail/tracking/emails/:id` | `mail.view` |
| Compose (dialog) | app shell | `POST /emails/send`, `/emails/send-html` (Idempotency-Key, `confirm: true`) | `mail.send`; transactional needs `mail.send_transactional` |
| Drafts / Approvals | `mail-drafts` (+ `contact-picker`, `template-picker`, `email-tracking`) | `/drafts` (generate, update, rewrite, approve, send, resolve, delete) | write: `mail.compose`; approve/send: `mail.send` |
| Product Emails (flag `PRODUCT_EMAILS_ENABLED`) | `product-emails` | `/mail/product-emails` (batches, approve, send, retry-failed, consent), `/mail/marketing` | compose / send / configure |
| Campaigns | `email-campaigns` + `zoho-campaigns` + `campaign-metrics` | `/mail/campaigns` (CRUD, validate, approve, send, refresh, resolve, recipients), `/mail/zoho` (status, connect, test, disconnect) | compose / send / configure |
| Email Templates | `email-templates` | `/mail/templates` (CRUD, duplicate, analyze, import) | view: `mail.view`; edit: `mail.compose` |
| Logs → Campaign log, Compose audit | `mail-logs`, `compose-report` | `GET /mail/activity/campaigns`, `GET /mail/compose-report` | `mail.view`; audit: `mail.configure` |
| Settings → Sending, Replies (IMAP), Marketing email, Tracking & privacy, Zoho Campaigns | `mail-settings`, `marketing-delivery`, `mail-tracking-settings` | `/mail/config`, `/mail/test-smtp`, `/mail/sync`, `/mail/marketing`, `/mail/tracking/settings`, `/mail/tracking/zeptomail-webhook` | `mail.configure` (others see why) |
| AI Campaigns → Email sequences (separate page, `businesses` route) | `command-center` → `outreach` | `/outreach/*` | compose / send |

## Findings and changes, by tab

**Mail Center frame**
- *Issues:*
  - The title "Mail Center" appeared twice: in the app bar, then again as a large heading with a
    paragraph.
  - Ten tabs sat in one ungrouped row, and the last tab was cut off at 1280 px.
  - The emoji button label rendered differently across systems.
  - On a phone, the header used a third of the screen.
- *Changes:*
  - **Toolbar:** a compact toolbar replaces the second title. It shows live shortcuts ("N unread",
    "N waiting for approval") and the Compose Email / Create Email actions with line icons. The
    heading is kept for screen readers.
  - **Tab groups:** tabs are grouped as Mail (Overview, Inbox, Sent Mail, Drafts, Approvals) ·
    Campaigns & content (Product Emails, Campaigns, Email Templates) · Records & setup (Logs,
    Settings), with dividers.
  - **Fit:** tighter spacing makes all ten tabs fit at 1280 px. Narrower screens scroll the tab
    row, with a fade as a hint.

**Shared design layer** (`features/mail/mail-ui.css`, loaded by every Mail Center component)
- Every tab now opens with the same header style: title, one-line description, actions on the right.
- The shared layer also covers panels (only one level, no boxes inside boxes), status tags,
  callouts, filter bars, tables, empty states, sub-tabs, form-control size and visible focus rings.
- Before this, Drafts, Templates and Product Emails each drew their own box inside the Mail Center
  box, each in a different style; Inbox, Sent Mail, Logs and Settings had none.

**Overview**
- *Issues:* the status bar text was larger than everything else around it.
- *Changes:* it now uses one size (status, counts, Needs attention, activity charts).

**Inbox**
- *Checked (works):* the list, reading pane, read/unread, search, filters, reply, forward, AI
  analysis, sync, and the "IMAP not set up" state.
- *Changes:*
  - Section header with an unread count; Sync moved into the header.
  - On phones, an open message gets the whole screen (filters and notices hide).
  - Icons instead of emoji.

**Sent Mail**
- *Checked (works):* statuses stay distinct (Sent, Accepted, Delivered, Opened, Clicked, Bounced,
  Not sent); status, purpose and date filters; failure reason; "Send again…" opens Compose without
  sending; delivery timeline.
- *Changes:*
  - Section header and shared tags.
  - A send whose origin isn't recorded shows "Not recorded" instead of "Other".

**Compose (dialog)**
- *Defects fixed:*
  1. **No way to type a plain-text message.** The dialog had only "Visual Page Preview" and
     "HTML Code", so a reply (plain text) could not be edited. It now has **Write / HTML /
     Preview**. Replies and forwards open in Write.
  2. **Clicking outside the dialog discarded the email without asking.** Cancel, ✕ and the
     backdrop now ask first when anything has been written.
  3. **Missing fields were only reported one at a time after Send.** Send now lists everything
     still needed: a valid recipient, subject, purpose and message. Invalid fields are marked.
- *Changes:*
  - Clearer labels (Send email…, Choose template, Save as template, Upload HTML).
  - Generic placeholders instead of demo text ("ThriveWoo B2B").
  - The dialog is labelled for screen readers.
- *Unchanged:* the required purpose choice, the server-side checks (purpose, permissions,
  suppression, approved mailbox) and the confirm-before-send step.

**Drafts / Approvals**
- *Checked (works):* opening a draft, editing (Save enables), the warning before switching drafts
  with unsaved changes, placeholder fill-in, and the approval gate.
- *Changes:* box inside a box removed; shared header.

**Product Emails**
- *Checked (works):* the blocked-sending explanation.
- *Changes:* box removed; shared header.
- *Left as is:* it still has its own copy of the marketing approval (Settings → Marketing email is
  the main place).

**Campaigns (Zoho)**
- *Issues:* the Zoho connection box came before any page heading; the empty state sat in a narrow
  side column.
- *Changes:*
  - The page now starts with a "Campaigns" header and its actions.
  - The Zoho connection is one panel with a Connected / Not connected tag.
  - The empty state spans the page.
- *Unchanged:* Zoho metrics semantics.

**Email Templates**
- *Checked (works):* search.
- *Changes:* box removed; shared header; "Create or import" menu button with icons.
- *Unchanged:* template variables and rendering.

**Logs**
- *Checked (works):* the campaign log lists AI and Zoho campaigns; the Compose audit is shown to
  Owners and Admins only.
- *Changes:* shared table, tags and sub-tabs.

**Settings**
- *Checked (works):* every sub-tab opens; sample IMAP values are flagged as not set up.
- *Changes:* shared header and sub-tabs.

**AI Campaigns → Email sequences**
- *Changes:* emoji removed from the area tabs and status chips; the tabs now use the Mail Center
  tab style and report `aria-selected`.

## Not fully verified, and why

- **Real sending, delivery, opens and clicks:** no live email was allowed. These paths are covered
  by the backend tests with providers mocked.
- **Zoho connect/disconnect and campaign send:** they need Zoho credentials and live API access;
  only the "not set up" state was seen.
- **IMAP sync:** it needs a real mailbox; only the "not set up" state and the refusal path were
  checked.
- **ZeptoMail webhook:** it stays disabled (`ZEPTOMAIL_WEBHOOKS_ENABLED` empty). Signature checks
  and the 404 when disabled are covered by `backend/tests/mailTracking.test.js`.
- **Phone Compose dialog:** it was viewed at 390 px. The body scrolls inside the dialog; it was not
  tested with an on-screen keyboard.

## Other finding (outside Mail Center)

The app shell requests `/api/appointments` on load and gets 403 for the demo workspace owner.
It does not affect mail, but it should be looked at separately.
