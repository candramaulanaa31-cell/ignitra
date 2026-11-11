# IGNITRA

Onchain automation for Robinhood Chain (chain id `4663`).
**IF** something happens onchain → **THEN** do something anywhere.

```
listener / clock / inbound URL ──▶ trigger + condition engine ──▶ runs (queued) ──▶ runner ──▶ actions
 (chain)   (cron)   (HTTP POST)       (match, enrich, evaluate)     (unique key)     (retry)     (Telegram, webhook, push, chain read)
```

> **Status: Phase 9 — hardening and launch.** Audit log, dead-letter queue with safe retries,
> gap detector, metrics, secret and key rotation, database backups, a session-key permission
> review, and every chain trigger proven end to end on a mainnet fork. Still open: the npm
> release of the SDK and the checks that need your own accounts (see the launch checklist).

## Layout

| Path | What |
|---|---|
| `apps/api` | Fastify HTTP API: SIWE sign-in, flows, connections, runs and traces, usage, inbound webhook URLs. |
| `apps/web` | Next.js app: landing, wallet sign-in, flow builder, dashboard, run traces, connections, settings; PWA (Web Push). |
| `apps/listener` | Chain process: ingestion (sync) + matcher, optionally runner and API in the same process; health endpoint, operator CLI (`pnpm ops`). |
| `apps/runner` | Flow runner: executes queued runs (concurrency, retries, traces, auto-pause). |
| `packages/core` | Domain core. `@ignitra/core` is isomorphic; `@ignitra/core/server` is Node-only. |
| `packages/actions` | SSRF-safe HTTP; WEBHOOK, TELEGRAM, WEB_PUSH, CHAIN_READ, HTTP_REQUEST, EMAIL, GOOGLE_SHEETS; connections (verified email, OAuth, host-bound secrets); run queue, executor. |
| `packages/engine` | Trigger modules (chain, schedule, state, inbound), enrichment, flow service with plan limits, matcher (occurrences → runs, metering). |
| `packages/chain` | RPC reader with failover, built-in ABIs, event decoder, contract-read encoding, explorer ABI registry. Test doubles under `@ignitra/chain/testing`. |
| `packages/db` | Drizzle schema, SQL migrations, driver-agnostic client (Postgres or PGlite). |
| `packages/sdk` | `@ignitra/sdk`: typed, dependency-free API client and webhook verification. |
| `contracts` | Foundry: `IgnitraSessionBounds`, the stateless onchain check of a grant's expiry and per-call ETH cap. |
| `deploy` | systemd units for the three services, a Caddyfile for TLS, and the nightly backup script. |

What lives in `packages/core`:

- **`chain`**: Robinhood Chain mainnet/testnet presets, env overrides, viem chain, explorer links.
- **`address`**: address and hash normalization. Stored lowercase, displayed as EIP-55, and mixed case with a bad checksum is rejected.
- **`ids`**: prefixed, time-sortable ids (`fl_…`, `run_…`, `conn_…`, `usr_…`, `key_…`, `grt_…`, `oca_…`).
- **`flow`**: Zod schema for a flow definition (trigger → conditions → actions + settings), bounded in size and depth.
- **`catalog`**: closed vocabularies (trigger and action types, operators, statuses).
- **`registry`**: shared module interfaces plus empty trigger, operator and action registries.
- **`time`**: everything is stored in UTC and displayed in the user's zone, WIB by default.
- **`server/envelope`**: AES-256-GCM envelope encryption with key ids, context binding and re-wrap for rotation.
- **`server/env`**: per-service env schemas. Errors name the bad variable but never echo its value.
- **`server/logger`, `server/service`**: pino with secret redaction, and a graceful process lifecycle.

## Quick start

Requirements: Node ≥ 22.12 (developed on 24), pnpm 12.

```bash
pnpm install
cp .env.example .env          # defaults work for a first run
pnpm gen:secret               # paste into ENCRYPTION_KEY (connections)
pnpm gen:secret               # paste into WEBHOOK_SIGNING_SECRET (webhook signatures, inbound URLs)

pnpm dev:api                  # http://localhost:4000/health
pnpm dev:web                  # http://localhost:3000
```

Ports: `API_PORT` / `API_HOST` for the API, `PORT` for the web app; point the web app at
the API with `API_URL`.

## Database

`DATABASE_URL` selects the driver:

| URL | Driver | Use |
|---|---|---|
| `postgres://…` / `postgresql://…` | node-postgres pool | Real deployments (Neon / Supabase free tier), and running several services at once. |
| `pglite://.data/pglite` | Embedded PGlite on disk, relative to the repo root | Zero-install dev for **one process at a time**. A lock file refuses a second process before it can corrupt the data dir. |
| `pglite://memory` | Embedded, ephemeral | Tests. |

The API migrates PGlite automatically on start. On real Postgres, run migrations as an
explicit step:

```bash
pnpm db:migrate               # apply pending migrations
pnpm db:generate              # after editing packages/db/src/schema.ts — review the SQL it writes
```

To run listener + runner + api together (`pnpm dev`), use a real Postgres URL.

### Invariants enforced by Postgres, not just app code

- `runs.idempotency_key` is **unique**, so the same event can never produce a second run. Run creation (Phase 3) will insert with `ON CONFLICT DO NOTHING`, and that pattern is already covered by a test.
- `runs (flow_id, flow_version)` has a foreign key to `flow_versions`. Every run points at the exact definition it executed, and versions are append-only.
- `users.address` must be canonical lowercase hex (`CHECK`).
- Statuses are closed sets. `finished_at` is set **if and only if** a run or step is in a final state.
- Deletes cascade from user to flows, versions, runs and steps, and from user to connections.
- `connections.secret_enc` holds an envelope bound to `connection:<id>` and is never returned to clients.

## Chain listener

```
head (poll / WS wake) ──▶ tick ──▶ deep-reorg check ──▶ confirmed pass ──▶ pending pass (fast watches)
                                     cursor hash still      re-query (cursor, head-N]   (head-N, head]
                                     canonical?             reconcile → confirmed /     → pending
                                                            reverted
```

- **Watches** say what to ingest: `(address, topic0 | all)`. They come from active flows (Phase 3) or the CLI.
- **Confirmation is decided by re-querying at depth**, not by trusting what was seen at head. Any reorg shallower than the confirmation depth is absorbed: rows that vanished are marked `reverted` (`reorg`), and their replacements are inserted as `confirmed`.
- **Deep reorgs** are caught by checking that the confirmed cursor's block hash is still canonical. When it is not, the last `REORG_REWIND_BLOCKS` blocks are re-verified, and affected rows become `reverted` (`deep_reorg`).
- **Exactly-once ingestion:** events are unique on `(chain, block_hash, log_index)`. Each range commits atomically together with its cursor and a lease check, so a crash or a lost lease can never skip or double-count a block.
- **One active listener per chain**, through a lease in Postgres. Standby instances take over when the lease expires.
- **Node limits:** `getLogs` ranges shrink when the node refuses them (too many logs or blocks), stay under any cap the node states, and grow back after successes.
- **Decoding:** a contract's verified ABI (Blockscout, plus the EIP-1967 implementation for proxies) is tried first, then the built-ins: ERC-20, ERC-721, Ownable, AccessControl, Pausable, ERC-1967 and Safe v1.3/v1.4. Raw topics and data are always kept.

Measured on mainnet (2026-11-05):

| Measurement | Value | Consequence |
|---|---|---|
| Block rate | ~10 blocks/s | `depth 20` ≈ 2 s |
| `safe` tag | ~12 min behind head | Optional `CONFIRMATION_STRATEGY=safe` |
| `finalized` tag | ~18 min behind head | Optional `CONFIRMATION_STRATEGY=finalized` |
| `eth_getLogs` limits | 10k logs and 30k blocks per call | Adaptive range |
| Public WebSocket | None | Polling by default |
| Rate limiting | Public RPC returns HTTP 429 under load | Set `RPC_URL_FALLBACK` |

```bash
pnpm listener:cli watch add <token> "Transfer(address,address,uint256)" [--fast]
pnpm listener:cli watch add <contract>          # every event of the address
pnpm listener:cli watch list | watch rm <id> | status | events | stats
pnpm dev:listener                               # health: http://127.0.0.1:4001/health
```

ABI fetching needs a free Blockscout key (`EXPLORER_API_KEY`, from dev.blockscout.com). Without one,
the built-in ABIs still decode the common standards.

