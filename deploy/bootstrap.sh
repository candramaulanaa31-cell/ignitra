#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu or Debian VPS for IGNITRA's API, listener and runner. As root:
#
#   API_DOMAIN=api.example.com bash bootstrap.sh
#
# It installs Node.js 24 LTS (NodeSource's signed apt repository), pnpm (corepack), Caddy (its signed
# apt repository) and rsync; creates the `ignitra` user and its directories; opens only SSH, 80 and
# 443; writes the Caddyfile for API_DOMAIN; installs the systemd units once the code is there; and
# schedules the nightly backup. Safe to run again. It starts nothing: fill /etc/ignitra/ignitra.env
# first (deploy/CHECKLIST.md), then run deploy/push.sh from your machine.
#
# DRY_RUN=1 prints the commands instead of running them.
set -euo pipefail

API_DOMAIN=${API_DOMAIN:-}
NODE_MAJOR=${NODE_MAJOR:-24}
DRY_RUN=${DRY_RUN:-0}
ROOT=/opt/ignitra
ENV_DIR=/etc/ignitra
BACKUP_DIR=/var/backups/ignitra
LOG_DIR=/var/log/ignitra

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}
say() { printf '\n== %s\n' "$*"; }
die() {
  printf 'bootstrap: %s\n' "$*" >&2
  exit 1
}

[ -n "$API_DOMAIN" ] || die "set API_DOMAIN, e.g. API_DOMAIN=api.example.com bash bootstrap.sh"
case "$API_DOMAIN" in *[!a-zA-Z0-9.-]* | .* | *.) die "API_DOMAIN must be a host name like api.example.com" ;; esac
if [ "$DRY_RUN" != 1 ]; then
  [ "$(id -u)" = 0 ] || die "run as root (sudo -i)"
  # shellcheck disable=SC1091
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in *" debian "* | *" ubuntu "*) ;; *) die "this script targets Ubuntu or Debian" ;; esac
fi
export DEBIAN_FRONTEND=noninteractive

say "base packages"
run apt-get update -y
run apt-get install -y ca-certificates curl gnupg git rsync ufw debian-keyring debian-archive-keyring apt-transport-https

say "Node.js $NODE_MAJOR"
current=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$current" -lt "$NODE_MAJOR" ] || [ "$DRY_RUN" = 1 ]; then
  run install -d -m 0755 /etc/apt/keyrings
  run sh -c 'curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg'
  run sh -c "echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main' > /etc/apt/sources.list.d/nodesource.list"
  run apt-get update -y
  run apt-get install -y nodejs
else
  echo "node $(node -v) is already installed"
fi
# pnpm comes from corepack, at the version pinned in package.json (packageManager).
run corepack enable

say "Caddy"
if ! command -v caddy > /dev/null 2>&1 || [ "$DRY_RUN" = 1 ]; then
  run sh -c 'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg'
  run sh -c 'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list'
  run apt-get update -y
  run apt-get install -y caddy
else
  echo "caddy is already installed"
fi

say "the ignitra user and its directories"
if ! id ignitra > /dev/null 2>&1; then
  # A home for pnpm's store and corepack's cache; the services themselves run with ProtectHome.
  run useradd --system --create-home --home-dir /home/ignitra --shell /usr/sbin/nologin ignitra
fi
run install -d -o ignitra -g ignitra -m 0755 "$ROOT"
run install -d -o ignitra -g ignitra -m 0750 "$BACKUP_DIR" "$LOG_DIR"
# Secrets: readable by root (systemd) and the ignitra group (migrations, backups), nobody else.
run install -d -o root -g ignitra -m 0750 "$ENV_DIR"
if [ ! -f "$ENV_DIR/ignitra.env" ]; then
  run install -o root -g ignitra -m 0640 /dev/null "$ENV_DIR/ignitra.env"
fi

say "firewall: SSH, 80 and 443 only"
run ufw allow OpenSSH
run ufw allow 80/tcp
run ufw allow 443/tcp
run ufw --force enable

say "Caddy in front of the API at $API_DOMAIN"
caddyfile="# Written by deploy/bootstrap.sh. Caddy gets and renews the certificate once DNS points here.
$API_DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:4000
}"
if [ "$DRY_RUN" = 1 ]; then
  printf '+ write /etc/caddy/Caddyfile:\n%s\n' "$caddyfile"
else
  printf '%s\n' "$caddyfile" > /etc/caddy/Caddyfile
fi
run systemctl reload-or-restart caddy

say "services"
if [ -d "$ROOT/deploy/systemd" ]; then
  run install -m 0644 "$ROOT"/deploy/systemd/ignitra-api.service "$ROOT"/deploy/systemd/ignitra-listener.service "$ROOT"/deploy/systemd/ignitra-runner.service /etc/systemd/system/
  run systemctl daemon-reload
  run systemctl enable ignitra-api ignitra-listener ignitra-runner
else
  echo "the code is not in $ROOT yet: deploy/push.sh copies it and installs the units"
fi

say "nightly backup (03:15 server time, which is UTC on most cloud images; kept 14 days)"
cron="15 3 * * * ignitra $ROOT/deploy/backup.sh >> $LOG_DIR/backup.log 2>&1"
if [ "$DRY_RUN" = 1 ]; then
  printf '+ write /etc/cron.d/ignitra: %s\n' "$cron"
else
  printf '%s\n' "$cron" > /etc/cron.d/ignitra
  chmod 0644 /etc/cron.d/ignitra
fi

say "done"
cat << EOF
Next:
  1. DNS: an A record for $API_DOMAIN pointing to this server.
  2. Fill $ENV_DIR/ignitra.env (deploy/CHECKLIST.md lists every value and where it comes from).
  3. From your machine, in the repo: deploy/push.sh root@<this server>
EOF
