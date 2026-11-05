# IGNITRA

Onchain automation for Robinhood Chain (chain id `4663`).
**IF** something happens onchain → **THEN** do something anywhere.

```
listener ──▶ trigger + condition engine ──▶ runs (queued) ──▶ runner ──▶ actions
 (chain)        (match, enrich, evaluate)     (unique key)     (retry)     (Discord, webhook, push…)
```

> **Status: Phase 3 — Triggers & conditions.** Chain events become queued runs for
> matching flows, with full evidence and per-condition traces. Executing runs (actions)
> arrives in Phase 4.

## Layout

| Path | What |
|---|---|
| `apps/api` | Fastify HTTP API. Phase 1: `GET /health`, JSON errors. |
| `apps/web` | Next.js app (landing + `/app` placeholder). |
| `apps/listener` | Chain process: ingestion (sync) + matcher, health endpoint, operator CLI (`pnpm ops`). |
| `apps/runner` | Flow runner process. Phase 1: boots, connects DB. |
| `packages/core` | Domain core. `@ignitra/core` is isomorphic; `@ignitra/core/server` is Node-only. |
| `packages/engine` | Trigger modules, token enrichment, condition evaluation glue, flow service, matcher (events → runs). |
| `packages/chain` | RPC reader with failover, built-in ABIs, event decoder, explorer ABI registry. Test doubles under `@ignitra/chain/testing`. |
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
pnpm gen:secret               # paste into ENCRYPTION_KEY (needed from Phase 5)

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

## Scripts

| Command | |
|---|---|
| `pnpm check` | typecheck + all tests |
| `pnpm typecheck` | strict `tsc` across every package |
| `pnpm test` | Vitest (core, db, api) |
| `pnpm build` | production build of the web app |
| `pnpm dev` | all apps in parallel (needs real Postgres) |
| `pnpm dev:listener` | chain listener |
| `pnpm ops …` | flows, runs, evaluations, watches, sync status, ingestion verify |

## Notes

- **TypeScript is pinned to 6.0.3.** TS 7 is the native port, and Next.js still needs the JS compiler API.
- **Workspace packages ship TypeScript source.** Node services run through `tsx`, and Next compiles `@ignitra/core` via `transpilePackages`.
- **Chain endpoints:** the RPC `https://rpc.mainnet.chain.robinhood.com` is public but rate limited, so set `RPC_URL_FALLBACK`. The explorer is `https://robinhoodchain.blockscout.com`.

## Roadmap

1. **Foundation** ✅
2. **Chain listener** ✅ blocks, logs, ABI registry, decoding, checkpoints, confirmations, reorgs
3. **Trigger and condition engine** ✅ five chain triggers, conditions, matcher, idempotent runs, runaway protection
4. Flow runner + WEBHOOK / DISCORD / WEB_PUSH
5. SIWE, connections, schedule, chain read, plan limits
6. Builder UI + email / Google Sheets / HTTP
7. Templates + public surface
8. SDK, integrations, scoped onchain actions
9. Hardening + launch
