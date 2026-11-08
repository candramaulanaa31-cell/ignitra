import { and, eq, inArray, lte } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { newId, normalizeAddress, type NormalizedAddress } from "@ignitra/core";
import { decryptJson, encryptJson, type Keyring } from "@ignitra/core/server";
import { onchainGrants, type Database, type OnchainGrantRow } from "@ignitra/db";
import { roleKeyFor, rolesAddressFor } from "./roles";
import type { GrantScope } from "./scope";

/**
 * Grants in the database. The session key is generated here, encrypted with the keyring (AES-GCM,
 * bound to the grant id), never returned to any client, and WIPED when the grant is revoked or
 * expires: from then on the key does not exist anywhere, so it cannot sign, whatever the Safe says.
 */

const context = (grantId: string) => `onchain-grant:${grantId}`;

export async function createGrant(
  db: Database,
  keyring: Keyring,
  input: { ownerId: string; chainId: number; label: string; safe: NormalizedAddress; scope: GrantScope; mandateConnectionId: string | null },
): Promise<OnchainGrantRow> {
  const id = newId("grant");
  const privateKey = generatePrivateKey();
  const sessionKey = normalizeAddress(privateKeyToAccount(privateKey).address);
  const [row] = await db
    .insert(onchainGrants)
    .values({
      id,
      ownerId: input.ownerId,
      chainId: input.chainId,
      label: input.label,
      safeAddress: input.safe,
      rolesAddress: rolesAddressFor(input.safe),
      roleKey: roleKeyFor(id),
      sessionKeyAddress: sessionKey,
      sessionKeyEnc: encryptJson(keyring, { private_key: privateKey }, context(id)) as unknown as Record<string, unknown>,
      scope: input.scope as unknown as Record<string, unknown>,
      mandateConnectionId: input.mandateConnectionId,
      status: "pending",
      expiresAt: new Date(input.scope.expires_at),
    })
    .returning();
  if (!row) throw new Error("grant insert returned nothing");
  return row;
}

/** The session key as a signer, or null once it was wiped. */
export function sessionAccount(keyring: Keyring, grant: OnchainGrantRow): PrivateKeyAccount | null {
  if (!grant.sessionKeyEnc) return null;
  const { private_key } = decryptJson(keyring, grant.sessionKeyEnc, context(grant.id)) as { private_key: `0x${string}` };
  return privateKeyToAccount(private_key);
}

export async function loadGrant(db: Database, id: string): Promise<OnchainGrantRow | null> {
  const [row] = await db.select().from(onchainGrants).where(eq(onchainGrants.id, id));
  return row ?? null;
}

export async function activateGrant(db: Database, id: string, txHash: string, now: Date): Promise<OnchainGrantRow | null> {
  const [row] = await db
    .update(onchainGrants)
    .set({ status: "active", grantTxHash: txHash.toLowerCase(), activatedAt: now })
    .where(and(eq(onchainGrants.id, id), eq(onchainGrants.status, "pending")))
    .returning();
  return row ?? null;
}

/** Revoked in IGNITRA at once: the key is wiped in the same statement. */
export async function revokeGrant(db: Database, id: string, ownerId: string, now: Date): Promise<OnchainGrantRow | null> {
  const [row] = await db
    .update(onchainGrants)
    .set({ status: "revoked", sessionKeyEnc: null, revokedAt: now })
    .where(and(eq(onchainGrants.id, id), eq(onchainGrants.ownerId, ownerId), inArray(onchainGrants.status, ["pending", "active"])))
    .returning();
  return row ?? null;
}

/** Grants past their expiry stop and lose their key (also enforced on chain by IgnitraSessionBounds). */
export async function expireGrants(db: Database, now: Date): Promise<number> {
  const rows = await db
    .update(onchainGrants)
    .set({ status: "expired", sessionKeyEnc: null })
    .where(and(inArray(onchainGrants.status, ["pending", "active"]), lte(onchainGrants.expiresAt, now)))
    .returning({ id: onchainGrants.id });
  return rows.length;
}
