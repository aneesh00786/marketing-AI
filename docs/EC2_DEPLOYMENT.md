# EC2 Deployment Runbook — Marketech.ai (Mail Center, email tracking, migrations 024–029)

For the operator deploying to one EC2 instance. All values below are placeholders (`<...>`); never
copy a real `.env`, key or password into this document, a ticket or a release archive.
Related: `docs/DEPLOYMENT_SAFETY.md` (settings, backup, restore), `docs/EMAIL_TRACKING_STAGING.md`
(provider verification), `docs/STAGING_RUNBOOK.md`.

Status when this was written: verified locally only (mocked providers, disposable databases).
**No live provider has been verified.** Keep `ZEPTOMAIL_WEBHOOKS_ENABLED` empty until section 8 passes.

## Release checklist (summary)

- [ ] Local: `node scripts/localVerify.js --db mt_rehearsal_<date>` → RESULT: PASS; package built from the release commit
- [ ] EC2: security group has no inbound rule for the API port; nginx is the only proxy; `LISTEN_HOST=127.0.0.1`, `TRUST_PROXY=1`
- [ ] `ZEPTOMAIL_WEBHOOKS_ENABLED` empty; `scripts/checkProductionConfig.js` OK as each service account
- [ ] Services stopped → `scripts/backup.sh` (verified, timestamped) → migrate `--status` (024 to 029 pending, or only what production has not applied yet)
- [ ] `npm run migrate -- --backup=<that dump>` → `--status` all applied (024, then 025, 026, 027, 028, then 029)
- [ ] Services started → health checks and log review (section 7)
- [ ] Rollback plan ready: previous release package + the pre-migration dump (section 10)
- [ ] Live provider checks (section 8) before enabling the webhook or relying on tracking

## 0. Before you start (on your Mac)

```bash
cd backend && node scripts/localVerify.js --db mt_rehearsal_<date>   # must print RESULT: PASS
cd .. && npm run package                                              # "Package OK" (committed HEAD only)
```
Commit everything you intend to ship first; the package is `git archive` of HEAD and excludes
`.env`, storage, logs, dumps and node_modules.

## 1. Topology (supported)

```
Internet ──443──> nginx (TLS, one reverse proxy) ──http://127.0.0.1:<PORT>──> node server.js (API + built frontend)
                                                                            node workers/socialWorker.js (one worker)
MariaDB/MySQL (same instance or RDS) — database <prod db>, user restricted to it
```
- Security group inbound: 443 (and 80 for the TLS redirect/ACME) from anywhere; 22 from your IP only.
  **Not** the API port.
- `LISTEN_HOST=127.0.0.1` so the API port is not reachable even if the security group changes.
- `TRUST_PROXY=1` only with exactly this one-proxy layout. With a load balancer or CDN in front of
  nginx (two hops) it is **not** supported (see DEPLOYMENT_SAFETY 2a); leave it empty and do not
  deploy that layout without a code change.
- Rate limits are in memory per API process: run **one** API process (no cluster mode).

## 2. Server preparation

1. Node.js (same major as local, ≥ 18), MariaDB client tools (`mariadb-dump`/`mysqldump`, `mysql`), nginx, certbot.
2. Two service accounts (e.g. `mkt-api`, `mkt-worker`) or one shared account; code checked out/unpacked
   at `<app dir>` owned by root, readable by the services.
3. Storage folders outside the code, writable by the API (and worker):
   `<data dir>/social-media`, `<data dir>/mail-assets`; logs under `<log dir>` (not inside the code).
4. Database: create `<prod db>` and a user with privileges on that database only
   (`SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, DROP` on `<prod db>.*`);
   a separate backup user (`SELECT, LOCK TABLES, SHOW VIEW, TRIGGER, EVENT` on `<prod db>.*`) with a
   chmod-600 client option file `<backup cnf>`.

## 3. `backend/.env` (production) — placeholders only

```dotenv
NODE_ENV=production
PORT=<api port, e.g. 8000>
LISTEN_HOST=127.0.0.1
TRUST_PROXY=1
APP_BASE_URL=https://<app host>
FRONTEND_URL=https://<app host>
DB_CLIENT=mysql
DB_HOST=<db host>
DB_PORT=3306
DB_USER=<app db user>
DB_PASSWORD=<app db password>
DB_NAME=<prod db>
JWT_SECRET=<openssl rand -base64 48>
SOCIAL_TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32>   # 32 bytes; never change after go-live
SOCIAL_MEDIA_STORAGE_DIR=<data dir>/social-media
MAIL_ASSET_STORAGE_DIR=<data dir>/mail-assets
# Email
ZEPTOMAIL_TOKEN=                       # optional server-wide token (workspace 1 legacy); workspaces store their own
ZOHO_CAMPAIGNS_CLIENT_ID=<from Zoho API console>
ZOHO_CAMPAIGNS_CLIENT_SECRET=<from Zoho API console>
PRODUCT_EMAILS_ENABLED=                # empty = hidden
ZEPTOMAIL_WEBHOOKS_ENABLED=            # EMPTY until section 8 passes
MAIL_TRACKING_RETENTION_DAYS=395
# Never set on production:
# DEPLOYMENT_ENV, PRODUCTION_*, STAGING_*  (staging-only guard settings)
```
- Generate secrets on the server or in a password manager; store them only in `backend/.env`
  (`chmod 600`, owned by the service account) or in AWS Secrets Manager/SSM if you template the file.
