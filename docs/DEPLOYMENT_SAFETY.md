# Deployment Safety — Marketech.ai

Covers packaging, migrations, media storage, backups and the production settings the API and worker
enforce. Platform test steps are in `SOCIAL_MEDIA_INTEGRATION_TEST_PLAN.md`.

## 1. Packaging

```bash
npm run package                      # from the repository root (macOS/Linux/Windows)
powershell -File create_zip.ps1      # Windows; runs the same script
```

- The archive is built with `git archive` from **committed** code only (`release/marketing-AI-<commit>.zip`).
  Commit what you intend to ship; uncommitted changes are not packaged (the script says so).
- `.env`, `backend/storage/` (uploaded media), logs, databases, dumps, archives, keys and `.git` are never
  included. The script lists the finished archive and deletes it if any such entry appears.
- Never share a hand-made zip of the project folder: it can contain `.env`, media and the full git history.

## 2. Production settings (`backend/.env`)

| Setting | Required value | Enforced at startup |
|---|---|---|
| `NODE_ENV` | `production` | turns the checks below into hard failures |
| `APP_BASE_URL` | public `https://` address of the API (not localhost/private) | API and worker refuse to start |
| `FRONTEND_URL` | public `https://` address of the app | — |
| `SOCIAL_MEDIA_STORAGE_DIR` | **absolute** path outside the code folder, writable by the API and worker users | API and worker refuse to start |
| `MAIL_ASSET_STORAGE_DIR` | absolute path outside the code folder (email template images), writable by the API | API and worker refuse to start |
| `JWT_SECRET` | ≥ 32 random characters | API and worker refuse to start |
| `SOCIAL_TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64 (or 64 hex); **never change after go-live** | API and worker refuse to start if missing or malformed; `node scripts/verifyEncryptedSecrets.js` proves it is the *right* key |
| `DB_*` | production database | — |

Both processes print `Social media storage: <absolute path>` at startup; the two lines must match.

## 3. Migrations

Where migrations run:

| Path | Behaviour |
|---|---|
| `npm run migrate` / `node db/migrate.js` | Applies pending migrations. **With `NODE_ENV=production` it refuses unless `--backup=<dump>` is a mysqldump/mariadb-dump that (a) names this database, (b) is less than 24 hours old, (c) ends with the "Dump completed" line (failed or truncated dumps are refused) and (d) records exactly the migrations applied to this database now (a dump of another copy or an older state is refused).** It does not prove the dump restores; the restore drill (section 5) does. |
| `start.bat`, `run.bat`, `run.ps1` | Run `seed.js`, then `db/migrate.js`, then start the worker and API. In production the migration step stops the script when migrations are pending and no backup was given, so the app does not start half-migrated. |
| `node server.js` / `npm start`, `npm run worker` | Never migrate. With `NODE_ENV=production` the API and the worker **refuse to start while migrations are pending**; otherwise they warn. |
| `npm run migrate:status` | Read-only list of applied/pending migrations. |

`seed.js` creates missing tables/columns and, in production, only first-install records (workspace,
admin user, membership, agent). Demo leads, emails, mail settings, appointments and content are seeded
only outside production, and only into empty tables.

Migration 023 (`023_social_media_library`) is additive: 10 nullable/defaulted columns on `assets`,
2 on `content_items`, 3 indexes and the `social_post_templates` table. It was verified against a
structural copy of the current database. There is no down-migration; older code ignores the new columns.

Deployment order:

```bash
# 1. stop the worker, then the API
# 2. back up (section 4) — keep the dump path
cd backend
npm run migrate:status                         # expect only the migrations you are deploying
npm run migrate -- --backup=/backups/tradesage-<stamp>.sql
npm run migrate:status                         # expect nothing pending
# 3. start the API, then the worker (one worker; under a process manager)
```

## 4. Backup

Back up these together; they belong to the same point in time:

1. **Database** (all records, including which media files exist).
2. **`SOCIAL_MEDIA_STORAGE_DIR`** and **`MAIL_ASSET_STORAGE_DIR`** (the files).
3. **`backend/.env`** — at minimum `SOCIAL_TOKEN_ENCRYPTION_KEY`. Store it separately and securely,
   not next to the dump: without it the stored OAuth tokens and mailbox passwords cannot be decrypted;
   with it, anyone holding the dump can decrypt them.

Consistency: stored files are never modified, only added or deleted. Take the database dump first and
copy the folders afterwards; with the API and worker stopped (or at least no uploads/deletes in between)
every file the dump refers to is in the copy.

```bash
# Linux (adjust paths); Windows XAMPP: C:\xampp\mysql\bin\mysqldump.exe and robocopy <src> <dst> /MIR
STAMP=$(date -u +%Y%m%d-%H%M)
mysqldump --single-transaction --triggers --default-character-set=utf8mb4 \
  -u <user> -p tradesage > /backups/tradesage-$STAMP.sql \
  || { echo "BACKUP FAILED - do not migrate"; exit 1; }
