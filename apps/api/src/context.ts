import type { ActionRegistry, ChainConfig, ChainTxClient, SafeHttpClient } from "@ignitra/core";
import type { Keyring, Logger } from "@ignitra/core/server";
import type { AbiRegistry, ChainReader } from "@ignitra/chain";
import type { EmailConfig, GoogleConfig } from "@ignitra/actions";
import type { Database } from "@ignitra/db";
import type { FlowServiceDeps, TokenInfo, TriggerModuleRegistry, TrustLookup } from "@ignitra/engine";
import type { AuthOptions } from "./auth";
import type { CallerLimiter } from "./http";

/** Everything route handlers need, resolved once at startup. */
export interface ApiContext {
  readonly db: Database;
  readonly chain: ChainConfig;
  readonly logger: Logger;
  readonly triggers: TriggerModuleRegistry;
  readonly actions: ActionRegistry;
  readonly flowDeps: FlowServiceDeps;
  /** ERC-1271 sign-in and save-time ABI lookups (null: EOA sign-in only, full signatures required). */
  readonly reader: ChainReader | null;
  /** Token metadata for address detection and samples (null without a reader). */
  readonly tokens: TokenInfo | null;
  readonly abis: AbiRegistry | null;
  /** Samples are read this many blocks below the head (like the listener's confirmation depth). */
  readonly confirmationDepth: number;
  /** Platform email sender (address verification codes). */
  readonly email: EmailConfig | null;
  /** Google OAuth client (GOOGLE_SHEETS connections). */
  readonly google: GoogleConfig | null;
  /** The web app, where the browser returns after OAuth. */
  readonly webUrl: string;
  /** A TEST run was queued (single process: wake the runner). */
  readonly onRunQueued: () => void;
  /** The flow shown live on the landing page (operator-chosen; public chain data only). */
  readonly demoFlowId: string | null;
  /** Encrypts connection secrets (null: connections cannot be created). */
  readonly keyring: Keyring | null;
  /** WEBHOOK_SIGNING_SECRET: per-owner webhook secrets and inbound hook URLs. */
  readonly webhookMaster: string | null;
  /** WEBHOOK_SIGNING_SECRET_PREVIOUS while it rotates: inbound URLs made with it still verify. */
  readonly webhookMasterPrevious: string | null;
  /** Outbound requests made by the API itself (verifying a Telegram destination). */
  readonly http: SafeHttpClient;
  readonly allowPrivateOutbound: boolean;
  readonly telegramApiBase: string | undefined;
  /** Base of URLs handed to users (inbound webhooks). */
  readonly publicUrl: string;
  readonly corsOrigins: readonly string[];
  readonly auth: AuthOptions;
  readonly inboundRatePerMinute: number;
  /** Requests stored per inbound hook per 24 h. */
  readonly inboundDailyLimit: number;
  readonly vapidPublicKey: string | null;
  readonly onInboundEvent: () => void;
  readonly now: () => number;
  /** Per-caller token buckets: API keys, signed-in users and anonymous client addresses. */
  readonly limiter: CallerLimiter;
  readonly rates: { readonly publicPerMinute: number; readonly sessionPerMinute: number };
  /** TRUST LAYER scores (null: not configured). */
  readonly trust: TrustLookup | null;
  /** Default VIGIL API for VIGIL connections (operator configuration). */
  readonly vigilApiUrl: string | null;
  /** Chain reads / receipts for onchain grants (null without an RPC). */
  readonly chainTx: ChainTxClient | null;
  /** Every onchain grant must name a MANDATE policy (ONCHAIN_MANDATE_REQUIRED). */
  readonly mandateRequired: boolean;
}
