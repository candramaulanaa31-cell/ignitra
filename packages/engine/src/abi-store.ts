import { and, eq } from "drizzle-orm";
import type { Abi } from "viem";
import type { NormalizedAddress } from "@ignitra/core";
import type { AbiStore, StoredAbi } from "@ignitra/chain";
import { contractAbis, type Database } from "@ignitra/db";

/** contract_abis-backed persistence for the ABI registry. */
export class DbAbiStore implements AbiStore {
  readonly #db: Database;
  readonly #chainId: number;

  constructor(db: Database, chainId: number) {
    this.#db = db;
    this.#chainId = chainId;
  }

  async get(address: NormalizedAddress): Promise<StoredAbi | null> {
    const [row] = await this.#db
      .select()
      .from(contractAbis)
      .where(and(eq(contractAbis.chainId, this.#chainId), eq(contractAbis.address, address)));
    if (!row) return null;
    return {
      status: row.status,
      abi: (row.abi as Abi | null) ?? null,
      implementation: (row.implementation as NormalizedAddress | null) ?? null,
      source: row.source,
      error: row.error,
      fetchedAt: row.fetchedAt,
    };
  }

  async put(address: NormalizedAddress, value: StoredAbi): Promise<void> {
    const row = {
      chainId: this.#chainId,
      address,
      status: value.status,
      abi: (value.abi as unknown[] | null) ?? null,
      implementation: value.implementation,
      source: value.source,
      error: value.error,
      fetchedAt: value.fetchedAt,
    };
    await this.#db
      .insert(contractAbis)
      .values(row)
      .onConflictDoUpdate({ target: [contractAbis.chainId, contractAbis.address], set: row });
  }
}
