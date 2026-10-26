#!/usr/bin/env bash
# Restores a scripts/backup.sh directory into a NEW staging database and EMPTY media folders, then
# runs the read-only verification. Staging only: refuses unless scripts/stagingPreflight.js passes
# (DEPLOYMENT_ENV=staging, target is not the production database name and is empty or absent).
#
#   MYSQL_DEFAULTS_FILE=/root/.marketech-restore.cnf scripts/staging-restore.sh <backup-dir> <target-database>
#
# Run from backend/ with the staging API and worker stopped. The media folders restored into are
# SOCIAL_MEDIA_STORAGE_DIR and MAIL_ASSET_STORAGE_DIR from the staging backend/.env; they must be
# empty. Stops at the first error.
set -euo pipefail
umask 027

: "${MYSQL_DEFAULTS_FILE:?Set MYSQL_DEFAULTS_FILE to a chmod-600 option file with [client] host/user/password}"
SRC="${1:?Usage: staging-restore.sh <backup-dir> <target-database>}"
TARGET="${2:?Usage: staging-restore.sh <backup-dir> <target-database>}"
[[ "$TARGET" =~ ^[A-Za-z0-9_]+$ ]] || { echo "Invalid database name: $TARGET" >&2; exit 1; }
cd "$(dirname "$0")/.."
if [ -n "${MARIADB_BIN_DIR:-}" ]; then MYSQL_BIN="$MARIADB_BIN_DIR/mysql"; [ -x "$MYSQL_BIN" ] || MYSQL_BIN="$MARIADB_BIN_DIR/mariadb"; else MYSQL_BIN="$(command -v mariadb || command -v mysql || true)"; fi
[ -n "$MYSQL_BIN" ] || { echo "mariadb/mysql client not found" >&2; exit 1; }
if command -v sha256sum >/dev/null; then SHA=(sha256sum -c --quiet); else SHA=(shasum -a 256 -c --quiet); fi

shopt -s nullglob
DUMPS=("$SRC"/*.sql)
[ "${#DUMPS[@]}" -eq 1 ] || { echo "Expected exactly one .sql dump in $SRC (found ${#DUMPS[@]})" >&2; exit 1; }
DUMP="${DUMPS[0]}"
echo "1/6 Staging preflight for restore target $TARGET"
node scripts/stagingPreflight.js --restore-target "$TARGET"

echo "2/6 Checking backup integrity (SHA256SUMS)"
( cd "$SRC" && "${SHA[@]}" SHA256SUMS )
TAIL="$(tail -c 200 "$DUMP")"
[[ "$TAIL" == *"-- Dump completed"* ]] || { echo "Dump is incomplete; refusing" >&2; exit 1; }

PATHS="$(node scripts/printMediaPaths.js)"
SOCIAL_DIR="$(printf '%s\n' "$PATHS" | sed -n 1p)"
MAIL_DIR="$(printf '%s\n' "$PATHS" | sed -n 2p)"
for d in "$SOCIAL_DIR" "$MAIL_DIR"; do
  [[ "$d" == /* ]] || { echo "Media folder path is not absolute: '$d'" >&2; exit 1; }
done
count_files() { if [ -d "$1" ]; then find "$1" -type f ! -name '.write-check-*' | wc -l | tr -d ' '; else echo 0; fi; }
for d in "$SOCIAL_DIR" "$MAIL_DIR"; do
  if [ -d "$d" ] && [ -n "$(ls -A "$d" 2>/dev/null)" ]; then echo "Media folder $d is not empty; refusing to overwrite" >&2; exit 1; fi
done

echo "3/6 Creating database $TARGET (fails if it already exists)"
"$MYSQL_BIN" --defaults-extra-file="$MYSQL_DEFAULTS_FILE" -e "CREATE DATABASE \`$TARGET\` DEFAULT CHARACTER SET utf8mb4"
echo "4/6 Importing $(basename "$DUMP")"
"$MYSQL_BIN" --defaults-extra-file="$MYSQL_DEFAULTS_FILE" "$TARGET" < "$DUMP"

echo "5/6 Restoring media folders"
mkdir -p "$SOCIAL_DIR" "$MAIL_DIR"
cp -Rp "$SRC/social-media/." "$SOCIAL_DIR/"
cp -Rp "$SRC/mail-assets/." "$MAIL_DIR/"
for pair in "social-media:$SOCIAL_DIR" "mail-assets:$MAIL_DIR"; do
  want="$(count_files "$SRC/${pair%%:*}")"; got="$(count_files "${pair#*:}")"
  [ "$want" = "$got" ] || { echo "Restored $got of $want ${pair%%:*} files; restore FAILED" >&2; exit 1; }
  echo "  ${pair%%:*}: $got file(s) into ${pair#*:}"
done

echo "6/6 Verifying (read-only) against $TARGET"
DB_NAME="$TARGET" node db/migrate.js --status
DB_NAME="$TARGET" node scripts/verifyMediaStorage.js
DB_NAME="$TARGET" node scripts/verifyEncryptedSecrets.js
echo "Restore verified. Next: point the staging backend/.env DB_NAME at $TARGET, then run"
echo "  node scripts/stagingNeutralize.js --confirm   (switches copied production integrations off locally;"
echo "                                                 do NOT disconnect them in the app: that revokes production's grants)"
echo "  node scripts/stagingPreflight.js              (must print OK) — only then start the API and worker."
