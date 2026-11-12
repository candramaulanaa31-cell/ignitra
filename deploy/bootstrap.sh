#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu or Debian server (x86-64 or ARM64) for IGNITRA's API, listener and
# runner. As root, for example:
#
#   DOMAIN=example.com TUNNEL=1 WITH_POSTGRES=1 bash bootstrap.sh
#
# DOMAIN         the web app at https://DOMAIN, the API at https://api.DOMAIN (API_DOMAIN overrides).
#                With it, an empty /etc/ignitra/ignitra.env gets a working starter: fresh secrets, the
#                public URLs, the chain RPC, and the database below.
# TUNNEL=1       reach the API through a Cloudflare Tunnel: no inbound port is opened and no
#                certificate is needed. The token comes from TUNNEL_TOKEN or a hidden prompt; pasting
#                the whole "cloudflared service install …" command works too.
#                Without TUNNEL, Caddy terminates TLS for the API on ports 80/443.
# WITH_POSTGRES=1 install PostgreSQL 17 here (its signed apt repository), listening on localhost
#                only, with a database and role `ignitra`.
#
# It installs Node.js 24 LTS (NodeSource's signed apt repository), pnpm (corepack) and rsync;
# creates the `ignitra` user and its directories; sets up the firewall; installs the systemd units
# once the code is there; and schedules the nightly backup. Safe to run again: existing settings,
# secrets and data are kept. It starts nothing; deploy/push.sh, run from your machine, does.
#
# DRY_RUN=1 prints the commands instead of running them.
set -euo pipefail

DOMAIN=${DOMAIN:-}
API_DOMAIN=${API_DOMAIN:-${DOMAIN:+api.$DOMAIN}}
TUNNEL=${TUNNEL:-0}
TUNNEL_TOKEN=${TUNNEL_TOKEN:-}
WITH_POSTGRES=${WITH_POSTGRES:-0}
NODE_MAJOR=${NODE_MAJOR:-24}
PG_MAJOR=${PG_MAJOR:-17}
DRY_RUN=${DRY_RUN:-0}
ROOT=/opt/ignitra
ENV_DIR=/etc/ignitra
ENV_FILE=$ENV_DIR/ignitra.env
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
host_ok() { case "$1" in "" | *[!a-zA-Z0-9.-]* | .* | *. | *..*) return 1 ;; *) return 0 ;; esac }

[ -n "$API_DOMAIN" ] || die "set DOMAIN (e.g. DOMAIN=example.com) or API_DOMAIN"
host_ok "$API_DOMAIN" || die "not a host name: $API_DOMAIN"
[ -z "$DOMAIN" ] || host_ok "$DOMAIN" || die "not a host name: $DOMAIN"
if [ "$DRY_RUN" != 1 ]; then
  [ "$(id -u)" = 0 ] || die "run as root (sudo -i, or sudo DOMAIN=… bash bootstrap.sh)"
  # shellcheck disable=SC1091
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in *" debian "* | *" ubuntu "*) ;; *) die "this script targets Ubuntu or Debian" ;; esac
fi
if [ "$TUNNEL" = 1 ] && [ -z "$TUNNEL_TOKEN" ] && [ "$DRY_RUN" != 1 ] && ! systemctl is-enabled --quiet cloudflared 2> /dev/null; then
  [ -t 0 ] || die "TUNNEL=1 needs TUNNEL_TOKEN (or run interactively to be asked for it)"
  read -rsp "Cloudflare tunnel token (input hidden): " TUNNEL_TOKEN
  echo
fi
# Pasted the whole install command? Keep only its last word, the token.
TUNNEL_TOKEN=${TUNNEL_TOKEN##* }
export DEBIAN_FRONTEND=noninteractive
echo "machine: $(uname -m), API at https://$API_DOMAIN via $([ "$TUNNEL" = 1 ] && echo 'Cloudflare Tunnel' || echo Caddy)"

say "base packages"
run apt-get update -y
run apt-get install -y ca-certificates curl gnupg git rsync ufw
run install -d -m 0755 /etc/apt/keyrings

say "Node.js $NODE_MAJOR"
current=$(node -p 'process.versions.node.split(".")[0]' 2> /dev/null || echo 0)
if [ "$current" -lt "$NODE_MAJOR" ] || [ "$DRY_RUN" = 1 ]; then
  run sh -c 'curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg'
  run sh -c "echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main' > /etc/apt/sources.list.d/nodesource.list"
  run apt-get update -y
  run apt-get install -y nodejs
else
  echo "node $(node -v) is already installed"
fi
# pnpm comes from corepack, at the version pinned in package.json (packageManager).
run corepack enable

if [ "$TUNNEL" = 1 ]; then
  say "Cloudflare Tunnel (cloudflared)"
  if ! command -v cloudflared > /dev/null 2>&1 || [ "$DRY_RUN" = 1 ]; then
    run sh -c 'curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg'
    run sh -c "echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list"
    run apt-get update -y
    run apt-get install -y cloudflared
  fi
  if systemctl is-enabled --quiet cloudflared 2> /dev/null; then
    echo "the tunnel service is already installed (to change the token: cloudflared service uninstall, then run this again)"
  elif [ "$DRY_RUN" = 1 ]; then
    echo "+ cloudflared service install <token>"
  else
    cloudflared service install "$TUNNEL_TOKEN"
  fi
else
  say "Caddy"
  if ! command -v caddy > /dev/null 2>&1 || [ "$DRY_RUN" = 1 ]; then
    run sh -c 'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg'
    run sh -c 'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list'
    run apt-get update -y
    run apt-get install -y caddy
  else
    echo "caddy is already installed"
  fi
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
if [ ! -f "$ENV_FILE" ]; then
  run install -o root -g ignitra -m 0640 /dev/null "$ENV_FILE"
fi

# A random value safe in URLs, shells and env files (what `pnpm gen:secret` prints).
secret() { node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'; }
DATABASE_URL=""
if [ "$WITH_POSTGRES" = 1 ]; then
  say "PostgreSQL $PG_MAJOR on localhost"
  if ! command -v "/usr/lib/postgresql/$PG_MAJOR/bin/postgres" > /dev/null 2>&1 || [ "$DRY_RUN" = 1 ]; then
    run install -d -m 0755 /usr/share/postgresql-common/pgdg
    run curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
    run sh -c '. /etc/os-release && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $VERSION_CODENAME-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
    run apt-get update -y
    run apt-get install -y "postgresql-$PG_MAJOR"
  fi
  if [ -s "$ENV_FILE" ] && grep -q '^DATABASE_URL=.' "$ENV_FILE"; then
    echo "DATABASE_URL is already set in $ENV_FILE: the database is left as it is"
  elif [ "$DRY_RUN" = 1 ]; then
    echo "+ create role and database ignitra with a fresh password"
    DATABASE_URL="postgres://ignitra:<password>@127.0.0.1:5432/ignitra"
  else
    password=$(secret)
    cd /tmp # psql as postgres would otherwise warn that it cannot enter root's directory
    runuser -u postgres -- psql -v ON_ERROR_STOP=1 -q << SQL
DO \$\$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'ignitra') THEN
    ALTER ROLE ignitra LOGIN PASSWORD '$password';
  ELSE
    CREATE ROLE ignitra LOGIN PASSWORD '$password';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE ignitra OWNER ignitra' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ignitra')\gexec