- Check as each service account: `sudo -u mkt-api node scripts/checkProductionConfig.js` → OK.

## 4. nginx (one proxy) — example with placeholders

```nginx
server {
  listen 443 ssl http2;
  server_name <app host>;
  ssl_certificate     /etc/letsencrypt/live/<app host>/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/<app host>/privkey.pem;
  client_max_body_size 60m;                     # media/ZIP template uploads
  location / {
    proxy_pass http://127.0.0.1:<api port>;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;   # overwrite: clients cannot inject addresses
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 120s;
  }
}
server { listen 80; server_name <app host>; return 301 https://$host$request_uri; }
```
Public endpoints that must stay reachable through the proxy (they are designed for it):
`/api/v1/mail/t/o/*.gif` (open pixel), `/api/v1/mail/t/c/*` (tracked links),
`/api/v1/mail/t/webhooks/zeptomail/*` (404 while disabled), `/api/v1/mail/unsubscribe/*`,
`/api/v1/outreach/unsubscribe/*`, `/api/v1/mail/assets/*`, `/api/v1/mail/campaigns/content/*`,
`/api/v1/mail/zoho/callback`, OAuth callbacks. No path-based blocking is needed beyond TLS.

## 5. Processes (systemd example)

```ini
# /etc/systemd/system/marketech-api.service
[Service]
User=mkt-api
WorkingDirectory=<app dir>/backend
ExecStart=/usr/bin/node server.js
Restart=on-failure
StandardOutput=append:<log dir>/api.log
StandardError=append:<log dir>/api.log
[Install]
WantedBy=multi-user.target
```
Same for `marketech-worker.service` with `ExecStart=/usr/bin/node workers/socialWorker.js` and
`User=mkt-worker`. Exactly one worker.

## 6. Release with migrations 024 to 029

Order matters: 024 (tracking tables), 025 (Compose purpose columns, capability grants), then 026
(`mail_provider_apps`: the Zoho API client entered in Mail Center → Settings, secret encrypted with
`SOCIAL_TOKEN_ENCRYPTION_KEY`), then 027 (`mail_campaign_contacts`: contacts selected for a campaign, and
three `contact_list_*` columns on `mail_campaigns`). After 027, reconnect Zoho once per workspace to grant
`ZohoCampaigns.contact.CREATE`; until then list-only campaigns keep working and selected contacts are refused
with a reconnect message. 028 adds the global CRM as new tables only (`crm_*`, with no `workspace_id`). Only the
platform admin (the Owner of workspace 1, `admin@tradesage.ai`) can open the CRM at first. Everyone else needs a
grant: `npm run crm-access -- grant <email> manager` (roles: viewer, sales,
support, manager; `list` and `revoke` also exist). To remove it, follow the rollback note in
`backend/migrations/028_global_crm.js`. 029 adds the call log (`crm_call_logs`); audio is never stored. All are additive; the runner applies them in order and records each in `schema_migrations`.

```bash
cd <app dir>/backend
sudo systemctl stop marketech-worker marketech-api
# 1. Back up (verified, timestamped; media folders too)
MYSQL_DEFAULTS_FILE=<backup cnf> scripts/backup.sh <prod db> <backup root>
# 2. Install the new release (unpacked package or git checkout of the released commit), then
npm ci --omit=dev
npm run migrate -- --status                 # expect: 024 to 029 [pending], nothing else
npm run migrate -- --backup=<backup root>/<prod db>-<timestamp>/<prod db>.sql   # <dir> from backup.sh's "Backup complete: <dir>" line + /<prod db>.sql
npm run migrate -- --status                 # expect: all [applied]
# 3. Start
sudo systemctl start marketech-api && sudo systemctl start marketech-worker
```
`NODE_ENV=production` refuses to migrate without a fresh (< 24 h), complete backup of this database
whose recorded migrations match the database; do not bypass it.

## 7. Post-deployment checks

