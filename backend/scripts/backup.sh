#!/usr/bin/env bash
# Backs up one database and both media folders into a new timestamped directory.
#
#   MYSQL_DEFAULTS_FILE=/root/.marketech-backup.cnf scripts/backup.sh <database> <backup-root>
#
# MYSQL_DEFAULTS_FILE: a chmod-600 MariaDB option file with a [client] section (host, port, user,
# password), so no password appears on the command line or in shell history.
# Run from backend/ with the API and worker stopped (or at least no uploads/deletes in progress).
# Stops at the first error. The dump is written to *.partial and only renamed after it is verified
# complete and for the right database. Media folder paths come from backend/.env.
set -euo pipefail
umask 077

: "${MYSQL_DEFAULTS_FILE:?Set MYSQL_DEFAULTS_FILE to a chmod-600 option file with [client] host/user/password}"
DB="${1:?Usage: backup.sh <database> <backup-root>}"
ROOT="${2:?Usage: backup.sh <database> <backup-root>}"
[[ "$DB" =~ ^[A-Za-z0-9_]+$ ]] || { echo "Invalid database name: $DB" >&2; exit 1; }
[ -f "$MYSQL_DEFAULTS_FILE" ] || { echo "Option file not found: $MYSQL_DEFAULTS_FILE" >&2; exit 1; }
cd "$(dirname "$0")/.."

# Use client tools of the same MariaDB version as the server (MARIADB_BIN_DIR, e.g. /opt/lampp/bin):
# newer mariadb-dump versions write a "sandbox mode" first line that older servers' clients reject.
if [ -n "${MARIADB_BIN_DIR:-}" ]; then DUMP_BIN="$MARIADB_BIN_DIR/mysqldump"; [ -x "$DUMP_BIN" ] || DUMP_BIN="$MARIADB_BIN_DIR/mariadb-dump"; else DUMP_BIN="$(command -v mariadb-dump || command -v mysqldump || true)"; fi
[ -n "$DUMP_BIN" ] || { echo "mariadb-dump/mysqldump not found" >&2; exit 1; }
if command -v sha256sum >/dev/null; then SHA=(sha256sum); else SHA=(shasum -a 256); fi
PATHS="$(node scripts/printMediaPaths.js)"
SOCIAL_DIR="$(printf '%s\n' "$PATHS" | sed -n 1p)"
MAIL_DIR="$(printf '%s\n' "$PATHS" | sed -n 2p)"
for d in "$SOCIAL_DIR" "$MAIL_DIR"; do
  [[ "$d" == /* ]] || { echo "Media folder path is not absolute: '$d'" >&2; exit 1; }
done
count_files() { if [ -d "$1" ]; then find "$1" -type f ! -name '.write-check-*' | wc -l | tr -d ' '; else echo 0; fi; }

STAMP="$(date -u +%Y%m%d-%H%M%S)"
DEST="$ROOT/$DB-$STAMP"
mkdir -p "$DEST"
echo "Backing up database $DB to $DEST"

# --triggers but no --routines: the application has no stored routines, and on MariaDB servers whose
# mysql.proc table is outdated --routines aborts the dump. Single database without --databases, so the
# dump can be restored into a database of another name.
"$DUMP_BIN" --defaults-extra-file="$MYSQL_DEFAULTS_FILE" --single-transaction --triggers \
  --default-character-set=utf8mb4 "$DB" > "$DEST/$DB.sql.partial"
# Captured into variables, not piped into grep -q (which can make pipefail report a false failure).
TAIL="$(tail -c 200 "$DEST/$DB.sql.partial")"
HEAD="$(head -c 2000 "$DEST/$DB.sql.partial")"
[[ "$TAIL" == *"-- Dump completed"* ]] || { echo "Dump is incomplete (no 'Dump completed' line); backup FAILED" >&2; exit 1; }
[[ "$HEAD" =~ Database:\ $DB([[:space:]]|$) ]] || { echo "Dump header does not name database $DB; backup FAILED" >&2; exit 1; }
mv "$DEST/$DB.sql.partial" "$DEST/$DB.sql"

for name in social-media mail-assets; do
  if [ "$name" = social-media ]; then src="$SOCIAL_DIR"; else src="$MAIL_DIR"; fi
  mkdir -p "$DEST/$name"
  if [ -d "$src" ]; then
    cp -Rp "$src/." "$DEST/$name/"
  else
    echo "WARNING: media folder $src does not exist; backing up no $name files (expected only if nothing was ever uploaded)" >&2
  fi
  want="$(count_files "$src")"; got="$(count_files "$DEST/$name")"
  [ "$want" = "$got" ] || { echo "Copied $got of $want $name files; backup FAILED" >&2; exit 1; }
  echo "  $name: $got file(s) from $src"
done

( cd "$DEST" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 "${SHA[@]}" > SHA256SUMS )
echo "Backup complete: $DEST ($(du -sh "$DEST" | cut -f1)). Copy the whole directory off the server."
echo "The encryption key is NOT included: keep SOCIAL_TOKEN_ENCRYPTION_KEY in the secret store."
