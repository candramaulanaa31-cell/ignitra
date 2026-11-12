# Launch checklist

Everything IGNITRA needs to go live, in order. The web app runs on Vercel. The API, the listener and the runner run on one Linux server. Steps marked **(you)** need your accounts; the rest are commands.

The host names below are `<domain>` for the web app and `api.<domain>` for the API.

There are two ways to run the server:

- **A. Free (default):** an Oracle Cloud Always Free ARM VM, with Postgres on the same VM. Cloudflare Tunnel brings traffic in, so the server opens no ports and needs no certificate. The domain's DNS must be on Cloudflare.
- **B. Any VPS:** Hetzner, DigitalOcean, Vultr and others. Caddy serves HTTPS on ports 80/443, and Postgres runs on the VPS or on Neon.

## 1. Accounts (you)

- [ ] **Domain**, with its nameservers moved to Cloudflare (required for A, optional for B).
- [ ] **SSH key** on your machine. In Git Bash, run `ssh-keygen -t ed25519` and press Enter at each prompt. The public key is `~/.ssh/id_ed25519.pub`.
- [ ] **A: Oracle Cloud.**
  - [ ] Sign up for the free tier. The home region is permanent; pick one near your users (for example Singapore). A card is checked, and you are not charged.
  - [ ] Create an instance:
    - Image: **Ubuntu 24.04**.
    - Shape: **VM.Standard.A1.Flex**, 1 OCPU and 6 GB. The free limit is 2 OCPU and 12 GB in total.
    - Networking: keep a public IPv4.
    - SSH key: paste the `.pub` file.
    - Note its public IP. The user is `ubuntu`.
  - [ ] If the console says "Out of capacity", try another availability domain, or try again later.
  - [ ] Optional: upgrade the account to Pay As You Go. Usage within the free limits stays free, and idle free instances are no longer reclaimed.
- [ ] **A: Cloudflare Tunnel.**
  - [ ] In Zero Trust → Networks → Tunnels, create a tunnel (type Cloudflared), named for example `ignitra-api`.
  - [ ] Copy the install command it shows (`… service install eyJ…`). Keep it private: anyone with the token can run the tunnel.
  - [ ] Add a public hostname: `api.<domain>` → service `HTTP`, URL `localhost:4000`. Cloudflare creates the DNS record itself.
  - [ ] Do **not** add an `A` record for `api`.
- [ ] **B: VPS.** Ubuntu 24.04 (or 22.04, or Debian 12), 1 vCPU and 1–2 GB RAM. Log in as root or as a user with passwordless sudo.
- [ ] **B: DNS.** An `A` record for `api.<domain>` pointing to the VPS IP (DNS only if it is on Cloudflare).
- [ ] **B: Postgres, if not on the VPS.** A Neon project in a region near the VPS. Use the **direct** connection string, not the pooled one. Each service keeps at most 10 connections.
- [ ] **Vercel.** An account that can import the GitHub repo.

## 2. Prepare the server (once)

From the repo on your machine (Git Bash on Windows):

```sh
scp deploy/bootstrap.sh ubuntu@<server-ip>:~
ssh ubuntu@<server-ip>
```

Then, on the server:

```sh
# A: tunnel + Postgres here. It asks for the tunnel token (input hidden; pasting the whole command works).
sudo DOMAIN=<domain> TUNNEL=1 WITH_POSTGRES=1 bash bootstrap.sh

# B: Caddy for HTTPS; add WITH_POSTGRES=1 to run Postgres on the VPS instead of Neon.
sudo DOMAIN=<domain> bash bootstrap.sh
```

The script:

- installs Node.js 24 (LTS), pnpm and rsync, then either cloudflared (A) or Caddy (B);
- with `WITH_POSTGRES=1`, installs PostgreSQL 17, listening on localhost only, with a database and role `ignitra` and a random password;
- creates the `ignitra` user and its directories;
- writes a working `/etc/ignitra/ignitra.env`: fresh secrets, a Web Push key pair, the public URLs, the chain RPC and the database;
- sets the firewall: SSH only for A; SSH, 80 and 443 for B. On Oracle's Ubuntu images, the existing iptables rules (SSH only) are kept;
- schedules the nightly backup.

It works on x86-64 and ARM64 and is safe to run again: existing settings, secrets and data are kept. `DRY_RUN=1` prints what it would do.

- [ ] **Copy `ENCRYPTION_KEY` somewhere safe and offline** (a password manager): `sudo grep ENCRYPTION_KEY= /etc/ignitra/ignitra.env`. Without it, stored secrets (bot tokens, API keys) cannot be decrypted, even from a backup.

## 3. Settings: `/etc/ignitra/ignitra.env`

With `DOMAIN`, the file is already complete for launch. Edit it with `sudo nano /etc/ignitra/ignitra.env`, one `KEY=value` per line; quote values that contain spaces. Without `DOMAIN` (or for Neon), fill it from this table. Generate secrets on your machine with `pnpm gen:secret` (one per secret), and the Web Push pair with `pnpm gen:vapid`.