SQL
    DATABASE_URL="postgres://ignitra:$password@127.0.0.1:5432/ignitra"
    echo "database ignitra ready (localhost only)"
    # Without DOMAIN no starter is written below: keep the URL (and its password) in the settings now.
    if [ -z "$DOMAIN" ]; then
      printf 'DATABASE_URL=%s\n' "$DATABASE_URL" >> "$ENV_FILE"
      echo "DATABASE_URL added to $ENV_FILE"
    fi
  fi
fi

if [ -n "$DOMAIN" ]; then
  say "settings: $ENV_FILE"
  if [ -s "$ENV_FILE" ]; then
    echo "already filled: kept as it is"
  elif [ "$DRY_RUN" = 1 ]; then
    echo "+ write a starter with fresh secrets, https://$DOMAIN and https://$API_DOMAIN"
  else
    vapid=$(node -e '
      const { generateKeyPairSync } = require("node:crypto");
      const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const pub = publicKey.export({ format: "jwk" });
      const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);
      console.log(`VAPID_PUBLIC_KEY=${point.toString("base64url")}\nVAPID_PRIVATE_KEY=${privateKey.export({ format: "jwk" }).d}`);
    ')
    cat > "$ENV_FILE" << EOF
# Written by deploy/bootstrap.sh on $(date -u +%F). Every key is explained in .env.example.
# Keep a copy of ENCRYPTION_KEY somewhere safe and offline: without it, stored secrets cannot be decrypted.
NODE_ENV=production
LOG_LEVEL=info

DATABASE_URL=${DATABASE_URL}
ENCRYPTION_KEY=$(secret)
ENCRYPTION_KEY_ID=k1
WEBHOOK_SIGNING_SECRET=$(secret)
${vapid}
VAPID_SUBJECT=mailto:ops@${DOMAIN}

API_HOST=127.0.0.1
API_PORT=4000
API_PUBLIC_URL=https://${API_DOMAIN}
WEB_URL=https://${DOMAIN}
CORS_ORIGINS=https://${DOMAIN}
TRUST_PROXY=127.0.0.1

CHAIN_ID=4663
# A provider endpoint as the primary is better: the public RPC is rate limited.
RPC_URL_PRIMARY=https://rpc.mainnet.chain.robinhood.com
RPC_URL_FALLBACK=

# Optional, add when you have them, then deploy again:
# EMAIL_PROVIDER=resend
# EMAIL_API_KEY=
# EMAIL_FROM="IGNITRA <alerts@${DOMAIN}>"
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_REDIRECT_URI=https://${DOMAIN}/api/v1/connections/google/callback
# EXPLORER_API_KEY=
EOF
    echo "written with fresh secrets$([ -z "$DATABASE_URL" ] && echo '; DATABASE_URL is still empty: fill it in')"
  fi
fi

if [ "$TUNNEL" = 1 ]; then
  say "firewall: SSH only (the tunnel connects out)"
  if [ -f /etc/iptables/rules.v4 ]; then
    # Oracle Cloud images ship their own iptables rules, which already allow SSH only.
    echo "this image manages its own iptables rules (SSH only): ufw left off"
  else
    run ufw allow OpenSSH
    run ufw --force enable
  fi
else
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
fi

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
if [ "$TUNNEL" = 1 ]; then
  echo "  1. In Cloudflare, the tunnel's public hostname $API_DOMAIN must point to http://localhost:4000."
else
  echo "  1. DNS: an A record for $API_DOMAIN pointing to this server."
fi
if [ -s "$ENV_FILE" ] || [ "$DRY_RUN" = 1 ]; then
  echo "  2. Settings are in $ENV_FILE. Copy ENCRYPTION_KEY somewhere safe: sudo grep ENCRYPTION_KEY= $ENV_FILE"
else
  echo "  2. Fill $ENV_FILE (deploy/CHECKLIST.md lists every value and where it comes from)."
fi
echo "  3. From your machine, in the repo: deploy/push.sh <user>@<this server>"
