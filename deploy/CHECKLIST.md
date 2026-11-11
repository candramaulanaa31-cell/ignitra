# Launch checklist

Everything IGNITRA needs to go live, in order. The layout is the one from the plan: the web app on Vercel; one small VPS for the API, the listener and the runner; Postgres on Neon. Steps marked **(you)** need your accounts. The rest are commands.

Pick two host names first, for example `app.example.com` (the web app) and `api.example.com` (the API). They appear below as `app.<domain>` and `api.<domain>`.

## 1. Accounts and DNS (you)

- [ ] **Domain.** Any registrar.
- [ ] **VPS.** Ubuntu 24.04 (or 22.04, or Debian 12), 1 vCPU, 1–2 GB RAM. Hetzner, DigitalOcean and Vultr all work. Note its IP. Log in as root or as a user with passwordless sudo.
- [ ] **Neon.** Create a project in a region near the VPS. Copy the **direct** connection string, not the pooled one. Each service keeps at most 10 connections.
- [ ] **Vercel.** An account, and the repo on a Git host it can import (or the Vercel CLI).
- [ ] **DNS.** An `A` record for `api.<domain>` pointing to the VPS IP. For `app.<domain>`, the record Vercel shows when you add the domain (usually a `CNAME` to `cname.vercel-dns.com`).

## 2. Prepare the server (once)

From the repo on your machine (Git Bash works on Windows):

```sh
scp deploy/bootstrap.sh root@<vps-ip>:/root/
ssh root@<vps-ip> 'API_DOMAIN=api.<domain> bash /root/bootstrap.sh'
```

The script installs Node.js 24 (LTS), pnpm, Caddy and rsync. It creates the `ignitra` user and its directories, and opens only SSH, 80 and 443. It also points Caddy at `api.<domain>` (HTTPS is automatic once the DNS record resolves) and schedules the nightly backup. It is safe to run again. `DRY_RUN=1` prints what it would do.

## 3. Fill `/etc/ignitra/ignitra.env`

On the server: `nano /etc/ignitra/ignitra.env`. Write one `KEY=value` per line, and quote values that contain spaces. Generate secrets on your machine with `pnpm gen:secret` (one per secret) and the Web Push pair with `pnpm gen:vapid`.

| Variable | Value | Needed |
|---|---|---|
| `NODE_ENV` | `production` | yes |
| `DATABASE_URL` | Neon's direct connection string (`postgres://…?sslmode=require`) | yes |
| `ENCRYPTION_KEY` | `pnpm gen:secret`. **Keep a copy offline:** without it, stored secrets cannot be decrypted. | yes |
| `ENCRYPTION_KEY_ID` | `k1` | yes |
| `WEBHOOK_SIGNING_SECRET` | `pnpm gen:secret` (a different one) | yes |
| `API_PUBLIC_URL` | `https://api.<domain>` | yes |
| `WEB_URL` | `https://app.<domain>` | yes |
| `CORS_ORIGINS` | `https://app.<domain>` | yes |
| `TRUST_PROXY` | `127.0.0.1` (Caddy is the proxy) | yes |
| `RPC_URL_PRIMARY` | `https://rpc.mainnet.chain.robinhood.com`, or a paid endpoint | yes |
| `RPC_URL_FALLBACK` | A second provider. Strongly advised: the public RPC answers 429 under load. | advised |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `pnpm gen:vapid` | for Web Push |
| `VAPID_SUBJECT` | `mailto:you@<domain>` | for Web Push |
| `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` | **(you)** `resend` or `brevo`, its API key, and a sender on a verified domain | for email |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | **(you)** Google Cloud console → Credentials → OAuth client (web). Scopes: openid, email, spreadsheets. | for Sheets |
| `GOOGLE_REDIRECT_URI` | `https://app.<domain>/api/v1/connections/google/callback` (also register it in Google's console) | for Sheets |
| `EXPLORER_API_KEY` | A Blockscout API key (optional; raises its limits) | optional |
| `TRUST_LAYER_API_URL` (`_KEY`) | Your Trust Layer, if you run one | optional |
| `VIGIL_API_URL` | Your VIGIL API (`https://…/api/v1`) | optional |
| `DEMO_FLOW_ID` | Later, for the landing's live demo: `pnpm ops demo setup <wallet>` | optional |

The rest of `.env.example` has working defaults. Telegram needs nothing here: users connect their own bots in the app.

## 4. Deploy the code (first time, and every update)

From the repo on your machine:

```sh
deploy/push.sh root@<vps-ip>
```

It ships the committed code, installs dependencies, migrates the database and runs the preflight (`pnpm ops doctor`). It restarts the services only if the preflight passes; when it fails, it prints what to fix.

## 5. The web app on Vercel (you, about 5 minutes)

- [ ] Import the repository. Set **Root Directory** to `apps/web`, and turn on **Include files outside the Root Directory** (the workspace packages live there). The framework (Next.js) and pnpm are detected.
- [ ] Environment variables, for Production:
  - `API_URL=https://api.<domain>`. It is read at build time, so redeploy after changing it.
  - `WEB_URL=https://app.<domain>`. It makes share cards, the sitemap and template links absolute.
- [ ] Add the domain `app.<domain>`, and the DNS record Vercel shows.

## 6. Verify

- [ ] `curl https://api.<domain>/health` answers `"status":"ok"` and shows a chain head.
- [ ] On the server, `systemctl status ignitra-api ignitra-listener ignitra-runner` shows all three active. Logs: `journalctl -u ignitra-listener -f`.
- [ ] Open `https://app.<domain>`. The block height ticks in the header. Sign in with a wallet, start from a template and press **Test**: the run shows up, marked TEST.
- [ ] Share `https://app.<domain>` in a chat (Telegram, X). The card shows "When the chain moves, everything follows." Template links show their own card.
- [ ] `https://app.<domain>/robots.txt` and `/sitemap.xml` use the real domain.

## 7. After launch (you, with Claude)

- [ ] **Backups.** `deploy/backup.sh` runs nightly into `/var/backups/ignitra`. Copy that directory off the machine too (rclone, restic). The file holds account data with secrets still encrypted; keep `ENCRYPTION_KEY` elsewhere.
- [ ] **Monitoring.** An uptime check on `https://api.<domain>/health`. The metrics are at `127.0.0.1:4001/metrics` on the server.
- [ ] **Live checks that were waiting for a public URL:**
  - Web Push on a phone (on iOS, add the site to the home screen first).
  - A Telegram bot made with @BotFather, connected in the app.
  - A VIGIL alert flow.
  - Email and Google Sheets with the real accounts.
- [ ] Optional: ONCHAIN_TX with a Safe you own and a little ETH for gas.
- [ ] npm: regenerate the recovery codes for the account that publishes `@ignitra/sdk`.