## Triggers, conditions and runs

```
chain_events ──▶ matcher ──▶ trigger module ──▶ conditions ──▶ hourly cap ──▶ runs (queued)
  confirmed stream → confirmed-mode flows          │ fail          │ over
  head stream      → fast-mode flows               ▼               ▼
  reverted stream  → mark / cancel runs      flow_evaluations (sampled) + flow_stats (exact)
```

| Trigger | Kind | Fires when |
|---|---|---|
| `TOKEN_TRANSFER` | log | An ERC-20 transfer of `token`, optionally only `in`/`out` of a `wallet`. |
| `CONTRACT_EVENT` | log | A specific event of `address`. A bare name is resolved to its full fragment at save time and pinned in the flow version. |
| `NEW_HOLDER` | log | An address's balance is 0 before a **transaction** and > 0 after it. Pass-through hops (routers) don't count. Confirmed mode only. |
| `BALANCE_THRESHOLD` | poll | A wallet's ETH or token balance **crosses** `threshold` (`below` / `above` / `cross`). It fires once per crossing. |
| `CONTRACT_DEPLOYED` | poll | A watched deployer creates a contract with CREATE. Detected via nonce → derived address → code. For CREATE2 factories, use `CONTRACT_EVENT` on the factory's creation event. |

How each trigger is built, from real mainnet behaviour (2026-11-05):

- **Re-decoded from raw data.** Triggers re-decode raw topics and data with their own canonical fragment, never the contract's ABI. WETH-style `src/dst/wad` naming can't break them.
- **NEW_HOLDER needs no indexer.** It keeps exact running balances, seeded once per batch at block N-1 through **Multicall3**. Batches never split a block. If the seed state was pruned (the public RPC keeps ~10–20 min), the event is recorded as `undetermined`, never guessed.
- **CONTRACT_DEPLOYED uses nonces.** The RPC has no `debug_*`/`trace_*`, so the trigger relies on deployer nonces instead of block scans.
- **Block timestamps are anchored.** The public RPC returns `blockTimestamp: "0x0"` in logs, so timestamps are exact at anchor headers and interpolated between them (error < 1 s).

**Conditions** (pure, fully tested, in `@ignitra/core`) follow these rules:

- Numbers and numeric strings compare as **exact decimals**: `"1000000000000000000000"` equals `1e21`.
- `0x` hex compares case-insensitively. Other strings compare exactly.
- A missing or null field **fails** every operator except `EXISTS`. A flow never runs on data it doesn't have.
- Incompatible types fail with `type_mismatch`.
- Every leaf is evaluated, so each run stores the full pass/fail trace with actual values.
- Fields are checked against the trigger's catalog at save time. `symbol` gets rejected with the hint *did you mean "token.symbol"?*
- Time windows use block time in WIB, e.g. `time.minutes_wib >= 480` (08:00).

**Runs and idempotency:**

- The run key is `chain_id:tx_hash:log_index:flow_id` for log triggers, `chain_id:balance:<block>:flow_id` for balance thresholds and `chain_id:deploy:<contract>:flow_id` for deployments.
- Keys are unique in Postgres, so replays are no-ops.
- Events from blocks before a flow's `activated_at` never trigger it.

**Reorgs:**

- Fast-mode runs whose event is reorged out get `reverted_at`. Still-queued ones are cancelled (`skipped`, `event_reverted`).
- If the same transaction re-lands in another block, the run is re-pointed, not reverted.

**Runaway protection:**

- `settings.max_runs_per_hour` is enforced from the runs table.
- If dropped events reach 3× the cap within an hour, the flow is **auto-paused** with a reason that explains how to fix it.

```bash
pnpm ops flow create flow.json --owner 0x…      # validates, normalizes, activates
pnpm ops flow list                              # status + matched / runs / failed / limited
pnpm ops runs --flow fl_…                       # runs with condition traces
pnpm ops evals --flow fl_…                      # why matching events did NOT run
pnpm ops flow pause|resume|show|update …
```

`GET /v1/triggers` serves the trigger catalog: params as JSON Schema, plus the payload fields available to conditions and templates.

Validated live on mainnet (USDG, ~2,000 transfers in 90 s):

| Check | Result |
|---|---|
| Whale flow | 208 runs; 1,784 transfers failed their condition and are counted and sampled |
| Firehose capped at 20/h | 20 runs, 134 dropped, auto-paused |
| Fast-mode approvals | 307 runs at head |
| Native balance crossing on a bot wallet | Fired once |
| NEW_HOLDER, checked on-chain | Every checkable run held a balance at the end of its block |

## Delivering actions (runner)

```
runs (queued) ──claim (FOR UPDATE SKIP LOCKED, lease)──▶ executor ──▶ step 1 ──▶ step 2 ──▶ …
                                                          │ retryable failure → back off (10 s, 30 s, 90 s, … · Retry-After)
                                                          │ permanent failure → next steps still run → run "partial"
                                                          └ trace per attempt in run_steps (request / response summaries, never secrets)
```

| Action | What it does |
|---|---|
| `TELEGRAM` | A bot message to a chat, group, topic or channel. HTML templates are supported, and every substituted value is escaped, so on-chain data can't inject markup. |
| `WEBHOOK` | A signed JSON envelope (`run.action`) sent to your server. |
| `WEB_PUSH` | A notification to the flow owner's browsers or installed PWA (VAPID, aes128gcm). |

**Telegram setup:**

1. Create a bot with @BotFather.
2. Add it to the group or channel (as admin for channels).
3. Register the destination:

   ```bash
   TELEGRAM_BOT_TOKEN=123:ABC… pnpm ops connection add telegram --owner 0x… --chat -1001234567890 --test
   ```

The token is verified (`getMe`, `getChat`) and stored encrypted. It is never returned and never written to traces.

**Webhooks** carry:

- `X-Ignitra-Signature: v1=<HMAC-SHA256(secret, "<timestamp>.<raw body>")>`
- `X-Ignitra-Timestamp`
- `X-Ignitra-Idempotency-Key`: `<run key>:<step id>`, the same value on every retry

Inline-URL webhooks are signed with your per-owner secret (`pnpm ops webhook secret --owner 0x…`, derived from `WEBHOOK_SIGNING_SECRET`). Connection webhooks get their own secret, shown once at creation.

If a fast-mode run was delivered and its event is later reorged out, the receiver also gets a signed `run.reverted`.

**Templates** (pure, no code execution):

- Syntax: `{{trigger.amount_formatted}}`, `{{steps.notify.message_id}}`, `{{now_wib}}`.
- Filters: `default: "…"`, `upper`, `lower`, `short`, `json`, `url`, `truncate: N`.
- Unknown variables are rejected when the flow is saved, using the trigger's field catalog and earlier steps' outputs.

**Safety:**

- Every outbound request goes through the SSRF guard. Private, loopback, link-local, metadata and reserved ranges are blocked. Each hostname is resolved and **pinned**, so DNS rebinding can't redirect it. Redirects are never followed.
- `OUTBOUND_ALLOW_PRIVATE=true` is for local development only.

**Reliability:**

- Workers that die mid-run lose their lease, and another worker resumes the run. Completed steps are never re-sent.
- A heartbeat keeps the lease alive during long steps.
- Pausing a flow, or reverting its event, stops pending steps while delivered ones keep their real result.
- After `RUNNER_AUTOPAUSE_FAILURES` consecutive failed runs (default 5), the flow is **auto-paused** and the owner is notified.

**Running the runner:**

- `pnpm dev:runner` starts a separate process. Several runners can share one Postgres.
- With embedded PGlite, run everything in one process: `LISTENER_ROLES=sync,matcher,runner pnpm dev:listener`.
- `pnpm gen:secret` and `pnpm gen:vapid` generate the keys.
- `pnpm ops run show <run_id>` prints the full trace.

Validated live on mainnet (USDG, about 80 s, all three stages in one process, independent receiver):

| Check | Result |
|---|---|
| Signed webhooks | 195 delivered: 174 inline + 21 via connection, **all signatures valid** |
| Duplicates | 0 idempotency keys repeated |
| Telegram | 153 messages rendered correctly |
| Cross-check | Two flows on the same NEW_HOLDER trigger delivered identical counts |
| Latency, block → receiver | p50 6.7 s, p95 17 s (the tail is public-RPC 429 backoff) |

