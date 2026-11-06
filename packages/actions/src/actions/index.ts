import { createActionRegistry, type ActionRegistry } from "@ignitra/core";
import { createTelegramAction } from "./telegram";
import { webPushAction } from "./web-push";
import { webhookAction } from "./webhook";

/** MVP actions. DISCORD stays in the catalog but is not offered (Telegram replaces it); EMAIL / GOOGLE_SHEETS / HTTP_REQUEST arrive in Phase 6. */
export function createActionModules(opts: { telegramApiBase?: string } = {}): ActionRegistry {
  const registry = createActionRegistry();
  registry.register(webhookAction);
  registry.register(createTelegramAction(opts.telegramApiBase ? { apiBase: opts.telegramApiBase } : {}));
  registry.register(webPushAction);
  return registry;
}

export * from "./telegram";
export * from "./web-push";
export * from "./webhook";