```bash
curl -fsS https://<app host>/api/status | jq '.status, .features'   # "online", {productEmails: ...}
curl -sI https://<app host>/api/v1/mail/t/o/$(openssl rand -hex 16).gif   # 200 image/gif
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<app host>/api/v1/mail/t/webhooks/zeptomail/$(openssl rand -hex 16)   # 404 (disabled)
curl -s -o /dev/null -w '%{http_code}\n' http://<ec2 public ip>:<api port>/api/status            # must fail (port closed)
```
- Sign in from two networks; `audit_logs.ip_address` must show the real public addresses (not 127.0.0.1).
- Mail Center → Overview: tracking off by default; Members: no "Transactional email" grants exist.
- Logs (first minutes after start, then daily):
  ```bash
  sudo systemctl status marketech-api marketech-worker --no-pager
  tail -n 200 <log dir>/api.log          # "Running on", no "Refusing to start", no stack traces
  grep -iE "error|refus|BACKUP_REQUIRED|staging guard" <log dir>/api.log | tail -n 50
  mysql --defaults-extra-file=<backup cnf> <prod db> -e "SELECT worker_kind, worker_id, beat_at FROM worker_heartbeats"   # updated within a minute
  mysql --defaults-extra-file=<backup cnf> <prod db> -e "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 3"
  ```

Troubleshooting: 502 from nginx → API not running or wrong port/`LISTEN_HOST`; every request rate
limited from one IP → `TRUST_PROXY` missing behind nginx; `BACKUP_REQUIRED` → take a new backup;
`MARKETING_PROVIDER_BLOCKED` on Drafts/sequences → the workspace needs an SMTP mailbox approved for
marketing (Mail settings); pixel/link URLs pointing at localhost → `APP_BASE_URL` not the https host.

## 8. Provider setup and verification (production or staging; test accounts only)

Follow `docs/EMAIL_TRACKING_STAGING.md` sections 3–5. In short:
- **ZeptoMail**: run `scripts/zeptoWebhookCapture.js --staging` behind the proxy, configure the Mail
  Agent webhook with authentication, click *Send test*, confirm ts unit, signed input, event fields,
  `client_reference`, retries (respond 500/429). Only if everything matches the table in section 3.6:
  set `ZEPTOMAIL_WEBHOOKS_ENABLED=1`, restart the API, create the workspace webhook URL in Mail Center,
  save the key, turn it on. Any mismatch: leave it off.
- **Browser calling**: set `TELNYX_WEBRTC_API_KEY`, `TELNYX_WEBRTC_CONNECTION_ID`, `TELNYX_CALLER_ID` and
  `TELNYX_CALLER_NAME`, then place one call to your own phone. Browsers allow the microphone only over https.
  Only users with CRM access that includes contacts (sales, support, manager, or the platform admin) can call.
  Transcripts use the same key and are made only when the caller ticks "Transcribe this call"; check the rules on
  recording and telling customers for each country you call.
- **Zoho contact sync**: reconnect Zoho, then send a campaign to 2–3 of your own addresses and confirm in Zoho
  that a private "Marketech campaign …" list appears, whether Zoho sent those addresses a confirmation email,
  and that the campaign reached them. Keep the first real audience small.
- **Zoho Campaigns**: API console client (redirect URI `https://<app host>/api/v1/mail/zoho/callback`),
  connect a workspace, then `scripts/zohoRecipientsProbe.js` on one already-sent campaign (staging
  guard) — or compare the Campaigns → recipient activity panel with Zoho's own report.
- **SMTP tracking**: a mailbox approved for marketing (Mail settings → marketing approval), tracking
  on, one test email to a mailbox you control; check pixel/redirect over https and that reset,
  unsubscribe, `mailto:` and secret-bearing links are unchanged in the raw source.

## 9. Privacy and consent (before turning tracking on)

- Open/click tracking is off by default; turn it on only if your privacy notice discloses it and,
  where required (e.g. GDPR/ePrivacy), you have consent. Product emails and drafts track opens/clicks
  only for leads with verified consent; delivery outcomes are always recorded.
- Tracking data retention: `MAIL_TRACKING_RETENTION_DAYS` (default 395); it is deleted with the
  workspace. Recipient addresses in the Compose report are masked; no message content is stored there.
- Marketing email needs an SMTP mailbox your provider allows for marketing; ZeptoMail is transactional
  only and is never used for marketing.

## 10. Rollback

- **Code only (preferred)**: 024 to 029 are additive and older code ignores the new tables/columns, so
  redeploy the previous release and restart; no database change needed. Turn off
  `ZEPTOMAIL_WEBHOOKS_ENABLED` first if it was on.
- **Database** (only if data must be reverted): stop both services, restore the pre-migration backup
  per DEPLOYMENT_SAFETY section 5 (data written after the backup is lost), redeploy the previous
  release, start. Rehearsed locally by `scripts/localVerify.js` ("rollback rehearsal").