## Accounts, API and plans

### Sign-In with Ethereum

No passwords and no private keys. The web app asks the wallet to sign an EIP-4361 message:

```
GET  /v1/auth/nonce                        → { nonce }  (single use, 10 min)
POST /v1/auth/verify { message, signature } → HttpOnly session cookie (+ bearer token with "return_token": true)
```

The server checks:

- the message is complete EIP-4361;
- its `domain` is allow-listed (`SIWE_DOMAINS`, default the hosts of `CORS_ORIGINS`) and `uri` is on that domain;
- the chain id is 4663;
- the time bounds hold;
- the nonce is unused;
- the signature is valid: ECDSA recovery for wallets, or **ERC-1271** `isValidSignature` on-chain for smart-contract wallets (Safe and others).

The nonce is deleted atomically, so a signed message works exactly once. Sessions store only a SHA-256 of the token.

Browsers get the HttpOnly session cookie (`SameSite=Lax`) and never see the token. Writes authenticated by that cookie must come from an allowed `Origin` (CSRF protection). Scripts send `Authorization: Bearer igs_…`.

### Endpoints

| | |
|---|---|
| `GET /v1/me`, `PATCH /v1/me`, `GET /v1/me/usage` | profile, display timezone (default `Asia/Jakarta`), plan, usage this month |
| `GET /v1/me/webhook-secret` | your secret for verifying inline-URL webhook signatures |
| `GET/POST /v1/connections`, `DELETE /v1/connections/:id` | Telegram (verified with Telegram before saving) and webhook destinations. Secrets go in and never come back, except a webhook connection's signing secret, which is shown once. A connection still used by a flow cannot be deleted (409). |
| `GET/POST /v1/flows`, `GET/PATCH/DELETE /v1/flows/:id` | flows. Every save writes a new immutable version. Validation errors return 422 with every issue and its path. |
| `POST /v1/flows/validate` | dry run: the normalized definition plus the trigger's payload fields |
| `POST /v1/flows/:id/pause` · `/resume` · `/hook/rotate` | resume re-validates and enforces the plan; rotate replaces the inbound URL |
| `GET /v1/flows/:id/runs?before=&status=`, `GET /v1/runs/:id` | run history (cursor paging) and the full trace |
| `GET /v1/flows/:id/evaluations` | why matches did **not** run: conditions, hourly cap, plan quota, undetermined, missed |
| `GET /v1/notifications`, `POST/GET/DELETE /v1/push/subscriptions` | owner notices (auto-pause, quota) and Web Push devices |

Every resource is scoped to its owner. Another owner's id answers 404, never 403. Errors are always `{ error: { code, message, … } }`.

### New triggers and action

| | |
|---|---|
| `SCHEDULE` | `{ "cron": "0 9 * * 1-5" }` fires at 09:00 WIB on weekdays. It uses 5-field cron plus `@daily` and similar, `L`, `W` and `#`, in any IANA timezone, and handles DST. Each scheduled time fires at most once (key `schedule:<time>`). After downtime, only the latest time fires (within 1 h); earlier ones are recorded as `missed`. |
| `STATE_CHANGE` | `{ "address": "0x…", "function": "balanceOf", "args": ["0x…"] }` fires when a contract read returns a different value. It is sampled at the confirmed head and exposes `previous`, `current` and `delta`. Bare function names are resolved from the ABI at save time. A reverting read is `undetermined`, never counted as a change. |
| `INBOUND_WEBHOOK` | Your own URL, `POST /v1/hooks/<flow_id>/<token>`, accepts JSON, form or text bodies up to 64 KB. Conditions and templates can read any path below `body.*`. `Idempotency-Key` dedupes retries. The response is 202 when stored, 404 for a wrong token, 409 when the flow is paused. |
| `CHAIN_READ` (action) | `eth_call` mid-flow, with templated address and args (`"{{trigger.to}}"`). The result is `{{steps.<id>.result}}`, typed from the function's return values, at `latest` or the trigger's block. |

The inbound URL token is `HMAC(HKDF(WEBHOOK_SIGNING_SECRET), flow_id:salt)`. Only the salt is stored, so a database dump cannot forge requests, the owner can always see the URL, and rotating it just means a new salt.

Intake is bounded:

- 60 requests per minute per URL;
- 5,000 requests per day per URL;
- nothing is stored when a free plan has no runs left (402).

### Plans

| Plan | Active flows | Runs / month | Over the quota | Schedules |
|---|---|---|---|---|
| Free | 3 | 500 | matches are recorded as `plan_limited`; no runs until the 1st (UTC) | no SCHEDULE (Builder feature, as are Email and Sheets) |
| Builder | 20 | 10,000 | keeps running, overage metered | every minute |
| Team | unlimited | 100,000 | keeps running, overage metered | every minute |

Limits are enforced server-side:

- **Active flows** are checked when a flow is created or resumed. The owner row is locked, so two concurrent activations cannot both pass. Over the limit returns 402.
- **Schedule frequency** is checked at save time.
- **Runs** are metered in `usage_monthly` inside the same transaction that creates them, so a replay creates and counts nothing.

Owners are notified once per month when the quota runs out. There is no billing yet: operators set a plan with `pnpm ops user plan <wallet> builder`.

### Running it

- With real Postgres, run `pnpm dev:api`, `pnpm dev:listener` and `pnpm dev:runner` as separate processes.
- With embedded PGlite, everything runs in one process: `LISTENER_ROLES=sync,matcher,runner,api pnpm dev:listener`.

Validated live on mainnet (2026-11-07, about 9 minutes, all four roles in one process). A local API client signed in with SIWE, then created connections and flows over the API:

| Check | Result |
|---|---|
| SIWE | EOA sign-in. Garbage message → 401. Another owner's flow → 404. |
| Plan limits | Free plan: 4th active flow → 402, minutely schedule → 422 |
| SCHEDULE `* * * * *` (WIB) | 9 consecutive minutes (13:22–13:30 WIB), 0 gaps, 0 duplicates. Fired 0.5 s after the minute (p50; max 1.0 s). CHAIN_READ `totalSupply()` ran in the same run. |
| STATE_CHANGE | `balanceOf` of a busy USDG pool: 92 changes, each with the correct `delta` |
| INBOUND_WEBHOOK | 4 POSTs: 1 duplicate key ignored, 1 below the condition, 2 runs with a CHAIN_READ of `body.wallet` |
| Independent check | 35 recorded values (STATE_CHANGE before / after, CHAIN_READ results) re-read straight from the RPC at the same blocks: **0 mismatches** |
| Delivery | 103 signed webhooks, all signatures valid, 0 duplicate keys. 103 Telegram messages. Usage meter = 103 = runs. |

Not yet exercised live; covered by tests only:

- **Scheduler downtime catch-up:** a deterministic clock fires the latest time and records 7 as `missed`.
- **ERC-1271 sign-in from a real Safe:** tested against an on-chain-style contract in FakeChain.
- **Real Telegram:** this run used a local Bot API stub.

## Builder UI and more actions

The web app is the product surface:

| Page | |
|---|---|
| `/app` | Flows: status, trigger → actions, runs, last run, last error |
| `/app/flows/new`, `/app/flows/<id>/edit` | The builder |
| `/app/flows/<id>` | Stats, run history (filter, cursor paging), "why it did not run", the inbound URL (copy / rotate), Test / Pause / Activate |
| `/app/runs/<id>` | Step-by-step trace: trigger evidence, every condition with its actual value, each action's request and response |
| `/app/connections` | Telegram, webhook, email (verified), Google (OAuth), HTTP secret headers |
| `/app/settings` | Plan and usage, display timezone, Web Push devices, webhook secret, notices |

The browser only talks to its own origin: `/api/*` is proxied to the API (`API_URL`, read **at build time**). The session cookie is therefore first-party, and the API's CSRF check sees the app's Origin.

- Put the app's origin in `CORS_ORIGINS`. The SIWE domain is derived from it.
- Set `TRUST_PROXY` to the proxy's addresses, so rate limits see client IPs.

**Builder.** A vertical form, not a canvas:

```
TRIGGER → CONDITIONS → ACTION 1 → ACTION 2 → … → SETTINGS
```

