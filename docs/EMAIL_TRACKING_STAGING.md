# Email Tracking — Staging Validation (ZeptoMail, Zoho Campaigns, SMTP)

Status: **implemented and tested with mocked providers only. Nothing here has been verified live.**
The ZeptoMail webhook stays off (`ZEPTOMAIL_WEBHOOKS_ENABLED` empty) everywhere until section 3 is
signed off. Production is out of scope: no step below is run against production.

## 0. Classification (decided 2026-10-28) and staging status

Suppression policy (`backend/lib/mailSuppression.js`), enforced inside the shared sender:

| Email type | Unsubscribed | Consent withdrawn | Hard bounce | Spam complaint |
|---|---|---|---|---|
| Marketing | blocked | blocked | blocked | blocked |
| Transactional | allowed | allowed | blocked | blocked |

| Path | Email type | Delivery |
|---|---|---|
| Product Emails (batches) | marketing | SMTP mailbox approved for marketing only |
| AI Campaigns sequences | marketing | SMTP mailbox approved for marketing only; a ZeptoMail-only workspace pauses the campaign with the reason |
| Mail Drafts | marketing | SMTP mailbox approved for marketing only; one-click unsubscribe link (header and footer) |
| Compose & Send — Transactional / Direct | transactional, **only if** declared and nothing points to marketing (`backend/lib/mailPurpose.js`) | ZeptoMail allowed; SMTP fallback only after a clear "not sent" |
| Compose & Send — Marketing (declared, missing, or reclassified: marketing template, pasted marketing template, unsubscribe wording, Zoho merge tags, promotional phrases) | marketing | recorded as a one-to-one marketing draft and sent through the approved SMTP mailbox with an unsubscribe link; refused without one |
| Workspace invitations | transactional | ZeptoMail or SMTP |

Marketing email never goes through ZeptoMail and never falls back to it.

**Staging status (2026-10-28, re-checked):** `node scripts/stagingPreflight.js` on the development machine
REFUSED (DEPLOYMENT_ENV not set; DB_NAME is the production name; PRODUCTION_APP_HOST not set;
ZEPTOMAIL_TOKEN set). No staging environment exists yet, so migration 024 was **not** applied to
any staging database and no live provider check has been run. Section 1 lists what staging needs.

## 1a. Infrastructure prerequisites (blocking) and setup plan

Nothing below may be created on the production host or with the production database. The
operator provides and authorises each item; the steps are run on the staging host only.

| # | Prerequisite | Provided by | Verify |
|---|---|---|---|
| 1 | Staging host (or isolated checkout on a non-production host) | operator | hostname differs from `PRODUCTION_APP_HOST` |
| 2 | MySQL/MariaDB server for staging (not the production server, or a separate instance) | operator | `SELECT @@hostname` differs from `PRODUCTION_DB_HOSTNAME` |
| 3 | Database `tradesage_staging` and a DB user limited to it | operator / DBA | `SHOW GRANTS` lists only `tradesage_staging` |
| 4 | Staging `backend/.env` (separate file) | operator | `DEPLOYMENT_ENV=staging`, `DB_NAME=tradesage_staging`, `PRODUCTION_DB_NAME`, `PRODUCTION_DB_HOSTNAME`, `PRODUCTION_APP_HOST` set; **no production `ZEPTOMAIL_TOKEN`**, Zoho/social secrets for test accounts only |
| 5 | Public HTTPS hostname for staging (`APP_BASE_URL`, `FRONTEND_URL`) behind one reverse proxy | operator | valid certificate; `TRUST_PROXY=1`; API port not reachable directly |
| 6 | Its own `SOCIAL_TOKEN_ENCRYPTION_KEY`, storage folders | operator | not the production key or folders |
| 7 | Test provider accounts: ZeptoMail Mail Agent (test), Zoho Campaigns test account with one already-sent test campaign, SMTP test mailbox | operator | sender addresses in `STAGING_ALLOWED_MAILBOXES`; `STAGING_ALLOW_ZOHO=1` |
| 8 | Recipient mailboxes we control | operator | no customer addresses |
| 9 | Backup storage for staging dumps | operator | off-host copy |
| 10 | Isolated storage and logs | operator | `SOCIAL_MEDIA_STORAGE_DIR`, `MAIL_ASSET_STORAGE_DIR` and the process-manager log directory are staging-only absolute paths (not shared with production); logs are not shipped to production log storage |
| 11 | Restricted DB user | DBA | `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON tradesage_staging.* TO 'mt_staging'@'<staging host>'` only; no `GRANT OPTION`, no access to other schemas; separate backup user with read/LOCK privileges on `tradesage_staging` only |
| 12 | Backup and restore drill | operator | `scripts/backup.sh` for `tradesage_staging` succeeds; `scripts/staging-restore.sh` into an empty scratch DB and `npm run migrate -- --status` on it (STAGING_RUNBOOK sections 2–3) |
| 13 | Proxy configuration | operator | one reverse proxy (nginx) in front; `TRUST_PROXY=1`; API bound to localhost/private network; sign-in shows the real client IP in `audit_logs.ip_address` (DEPLOYMENT_SAFETY 2a) |
| 14 | No production credentials | operator | staging `.env` has no production `ZEPTOMAIL_TOKEN`, Zoho client secret, social app secrets, SMTP passwords or `JWT_SECRET`; `node scripts/stagingPreflight.js` passes |

