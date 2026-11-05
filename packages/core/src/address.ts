import { getAddress } from "viem";

/**
 * Address & hash normalization.
 *
 * Canonical STORAGE form: lowercase, 0x-prefixed, 40 hex chars. Everything that
 * is persisted, compared, or used inside an idempotency key goes through
 * `normalizeAddress` first. Canonical DISPLAY form: EIP-55 checksum
 * (`toChecksumAddress`).
 *
 * Mixed-case input is treated as an EIP-55 checksum claim and is rejected if
 * the checksum does not match — that is almost always a typo or a tampered
 * address, and silently lowercasing it would hide the mistake.
 */

declare const addressBrand: unique symbol;
declare const hashBrand: unique symbol;

/** Lowercase 0x-prefixed 20-byte address. Only produced by `normalizeAddress`. */
export type NormalizedAddress = `0x${string}` & { readonly [addressBrand]: true };

/** Lowercase 0x-prefixed 32-byte hash (tx hash, block hash, topic). */
export type NormalizedHash = `0x${string}` & { readonly [hashBrand]: true };

export class InvalidAddressError extends Error {
  readonly input: string;
  readonly reason: "format" | "checksum";

  constructor(input: string, reason: "format" | "checksum") {
    super(
      reason === "format"
        ? `Invalid address: expected 0x followed by 40 hex characters`
        : `Invalid address: EIP-55 checksum mismatch`,
    );
    this.name = "InvalidAddressError";
    this.input = input;
    this.reason = reason;
  }
}

export class InvalidHashError extends Error {
  constructor() {
    super("Invalid hash: expected 0x followed by 64 hex characters");
    this.name = "InvalidHashError";
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as NormalizedAddress;

export function normalizeAddress(input: string): NormalizedAddress {
  const value = input.trim();
  if (!ADDRESS_RE.test(value)) throw new InvalidAddressError(input, "format");

  const body = value.slice(2);
  const isMixedCase = /[a-f]/.test(body) && /[A-F]/.test(body);
  if (isMixedCase && getAddress(value) !== value) {
    throw new InvalidAddressError(input, "checksum");
  }
  return value.toLowerCase() as NormalizedAddress;
}

export function tryNormalizeAddress(input: string): NormalizedAddress | null {
  try {
    return normalizeAddress(input);
  } catch {
    return null;
  }
}

export function isValidAddress(input: string): boolean {
  return tryNormalizeAddress(input) !== null;
}

/** EIP-55 checksum form, for display only. */
export function toChecksumAddress(input: string): `0x${string}` {
  return getAddress(normalizeAddress(input));
}

export function isSameAddress(a: string, b: string): boolean {
  const left = tryNormalizeAddress(a);
  return left !== null && left === tryNormalizeAddress(b);
}

/** `0x7F3a…cA91` — checksum form, for dense UI. */
export function shortAddress(input: string, chars = 4): string {
  const checksum = toChecksumAddress(input);
  return `${checksum.slice(0, 2 + chars)}…${checksum.slice(-chars)}`;
}

export function normalizeHash(input: string): NormalizedHash {
  const value = input.trim();
  if (!HASH_RE.test(value)) throw new InvalidHashError();
  return value.toLowerCase() as NormalizedHash;
}

export function tryNormalizeHash(input: string): NormalizedHash | null {
  try {
    return normalizeHash(input);
  } catch {
    return null;
  }
}
