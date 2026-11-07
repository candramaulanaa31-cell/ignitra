import type { ActionRegistry, ChainConfig, SafeHttpClient } from "@ignitra/core";
import type { Keyring, Logger } from "@ignitra/core/server";
import type { ChainReader } from "@ignitra/chain";
import type { Database } from "@ignitra/db";
import type { FlowServiceDeps, TriggerModuleRegistry } from "@ignitra/engine";
import type { AuthOptions } from "./auth";

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
  /** Encrypts connection secrets (null: connections cannot be created). */
  readonly keyring: Keyring | null;
  /** WEBHOOK_SIGNING_SECRET: per-owner webhook secrets and inbound hook URLs. */
  readonly webhookMaster: string | null;
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
}