Setup plan (each step needs the operator's go-ahead):
1. Empty staging database: `node scripts/stagingPreflight.js` must pass with the staging `.env`, then
   `npm run migrate` creates the schema (or, if production data is wanted, follow STAGING_RUNBOOK
   section 3 with `--restore-target tradesage_staging`, then section 4 *neutralize* before starting).
2. Independently confirm the target: `SELECT DATABASE(), @@hostname` = `tradesage_staging` on the
   staging server; compare with the production identifiers in the staging `.env`.
3. Back up staging (`scripts/backup.sh` per STAGING_RUNBOOK section 2) before migration 024.
4. `npm run migrate -- --status` (024 pending) → `npm run migrate -- --backup=<staging dump>` →
   `--status` shows nothing pending; check the four tables and four columns exist (section 1).
5. Start the staging API (and worker only after the guard passes); then sections 3–5.

## 1. Prerequisites (staging)

- A separate staging host/checkout with its own `backend/.env`, set up per `docs/STAGING_RUNBOOK.md`:
  `DEPLOYMENT_ENV=staging`, `DB_NAME=tradesage_staging` (never the production name),
  `PRODUCTION_DB_NAME`, `PRODUCTION_DB_HOSTNAME`, `PRODUCTION_APP_HOST`, no production
  `ZEPTOMAIL_TOKEN` (or a sandbox token with `STAGING_ALLOW_ZEPTOMAIL=1`).
- `node scripts/stagingPreflight.js` prints no problems (and `--restore-target tradesage_staging`
  before any restore). Staging database is a copy, never production.
- **Migration 024 on the staging database only** (approved 2026-10-28, conditional on the guard):
  `node scripts/stagingPreflight.js && npm run migrate -- --status` (024 pending), back up the staging
  database, `npm run migrate -- --backup=<staging dump>`, then `npm run migrate -- --status` shows
  nothing pending. Rollback: restore that staging dump (024 is additive; the app ignores the new
  tables when the code is rolled back).
- `APP_BASE_URL` = the staging public **https** address; `TRUST_PROXY` set per
  `docs/DEPLOYMENT_SAFETY.md` 2a; confirm the audit log shows your real IP after signing in.
- A **dedicated test workspace** whose ZeptoMail Mail Agent and SMTP mailbox are test accounts; their
  sender addresses in `STAGING_ALLOWED_MAILBOXES`. For Zoho: `STAGING_ALLOW_ZOHO=1` and a Zoho test
  account that already has **one sent test campaign** (do not create or send a new one).
- **Recipient mailboxes we control** (e.g. `tracking-test+1@<our domain>`). No customer addresses.
- Diagnostic output goes to the test ticket only after checking it is redacted (the tools mask
  addresses, ids and signatures; keys are read from the environment and never printed).

## 2. Mocked vs live coverage

| Behaviour | Automated (mocked) | Needs live check |
|---|---|---|
| Status order, duplicates, out-of-order events | yes (`mailTracking.test.js`) | real event names/fields (3) |
| Signature, stale timestamp, tampering, wrong key/workspace | yes (documented format) | real signing input and ts unit (3.2) |
| Hard bounce / complaint → suppression, once, audited | yes | real bounce/complaint payload (3.4) |
| Suppression policy per email type and path | yes (`mailSuppression.test.js`, outreach) | — |
| Marketing routing (drafts, sequences never via ZeptoMail; unsubscribe link) | yes (`mail.test.js`, `outreach.test.js`, `productEmails.test.js`) | real SMTP provider accepts List-Unsubscribe (5) |
| SMTP pixel, click redirect, sensitive-link exclusions | yes (local HTTP) | real clients, https, image proxies (5) |
| Tracking off by default; role checks; workspace isolation | yes | role check in staging UI (4.3) |
| Retention purge; migration 024 | yes (test DB) | migration on staging DB (1) |
| Zoho recipient lists, paging, opens meaning | yes (documented shape) | real responses (4) |
| Zoho / ZeptoMail retry and rate behaviour | — | yes (3.3, 4.4) |

## 3. ZeptoMail webhook (stays disabled until 3.6 is signed off)

**3.1 Start the capture listener** (no app, no database, no outgoing calls):

```bash
cd backend
CAPTURE_KEY='<ZeptoMail Authentication Key>' node scripts/zeptoWebhookCapture.js --staging --port 8787
# prints: Webhook path ... /capture/<random>
```

Route `https://<staging host>/capture/<random>` to port 8787 through the staging proxy (temporary
location block). In the ZeptoMail Mail Agent of the test account: Webhooks → Add → that URL; events
Delivered, Soft bounce, Hard bounce, Open, Click, Feedback loop; enable authentication (the key used
above).

**3.2 Signature and timestamp.** Click **Send test** in ZeptoMail. The report shows:
- `producerSignature.ts.digits` / `unitGuess` → record whether ts is milliseconds (13 digits) or seconds;
  `skewSeconds` → clock skew (the app accepts ±300 s);
- `signature.decodedBytes` must be 32 (HMAC-SHA256), `algorithm` `HmacSHA256`;
- `signatureCheck` → exactly one input must match. The app verifies **raw body** or **decoded value of a
  single form field**. If only `ts + body` (or another variant) matches, **stop**: the verifier must be
  changed and re-reviewed; do not enable.
- `contentType` (JSON or form) and `authorizationHeaderPresent`.

**3.3 Retry behaviour.** Restart with `--respond 500`, Send test again, leave it 30 minutes; record each
arrival time and whether `webhookRequestIdHash` stays the same (retries) or changes. Repeat with
`--respond 429`. Record: retries yes/no, schedule, same id on retry. The app de-duplicates by event
content, so retries are safe; if ZeptoMail does **not** retry, a 429 above 600/min per endpoint loses
events (raise the limit before go-live).

**3.4 Real events.** Turn workspace tracking on (Mail Center → Overview → tracking). With the capture
URL still configured, from the test workspace use **Compose & Send** (one email each, confirmed):
1. to `tracking-test+1@<our domain>` → open it with images on; click one ordinary link;
2. to a non-existent address at our own domain (e.g. `no-such-user-<date>@<our domain>`) → hard bounce;
3. (if obtainable) mark a test message as spam in a test mailbox to trigger Feedback loop; otherwise
   record "complaint not verified".

For each captured event record from `body`: the event name value(s), where `request_id` sits, whether
`email_info.client_reference` is present (it should equal the tracking token sent; compare hashes:
`mail_message_tracking.tracking_token`), where the time is and its format, bounce `reason` /
`diagnostic_message` field names, click URL field name.

**3.5 Tracking flags honoured?** View the raw source of email 1 in the mailbox: with tracking **on**,
ZeptoMail should have rewritten links / added its pixel; send one more with tracking **off** and
confirm the raw source has the original links and no ZeptoMail pixel. Record both.

**3.6 Compare and decide.** The app (`backend/modules/mail/tracking/zeptoWebhook.js`) expects:

| Item | Expected | Captured |
|---|---|---|
| Header | `producer-signature: ts=…;s=…;s-algorithm=HmacSHA256` | |
| ts unit | milliseconds | |
| Signed input | raw body, or decoded single form field | |
| Event names | hardbounce, softbounce, delivered/email_delivered, email_open/open, email_link_click/click, feedback_loop/spam | |
| Message list | `event_message[]` with `request_id` | |
| Our reference | `event_message[].email_info.client_reference` | |
| Time | `event_data[].details[].time` (ms, s or ISO) | |
| Bounce reason | `details[].reason`, `details[].diagnostic_message` | |
| Click URL | `details[].clicked_link` / `link` / `url` | |

All match → sign-off recorded in the ticket → on **staging only** set `ZEPTOMAIL_WEBHOOKS_ENABLED=1`,
restart the staging API, in Mail Center create the webhook URL, save the key, turn it on, point the
ZeptoMail webhook to `https://<staging host>/api/v1/mail/t/webhooks/zeptomail/<token>`, then repeat 3.4
and check in Mail Center → mailbox → Delivery & tracking: Accepted → Delivered; first open; click;
the bounce shows Bounced with a reason and the address appears in the suppression list once
(`audit_logs` action `mail.recipient_suppressed`, no address in metadata); Send test twice → second
is a duplicate. Any mismatch → leave disabled, record the difference; the parser is changed and
re-reviewed first.

Remove the temporary proxy location for `/capture/` afterwards.

## 4. Zoho Campaigns recipient activity (read-only)

**4.1 Probe** an already-sent test campaign (its Zoho campaign key; at most 40 read calls, 1 per 1.5 s):

```bash
cd backend
DEPLOYMENT_ENV=staging node scripts/zohoRecipientsProbe.js --workspace <test workspace id> --campaign-key <key> --max-calls 20
```

Record per action: `topLevelKeys`, `recordFieldNames`, `appParserMatchesRecords` (must be `true` for every
action with records), and `paging.rangeHonoured` / `overlap` (0 expected). `opensCountMeaning` states
whether `opens_count` behaves like unique opens (only conclusive with fewer than 50 opened contacts).
If the probe returns a method/parameter error for the POST call, record the exact error code.

**4.2 Activities.** Confirm each action's records describe what the UI label says (Opened, Clicked,
Hard/Soft bounced, Unsubscribed = `optoutcontacts`, Spam, Not opened, Sent to). Zoho gives no
per-recipient event time for these lists (only `sent_time`); the UI must not show one.

