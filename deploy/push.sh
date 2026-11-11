#!/usr/bin/env bash
# Ships the committed code to the server and restarts IGNITRA: the first deploy and every update.
# From the repo, on your machine (Git Bash works on Windows):
#
#   deploy/push.sh root@203.0.113.7
#
# It uploads `git archive HEAD` (uncommitted changes are not shipped), syncs it into /opt/ignitra
# keeping node_modules, installs dependencies, migrates the database, and runs the preflight
# (pnpm ops doctor). The services restart only if the preflight passes; otherwise the running
# processes keep the previous code and the failing checks are printed.
set -euo pipefail

TARGET=${1:-}
[ -n "$TARGET" ] || {
  echo "usage: deploy/push.sh user@host" >&2
  exit 1
}
cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain)" ] || echo "note: uncommitted changes are not shipped (git archive HEAD)"
REV=$(git rev-parse --short HEAD)
ARCHIVE=$(mktemp "${TMPDIR:-/tmp}/ignitra-XXXXXX")
trap 'rm -f "$ARCHIVE"' EXIT
git archive --format=tar.gz -o "$ARCHIVE" HEAD
echo "uploading $REV to $TARGET"
scp -q "$ARCHIVE" "$TARGET:/tmp/ignitra-$REV.tar.gz"

# The script below runs on the server as root (directly, or through sudo for users like ubuntu@);
# only REV crosses over, in the command line.
ssh "$TARGET" "if [ \"\$(id -u)\" = 0 ]; then REV=$REV bash -s; else sudo -n REV=$REV bash -s; fi" << 'REMOTE'
set -euo pipefail
ROOT=/opt/ignitra
ENV=/etc/ignitra/ignitra.env
[ "$(id -u)" = 0 ] || { echo "push: needs root on the server (log in as root, or a user with passwordless sudo)" >&2; exit 1; }
[ -s "$ENV" ] || { echo "push: fill $ENV first (deploy/CHECKLIST.md)" >&2; exit 1; }

stage=$(mktemp -d)
tar -xzf "/tmp/ignitra-$REV.tar.gz" -C "$stage"
rm -f "/tmp/ignitra-$REV.tar.gz"
# Mirror the release, but keep installed dependencies and build output between releases.
rsync -a --delete --exclude 'node_modules/' --exclude '.next/' "$stage/" "$ROOT/"
rm -rf "$stage"
echo "$REV" > "$ROOT/REVISION"
chown -R ignitra:ignitra "$ROOT"

install -m 0644 "$ROOT"/deploy/systemd/ignitra-api.service "$ROOT"/deploy/systemd/ignitra-listener.service "$ROOT"/deploy/systemd/ignitra-runner.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet ignitra-api ignitra-listener ignitra-runner

as_ignitra() {
  runuser -u ignitra -- env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 bash -c "set -euo pipefail; cd $ROOT; set -a; . $ENV; set +a; $1"
}
echo "== install"
as_ignitra "pnpm install --frozen-lockfile"
echo "== migrate"
as_ignitra "pnpm db:migrate"
echo "== preflight"
if ! as_ignitra "pnpm ops doctor"; then
  echo "push: the preflight failed; the services were NOT restarted (fix $ENV, then push again)" >&2
  exit 1
fi
echo "== restart"
systemctl restart ignitra-api ignitra-listener ignitra-runner
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4000/health > /dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:4000/health && echo
echo "deployed $REV"
REMOTE
