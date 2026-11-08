#!/bin/sh
# Nightly logical backup of the IGNITRA database: export, verify, keep 14 days.
# /etc/cron.d/ignitra:  15 3 * * * ignitra /opt/ignitra/deploy/backup.sh >> /var/log/ignitra/backup.log 2>&1
# Copy BACKUP_DIR off the machine as well (rclone, restic, …). The file holds account data
# (secrets stay encrypted): store it like the database, and keep ENCRYPTION_KEY elsewhere.
set -eu

ROOT=${IGNITRA_ROOT:-/opt/ignitra}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/ignitra}
KEEP_DAYS=${KEEP_DAYS:-14}

set -a
. /etc/ignitra/ignitra.env
set +a

mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/ignitra-$(date -u +%Y%m%dT%H%M%SZ).ignitra.gz"
cd "$ROOT/apps/listener"
node node_modules/tsx/dist/cli.mjs src/cli.ts db export "$file"
node node_modules/tsx/dist/cli.mjs src/cli.ts db verify "$file" > /dev/null
find "$BACKUP_DIR" -name 'ignitra-*.ignitra.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -u +%FT%TZ) backup ok: $file"