**4.3 Roles.** In the staging UI, Campaigns → the sent campaign → "Show recipient activity": visible
and working for Owner, Admin, Marketing Manager, Approver; hidden for Member, and
`GET /api/v1/mail/campaigns/<id>/recipients?activity=opened` with a Member token returns 403.
Another workspace's token returns 404.

**4.4 Limits.** The app allows 30 lookups/minute per workspace (then 429). Do not run the probe while
a campaign is being sent; Zoho locks the account for 30 minutes after 500 calls in 5 minutes.

## 5. SMTP open/click tracking over HTTPS

Test workspace with an SMTP mailbox (in `STAGING_ALLOWED_MAILBOXES`), tracking on. Compose & Send one
email to `tracking-test+2@<our domain>` whose HTML contains: an ordinary https link, a password-reset
style link (`/reset-password`), a link with `?token=…`, a `mailto:` link, and (Product Emails, if
enabled) the unsubscribe link. Then:
- raw source: only the ordinary link points to `https://<staging host>/api/v1/mail/t/c/<32 hex>`; the
  others are unchanged; one pixel `…/t/o/<32 hex>.gif` before `</body>`;
- open with images on → Delivery & tracking shows a recorded open (estimate); open again within a
  minute → still 1; click the link → lands on the original page (302), one click recorded;
