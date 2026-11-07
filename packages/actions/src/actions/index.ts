import { createActionRegistry, type ActionRegistry } from "@ignitra/core";
import { chainReadAction } from "./chain-read";
import { createTelegramAction } from "./telegram";
import { webPushAction } from "./web-push";
import { webhookAction } from "./webhook";

/** MVP actions + CHAIN_READ. DISCORD stays in the catalog but is not offered (Telegram replaces it); EMAIL / GOOGLE_SHEETS / HTTP_REQUEST come later. */
export function createActionModules(opts: { telegramApiBase?: string } = {}): ActionRegistry {
  const registry = createActionRegistry();
  registry.register(webhookAction);
  registry.register(createTelegramAction(opts.telegramApiBase ? { apiBase: opts.telegramApiBase } : {}));
  registry.register(webPushAction);
  registry.register(chainReadAction);
  return registry;
}

export * from "./chain-read";
export * from "./telegram";
export * from "./web-push";
export * from "./webhook";
