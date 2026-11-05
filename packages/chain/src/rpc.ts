import { normalizeAddress, normalizeHash, redactUrl, type NormalizedAddress, type NormalizedHash } from "@ignitra/core";
import {
  CallRevertedError,
  LogRangeTooLargeError,
  RpcQueryError,
  StateUnavailableError,
  type BlockHeader,
  type BlockTag,
  type CallRequest,
  type ChainReader,
  type LogQuery,
  type RawLog,
  type TxSummary,
} from "./types";

/**
 * Minimal JSON-RPC over fetch with ordered failover.
 *
 * Why not a generic transport: the listener must tell apart "this node is
 * down / rate limiting me" (fail over, cool down) from "this query is too big"
 * (narrow the range, same node). Generic retry layers blur the two.
 */

export class RpcError extends Error {
  readonly endpoint: string;
  readonly code: number | null;
  readonly httpStatus: number | null;

  constructor(endpoint: string, message: string, opts: { code?: number | null; httpStatus?: number | null } = {}) {
    super(message);
    this.name = "RpcError";
    this.endpoint = endpoint;
    this.code = opts.code ?? null;
    this.httpStatus = opts.httpStatus ?? null;
  }
}

export class ChainIdMismatchError extends Error {
  constructor(endpoint: string, expected: number, actual: number) {
    super(`RPC endpoint ${endpoint} serves chain ${actual}, expected ${expected}`);
    this.name = "ChainIdMismatchError";
  }
}

export interface RpcEndpoint {
  readonly name: string;
  /** Redacted, safe to log. */
  readonly label: string;
  request(method: string, params: readonly unknown[]): Promise<unknown>;
}

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

const RATE_LIMIT_RE = /rate.?limit|too many requests|request limit reached|capacity exceeded|daily request count/i;
const RANGE_RE =
  /exceeds limit|too many (logs|results)|query returned more than|response size|block range|spans? \d+ blocks|range (is )?too (large|wide|big)|narrow the block range|max(imum)? (block )?range|limit exceeded/i;
const MAX_BLOCKS_RES = [/only (\d+) (?:blocks )?are allowed/i, /max(?:imum)? (?:block )?range(?: is| of)? (\d+)/i, /(\d+) block range/i];

const STATE_RE = /historical state .* not available|missing trie node|state (is )?not available|state.*pruned|header not found for state/i;
const REVERT_RE = /execution reverted|revert|invalid opcode|out of gas|stack (underflow|overflow)|invalid jump/i;

/** Maps a JSON-RPC error to a query-level error when it is one (node healthy), else null. */
export function asQueryError(method: string, code: number | null, message: string, data: unknown): RpcQueryError | null {
  if (method === "eth_getLogs") {
    const range = asRangeTooLarge(message);
    if (range) return range;
  }
  if (STATE_RE.test(message)) return new StateUnavailableError(`${method}: ${message}`);
  if (method === "eth_call" && (code === 3 || REVERT_RE.test(message))) {
    return new CallRevertedError(`eth_call: ${message}`, typeof data === "string" && /^0x[0-9a-fA-F]*$/.test(data) ? (data.toLowerCase() as `0x${string}`) : null);
  }
  return null;
}

/** True when a node refused a log query because of its size (not because it is unhealthy). */
export function asRangeTooLarge(message: string): LogRangeTooLargeError | null {
  if (RATE_LIMIT_RE.test(message) || !RANGE_RE.test(message)) return null;
  for (const re of MAX_BLOCKS_RES) {
    const m = re.exec(message);
    if (m?.[1]) return new LogRangeTooLargeError(message, Number.parseInt(m[1], 10));
  }
  return new LogRangeTooLargeError(message);
}

export class HttpJsonRpcEndpoint implements RpcEndpoint {
  readonly name: string;
  readonly label: string;
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchFn;
  #id = 0;