tail -c 200 /backups/tradesage-$STAMP.sql | grep -q "Dump completed" || { echo "BACKUP INCOMPLETE"; exit 1; }
rsync -a "$SOCIAL_MEDIA_STORAGE_DIR/" /backups/social-media-$STAMP/
rsync -a "$MAIL_ASSET_STORAGE_DIR/"   /backups/mail-assets-$STAMP/
```

`--routines` is omitted on purpose: the application defines no stored procedures, functions or
triggers, and on the current XAMPP MariaDB (10.4.28) `--routines` fails with "Column count of
mysql.proc is wrong … use mysql_upgrade". A DBA should run `mysql_upgrade` on that server; until then,
always check the dump command's exit status — a failed dump still leaves a file behind.

No backup automation exists in this repository; schedule the commands above (daily, plus before
every deployment) and copy them off the server.

## 5. Restore

1. Stop the worker, then the API (nothing may publish or upload during a restore).
2. Restore the database from the dump (into an empty database of the same name).
3. Restore the media folders to the **same absolute paths** as `SOCIAL_MEDIA_STORAGE_DIR` /
   `MAIL_ASSET_STORAGE_DIR`, owned by the user the API and worker run as.
4. Restore `backend/.env` with the **same** `SOCIAL_TOKEN_ENCRYPTION_KEY`.
5. Verify, read-only:
   ```bash
   cd backend
   npm run migrate:status
   node scripts/verifyMediaStorage.js      # exit 1 lists media recorded in the database but missing on disk
   node scripts/verifyEncryptedSecrets.js  # exit 1 if any stored credential cannot be decrypted with this key
   ```
   Missing files do not cause bad posts: a post using one fails with `MEDIA_MISSING` before anything
   is sent. Re-upload the file and attach it, or restore the folder from a newer copy.
6. Start the API, then the worker. Check the Publishing Queue for `queued` jobs whose time has passed:
   they will publish as soon as the worker starts — cancel any that should not.

### Staging restore drill (do this once before go-live, and after any backup-process change)

On a **staging** server whose `backend/.env` has its own `DB_NAME` (never the production database):

```bash
# 1. Take a backup on production exactly as in section 4 (database dump + both media folders + key).
# 2. Copy the dump, the two media folders and SOCIAL_TOKEN_ENCRYPTION_KEY to staging.
mysql -u <user> -p -e "CREATE DATABASE tradesage_staging DEFAULT CHARACTER SET utf8mb4"
mysql -u <user> -p tradesage_staging < tradesage-<stamp>.sql
rsync -a social-media-<stamp>/ "$SOCIAL_MEDIA_STORAGE_DIR/"
rsync -a mail-assets-<stamp>/  "$MAIL_ASSET_STORAGE_DIR/"
cd backend                                   # staging .env: DB_NAME=tradesage_staging, same key
npm run migrate:status                       # same applied list as production
node scripts/verifyMediaStorage.js           # expect 0 missing / 0 damaged
node scripts/verifyEncryptedSecrets.js       # expect 0 unreadable
# 3. Compare table row counts with production (SELECT COUNT(*) per table) — expect equality.
# 4. Optionally rehearse the deployment: npm run migrate -- --backup=<a fresh dump of tradesage_staging>
```

Do not start the worker on a staging copy of production data unless its social accounts are
disconnected first: queued jobs would publish to the real accounts.

## 5a. Operations: schedule, retention, rollback, roles

**Schedule and retention (recommended; none of this is automated or verified yet):**
- Database dump + both media folders: daily, plus immediately before every deployment or migration.
- Keep 7 daily, 4 weekly and 3 monthly copies. Keep the pre-migration dump of each release until the next release is stable.
- Copy every backup off the server (another region/provider), encrypted at rest, readable only by the
  operators who restore. Check weekly that the newest off-site copy exists and its dump ends with "Dump completed".
- Run the staging restore drill (above) quarterly and after any change to the backup process.

**Encryption key recovery:** keep `SOCIAL_TOKEN_ENCRYPTION_KEY` in a password manager or secret store
with at least two named owners, separate from the database backups. If it is lost, stored OAuth tokens,
provider app secrets and mailbox passwords cannot be recovered: every social account, provider app,
Zoho connection and mailbox must be reconnected/re-entered. Never "fix" a lost key by setting a new one
on a database with existing credentials — `verifyEncryptedSecrets.js` will show them all unreadable.

**Resuming after a restore or long outage:** start the API first; open Publishing Queue → filter Queued
and check every job whose time has passed (they publish as soon as the worker starts — cancel any that
should not), and Needs attention. Check Mail Center → Product Emails for batches in Sending. Then start
the worker.

**Rollback of the Social Media release (migration 023):**
1. Prefer rolling back **code only**: 023 is additive and the previous release ignores the new columns
   and table. Before switching code, cancel scheduled posts that use uploaded media (Media Library
   files) — the previous release cannot publish uploaded files — and let `processing` jobs finish.
2. Restoring the pre-migration dump is a last resort (e.g. the migration itself failed): it discards
   everything created after the dump. Stop both processes, restore (section 5), then start the previous
   release. Uploaded files can stay on disk; nothing refers to them after such a restore.
3. A partially applied 023 (MariaDB DDL is not transactional) is completed by re-running
   `npm run migrate -- --backup=<fresh dump>`; every step is idempotent.

**Who does what:**
| Task | Role |
|---|---|
| Backups, restore drill, `mysql_upgrade`, migration run | DBA / production operator |
| `.env` values, storage folders and permissions, HTTPS, process manager | Production operator |
| Meta/LinkedIn/Google app approvals, OAuth redirect URIs, test accounts | Platform administrator |
| Commit approval, release decision, live-test authorization | Product owner |

## 6. Platform approvals (manual, per platform)

| Platform | Needed before customers publish |
|---|---|
| Meta (Facebook/Instagram) | App Review approval for `pages_manage_posts`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`, `read_insights`, `business_management`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`; Business Verification; app switched to Live; redirect URI `<APP_BASE_URL>/api/v1/social/oauth/meta/callback`. |
| LinkedIn | Community Management API product approved for the app; scopes `r_organization_social`, `w_organization_social`, `rw_organization_admin`; redirect URI `<APP_BASE_URL>/api/v1/social/oauth/linkedin/callback`. |
| Google (YouTube) | YouTube Data API v3 enabled; OAuth consent screen verified for `youtube.readonly` and `youtube.force-ssl` (sensitive scopes); **YouTube API compliance audit** — until it passes, uploads are locked private; quota increase if more than ~5 uploads/day are expected (each upload ≈ 1,600 of 10,000 default units). |

These scopes are the ones the code requests today; they were not changed in this review.

## 7. Deployment checklist

- [ ] Work committed; `npm run package` reports "Package OK".
- [ ] Backend tests, frontend tests and production build pass on the release commit.
- [ ] `backend/.env` on the server: `NODE_ENV=production`, https `APP_BASE_URL`/`FRONTEND_URL`, absolute
      `SOCIAL_MEDIA_STORAGE_DIR` and `MAIL_ASSET_STORAGE_DIR` outside the code folder, unchanged encryption key.
- [ ] Database dump and media copies taken and copied off the server; restore tested once on staging.
- [ ] Worker and API stopped; `npm run migrate -- --backup=<dump>`; status shows nothing pending.
- [ ] Under each service account: `sudo -u <api-user> node scripts/checkProductionConfig.js` and the same for the
      worker account — both print the same storage folder and "OK" (permissions are checked as that account).
- [ ] API and worker started; both log the same storage folder and no configuration errors.
- [ ] `node scripts/verifyMediaStorage.js` reports 0 missing.
- [ ] Publishing Queue reviewed for overdue `queued` jobs.
- [ ] **Requires manual approval / live staging:** platform approvals (section 6), and the integration test
      plan passed on staging for each platform offered. Live platform behaviour has not been verified.
