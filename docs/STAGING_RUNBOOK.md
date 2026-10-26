# Staging Runbook — Marketech.ai Phase 8–9

Release under test: commits `cdc6268` (Social Media) and `e6494d2` (deployment safety), plus the staging
tooling described here. Status: **ready for staging; staging has not been run.** Every box below is
open until an operator ticks it on the real staging server.

Legend — **[auto]** verified by automated tests or local drills on disposable databases ·
**[staging]** must be done on the staging server · **[DBA]** · **[platform admin]** · **[owner]** human approval.

## 0. Prerequisites

| # | Item | Owner |
|---|---|---|
| P1 | A staging host (Linux, bash ≥ 3.2, Node 20+ matching production, MariaDB client tools **of the same version as the staging server**) | Operator |
| P2 | A public HTTPS hostname for staging (e.g. `staging.<domain>`), different from production | Operator |
| P3 | A staging MariaDB database (e.g. `tradesage_staging`) on a server that is **not** the production server, and DB credentials that cannot reach the production database | DBA |
| P4 | Two service accounts, e.g. `mkt-api` and `mkt-worker` (or one shared account) and a process manager (systemd/pm2) | Operator |
| P5 | Dedicated test accounts per platform (section 6) — never customer or production accounts | Platform admin |
| P6 | The production backup (if staging should start from production data) and the encryption key from the secret store | DBA / owner |

## 1. Staging setup checklist

- [ ] **Code** [staging]: deploy the package built by `npm run package` (commit `e6494d2` or later); `npm ci` in `backend/`.
- [ ] **HTTPS** [staging]: TLS terminates for the staging hostname; `curl -sSI https://<staging-host>/api/status` returns 200.
- [ ] **`backend/.env`** [staging] — required values (never copy production values except the encryption key when restoring production data):

  | Setting | Staging value |
  |---|---|
  | `NODE_ENV` | `production` (so every production safeguard is active) |
  | `DEPLOYMENT_ENV` | `staging` (adds the staging guard; **never set in production**) |
  | `APP_BASE_URL`, `FRONTEND_URL` | `https://<staging-host>` |
  | `PRODUCTION_DB_NAME` | the production database name (default `tradesage`) |
  | `PRODUCTION_DB_HOSTNAME` | **required** — the production database server's `@@hostname` (DBA: `SELECT @@hostname`); without it every staging-only operation refuses |
  | `PRODUCTION_APP_HOST` | **required** — the production app hostname; without it every staging-only operation refuses |
  | `DB_HOST`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` | the staging database only |
  | `SOCIAL_MEDIA_STORAGE_DIR` | absolute, e.g. `/srv/marketech-staging/media/social` |
  | `MAIL_ASSET_STORAGE_DIR` | absolute, e.g. `/srv/marketech-staging/media/mail` |
  | `JWT_SECRET` | ≥ 32 random characters, **different from production** |
  | `SOCIAL_TOKEN_ENCRYPTION_KEY` | the production key only if production data is restored; otherwise a new staging key |
  | `ZEPTOMAIL_TOKEN` | **empty** (or a sandbox token with `STAGING_ALLOW_ZEPTOMAIL=1`) |
  | `STAGING_ALLOWED_SOCIAL_ACCOUNTS` | external ids of the dedicated test Page/IG account/LinkedIn Page/channel (comma-separated) |
  | `STAGING_ALLOWED_MAILBOXES` | sender address of a test mailbox, if mail is tested |
  | Meta / LinkedIn / Google app credentials | staging apps with the staging redirect URIs (section 6) |
  | Telnyx / ElevenLabs keys | leave empty unless explicitly testing voice |

- [ ] **Media folders and permissions** [staging]:
  ```bash
  sudo install -d -o mkt-api -g mkt-media -m 2770 /srv/marketech-staging/media/social /srv/marketech-staging/media/mail
  sudo usermod -aG mkt-media mkt-worker        # the worker reads social media files to upload them
  ```
- [ ] **Configuration check under each account** [staging] — prints problems, never values; exit 0 = OK:
  ```bash
  cd backend
  sudo -u mkt-api    node scripts/checkProductionConfig.js
  sudo -u mkt-worker node scripts/checkProductionConfig.js   # same storage folder printed, "OK"
  node scripts/stagingPreflight.js                            # exit 0 = staging-safe
  ```
- [ ] **Logs** [staging]: API and worker logs readable by the operator (`journalctl -u marketech-api -u marketech-worker`
  or pm2 logs), rotated, and **not** world-readable. Startup lines to look for: `Social media storage: <path>` (same
  in both), no `Configuration error`, no `Staging guard:` refusals.

## 2. Backup checklist (production or staging)

Use `backend/scripts/backup.sh` [auto: exercised end to end and on failure paths on disposable databases]. It stops at the first error,
writes `<db>.sql.partial` and renames it only when the dump ends with "Dump completed" and names the database,
copies both media folders, checks file counts, and writes `SHA256SUMS`.

```bash
# once: a client option file readable only by the backup user (keeps the password off the command line)
install -m 600 /dev/null /root/.marketech-backup.cnf
printf '[client]\nhost=%s\nuser=%s\npassword=%s\n' "<db-host>" "<db-user>" "<password>" > /root/.marketech-backup.cnf

