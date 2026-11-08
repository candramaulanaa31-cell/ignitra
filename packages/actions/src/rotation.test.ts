import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId, normalizeAddress, type SafeHttpClient } from "@ignitra/core";
import { createKeyring } from "@ignitra/core/server";
import { createDb, onchainGrants, users, type DbHandle } from "@ignitra/db";
import { eq } from "drizzle-orm";
import { deliverWebhook, resolveWebhookTarget } from "./actions/webhook";
import { createConnection, loadConnection } from "./connections";
import { keyUsage, rewrapAll } from "./keys";
import { createGrant, sessionAccount } from "./onchain/grants";
import type { GrantScope } from "./onchain/scope";
import { deriveOwnerSigningSecret, verifyWebhookSignature } from "./signing";

/** Phase 9: rotating ENCRYPTION_KEY (re-wrap every data key) and WEBHOOK_SIGNING_SECRET (overlap). */

let h: DbHandle;
beforeAll(async () => {
  h = await createDb("pglite://memory");
  await h.migrate();
}, 30_000);
afterAll(async () => {
  await h.close();
});

describe("ENCRYPTION_KEY rotation", () => {
  it("re-wraps every data key under the new key, so the old key can be retired", async () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);
    const k1 = createKeyring({ kid: "k1", key: key1 });
    const ownerId = newId("user");
    await h.db.insert(users).values({ id: ownerId, address: `0x${randomBytes(20).toString("hex")}` });
    const hook = await createConnection(h.db, k1, { ownerId, type: "webhook", label: "Hook", secret: { url: "https://hooks.example.com/x?token=s3cret", signing_secret: "whsec_a" }, metadata: {} });
    const tg = await createConnection(h.db, k1, { ownerId, type: "telegram", label: "Chat", secret: { bot_token: "123:abc" }, metadata: {} });
    const scope = { targets: [], max_value_per_tx_wei: "0", max_value_per_day_wei: "0", expires_at: new Date(Date.now() + 86_400_000).toISOString() } as GrantScope;
    const grant = await createGrant(h.db, k1, { ownerId, chainId: 4663, label: "g", safe: normalizeAddress(`0x${"11".repeat(20)}`), scope, mandateConnectionId: null });

    // Step 1–2: a new active key, the old one still listed (everything keeps working).
    const k2 = createKeyring({ kid: "k2", key: key2 }, [{ kid: "k1", key: key1 }]);
    expect(await keyUsage(h.db, k2)).toEqual({ activeKid: "k2", byKid: { k1: 3 }, pending: 3 });
    expect((await loadConnection(h.db, k2, hook.id))?.secret).toMatchObject({ signing_secret: "whsec_a" });

    // Step 3: re-wrap (a dry run first changes nothing).
    expect(await rewrapAll(h.db, k2, { dryRun: true })).toEqual({ rewrapped: { connections: 2, onchain_grants: 1 }, skipped: 0, failed: [] });
    expect((await keyUsage(h.db, k2)).pending).toBe(3);
    expect(await rewrapAll(h.db, k2, { pageSize: 1 })).toEqual({ rewrapped: { connections: 2, onchain_grants: 1 }, skipped: 0, failed: [] });
    expect(await keyUsage(h.db, k2)).toEqual({ activeKid: "k2", byKid: { k2: 3 }, pending: 0 });

    // Step 4: a keyring without the old key opens everything.
    const only2 = createKeyring({ kid: "k2", key: key2 });
    expect((await loadConnection(h.db, only2, hook.id))?.secret).toEqual({ url: "https://hooks.example.com/x?token=s3cret", signing_secret: "whsec_a" });
    expect((await loadConnection(h.db, only2, tg.id))?.secret).toEqual({ bot_token: "123:abc" });
    const [row] = await h.db.select().from(onchainGrants).where(eq(onchainGrants.id, grant.id));
    expect(sessionAccount(only2, row as NonNullable<typeof row>)?.address.toLowerCase()).toBe(grant.sessionKeyAddress);

    // Idempotent; and an envelope no listed key can open is reported, never altered.
    expect((await rewrapAll(h.db, k2)).rewrapped).toEqual({ connections: 0, onchain_grants: 0 });
    const stranger = createKeyring({ kid: "k3", key: randomBytes(32) });
    const blind = await rewrapAll(h.db, stranger);
    expect(blind.failed.map((f) => f.table).sort()).toEqual(["connections", "connections", "onchain_grants"]);
    expect((await keyUsage(h.db, k2)).byKid).toEqual({ k2: 3 });
  });
});

describe("WEBHOOK_SIGNING_SECRET rotation", () => {
  it("signs owner-secret deliveries with both secrets while it rotates; receivers accept either", async () => {
    const seen: Array<Record<string, string>> = [];
    const http: SafeHttpClient = {
      request: async (req) => {
        seen.push(req.headers as Record<string, string>);
        return { status: 200, headers: {}, body: "", durationMs: 1 };
      },
    };
    const owner = newId("user");
    const current = deriveOwnerSigningSecret("new-master-0123456789", owner);
    const previous = deriveOwnerSigningSecret("old-master-0123456789", owner);
    const target = resolveWebhookTarget({ url: "https://receiver.example/hook" } as never, { connection: null, ownerSigningSecret: current, ownerSigningSecretPrevious: previous });
    if (typeof target === "string") throw new Error(target);
    await deliverWebhook(http, target, "run.action", "key-1", { type: "run.action" });
    const headers = seen[0] as Record<string, string>;
    const signature = headers["x-ignitra-signature"] as string;
    expect(signature.split(",")).toHaveLength(2);
    const body = JSON.stringify({ type: "run.action" });
    const verify = (secret: string) => verifyWebhookSignature({ secret, body, signature, timestamp: headers["x-ignitra-timestamp"] });
    expect([verify(current), verify(previous), verify("whsec_someone_else")]).toEqual([true, true, false]);

    // A connection's own secret is not the owner's: one signature, no overlap.
    const conn = resolveWebhookTarget({ connection_id: "conn_x" } as never, {
      connection: { id: "conn_x", type: "webhook", label: "c", secret: { url: "https://receiver.example/c", signing_secret: "whsec_conn" }, metadata: {} } as never,
      ownerSigningSecret: current,
      ownerSigningSecretPrevious: previous,
    });
    if (typeof conn === "string") throw new Error(conn);
    await deliverWebhook(http, conn, "run.action", "key-2", { type: "run.action" });
    expect((seen[1] as Record<string, string>)["x-ignitra-signature"]?.split(",")).toHaveLength(1);
  });
});