| Variable | Value | Needed |
|---|---|---|
| `NODE_ENV` | `production` | yes |
| `DATABASE_URL` | Written by `WITH_POSTGRES=1`, or Neon's direct connection string (`postgres://…?sslmode=require`) | yes |
| `ENCRYPTION_KEY` | `pnpm gen:secret`. **Keep a copy offline.** | yes |
| `ENCRYPTION_KEY_ID` | `k1` | yes |
| `WEBHOOK_SIGNING_SECRET` | `pnpm gen:secret` (a different one) | yes |
| `API_PUBLIC_URL` | `https://api.<domain>` | yes |
| `WEB_URL` | `https://<domain>` | yes |
| `CORS_ORIGINS` | `https://<domain>` | yes |
| `TRUST_PROXY` | `127.0.0.1` (cloudflared or Caddy is the proxy) | yes |
| `RPC_URL_PRIMARY` | `https://rpc.mainnet.chain.robinhood.com`, or a paid endpoint | yes |
| `RPC_URL_FALLBACK` | A second provider. Strongly advised: the public RPC answers 429 under load. | advised |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `pnpm gen:vapid` | for Web Push |
| `VAPID_SUBJECT` | `mailto:you@<domain>` | for Web Push |
| `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` | **(you)** `resend` or `brevo`, its API key, and a sender on a verified domain | for email |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | **(you)** Google Cloud console → Credentials → OAuth client (web). Scopes: openid, email, spreadsheets. | for Sheets |
| `GOOGLE_REDIRECT_URI` | `https://<domain>/api/v1/connections/google/callback` (also register it in Google's console) | for Sheets |
| `EXPLORER_API_KEY` | A Blockscout API key (optional; raises its limits) | optional |
| `TRUST_LAYER_API_URL` (`_KEY`) | Your Trust Layer, if you run one | optional |
| `VIGIL_API_URL` | Your VIGIL API (`https://…/api/v1`) | optional |
| `DEMO_FLOW_ID` | Later, for the landing's live demo: `pnpm ops demo setup <wallet>` | optional |

The rest of `.env.example` has working defaults. Telegram needs nothing here: users connect their own bots in the app. After editing, run `deploy/push.sh` again, or `sudo systemctl restart ignitra-api ignitra-listener ignitra-runner`.

## 4. Deploy the code (first time, and every update)

From the repo on your machine:

```sh
deploy/push.sh ubuntu@<server-ip>
```

It ships the committed code, installs dependencies, migrates the database and runs the preflight (`pnpm ops doctor`). It restarts the services only if the preflight passes; when it fails, it prints what to fix. The first run takes a few minutes (dependencies).

## 5. The web app on Vercel (you, about 5 minutes)

- [ ] Import the repository.
  - Set **Root Directory** to `apps/web`.
  - Turn on **Include files outside the Root Directory** (the workspace packages live there).
  - The framework (Next.js) and pnpm are detected.
- [ ] Add these environment variables for Production:
  - `API_URL=https://api.<domain>`. It is read at build time, so redeploy after changing it.
  - `WEB_URL=https://<domain>`. It makes share cards, the sitemap and template links absolute.
- [ ] Add the domain `<domain>` (and `www.<domain>` if you want it to redirect).
  - In Cloudflare DNS, create the records Vercel shows.
  - Set them to **DNS only** (grey cloud), so Vercel can issue the certificate.
- [ ] Vercel's Hobby plan is for non-commercial use. Move to Pro before charging money.

## 6. Verify

- [ ] `curl https://api.<domain>/health` answers `"status":"ok"` and shows a chain head.
- [ ] On the server, `systemctl status ignitra-api ignitra-listener ignitra-runner` shows all three active (A: also `cloudflared`). Logs: `journalctl -u ignitra-listener -f`.
- [ ] Open `https://<domain>`. The block height ticks in the header. Sign in with a wallet, start from a template and press **Test**: the run shows up, marked TEST.
- [ ] Share `https://<domain>` in a chat (Telegram, X). The card shows "When the chain moves, everything follows." Template links show their own card.
- [ ] `https://<domain>/robots.txt` and `/sitemap.xml` use the real domain.

## 7. After launch (you, with Claude)

- [ ] **Backups.** `deploy/backup.sh` runs nightly into `/var/backups/ignitra`. Copy that directory off the machine too (rclone, restic). This matters most when Postgres runs on the same server. The file holds account data with secrets still encrypted; keep `ENCRYPTION_KEY` elsewhere.
- [ ] **Monitoring.** An uptime check on `https://api.<domain>/health`. The metrics are at `127.0.0.1:4001/metrics` on the server.
- [ ] **RPC.** Add a second provider as `RPC_URL_FALLBACK`, or make a paid endpoint primary.
- [ ] **Live checks that were waiting for a public URL:**
  - Web Push on a phone (on iOS, add the site to the home screen first).
  - A Telegram bot made with @BotFather, connected in the app.
  - A VIGIL alert flow.
  - Email and Google Sheets with the real accounts.
- [ ] Optional: ONCHAIN_TX with a Safe you own and a little ETH for gas.
- [ ] npm: regenerate the recovery codes for the account that publishes `@ignitra/sdk`.