cd backend
MYSQL_DEFAULTS_FILE=/root/.marketech-backup.cnf MARIADB_BIN_DIR=<dir of tools matching the server> \
  scripts/backup.sh <database> /var/backups/marketech
```

- [ ] Exit status 0 and "Backup complete" [DBA]. Non-zero = no usable backup (the `.partial` file is not a backup).
- [ ] `MARIADB_BIN_DIR` points at tools of the **server's** version (newer `mariadb-dump` writes a first line older
      servers reject) [DBA].
- [ ] `--routines` is not used: the app has no routines; on the current XAMPP MariaDB 10.4.28 it fails until a DBA
      runs `mysql_upgrade` [DBA].
- [ ] The backup directory is copied off the server (encrypted, access-controlled); retention 7 daily / 4 weekly /
      3 monthly; pre-migration backups kept until the next release is stable [DBA]. **Not set up yet.**
- [ ] The encryption key is **not** in the backup; it is in the secret store with two named owners [owner].

## 3. Restore checklist (staging only)

`backend/scripts/staging-restore.sh` [auto: end to end and failure paths on disposable databases with the previous
guard; the stricter guard (required production identifiers, case-insensitive names, open-database check) is covered
by unit tests and must be re-drilled — see the release notes] runs
`stagingPreflight.js --restore-target`, verifies `SHA256SUMS` and the dump trailer, refuses non-empty media folders,
creates the target database (fails if it exists), imports, restores both folders with file-count checks, then runs
`migrate --status`, `verifyMediaStorage.js` and `verifyEncryptedSecrets.js`. It stops at the first failure.

```bash
cd backend                                   # staging .env: DEPLOYMENT_ENV=staging, staging media paths, same key
MYSQL_DEFAULTS_FILE=/root/.marketech-restore.cnf MARIADB_BIN_DIR=<tools matching the staging server> \
  scripts/staging-restore.sh /var/backups/marketech/<db>-<stamp> tradesage_staging
```

- [ ] Exit 0 and "Restore verified": 0 missing/damaged media, 0 unreadable credentials [staging].
- [ ] Row counts: compare `SELECT COUNT(*)` per table between the restored database and the source at backup time
      (DBA) — expect equality [DBA].
- [ ] Missing-media check [auto]: a post whose file is missing fails with `MEDIA_MISSING` before any platform request.
- [ ] Production untouched: the preflight refuses the production database name (in any letter case — MariaDB on
      macOS/Windows treats `TRADESAGE` as `tradesage`), the production server (`PRODUCTION_DB_HOSTNAME`, required),
      a non-empty target, and a missing staging marker [auto: unit tests].

## 4. Neutralize copied production integrations (before starting anything on staging data)

A copy of production holds live production social accounts, mailbox passwords, Zoho connections, queued posts,
product-email batches, outreach campaigns and automations. **Do not disconnect them in the app**: that revokes the
grant at Meta/LinkedIn/Google and breaks production. Instead [auto: tested on a disposable copy]:

```bash
cd backend
node scripts/stagingNeutralize.js            # dry run: lists what would change
node scripts/stagingNeutralize.js --confirm  # disconnects locally (no provider call), clears mailbox passwords,
                                             # disconnects Zoho, cancels queued posts, stops batches/outreach/automation
node scripts/stagingPreflight.js             # must print "OK" (exit 0)
```

The API and worker themselves refuse to start on staging while any such integration remains [auto].

## 5. Start and verify staging

```bash
cd backend
node scripts/stagingPreflight.js && npm run migrate:status          # expect 023 pending on a 022 copy
MYSQL_DEFAULTS_FILE=/root/.marketech-restore.cnf scripts/backup.sh tradesage_staging /var/backups/marketech-staging  # fresh dump for the guard
NODE_ENV=production npm run migrate -- --backup=/var/backups/marketech-staging/tradesage_staging-<stamp>/tradesage_staging.sql
npm run migrate:status                                              # nothing pending
# start the API (process manager), check its log, then:
# Publishing Queue → Queued: cancel anything overdue that should not run; then start the worker.
```

Verification criteria:
- [ ] API and worker logs show the same storage folder, no configuration errors, no staging-guard refusals.
- [ ] `https://<staging-host>` loads; login works; Social → Media Library uploads a JPEG and an MP4 (verified, sizes shown).
- [ ] Overdue posts on demo accounts end `failed` with `DEMO_ACCOUNT` and no platform request [auto].
- [ ] Only allowlisted test accounts are connected.

