import type { Logger } from "pino";
import type { ChainConfig, FieldSpec, NormalizedAddress, NormalizedHash, TriggerDefinition, TriggerType } from "@ignitra/core";
import type { AbiRegistry, BlockHeader, ChainReader, JsonValue } from "@ignitra/chain";
import type { Registry } from "@ignitra/core";
import type { TokenInfo } from "./tokens";

/**
 * Trigger module contract (rule 3: pluggable modules, one shared interface).
 *
 *   log triggers  — react to ingested chain_events (TOKEN_TRANSFER, CONTRACT_EVENT, NEW_HOLDER)
 *   poll triggers — sample state at the confirmed head (BALANCE_THRESHOLD, CONTRACT_DEPLOYED)
 *
 * Modules decide WHETHER an occurrence happened and build its payload. They
 * never touch the database, never evaluate conditions and never create runs —
 * the matcher does that, uniformly, for every module.
 */

export type Payload = Record<string, JsonValue>;

/** A chain_events row as triggers see it. */
export interface ChainEventView {
  readonly id: number;
  readonly chainId: number;
  readonly blockNumber: number;
  readonly blockHash: NormalizedHash;
  /** Unix seconds, null if unknown. */
  readonly blockTimestamp: number | null;
  readonly txHash: NormalizedHash;
  readonly txIndex: number;
  readonly logIndex: number;
  readonly address: NormalizedAddress;
  readonly topics: readonly NormalizedHash[];
  readonly data: `0x${string}`;
  readonly status: "pending" | "confirmed";
}

export interface WatchSpec {
  readonly address: NormalizedAddress;
  /** null = every event of the address. */
  readonly topic0: NormalizedHash | null;
}

/** The trigger fired. `key` is unique per (chain, flow) for this occurrence. */
export interface TriggerMatch {
  readonly kind: "match";
  readonly key: string;
  readonly payload: Payload;
  readonly chainEventId?: number;
}

/** The trigger could not be decided (recorded as an `undetermined` evaluation — never silently dropped). */
export interface TriggerUndetermined {
  readonly kind: "undetermined";
  readonly key: string;
  readonly reason: string;
  readonly payload: Payload;
  readonly chainEventId?: number;
}

export type TriggerOutcome = TriggerMatch | TriggerUndetermined;

export interface TriggerRuntime {
  readonly chain: ChainConfig;
  readonly reader: ChainReader;
  readonly tokens: TokenInfo;
  readonly logger: Logger;
}

export interface PrepareContext {
  /** For save-time lookups (ABI resolution). Null in pure validation (no network). */
  readonly abis: AbiRegistry | null;
}

/** Identity of the flow a module evaluates for; `generation` changes on re-activation or new version. */
export interface FlowScope {
  readonly flowId: string;
  readonly generation: string;
}

interface TriggerModuleBase<P> extends TriggerDefinition<P> {
  /** Save-time normalization (e.g. resolve an event name to its full fragment). Stored in the flow version. */
  prepare?(params: P, ctx: PrepareContext): Promise<P>;
  /** Payload fields for these params: validated against conditions at save time, listed in the builder. */
  fields(params: P): readonly FieldSpec[];
  /** Whether fast mode (acting on pending events at head) makes sense for this trigger. */
  readonly supportsFast: boolean;
  /** Drop in-memory state (after a failed batch or a deep reorg). Correctness must survive a reset. */
  reset?(): void;
}

export interface LogTriggerModule<P = unknown> extends TriggerModuleBase<P> {
  readonly kind: "log";
  watches(params: P): WatchSpec[];
  /**
   * Events arrive in chain order and are already filtered to this flow's
   * watches. Returns one entry per event (null = not a match).
   */
  matchBatch(events: readonly ChainEventView[], params: P, rt: TriggerRuntime, scope: FlowScope): Promise<Array<TriggerOutcome | null>>;
}

export interface PollInput<P, S> {
  readonly params: P;
  /** null on the first poll, or after the flow version changed. */
  readonly state: S | null;
  /** Confirmed block to sample at. */
  readonly block: BlockHeader;
  readonly scope: FlowScope;
}

export interface PollTriggerModule<P = unknown, S = unknown> extends TriggerModuleBase<P> {
  readonly kind: "poll";
  /** `state: null` = leave the stored state unchanged (nothing new, or the sample was undetermined). */
  poll(input: PollInput<P, S>, rt: TriggerRuntime): Promise<{ state: S | null; outcomes: TriggerOutcome[] }>;
}

/*
 * Registries hold modules with erased params; each module re-validates its
 * params through `paramsSchema` before use (see matcher/flow index).
 */
export type AnyLogTrigger = LogTriggerModule<any>;
export type AnyPollTrigger = PollTriggerModule<any, any>;
export type AnyTriggerModule = AnyLogTrigger | AnyPollTrigger;
export type TriggerModuleRegistry = Registry<TriggerType, AnyTriggerModule>;