  constructor(name: string, url: string, opts: { timeoutMs?: number; fetch?: FetchFn } = {}) {
    this.name = name;
    this.label = redactUrl(url);
    this.#url = url;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async request(method: string, params: readonly unknown[]): Promise<unknown> {
    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? `timeout after ${this.#timeoutMs}ms` : "network error";
      throw new RpcError(this.name, `${method}: ${reason}`);
    }
    const text = await res.text();
    let body: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new RpcError(this.name, `${method}: non-JSON response (HTTP ${res.status})`, { httpStatus: res.status });
    }
    if (body.error) {
      const message = String(body.error.message ?? "unknown RPC error");
      const queryError = asQueryError(method, body.error.code ?? null, message, body.error.data);
      if (queryError) throw queryError;
      throw new RpcError(this.name, `${method}: ${message}`, { code: body.error.code ?? null, httpStatus: res.status });
    }
    if (!res.ok) throw new RpcError(this.name, `${method}: HTTP ${res.status}`, { httpStatus: res.status });
    return body.result;
  }
}

export interface EndpointStats {
  readonly name: string;
  readonly label: string;
  readonly requests: number;
  readonly failures: number;
  readonly consecutiveFailures: number;
  readonly lastOkAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastError: string | null;
  readonly coolingDown: boolean;
}

interface MutableStats {
  requests: number;
  failures: number;
  consecutiveFailures: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  cooldownUntil: number;
}

export interface RpcPoolOptions {
  /** After a failure, skip the endpoint for this long (unless every endpoint is cooling down). */
  cooldownMs?: number;
  now?: () => number;
}

export class RpcPool {
  #endpoints: RpcEndpoint[];
  readonly #stats = new Map<string, MutableStats>();
  readonly #cooldownMs: number;
  readonly #now: () => number;

  constructor(endpoints: readonly RpcEndpoint[], opts: RpcPoolOptions = {}) {
    if (endpoints.length === 0) throw new Error("RpcPool needs at least one endpoint");
    this.#endpoints = [...endpoints];
    this.#cooldownMs = opts.cooldownMs ?? 30_000;
    this.#now = opts.now ?? Date.now;
    for (const e of endpoints) {
      this.#stats.set(e.name, {
        requests: 0,
        failures: 0,
        consecutiveFailures: 0,
        lastOkAt: null,
        lastErrorAt: null,
        lastError: null,
        cooldownUntil: 0,
      });
    }
  }

  get endpoints(): readonly RpcEndpoint[] {
    return this.#endpoints;
  }

  #stat(name: string): MutableStats {
    const s = this.#stats.get(name);
    if (!s) throw new Error(`unknown endpoint ${name}`);
    return s;
  }

  async request<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
    const now = this.#now();
    const ready = this.#endpoints.filter((e) => this.#stat(e.name).cooldownUntil <= now);
    const order = ready.length > 0 ? ready : this.#endpoints;
    let lastError: unknown = null;
    for (const endpoint of order) {
      const s = this.#stat(endpoint.name);
      s.requests++;
      try {
        const result = await endpoint.request(method, params);
        s.consecutiveFailures = 0;
        s.lastOkAt = this.#now();
        s.cooldownUntil = 0;
        return result as T;
      } catch (err) {
        if (err instanceof RpcQueryError) {
          // The node answered; the query itself failed. No cooldown. Only try
          // another endpoint when it could answer differently (pruned state).
          s.consecutiveFailures = 0;
          s.lastOkAt = this.#now();
          if (!err.retryElsewhere) throw err;
          lastError = err;
          continue;
        }
        s.failures++;
        s.consecutiveFailures++;
        s.lastErrorAt = this.#now();
        s.lastError = err instanceof Error ? err.message : String(err);
        s.cooldownUntil = this.#now() + this.#cooldownMs;
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Ensures every endpoint serves the expected chain. A mismatched or
   * unreachable fallback is dropped (with the reason returned); a mismatched
   * primary is fatal — reading the wrong chain would fabricate events.
   */
  async verifyChainId(expected: number): Promise<{ dropped: Array<{ name: string; reason: string }> }> {
    const dropped: Array<{ name: string; reason: string }> = [];
    const keep: RpcEndpoint[] = [];
    for (const [i, endpoint] of this.#endpoints.entries()) {
      try {
        const actual = parseQuantity(await endpoint.request("eth_chainId", []), "chainId");
        if (actual !== expected) throw new ChainIdMismatchError(endpoint.label, expected, actual);
        keep.push(endpoint);
      } catch (err) {
        if (i === 0 && err instanceof ChainIdMismatchError) throw err;
        if (i === 0) throw new Error(`primary RPC unreachable during startup: ${(err as Error).message}`);
        dropped.push({ name: endpoint.name, reason: (err as Error).message });
      }
    }
    this.#endpoints = keep;
    return { dropped };
  }

  stats(): EndpointStats[] {
    const now = this.#now();
    return this.#endpoints.map((e) => {
      const s = this.#stat(e.name);
      return {
        name: e.name,
        label: e.label,
        requests: s.requests,
        failures: s.failures,
        consecutiveFailures: s.consecutiveFailures,
        lastOkAt: s.lastOkAt ? new Date(s.lastOkAt).toISOString() : null,
        lastErrorAt: s.lastErrorAt ? new Date(s.lastErrorAt).toISOString() : null,
        lastError: s.lastError,
        coolingDown: s.cooldownUntil > now,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Parsing — every value from the node is validated, never trusted.
// ---------------------------------------------------------------------------

export class RpcResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcResponseError";
  }
}

export function parseQuantity(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new RpcResponseError(`invalid quantity for ${field}`);
  }
  const n = BigInt(value);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RpcResponseError(`${field} exceeds safe integer range`);
  return Number(n);
}

const toQuantity = (n: number): `0x${string}` => `0x${n.toString(16)}`;

const toBlockTag = (blockNumber: number | undefined): string => (blockNumber === undefined ? "latest" : toQuantity(blockNumber));

function parseHex(value: unknown, field: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) throw new RpcResponseError(`invalid hex for ${field}`);
  return value.toLowerCase() as `0x${string}`;
}

