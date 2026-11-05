import { ZERO_ADDRESS, normalizeAddress, normalizeHash, type FieldSpec, type NormalizedAddress } from "@ignitra/core";
import { EventDecoder } from "@ignitra/chain";
import { formatDisplay, percentOf, toDecimalUnits } from "../format";
import type { TokenMeta } from "../tokens";
import type { ChainEventView, Payload } from "../types";

/**
 * Canonical ERC-20 Transfer parsing straight from raw topics/data — never from
 * a contract's verified ABI, whose parameter names vary (WETH: src/dst/wad).
 * ERC-721 Transfer shares the topic0 but has 4 topics, so it never parses here.
 */
export const TRANSFER_TOPIC = normalizeHash(EventDecoder.selector("Transfer(address,address,uint256)"));

export interface Erc20Transfer {
  readonly from: NormalizedAddress;
  readonly to: NormalizedAddress;
  readonly value: bigint;
}

const topicAddress = (topic: string): NormalizedAddress | null =>
  /^0x0{24}[0-9a-f]{40}$/.test(topic) ? normalizeAddress(`0x${topic.slice(26)}`) : null;

export function parseErc20Transfer(event: Pick<ChainEventView, "topics" | "data">): Erc20Transfer | null {
  if (event.topics.length !== 3 || event.topics[0] !== TRANSFER_TOPIC) return null;
  if (!/^0x[0-9a-f]{64}$/.test(event.data)) return null;
  const from = topicAddress(event.topics[1] ?? "");
  const to = topicAddress(event.topics[2] ?? "");
  if (!from || !to) return null;
  return { from, to, value: BigInt(event.data) };
}

export function tokenPayload(meta: TokenMeta, supply: bigint | null): Payload {
  return {
    address: meta.address,
    symbol: meta.symbol,
    name: meta.name,
    decimals: meta.decimals,
    total_supply: supply === null ? null : supply.toString(),
    total_supply_decimal: supply === null ? null : toDecimalUnits(supply, meta.decimals),
  };
}

export function amountPayload(prefix: string, raw: bigint, decimals: number | null): Payload {
  const decimal = toDecimalUnits(raw, decimals);
  return {
    [prefix]: raw.toString(),
    [`${prefix}_decimal`]: decimal,
    [`${prefix}_formatted`]: formatDisplay(decimal),
  };
}

export { percentOf };

export const isZero = (a: NormalizedAddress): boolean => a === ZERO_ADDRESS;

export function tokenFields(prefix = "token"): FieldSpec[] {
  return [
    { path: `${prefix}.address`, type: "address", description: "Token contract" },
    { path: `${prefix}.symbol`, type: "string", description: "Token symbol", nullable: true },
    { path: `${prefix}.name`, type: "string", description: "Token name", nullable: true },
    { path: `${prefix}.decimals`, type: "number", description: "Token decimals", nullable: true },
    { path: `${prefix}.total_supply`, type: "uint", description: "Total supply, base units (recent)", nullable: true },
    { path: `${prefix}.total_supply_decimal`, type: "decimal", description: "Total supply, token units (recent)", nullable: true },
  ];
}

export function amountFields(prefix: string, what: string): FieldSpec[] {
  return [
    { path: prefix, type: "uint", description: `${what}, base units (exact)` },
    { path: `${prefix}_decimal`, type: "decimal", description: `${what}, token units (exact)`, nullable: true },
    { path: `${prefix}_formatted`, type: "string", description: `${what} for display, e.g. 1,234.5`, nullable: true },
  ];
}
