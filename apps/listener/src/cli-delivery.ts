import { readFileSync } from "node:fs";
import { asc, desc, eq } from "drizzle-orm";
import {
  addPushSubscription,
  createConnection,
  createSafeHttp,
  deleteConnection,
  deriveOwnerSigningSecret,
  inspectTelegramDestination,
  keyringFromRunnerEnv,
  listConnections,
  telegramCall,
  webhookDestination,
} from "@ignitra/actions";
import { ownerNotifications, pushSubscriptions, runSteps, runs, users, type Database } from "@ignitra/db";
import { ensureUser } from "@ignitra/engine";
import type { ListenerEnv } from "./config";

/**
 * Delivery commands of `pnpm ops` (Phase 4). Secrets are read from flags or
 * env (TELEGRAM_BOT_TOKEN) and are never printed back — except a webhook
 * signing secret, shown ONCE at creation so the receiver can be configured.
 */

export interface DeliveryCliValues {
  owner?: string | undefined;
  label?: string | undefined;
  token?: string | undefined;
  chat?: string | undefined;
  thread?: string | undefined;
  url?: string | undefined;
  file?: string | undefined;
  test?: boolean | undefined;
}

export const DELIVERY_USAGE = `  connection add telegram --owner 0x.. --chat <chat_id> [--label ..] [--thread <topic_id>] [--test]   (token: --token or TELEGRAM_BOT_TOKEN)
  connection add webhook --owner 0x.. --url https://.. [--label ..]
  connection list [--owner 0x..] | connection rm <id> --owner 0x..
  webhook secret --owner 0x..           signing secret for inline-URL webhooks
  push add --owner 0x.. --file subscription.json | push list [--owner 0x..]
  run show <run_id>                     full trace: trigger, conditions, every step attempt
  notifications [--owner 0x..]`;

const short = (s: unknown, n = 40) => {
  const v = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return v.length > n ? `${v.slice(0, n)}…` : v;
};