function parseBlock(value: unknown): BlockHeader | null {
  if (value === null) return null;
  if (typeof value !== "object") throw new RpcResponseError("invalid block");
  const b = value as Record<string, unknown>;
  return {
    number: parseQuantity(b.number, "block.number"),
    hash: normalizeHash(String(b.hash)),
    parentHash: normalizeHash(String(b.parentHash)),
    timestamp: parseQuantity(b.timestamp, "block.timestamp"),
  };
}

export function parseLog(value: unknown): RawLog | null {
  if (typeof value !== "object" || value === null) throw new RpcResponseError("invalid log");
  const l = value as Record<string, unknown>;
  if (l.removed === true) return null;
  if (!Array.isArray(l.topics)) throw new RpcResponseError("invalid log.topics");
  const data = String(l.data ?? "0x");
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) throw new RpcResponseError("invalid log.data");
  return {
    address: normalizeAddress(String(l.address)),
    topics: l.topics.map((t) => normalizeHash(String(t))),
    data: data.toLowerCase() as `0x${string}`,
    blockNumber: parseQuantity(l.blockNumber, "log.blockNumber"),
    blockHash: normalizeHash(String(l.blockHash)),
    // Robinhood Chain's RPC sends "0x0" (field present, never filled): treat 0 as unknown.
    blockTimestamp: l.blockTimestamp === undefined || l.blockTimestamp === null ? null : parseQuantity(l.blockTimestamp, "log.blockTimestamp") || null,
    txHash: normalizeHash(String(l.transactionHash)),
    txIndex: parseQuantity(l.transactionIndex, "log.transactionIndex"),
    logIndex: parseQuantity(l.logIndex, "log.logIndex"),
  };
}

export class RpcChainReader implements ChainReader {
  readonly pool: RpcPool;

  constructor(pool: RpcPool) {
    this.pool = pool;
  }

  async chainId(): Promise<number> {
    return parseQuantity(await this.pool.request("eth_chainId"), "chainId");
  }

