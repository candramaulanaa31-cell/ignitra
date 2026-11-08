import { createActionRegistry, type ActionRegistry } from "@ignitra/core";
import type { EmailConfig } from "../email";
import type { GoogleConfig } from "../google";
import { chainReadAction } from "./chain-read";
import { createEmailAction } from "./email";
import { createGoogleSheetsAction } from "./google-sheets";
import { createOnchainTxAction, type OnchainDeps } from "./onchain-tx";
import { httpRequestAction } from "./http-request";
import { createTelegramAction } from "./telegram";
import { webPushAction } from "./web-push";
import { webhookAction } from "./webhook";

export interface ActionModuleOptions {
  telegramApiBase?: string;
  /** Platform email sender (null: EMAIL steps fail with "not configured"). */
  email?: EmailConfig | null;
  /** Google OAuth client (null: GOOGLE_SHEETS steps fail with "not configured"). */
  google?: GoogleConfig | null;
  /** Onchain execution (null: ONCHAIN_TX steps fail with "not configured"). */
  onchain?: OnchainDeps | null;
}

/**
 * Every available action. DISCORD stays in the catalog but is not offered
 * (Telegram replaces it); X_POST and ONCHAIN_TX come in later phases.
 */
export function createActionModules(opts: ActionModuleOptions = {}): ActionRegistry {
  const registry = createActionRegistry();
  registry.register(webhookAction);
  registry.register(createTelegramAction(opts.telegramApiBase ? { apiBase: opts.telegramApiBase } : {}));
  registry.register(webPushAction);
  registry.register(chainReadAction);
  registry.register(httpRequestAction);
  registry.register(createEmailAction(opts.email ?? null));
  registry.register(createGoogleSheetsAction(opts.google ?? null));
  registry.register(createOnchainTxAction(opts.onchain ?? null));
  return registry;
}

export * from "./chain-read";
export * from "./email";
export * from "./google-sheets";
export * from "./http-request";
export * from "./onchain-tx";
export * from "./telegram";
export * from "./web-push";
export * from "./webhook";