- **Address auto-detection:** a pasted address is identified as a token (symbol, name, decimals, supply), a contract (its ABI's events and view functions become pickers) or a wallet.
- **Live sample:** the latest **real** matching event, found by scanning back from the confirmed head (about 2.8 h), preferring one that passes the conditions. Poll triggers sample the current state, SCHEDULE its time, INBOUND_WEBHOOK the last request or a pasted body. Nothing is invented.
- **Conditions:** evaluated against the sample in the browser, with the matcher's own evaluator ("✓ passes with 1542.35").
- **Variable picker:** inserts `{{…}}` at the cursor. It lists the trigger's fields with sample values, the outputs of earlier steps (typed, e.g. CHAIN_READ results) and built-ins.
- **Test flow:** saves a draft, then runs the actions once with the sample.
  - Test runs are labelled: `🧪 TEST` in Telegram, `[TEST]` in email subjects and push titles, `test: true` / `X-Ignitra-Test` in webhooks and HTTP requests, a trailing `🧪 TEST run` cell in Google Sheets rows.
  - They are never metered, run on paused drafts, and are capped at 30 per hour.
  - Conditions are evaluated and shown, so you see whether a real event like this one would have run.

**New actions:**

| | |
|---|---|
| `HTTP_REQUEST` | Any method and headers, with a JSON / text / form body built from templates. In JSON bodies, values are JSON-escaped and the result must parse. API keys live in an `http` connection, encrypted and **bound to one host**, so a templated URL can never carry them elsewhere. Header names that look like credentials are refused in plain params. Requests are signed and carry the idempotency key. |
| `EMAIL` | Plain text with a safe HTML twin, via Resend or Brevo from the platform's sender. Recipients are `email` connections that confirmed a 6-digit code (30 min, 5 tries, 3 pending per user), so nobody can be mailed without consent. |
| `GOOGLE_SHEETS` | Appends a row (one template per column). Google OAuth uses offline access; the refresh token is stored encrypted and access tokens are cached in memory. With USER_ENTERED, substituted values that would be read as a formula (=, +, -, @) are written as text, so on-chain data cannot inject `IMPORTXML`. Appends are at-least-once: add `{{run.idempotency_key}}` as a column to dedupe. |

**Plan features** follow the monetization table:

- Email, Google Sheets and SCHEDULE need **Builder**. Locked types are greyed out in the builder and rejected by the API.
- A downgrade (`pnpm ops user plan`) pauses flows that use locked features and notifies the owner.

**PWA.** The app ships a manifest, generated icons and a service worker for Web Push and notification clicks. App data is never cached.

- On Android and desktop, "Enable on this device" in Settings is enough.
- On iPhone, add IGNITRA to the Home Screen first; Web Push works from there (iOS 16.4+).

Validated live on mainnet (2026-11-07). The production build ran on :3200 with the API behind its proxy. The client drove everything through `/api` like a browser: session cookie only, Origin header, no bearer token. Email and Google ran against local stubs of Resend and Google (consent → callback → token refresh); Telegram ran against a stub too.

| Check | Result |
|---|---|
| Sign-in through the proxy | SIWE → HttpOnly cookie (no token in the body). A cookie write without Origin → 403. |
| Detection / sample | USDG detected (Global Dollar, 6 decimals). The sample was the latest real transfer, preferring one ≥ 1,000 USDG to match the conditions. |
| Connections | Telegram verified. Email verified with the mailed code. HTTP secret headers. Google OAuth round trip through the proxy. |
| Test flow | One TEST run of a 5-step flow (CHAIN_READ → Telegram → HTTP API → email → Sheets): all succeeded and every message was labelled TEST |
| Activated | 20 real runs, all succeeded. 994 matches: 912 failed the conditions, then 62 hit `max_runs_per_hour=20` and the flow **auto-paused** (runaway protection), with a notice in Settings. |
| HTTP API calls | 22 requests: 22/22 valid signatures, the host-bound secret header present, valid JSON bodies with values from the trigger and earlier steps, 0 duplicate idempotency keys |
| Email / Sheets / Telegram | 21 emails, 21 rows (one OAuth refresh for the whole session), 21 messages |
| Inbound URL through the proxy | 202. A retry with the same Idempotency-Key → `duplicate: true`, one run. |
| UI | Headless Edge screenshots of every page with live data, desktop and phone width (the run history becomes cards). No page errors. |

Not exercised live yet:

- real Resend / Brevo / Google accounts (they need your keys and OAuth client);
- Web Push on a phone;
- a wallet extension in a real browser (the SIWE server path is the one validated above).

## Templates, gallery and docs

Public pages (no sign-in), server-rendered from the API:

| Page | |
|---|---|
| `/` | Landing: the pitch, a **live demo** (a real flow's latest runs on mainnet), featured templates, guarantees, system status |
| `/templates` | Gallery: 14 official templates by category, plus community templates |
| `/templates/<slug>` | What a template does (WHEN / IF / THEN), what you fill in, Share on X, copy link |
| `/docs` | Overview, Triggers, Conditions, Actions, Variables, Webhooks, API. Triggers and Actions are generated from the live catalog (`/v1/triggers`, `/v1/actions`) |

In the app, `/app/templates/<slug>` fills in a template ("Create & activate" or a draft) and `/app/templates` lists the templates you shared. Every flow page has "Share as template", and the builder offers "Start from a template".

**Templates.** A template is a flow definition whose variable parts are whole-value placeholders, `{"$param": "token"}`:

- Types: address, decimal, number, text, connection (of a given type), cron, url, spreadsheet, select. An optional placeholder left empty drops its property.
- "Use template" fills them in and validates exactly like a hand-built flow, with issues mapped back to each field. It applies the plan's limits and creates the flow, active or as a draft.
- Destinations are never defaults: a connection, URL or spreadsheet is always the user's own choice.

The official templates live in `packages/core/src/template-catalog.ts`. A test fills each one with example values and validates it against the real trigger and action modules. Each has a ready-made post for X (`shareText`), which "Share on X" pre-fills.

| Template | Trigger → actions | You fill in |
|---|---|---|
| `big-buy-telegram` | TOKEN_TRANSFER → TELEGRAM | token, threshold, chat |
| `whale-sell-push` | TOKEN_TRANSFER → WEB_PUSH | token, whale, min_amount |
| `new-holder-sheets` (builder) | NEW_HOLDER → GOOGLE_SHEETS | token, google, spreadsheet, sheet |
| `new-holder-welcome-telegram` | NEW_HOLDER → TELEGRAM | token, chat |
| `treasury-low-email` (builder) | BALANCE_THRESHOLD → EMAIL | wallet, threshold, email |
| `token-balance-low-telegram` | BALANCE_THRESHOLD → TELEGRAM | wallet, token, threshold, chat |
| `proxy-upgraded-webhook` | CONTRACT_EVENT → WEBHOOK | proxy, url |
| `ownership-transferred-telegram` | CONTRACT_EVENT → TELEGRAM | contract, chat |
| `paused-telegram` | STATE_CHANGE → TELEGRAM | contract, chat |
| `daily-supply-sheets` (builder) | SCHEDULE → CHAIN_READ → GOOGLE_SHEETS | token, schedule, google, spreadsheet, sheet |
| `new-contract-telegram` | CONTRACT_DEPLOYED → TELEGRAM | deployer, chat |
| `large-transfer-webhook` | TOKEN_TRANSFER → WEBHOOK | token, min_amount, url |
| `mint-burn-telegram` | TOKEN_TRANSFER → TELEGRAM | token, chat |
| `inbound-telegram-relay` | INBOUND_WEBHOOK → TELEGRAM | chat |

Telegram stands in for Discord, as in Phase 4. Phase 8 adds four more (18 in all): `pons-launch-telegram`, `vigil-upgrade-webhook`, `vigil-critical-telegram` and `risky-buyer-telegram`. `proxy-upgraded-webhook` still watches the EIP-1967 `Upgraded` event directly, without VIGIL.

**Sharing.** "Share as template" publishes the flow's current version and converts it automatically:

- Connections, webhook and HTTP URLs, spreadsheets and contract-read addresses become placeholders with no default.
- Trigger addresses, thresholds and schedules become editable defaults. Condition placeholders read like a form, e.g. "Minimum amount (token units)".
- Message texts are kept as written, and the author's wallet address is shown. The form says both before publishing.
- Visibility is `unlisted` (anyone with the link) or `public` (listed under Community). Each user can publish 10 per hour, and uses are counted.
- The operator can take one down with `pnpm ops template hide <slug>`: it then answers 404 everywhere. Flows already made from it keep running, because they are copies. `unhide` restores it and `template list` reviews them.

**Live demo.** `pnpm ops demo setup <wallet> [--token 0x…] [--min 1000]` creates a read-only flow owned by that wallet and prints its id: transfers ≥ min → read the recipient's balance. Set `DEMO_FLOW_ID` on the API.

- `GET /v1/demo` serves the outline (destinations hidden), stats, the p50 / p90 latency from block to finished run, and the last 12 runs, cached for 5 s.
- Demo runs are metered. The command warns when the owner's plan is capped; fix it with `pnpm ops user plan <wallet> team`.

**Caching.** Refresh rates:

- The landing regenerates at most every 5 s. Its feed polls while the tab is visible.
- Template pages refresh every 60 s, and the official ones are pre-rendered at build.
- The docs catalogs refresh every 5 minutes.

If the API is down during a refresh, the last good page stays up: a fallback is never cached as a 404. Build the web app with the API reachable at `API_URL`. Otherwise the first docs build shows "catalog unavailable" until its next refresh.

Validated live on mainnet (2026-11-07). The production build ran on :3300 with the API behind its proxy, and the client acted like a browser (cookie + Origin). Telegram ran against a stub. The receiver verified webhooks with the docs' own Node snippet.

| Check | Result |
|---|---|
| Gallery | 14 official templates, served anonymously. The category filter works and an unknown slug → 404. Every detail page has placeholders, an outline, a link and X text. |
| Use template | big-buy-telegram (threshold: 2,000 USDG as a % of supply) and large-transfer-webhook were created active. The token was normalized to lowercase. Missing or bad values → 422 per field. Another user's connection → 422. A builder-only template on free → 422 "needs the builder plan". Signed out → 401; a cookie write without Origin → 403. |
| Publish | A public and an unlisted template from A's flows contain no connection id, chat id or URL. The unlisted one is not listed but works by link. B can neither publish nor delete A's. |
| Community use | B used A's public template with B's own chat. The flow went active, the card counted the use, and B's flow posts to B's bot. |
| Real runs (≈ 20 min) | 60 + 60 + 60 succeeded runs; each flow then reached `max_runs_per_hour`. 120 Telegram messages and 60 webhooks: 60/60 signatures valid with the docs snippet, 60 distinct idempotency keys. No duplicates across two backend restarts. |
| Operator | `template hide` → 404 on the API, the gallery, the page and instantiate. The flow made from it kept running. `unhide` restored it with its use count. |
| Docs examples | The API docs' sign-in script ran verbatim (bearer token, lists the flows). The create-flow example validates. |
| Demo | `/v1/demo` with real runs: p50 5.0 s, p90 6.8 s block → done over 100 runs in steady state. A restart shows up as a longer p90. |
| UI | Headless Edge at desktop and phone width: landing with the live feed, gallery, details, the use form (and the plan lock), the share form, every docs page. No page errors, no horizontal overflow. |

Not exercised live: the Email and Sheets templates against real accounts (the actions were validated on stubs in Phase 6), and the Python verification snippet (no Python on the test machine; it mirrors the tested Node one).

## SDK, integrations and onchain actions

**API keys.** Team plan, made in Settings → API keys (or `POST /v1/api-keys` with a wallet session).

- `igk_` + 32 random bytes, shown once. Only its SHA-256 and a 12-character prefix are stored. At most 20 active keys; revoking stops a key at once.
- A key acts as its account, except that managing keys and creating or verifying onchain grants need the wallet. Revoking a grant works with a key.
- Limits are token buckets: 600/min per key (stored per key), 600/min per signed-in account (`SESSION_RATE_PER_MINUTE`), and 300/min per client address on public routes (`PUBLIC_RATE_PER_MINUTE`). The landing page's `/v1/demo` has its own bucket at 4×.
- Inbound hooks and VIGIL deliveries are limited per hook or connection. Failed lookups (unknown URL, bad token or signature) also spend a 120/min budget of the sender's address, so guessing is bounded while one sender delivering for many users is not.
- Answers carry `RateLimit-Limit`, `-Remaining` and `-Reset`, plus `Retry-After` on a 429.

**`@ignitra/sdk`** (`packages/sdk`, README there), on npm: `npm install @ignitra/sdk`. Dependency-free ESM for Node 20+, Deno, Bun, browsers and edge runtimes.

- Covers flows (`iterateRuns` pages for you), runs and traces, connections (incl. `setVigilSecret`), templates, catalogs and the account.
- `parseWebhook`, `verifyWebhookSignature` and `signWebhookPayload` use WebCrypto.
- A 429 is retried after `Retry-After`; 502, 503, 504 and network errors are retried only for idempotent requests.
- `pnpm --filter @ignitra/sdk build` writes `dist/` (`prepack` runs it). Not published to npm yet.

**Integrations.**

| Service | In IGNITRA |
|---|---|
| VIGIL | The `VIGIL_ALERT` trigger. Add the connection in one of two ways. With a `vgl_` API key, IGNITRA registers its receiver in VIGIL itself and does not keep the key. Without one, the user registers the receiver URL in VIGIL, then pastes the secret VIGIL showed into `POST /v1/connections/:id/verify`; deliveries are refused until then. The receiver `POST /v1/integrations/vigil/:connection_id` checks `x-vigil-signature` (HMAC over `"<ts>.<raw body>"`, 5 min). The trigger's options are stage, minimum severity, rules, contracts and retractions. Each alert runs once per stage. VIGIL only delivers to public URLs, so the API must be reachable at a public `API_PUBLIC_URL`. |
| TRUST LAYER | `counterparty_trust_score`, `from_trust_*` and `to_trust_*` (score, band, status) for conditions and templates. Lookups are lazy: only for flows that read them, after the other conditions pass, cached per address, with a circuit breaker. A 429 pauses every lookup for its `Retry-After`. A score is never invented: without one the score is null and `*_trust_status` says why (`pending`, `unavailable`, …). Matching waits up to `TRUST_LAYER_WAIT_MS` (8 s) for a score. Trust Layer computes a stale score on request, which can take seconds, so a later answer is still cached for the next event from that address. TEST runs and the builder's preview wait up to 15 s. Set `TRUST_LAYER_API_URL` (and `_KEY`). |
| MANDATE | The policy every ONCHAIN_TX must pass, defined here: a signed POST of the exact call (`onchain.intent`), answered `{"decision":"allow"|"deny"}`. Only `allow` sends. `deny` is final; anything else is retried and nothing is sent. `ONCHAIN_MANDATE_REQUIRED` (default true) makes it mandatory for every grant. |
| Pons | The `NEW_LAUNCH` trigger: `TokenLaunched` on the Pons V2 factory. It gives the token, the deployer (`counterparty`), the curve, the pair (ETH or a token), the graduation threshold and the socials (unverified). |

**Onchain actions (ONCHAIN_TX).** Team plan; a flow must opt in (`settings.onchain`) and run on confirmed events.

- **Grant.** IGNITRA makes a session key per grant, stores it encrypted and wipes it on revoke or expiry. The user's Safe gives that key a Zodiac Roles v2 role: specific targets and functions only.
- **Limits.** Amounts per call (`LessThan`) and per day (`WithinAllowance`), ETH per day (`EtherWithinAllowance`), and ETH per call plus the expiry (`IgnitraSessionBounds`, a stateless `Custom` condition) are all enforced on chain. The Roles mastercopy on Robinhood Chain is byte-identical to the copy verified on Ethereum.
- **Refused scopes.** The Safe, its Roles modifier and every enabled module can not be targets. Token movers without amount caps, read-only functions and expiries outside 10 min–90 days are refused. Delegatecall is never allowed.
- **Approval.** One Safe transaction batched through MultiSendCallOnly. It deploys the modifier and the bounds contract the first time, enables the modifier, gives the role, scopes each function and sets the daily allowances. A 1-of-N owner sends it from the wallet (pre-validated signature); otherwise it goes out as a Safe Transaction Builder file.
- **Verification.** The mined transaction's Roles events are replayed in log order into the permissions they leave, which must be exactly the grant. Then the module, its owner, avatar and target, and the bounds contract are checked live. Only then is the grant active.
- **Execution.** Scope and daily totals, then MANDATE, then a simulation as the session key (Roles refusals are explained). The transaction is signed and recorded under a row lock on the grant, then broadcast under that lock, so a revocation committed first stops it.
- **Guarantees.** A step is signed at most once: retries re-send the same bytes and a record is never overwritten. Nonces are held for transactions the node has not seen yet. TEST runs only simulate. Every attempt is logged in `onchain_actions` with its hash.
- **Revoke.** In IGNITRA, at once (the key is deleted), plus the Safe transaction that also removes the role.

**Web.** New and changed screens:

- Settings has API keys; Connections adds VIGIL (with the two-step manual setup) and MANDATE.
- `/app/onchain` creates grants, approves them from the wallet or a Transaction Builder file, verifies, revokes, and shows the session key's gas balance and the action log.
- The builder adds Pons launch and VIGIL alert triggers, and an Onchain transaction step (grant → contract → function) with its opt-in.
- Docs: `/docs/integrations`, `/docs/onchain` and `/docs/sdk`; the API page covers keys and grants.

**Validated (2026-11-08).** Typecheck plus 528 tests.

- The fork test (`FORK_TESTS=1`, anvil on a mainnet fork) uses the real Safe 1.4.1, Roles v2, MultiSendCallOnly and USDG contracts.
- It proves every limit is enforced by the chain itself, not only by IGNITRA: ETH and USDG per call and per day, functions, targets and expiry.
- It also covers MANDATE deny, down and allow, exactly-once, TEST simulation, and revocation on the Safe and in IGNITRA.

Live on mainnet, with a local backend, the web app, a stub receiver and a throwaway test wallet:

| Check | Result |
|---|---|
| SDK (the built package) with an API key | 10/10: account, catalog, connections (webhook, MANDATE, Telegram, VIGIL pending), validate with trust fields, 422 issues, create, TEST run, `iterateRuns`, pause. An API key can not create keys or grants (403 `session_required`). |
| Webhooks | 31 deliveries (30 real USDG transfers + 1 TEST), 31 verified by the SDK's `parseWebhook`. The busy flow then auto-paused at `max_runs_per_hour`. |
| TRUST LAYER | Real lookups against a running Trust Layer. It answered 202 (still indexing), giving `pending`, then 429, giving `unavailable`; a score was never invented. This led to honouring `Retry-After`. On 2026-11-10 it had scores. TEST runs of 13 real USDG transfers from the earlier run (a draft flow with `from_trust_score ≥ 600`) read `scored` 4 times (673–750), `provisional` 3 times (665–705), `insufficient_data` 3 times and `pending` 3 times, each as Trust Layer answered. The condition passed for exactly the seven scored and provisional senders. A stale score took 3–10 s on its first request and about 20 ms after that. That outran the old 3 s timeout, so lookups now wait a bounded time and keep late answers. |
| Pons | The latest real launch decoded through `/v1/samples`: LimeLift (LIME), block 108,642,056, ETH pair, 4.2 ETH graduation, socials. |
| Grant on a real Safe | A pending grant for a mainnet Safe 1.4.1 that is not ours: 7 planned calls and a Transaction Builder file. Without MANDATE → 422; with an API key → 403; verifying an unrelated transaction → refused with the reasons. Nothing was sent. |
| UI | Headless Edge: Settings, Connections, Onchain, the grant page, the builder with an Onchain transaction step, the new docs. No page errors, no horizontal overflow. |
| VIGIL | Against a running VIGIL: a test account (wallet sign-in) and a `vgl_` key. IGNITRA registered its public receiver URL (through a tunnel) in VIGIL with that key, and VIGIL accepted it as public. VIGIL's own signed test request crossed the internet to IGNITRA and passed its check (200, 480 ms). Separately, VIGIL's real sender code posted a real VIGIL finding (a large USDG mint): verified, and mapped to the trigger's fields (rule, severity, tx, block, actor, explorer link). |

Not validated live yet:

- **A run started by a real VIGIL alert.** Three watches on busy wallets raised no alert in about 15 minutes. Such an alert takes the path VIGIL's test request took.
- **ONCHAIN_TX on mainnet.** It needs a Safe we own; the fork test proves it.

**The npm release.** `@ignitra/sdk@0.1.0` was published on 2026-11-11 by the `ignitra` organization. The tarball on the registry is byte-identical to the local pack (same sha512, signed by the registry), and a clean `npm install @ignitra/sdk` imports it.

To release a new version, bump `version` in `packages/sdk/package.json` and run `pnpm release:sdk` in an interactive terminal. It must be pnpm: it publishes the `dist` entry points from `publishConfig`, and `prepublishOnly` runs the typecheck and tests first. The account has 2FA, so npm asks for an approval in the browser. Without a terminal, publish the tarball from `pnpm pack` and answer the same approval. A brand-new package shows a temporary `0.0.0-stage` placeholder version, and `latest` points to the real one.

## Hardening and operations

**Security.**

- **Rate limits and abuse.** Token buckets per API key, account and client address; per-hook and per-connection limits on receivers, plus a failure budget per sender address that bounds URL guessing. Sign-in nonces, test runs, grants and retries have their own limits.
- **SSRF.** Every outbound request resolves the name first and refuses private, loopback, link-local, CGNAT, multicast and reserved addresses in every spelling (short and mixed IPv4, mapped and IPv4-compatible IPv6, Teredo, `.local`, `localhost.`). The connection is pinned to the address that was checked (no DNS rebinding) and redirects are never followed.
- **Templates never execute code.** `{{…}}` is a path lookup with escapes (JSON, Sheets formula injection), never `eval`; the prototype chain is never walked.
- **Audit log.** Every change through the API (flows, connections, API keys, grants, templates, settings, push devices, sign-ins, revealing the webhook secret), the system's auto-pauses and the operator CLI are recorded with the actor (session, API key, operator, system), the key that acted, non-secret details and the client address. `GET /v1/audit-log`, the SDK's `auditLog()`, Settings → Activity.
- **Permission review.** `/app/onchain` lists every grant that can still act: what it may call and how much, the flows using it, its last 7 days, and findings (no active flow uses it, pending for over a day, idle for 30 days, no MANDATE policy, expiring, can send ETH). **Revoke all** deletes every session key at once and prepares one optional Safe transaction per Safe to remove the roles. API: `GET /v1/onchain/review`, `POST /v1/onchain/grants/revoke-all` (an API key may revoke).

**Reliability.**

- The listener resumes from its cursors after a restart without duplicates, and never advances past a failed tick. One instance leads (lease); a stand-by takes over when the lease expires and the old leader can no longer commit.
- **Gap detector.** Every `SYNC_VERIFY_EVERY_MS` (5 min) the listener re-reads up to `SYNC_VERIFY_MAX_BLOCKS` recent confirmed blocks and inserts watched events the node had left out. Their flows still run, late but never lost.
- **Runner crash recovery.** A run whose worker died is reclaimed when its lease expires (`RUNNER_LEASE_MS`); the dead worker is fenced out, and steps that already delivered are not sent again.
- **Dead letters.** Steps that failed for good wait on the dashboard (Needs attention), `GET /v1/dead-letters` and `pnpm ops dead-letters`. A retry re-runs only those steps with the same idempotency keys.
- **RPC fallback.** A failing endpoint cools down and the next one serves; the chain id is verified on every endpoint before the first read.

**Metrics.** Prometheus text on the listener's internal health port (`LISTENER_HEALTH_PORT`, path `/metrics`), never on the public API. `pnpm ops metrics` shows the same numbers. Suggested alerts:

| Metric | Alert when | Means |
|---|---|---|
| `ignitra_listener_last_tick_age_seconds` | > 60 | The listener is stuck or down |
| `ignitra_listener_lag_blocks` | > 600 for 5 min (about a minute of blocks) | Ingestion falls behind |
| `ignitra_gap_detector_missing_total` | increases | An RPC endpoint answered short: check it |
| `ignitra_rpc_error_rate` | > 0.2 for 10 min on an endpoint | Rate limits or an outage |
| `ignitra_queue_oldest_due_seconds` | > 120 | The runner is down or saturated |
| `ignitra_event_to_run_seconds{quantile="0.95"}` | > 60 (depth confirmations) | Slow matching or delivery |
| `ignitra_step_success_rate` | < 0.9 for an action type, with 20+ steps an hour | A destination or integration is failing |
| `ignitra_dead_letters` | jumps | Many owners have failed steps to retry |

**`pnpm ops doctor`.** Checks a deployment's configuration against the real services and exits 1 on a failure. Run it after every change to the environment.

- **Core.** The database and pending migrations. Every RPC endpoint's chain id and head (only the host is printed: RPC URLs carry API keys). Whether `ENCRYPTION_KEY` still opens the stored secrets: it catches a key replaced under the same `ENCRYPTION_KEY_ID`, which `keys status` cannot.
- **Settings.** The webhook secret and an unfinished rotation. That the VAPID key pair matches. That the public URLs are https, and that CORS and the sign-in domains include the web app.
- **Email.** Resend: the key, and that `EMAIL_FROM`'s domain is verified. Brevo: that the sender is active.
- **Google.** The OAuth client is presented with a made-up code, and Google says whether it knows the client.

Nothing is sent to users and nothing is written.

**Rotating `ENCRYPTION_KEY`.** Secrets use envelope encryption, so a rotation re-wraps data keys and never re-encrypts the data.

1. `pnpm gen:secret`. On every service set the new `ENCRYPTION_KEY`, a new `ENCRYPTION_KEY_ID` (e.g. `k2`), and the old key in `ENCRYPTION_KEYS_PREVIOUS` (`k1:<old>`). Restart. Everything keeps working, and new secrets use the new key.
2. `pnpm ops keys rewrap --dry-run`, then `pnpm ops keys rewrap`: every connection secret and session key now opens with the new key. A secret no listed key opens is reported, never altered.
3. `pnpm ops keys status` shows `pending: 0`. Remove the old key from `ENCRYPTION_KEYS_PREVIOUS` and restart. Backups taken before the rotation still need the old key: keep it with them.

**Rotating `WEBHOOK_SIGNING_SECRET`.**

1. Set the new value, with the old one in `WEBHOOK_SIGNING_SECRET_PREVIOUS`, on every service. Restart.
2. During the overlap, deliveries signed with the owner secret carry two `v1=` signatures (receivers accept either). Inbound URLs and Google sign-ins started with the old value still work. Settings shows the owner's new secret and the previous one. Connection webhooks have their own secrets and are not affected.
3. Tell owners to switch receivers to the new secret and senders to the new inbound URLs (each flow shows its current URL). Then remove `WEBHOOK_SIGNING_SECRET_PREVIOUS` and restart: the old URLs answer 404.

**Backups.** `pnpm ops db export <file.ignitra.gz>` writes every table from one consistent snapshot, so it can run while the services do (with PGlite, stop the process first: one process per data dir). The same file restores into PGlite or Postgres, which also moves a dev database to Postgres.

- Bigints, jsonb and timestamps round-trip exactly, and every sequence is restored (ids, and the event-stream positions consumers track). A sha256 trailer catches truncation and edits. The file is owner-only.
- Timestamps are written in UTC whatever the server's TimeZone, so the same data gives the same bytes on every server. It also restores across Postgres major versions (PGlite is PostgreSQL 18).
- `pnpm ops db verify <file>` checks one without a database. `pnpm ops db import <file>` restores into an **empty** database at the **same schema version** (restore with the IGNITRA version that took the backup, then upgrade), in one transaction: any problem leaves the database as it was.
- Secrets stay encrypted inside, so a restore needs the same `ENCRYPTION_KEY`. Store the key apart from the backups.
- Suggested: a nightly export by cron or Task Scheduler, kept 14 days and copied off the machine; a monthly restore test into a scratch database. With managed Postgres, keep its point-in-time recovery too.

**Launch checklist** (2026-11-08). Typecheck plus 556 tests; fork tests opt in with `FORK_TESTS=1`.

| Item | Status | Evidence |
|---|---|---|
| Flow from a template in under 2 min | ✅ | One form (Phase 7, live): pick the values and a destination, the flow starts active |
| Every trigger on a live chain or a fork | ✅ | See the matrix below |
| No duplicate runs for one event | ✅ | Unique key per event and flow in Postgres; live: 0 duplicate keys, also across two restarts (Phase 7); fork: a restart replays nothing |
| Retries + idempotency | ✅ | Executor tests (backoff, resume at the failed step, same keys); live: distinct idempotency keys on every delivery |
| Web Push on a phone | ⏳ | Through a real push service: ✅ (below). On a phone: needs your phone and the app on public HTTPS |
| Webhook signature verifiable with the SDK | ✅ | Live (Phase 8): 31/31 deliveries verified by `parseWebhook` |
| Google Sheets + email | ⏳ | Validated against local Resend and Google stubs (Phase 6); real accounts need your keys and OAuth client |
| Run trace explains every skip and failure | ✅ | Condition traces, sampled evaluations with reasons, per-step errors, dead letters |
| Docs complete | ✅ | `/docs` (overview, triggers, actions, conditions, variables, webhooks, API, SDK, integrations, onchain), this README, the SDK README |
| Monitoring in place | ✅ | `/metrics` and the alerts above |

Trigger matrix. The fork test (`apps/listener/src/triggers.fork.test.ts`) runs anvil on a mainnet fork through the production RPC reader, ChainSync and Matcher:

| Trigger | Live on mainnet | Fork (2026-11-08) |
|---|---|---|
| TOKEN_TRANSFER | Phases 3, 5, 7 (USDG) | 2 transfers into a wallet → 2 runs |
| CONTRACT_EVENT | Phase 3 (fast-mode approvals) | USDG `Approval` → 1 run with decoded args |
| NEW_HOLDER | Phase 3 (checked on chain) | 2 new holders → 2 runs; a repeat transfer → none |
| BALANCE_THRESHOLD | Phase 3 (native, a bot wallet) | Crossing 1 ETH → 1 run; staying above → none |
| CONTRACT_DEPLOYED | — | A deployment by the watched EOA → 1 run with the address |
| STATE_CHANGE | Phase 5 (a USDG pool) | `balanceOf` 0 → 12.5 → 13.5 USDG → 2 runs |
| NEW_LAUNCH | Phase 8 (a real launch decoded) | The newest real Pons `launchAndBuy`, sent again with a fresh CREATE2 salt → 1 run with the new token |
| SCHEDULE | Phase 5 (9 minutes, 0 gaps, 0 duplicates) | not a chain trigger |
| INBOUND_WEBHOOK | Phases 5, 6 (incl. a duplicate key) | not a chain trigger |
| VIGIL_ALERT | Phase 8 (VIGIL's signed request and a real finding verified) | not a chain trigger |

Web Push through a real push service (2026-11-08). Headless Edge with the production web build, the backend in one process:

| Check | Result |
|---|---|
| Subscribe | Settings → Enable on this device: the app's own code subscribed with the server's VAPID key, and the API stored a device on `wns2-pn1p.notify.windows.com` (Microsoft's push service) |
| Deliver | A real INBOUND_WEBHOOK request ran a WEB_PUSH step: the runner sent it through the SSRF-guarded client, and the push service accepted it (`delivered: 1`, 554 ms) |
| Show | IGNITRA's service worker showed "Order A-77 paid / 120 USDG from 0xabc…def" with the rendered https link, tagged per flow |
| Remove | Unsubscribed in the browser and removed through the API (204) |

This run found a real bug, now fixed. A request sent 24 ms after its flow was created never ran: the matcher's flow index was cached and the stream's offset moved past the request. Rows newer than the index are now matched with an index read after them, and a regression test covers confirmed, fast and inbound flows.

Still open: Web Push on a phone; real Resend and Google accounts; a run from an organic VIGIL alert; ONCHAIN_TX on mainnet (it needs a Safe we own; the fork test covers it).

## Deploying

The low-cost layout from the plan: the web app on Vercel, one small VPS for the API, listener and runner, and Postgres on Neon (or Supabase). The files are in `deploy/`. They have not been run on a VPS yet. The multi-process setup itself was rehearsed on real Postgres (below).

**`deploy/CHECKLIST.md` is the step-by-step launch list**: accounts, DNS, every variable and where it comes from, Vercel settings, and checks. Two scripts do the server work:

- `deploy/bootstrap.sh`, once, as root on a fresh Ubuntu or Debian VPS: `API_DOMAIN=api.example.com bash bootstrap.sh`. It installs Node.js 24 (LTS), pnpm, Caddy and rsync, creates the `ignitra` user and directories, and sets up the firewall (SSH, 80, 443), Caddy, the systemd units and the nightly backup. It is safe to run again; `DRY_RUN=1` prints the commands instead.
- `deploy/push.sh root@host`, from your machine, for the first deploy and every update. It ships `git archive HEAD`, installs, migrates, and runs `pnpm ops doctor`. It restarts the services only if the preflight passes.

What the scripts do, by hand:

1. **Postgres.** Create a Neon project and use its direct (unpooled) connection string as `DATABASE_URL`. Each service keeps at most 10 connections.
2. **VPS** (1 vCPU, 1–2 GB). Install Node 22.12+ and pnpm (`corepack enable`), create a user `ignitra`, put the repo in `/opt/ignitra` and run `pnpm install --frozen-lockfile`. Do not use `--prod`: the services run TypeScript through tsx, a dev dependency.
3. **Configuration.** Copy `.env.example` to `/etc/ignitra/ignitra.env` (owner root, group `ignitra`, mode 640: systemd reads it as root, and migrations and backups run as `ignitra`). Write one `KEY=value` per line, and quote values with spaces. Fill the secrets (`pnpm gen:secret`, `pnpm gen:vapid`) and the public URLs:

   ```
   API_PORT=4000
   API_PUBLIC_URL=https://api.example.com
   TRUST_PROXY=127.0.0.1
   WEB_URL=https://app.example.com
   CORS_ORIGINS=https://app.example.com
   GOOGLE_REDIRECT_URI=https://app.example.com/api/v1/connections/google/callback
   ```

4. **Schema and preflight.** `pnpm db:migrate`, then `pnpm ops doctor` until nothing fails.
5. **Services.** Copy `deploy/systemd/*.service` to `/etc/systemd/system/`, then `systemctl enable --now ignitra-api ignitra-listener ignitra-runner`. Put Caddy in front of the API (`deploy/Caddyfile`); it handles the certificate. Open only SSH, 80 and 443 in the firewall: the services listen on 127.0.0.1.
6. **Web app on Vercel.** Set the root directory to `apps/web` and include files outside it (the workspace packages). Set `API_URL=https://api.example.com` (read at build time, so redeploy after changing it) and `WEB_URL=https://app.example.com` (it makes share cards, the sitemap and template links absolute).
7. **Backups and monitoring.** Run `deploy/backup.sh` from cron: nightly, verified, kept 14 days. Add an uptime check on `https://api.example.com/health`, and scrape `127.0.0.1:4001/metrics` on the box with the alerts above.

To update, run `deploy/push.sh` again. By hand, that is `pnpm install --frozen-lockfile && pnpm db:migrate && pnpm ops doctor`, then a restart of the three services. The listener resumes from its cursors, and runs in flight are reclaimed when their lease expires.

**Production rehearsal (2026-11-08).** PostgreSQL 17.10 on the test machine (the server's TimeZone was Asia/Bangkok). The API, the listener (sync + matcher) and two runners ran as separate processes against mainnet, with the production web build and headless Edge, for 400 s. Migrations went through node-postgres, and `pnpm ops doctor` passed.

| Check | Result |
|---|---|
| Kill the listener (hard) | Its replacement took both leases 31 s later and resumed from the cursors. USDG transfers ≥ 1,000, re-read from the RPC for blocks 109,246,188–109,249,777: **337 on chain, 337 runs**, none missing, none twice. |
| Kill a runner (hard) mid-work | The second runner and a restarted one finished everything: 347 runs, all succeeded. 351 webhook deliveries, all verified with the SDK; outside the deliberately failing endpoint, every key arrived exactly once. |
| Retries | A receiver that answered 503 to each first delivery got every order again with the same idempotency key, then 200. |
| SCHEDULE | One run per minute for 6 minutes across the listener swap: no gap, no duplicate. |
| INBOUND_WEBHOOK + WEB_PUSH | A retried request (same key) ran once. Each of the 4 orders was delivered through Microsoft's push service. Headless Edge shows a notification for about 25 s; it was checked later than that, so display was proven separately. |
| Backups | Exported while everything ran (3,127 rows), then later from the final state (4,083 rows): each restored into an empty database and backed up again to the same bytes. A PGlite database (PostgreSQL 18.6, UTC) moved to Postgres 17.10 and also gave the same bytes. |
| Metrics | `/metrics` from Postgres: lag 0 blocks, queue empty, gap detector found nothing missing. |

The rehearsal found one thing to fix: backups had rendered timestamps in the server's TimeZone. The data was the same, but not the bytes, so exports now use UTC.

Event → delivered took 7.7 s (median) in confirmed mode, and almost all of it was ingestion:

- The node serves a block about 2.2 s after its timestamp.
- 20 blocks of confirmation take about 2.1 s.
- `POLL_INTERVAL_MS` adds up to 2 s.
- RPC round trips take about 0.3 s each.

Matching took 0.03 s, a runner claimed the run 0.6 s later, and the webhook took 0.03 s. Fast mode skips the confirmations. The public RPC answered `429 Too Many Requests` twice while the new listener caught up: both were retried with no loss, which is why `RPC_URL_FALLBACK` matters.

## Scripts

| Command | |
|---|---|
| `pnpm check` | typecheck + all tests |
| `pnpm typecheck` | strict `tsc` across every package |
| `pnpm test` | Vitest, every package |
| `pnpm build` | production build of the web app |
| `pnpm dev` | all apps in parallel (needs real Postgres) |
| `pnpm dev:listener` | chain listener |
| `pnpm dev:runner` | flow runner |
| `pnpm dev:api` | HTTP API (separate process needs real Postgres; with PGlite use the `api` role) |
| `pnpm dev:web` | web app on :3000; `/api` proxies to `API_URL` |
| `pnpm gen:secret` / `pnpm gen:vapid` | secrets (base64url) / Web Push VAPID keys |
| `pnpm ops …` | flows, runs, traces, evaluations, connections, push, watches, sync status, verify, `user plan`, `usage`, `template list / hide / unhide`, `demo setup`, `doctor`, `metrics`, `dead-letters`, `run retry`, `keys status / rewrap`, `db export / verify / import` |

## Notes

- **TypeScript is pinned to 6.0.3.** TS 7 is the native port, and Next.js still needs the JS compiler API.
- **Workspace packages ship TypeScript source.** Node services run through `tsx`, and Next compiles `@ignitra/core` via `transpilePackages`.
- **Chain endpoints:** the RPC `https://rpc.mainnet.chain.robinhood.com` is public but rate limited, so set `RPC_URL_FALLBACK`. The explorer is `https://robinhoodchain.blockscout.com`.

## Roadmap

1. **Foundation** ✅
2. **Chain listener** ✅ blocks, logs, ABI registry, decoding, checkpoints, confirmations, reorgs
3. **Trigger and condition engine** ✅ five chain triggers, conditions, matcher, idempotent runs, runaway protection
4. **Flow runner** ✅ WEBHOOK / TELEGRAM (replaces Discord) / WEB_PUSH, retries, traces, SSRF guard, auto-pause
5. **Accounts and API** ✅ SIWE (EOA + ERC-1271), connections and flows API, SCHEDULE / STATE_CHANGE / INBOUND_WEBHOOK, CHAIN_READ, plan limits + metering
6. **Builder UI** ✅ builder, live samples, Test flow, variable picker, dashboard, run traces, HTTP_REQUEST / EMAIL / GOOGLE_SHEETS, PWA
7. **Templates + public surface** ✅ 14 official templates, gallery, use / share templates, landing with a live demo, docs
8. **SDK, integrations, scoped onchain actions** ✅ API keys, `@ignitra/sdk`, VIGIL / TRUST LAYER / MANDATE / Pons, ONCHAIN_TX via Safe + Zodiac Roles v2
9. **Hardening + launch** ✅ (account-bound checks pending) audit log, dead letters, gap detector, metrics, key rotation, backups, permission review, trigger matrix on a fork

## License

IGNITRA is free software under the GNU Affero General Public License, version 3 only ([LICENSE](LICENSE)). You may use it, change it and run it yourself. If you run a modified version as a network service, you must offer its users the modified source code (section 13). The web app's footer links to the source so that the offer is always one click away.

The SDK in `packages/sdk` (`@ignitra/sdk` on npm) is MIT-licensed ([packages/sdk/LICENSE](packages/sdk/LICENSE)), so it can go into any project, open or closed.

Copyright (C) 2026 candra.