  async blockNumber(): Promise<number> {
    return parseQuantity(await this.pool.request("eth_blockNumber"), "blockNumber");
  }

  async blockByNumber(number: number): Promise<BlockHeader | null> {
    return parseBlock(await this.pool.request("eth_getBlockByNumber", [toQuantity(number), false]));
  }

  async blockByHash(hash: NormalizedHash): Promise<BlockHeader | null> {
    return parseBlock(await this.pool.request("eth_getBlockByHash", [hash, false]));
  }

  async blockByTag(tag: BlockTag): Promise<BlockHeader | null> {
    return parseBlock(await this.pool.request("eth_getBlockByNumber", [tag, false]));
  }

  async getLogs(query: LogQuery): Promise<RawLog[]> {
    if (query.addresses.length === 0) return [];
    const result = await this.pool.request<unknown>("eth_getLogs", [
      {
        fromBlock: toQuantity(query.fromBlock),
        toBlock: toQuantity(query.toBlock),
        address: query.addresses.length === 1 ? query.addresses[0] : query.addresses,
        topics: query.topic0s ? [query.topic0s] : [],
      },
    ]);
    if (!Array.isArray(result)) throw new RpcResponseError("eth_getLogs: expected an array");
    const logs: RawLog[] = [];
    for (const item of result) {
      const log = parseLog(item);
      if (log) logs.push(log);
    }
    return logs;
  }

  async getStorageAt(address: NormalizedAddress, slot: `0x${string}`): Promise<`0x${string}`> {
    return parseHex(await this.pool.request<unknown>("eth_getStorageAt", [address, slot, "latest"]), "storage");
  }

  async call(request: CallRequest): Promise<`0x${string}`> {
    return parseHex(await this.pool.request<unknown>("eth_call", [{ to: request.to, data: request.data }, toBlockTag(request.blockNumber)]), "eth_call");
  }

  async getBalance(address: NormalizedAddress, blockNumber?: number): Promise<bigint> {
    return BigInt(parseHex(await this.pool.request<unknown>("eth_getBalance", [address, toBlockTag(blockNumber)]), "balance"));
  }

  async getTransactionCount(address: NormalizedAddress, blockNumber?: number): Promise<number> {
    return parseQuantity(await this.pool.request<unknown>("eth_getTransactionCount", [address, toBlockTag(blockNumber)]), "nonce");
  }

  async getCode(address: NormalizedAddress, blockNumber?: number): Promise<`0x${string}`> {
    return parseHex(await this.pool.request<unknown>("eth_getCode", [address, toBlockTag(blockNumber)]), "code");
  }

  async blockTransactions(number: number): Promise<TxSummary[] | null> {
    const block = await this.pool.request<unknown>("eth_getBlockByNumber", [toQuantity(number), true]);
    if (block === null) return null;
    const txs = (block as { transactions?: unknown }).transactions;
    if (!Array.isArray(txs)) throw new RpcResponseError("invalid block.transactions");
    return txs.map((raw) => {
      const tx = raw as Record<string, unknown>;
      return {
        hash: normalizeHash(String(tx.hash)),
        from: normalizeAddress(String(tx.from)),
        to: tx.to === null || tx.to === undefined ? null : normalizeAddress(String(tx.to)),
        nonce: parseQuantity(tx.nonce, "tx.nonce"),
      };
    });
  }
}

export function createRpcChainReader(
  urls: { primary: string; fallback?: string | null },
  opts: { timeoutMs?: number; cooldownMs?: number; fetch?: FetchFn } = {},
): RpcChainReader {
  const endpointOpts = { ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) };
  const endpoints: RpcEndpoint[] = [new HttpJsonRpcEndpoint("primary", urls.primary, endpointOpts)];
  if (urls.fallback) endpoints.push(new HttpJsonRpcEndpoint("fallback", urls.fallback, endpointOpts));
  return new RpcChainReader(new RpcPool(endpoints, opts.cooldownMs ? { cooldownMs: opts.cooldownMs } : {}));
}