## 6. Platform-by-platform checklist

For each platform: **A** approvals, **B** configuration, **C** mocked tests that already pass [auto],
**D** live staging tests (dedicated test accounts only; record post id, URL and a screenshot) [staging].
Full live steps: `SOCIAL_MEDIA_INTEGRATION_TEST_PLAN.md`.

### Facebook Page
- **A** [platform admin]: Meta app (staging), App Review for `pages_manage_posts`, `pages_read_engagement`,
  `pages_read_user_content`, `pages_manage_engagement`, `read_insights`, `business_management`; or development
  mode with the tester as an app role. Business Verification before customers.
- **B**: `META_APP_ID`/`META_APP_SECRET` or the workspace provider app; redirect
  `https://<staging-host>/api/v1/social/oauth/meta/callback`; test Page id in `STAGING_ALLOWED_SOCIAL_ACCOUNTS`.
- **C**: text/link/photo/multi-photo publishing; failed unpublished photo upload is retried, not "unknown";
  video upload is `processing` until ready; expired token → reconnect; rate limit honours Retry-After;
  unknown outcome → needs_review; two workers never double-publish.
- **D**: text, link, 1 photo, 3 photos, video (watch `processing on platform` → published); photo + link refused
  before publishing; revoke the app → AUTH_EXPIRED and reconnect guidance; analytics after 24–48 h.

### Instagram (Professional account linked to the Page)
- **A**: `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `instagram_manage_comments`.
- **B**: `APP_BASE_URL` public HTTPS (Instagram downloads files from it); IG account id allowlisted.
- **C**: container flow for image, Reel and carousel (order kept); still-processing containers never published;
  only `media_publish` can be ambiguous; PNG refused (JPEG only); aspect/duration/codec rules.
- **D**: single JPEG, carousel of 2 (order matches), Reel (9:16, H.264/AAC, 3–15 min); PNG and HTTP base URL refused.

### LinkedIn Page
- **A**: Community Management API product approved; scopes `r_organization_social`, `w_organization_social`,
  `rw_organization_admin`; the tester is a Page admin.
- **B**: app credentials; redirect `https://<staging-host>/api/v1/social/oauth/linkedin/callback`; organization id allowlisted.
- **C**: images posted only after AVAILABLE; multi-image with alt text; video parts uploaded with ETags,
  finalized, posted after AVAILABLE; token refresh.
- **D**: text, link, 1 image with alt text, 3 images, video with title; token expiry/refresh behaviour.

### YouTube channel
- **A**: Google Cloud project, YouTube Data API v3, OAuth consent (sensitive scopes `youtube.readonly`,
  `youtube.force-ssl`), the tester as a test user; **compliance audit** (until then uploads are private);
  quota (≈1,600 units per upload of 10,000/day default).
- **B**: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; redirect `https://<staging-host>/api/v1/social/oauth/youtube/callback`;
  channel id allowlisted.
- **C**: resumable upload; dropped upload → needs_review; `uploaded` → processing → processed; rejected/failed →
  failed and a retry uploads again; privacy override reported; quota errors wait until midnight Pacific.
- **D**: one unlisted upload (expect the "set to private" note before the audit); duplicate upload rejected;
  ≤ 5 uploads per day.

### All platforms [staging]
- [ ] Scheduling in `Asia/Kolkata` publishes at the right instant; restart API + worker before the time → still publishes once.
- [ ] Approval required; demoted approver → APPROVAL_REQUIRED; Member cannot publish.
- [ ] Kill the worker mid-upload → `needs_review` within ~10 min, never retried automatically; two workers → one post.

## 7. Who must act

| Action | Who |
|---|---|
| Provision staging host, HTTPS, service accounts, process manager, log access | Operator |
| Staging database, credentials, backup off-site copy and retention, `mysql_upgrade` | DBA |
| Staging apps, redirect URIs, app review/verification/audit, dedicated test accounts | Platform admin |
| Authorize live test posts, approve production review | Owner |

Staging is **not** passed until sections 1–6 are ticked on the real staging server with evidence.