- the saved copy of the email (mailbox view in the app) has no tracking links;
- Delivery shows "Not supported by provider (SMTP)". Record any image-proxy effect (Gmail shows the
  open from Google's proxy, possibly at delivery time).

## 6. Other checks on staging

- Tracking off by default for a new workspace; Member/Approver cannot change it.
- Suppression: in the test workspace, Compose to an address on the suppression list → refused
  (`mail.send_blocked` in the audit log, no address in metadata).
- Retention: `MAIL_TRACKING_RETENTION_DAYS` default 395; the purge runs every 6 h in the API process.

## 7. Rollback (staging)

Unset `ZEPTOMAIL_WEBHOOKS_ENABLED` and restart the API (the webhook then answers 404); in Mail Center
turn the workspace webhook off and tracking off; remove the ZeptoMail webhook entry; remove the
`/capture/` proxy location. Tracking data stays and is purged by retention.

## 8. Sign-off (record in the ticket)

- [x] 0: classification decided (2026-10-28); Compose purpose mechanism still open
- [ ] 1: staging environment exists and `stagingPreflight.js` passes; migration 024 applied to staging only
- [ ] 3.2 ts unit and signed input match the app; 3.3 retry behaviour recorded
- [ ] 3.4 event payloads match (table in 3.6); 3.5 tracking flags honoured
- [ ] 3.6 end-to-end on staging with the webhook enabled
- [ ] 4.1–4.4 Zoho probe, activities, roles and limits
- [ ] 5 SMTP tracking over https
- [ ] Production enablement requested separately (not part of this procedure)