export async function deliveryCommand(db: Database, env: ListenerEnv, values: DeliveryCliValues, cmd: string, sub: string | undefined, rest: string[], limit: number): Promise<boolean> {
  const owner = async () => {
    if (!values.owner) throw new Error("--owner <wallet> is required");
    return ensureUser(db, values.owner);
  };
  const keyring = () => {
    const k = keyringFromRunnerEnv(env);
    if (!k) throw new Error("ENCRYPTION_KEY is not set — generate one with `pnpm gen:secret` and put it in .env");
    return k;
  };
  const http = () => createSafeHttp({ allowPrivate: env.OUTBOUND_ALLOW_PRIVATE, timeoutMs: env.OUTBOUND_TIMEOUT_MS });

  if (cmd === "connection" && sub === "add" && rest[0] === "telegram") {
    const token = values.token ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("bot token missing: pass --token or set TELEGRAM_BOT_TOKEN (keeps it out of shell history)");
    if (!values.chat) throw new Error("--chat <chat_id> is required (e.g. -1001234567890, or @yourchannel)");
    const threadId = values.thread ? Number.parseInt(values.thread, 10) : undefined;
    const apiBase = env.TELEGRAM_API_URL ?? "https://api.telegram.org";
    const dest = await inspectTelegramDestination(http(), { token, chatId: values.chat, ...(threadId !== undefined ? { threadId } : {}), apiBase });
    const conn = await createConnection(db, keyring(), {
      ownerId: await owner(),
      type: "telegram",
      label: values.label ?? String(dest.metadata.chat_title ?? `Telegram ${values.chat}`),
      secret: dest.secret,
      metadata: dest.metadata,
    });
    console.log(`created ${conn.id} — @${String(dest.metadata.bot_username)} → ${String(dest.metadata.chat_title ?? values.chat)} (${String(dest.metadata.chat_type)})`);
    if (values.test) {
      const sent = await telegramCall(http(), apiBase, token, "sendMessage", { chat_id: values.chat, text: "✅ IGNITRA is connected to this chat.", ...(threadId !== undefined ? { message_thread_id: threadId } : {}) });
      console.log(sent.json.ok ? "test message sent ✓" : `test message failed: ${sent.json.description ?? `HTTP ${sent.status}`}`);
    }
  } else if (cmd === "connection" && sub === "add" && rest[0] === "webhook") {
    if (!values.url) throw new Error("--url <https://…> is required");
    const dest = webhookDestination(values.url, { allowPrivate: env.OUTBOUND_ALLOW_PRIVATE });
    const conn = await createConnection(db, keyring(), { ownerId: await owner(), type: "webhook", label: values.label ?? String(dest.metadata.host), secret: dest.secret, metadata: dest.metadata });
    console.log(`created ${conn.id} → ${String(dest.metadata.host)}`);
    console.log(`signing secret (shown once — configure your receiver with it):\n  ${dest.signingSecret}`);
  } else if (cmd === "connection" && sub === "list") {
    const ownerId = values.owner ? await owner() : undefined;
    console.table((await listConnections(db, ownerId)).map((c) => ({ id: c.id, type: c.type, label: c.label, owner: c.ownerId, details: short(c.metadata, 60), created: c.createdAt.toISOString().slice(0, 19) })));
  } else if (cmd === "connection" && sub === "rm") {
    const [id] = rest;
    if (!id) throw new Error("connection rm <id> --owner 0x..");
    console.log((await deleteConnection(db, id, await owner())) ? `removed ${id}` : `no connection ${id} for that owner`);
  } else if (cmd === "webhook" && sub === "secret") {
    if (!env.WEBHOOK_SIGNING_SECRET) throw new Error("WEBHOOK_SIGNING_SECRET is not set (generate with `pnpm gen:secret`)");
    console.log(deriveOwnerSigningSecret(env.WEBHOOK_SIGNING_SECRET, await owner()));
  } else if (cmd === "push" && sub === "add") {
    if (!values.file) throw new Error("--file <subscription.json> is required (PushSubscription.toJSON() from the browser)");
    const sub = JSON.parse(readFileSync(values.file, "utf8")) as { endpoint: string; keys: { p256dh: string; auth: string } };
    console.log(`subscribed ${await addPushSubscription(db, await owner(), sub)}`);
  } else if (cmd === "push" && sub === "list") {
    const rows = await db.select({ s: pushSubscriptions, address: users.address }).from(pushSubscriptions).innerJoin(users, eq(users.id, pushSubscriptions.userId)).orderBy(desc(pushSubscriptions.createdAt));
    console.table(
      rows
        .filter((r) => !values.owner || r.address === values.owner.toLowerCase())
        .map((r) => ({ id: r.s.id, owner: r.address, endpoint: short(new URL(r.s.endpoint).host, 40), active: r.s.disabledAt === null, failures: r.s.failureCount, last_ok: r.s.lastSuccessAt?.toISOString().slice(0, 19) ?? "" })),
    );
  } else if (cmd === "run" && sub === "show") {
    const [id] = rest;
    if (!id) throw new Error("run show <run_id>");
    const [run] = await db.select().from(runs).where(eq(runs.id, id));
    if (!run) throw new Error(`run ${id} not found`);
    const steps = await db.select().from(runSteps).where(eq(runSteps.runId, id)).orderBy(asc(runSteps.position));
    console.log(JSON.stringify({ run, steps }, null, 2));
  } else if (cmd === "notifications") {
    const rows = await db.select({ n: ownerNotifications, address: users.address }).from(ownerNotifications).innerJoin(users, eq(users.id, ownerNotifications.userId)).orderBy(desc(ownerNotifications.createdAt)).limit(limit);
    for (const { n, address } of rows.filter((r) => !values.owner || r.address === values.owner.toLowerCase())) {
      console.log([n.createdAt.toISOString().slice(0, 19), address, n.kind, n.flowId ?? "", n.message].join("  "));
    }
  } else {
    return false;
  }
  return true;
}
