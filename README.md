# IGNITRA

Onchain automation for Robinhood Chain (chain id `4663`).
**IF** something happens onchain → **THEN** do something anywhere.

```
listener / clock / inbound URL ──▶ trigger + condition engine ──▶ runs (queued) ──▶ runner ──▶ actions
 (chain)   (cron)   (HTTP POST)       (match, enrich, evaluate)     (unique key)     (retry)     (Telegram, webhook, push, chain read)
```

> **Status: Phase 5 — Accounts, API & plans.** Sign in with a wallet (SIWE), manage
> connections and flows over the HTTP API, run flows on a **schedule**, on **contract state
> changes** or from your own **inbound webhook URL**, read contracts mid-flow (**CHAIN_READ**),
> with plan limits and exact usage metering enforced server-side. The builder UI is Phase 6.

## Layout

| Path | What |
|---|---|
| `apps/api` | Fastify HTTP API: SIWE sign-in, flows, connections, runs and traces, usage, inbound webhook URLs. |
| `apps/web` | Next.js app (landing + `/app` placeholder). |
| `apps/listener` | Chain process: ingestion (sync) + matcher, optionally runner and API in the same process; health endpoint, operator CLI (`pnpm ops`). |
| `apps/runner` | Flow runner: executes queued runs (concurrency, retries, traces, auto-pause). |
| `packages/core` | Domain core. `@ignitra/core` is isomorphic; `@ignitra/core/server` is Node-only. |
| `packages/actions` | SSRF-safe HTTP, WEBHOOK / TELEGRAM / WEB_PUSH / CHAIN_READ modules, connections, Postgres run queue, executor. |
| `packages/engine` | Trigger modules (chain, schedule, state, inbound), enrichment, flow service with plan limits, matcher (occurrences → runs, metering). |
| `packages/chain` | RPC reader with failover, built-in ABIs, event decoder, contract-read encoding, explorer ABI registry. Test doubles under `@ignitra/chain/testing`. |
| `packages/db` | Drizzle schema, SQL migrations, driver-agnostic client (Postgres or PGlite). |
| `packages/sdk` | `@ignitra/sdk` skeleton (Phase 8). |

What lives in `packages/core`:

- **`chain`**: Robinhood Chain mainnet/testnet presets, env overrides, viem chain, explorer links.
- **`address`**: address and hash normalization. Stored lowercase, displayed as EIP-55, and mixed case with a bad checksum is rejected.
- **`ids`**: prefixed, time-sortable ids (`fl_…`, `run_…`, `conn_…`, `usr_…`).
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

| Plan | Active flows | Runs / month | Over the quota | Fastest schedule |
|---|---|---|---|---|
| Free | 3 | 500 | matches are recorded as `plan_limited`; no runs until the 1st (UTC) | every 15 min |
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

## Scripts

| Command | |
|---|---|
| `pnpm check` | typecheck + all tests |
| `pnpm typecheck` | strict `tsc` across every package |
| `pnpm test` | Vitest (core, db, api) |
| `pnpm build` | production build of the web app |
| `pnpm dev` | all apps in parallel (needs real Postgres) |
| `pnpm dev:listener` | chain listener |
| `pnpm dev:runner` | flow runner |
| `pnpm dev:api` | HTTP API (separate process needs real Postgres; with PGlite use the `api` role) |
| `pnpm gen:secret` / `pnpm gen:vapid` | secrets (base64url) / Web Push VAPID keys |
| `pnpm ops …` | flows, runs, traces, evaluations, connections, push, watches, sync status, verify, `user plan`, `usage` |

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
6. Builder UI + email / Google Sheets / HTTP
7. Templates + public surface
8. SDK, integrations, scoped onchain actions
9. Hardening + launch
