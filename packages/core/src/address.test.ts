import { describe, expect, it } from "vitest";
import {
  InvalidAddressError,
  ZERO_ADDRESS,
  isSameAddress,
  isValidAddress,
  normalizeAddress,
  normalizeHash,
  shortAddress,
  toChecksumAddress,
  tryNormalizeAddress,
} from "./address";

// EIP-55 test vector.
const CHECKSUM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const LOWER = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const UPPER = "0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED";

describe("normalizeAddress", () => {
  it("lowercases valid checksum, lowercase and all-uppercase input", () => {
    expect(normalizeAddress(CHECKSUM)).toBe(LOWER);
    expect(normalizeAddress(LOWER)).toBe(LOWER);
    expect(normalizeAddress(UPPER)).toBe(LOWER);
  });

  it("trims surrounding whitespace (pasted addresses)", () => {
    expect(normalizeAddress(`  ${CHECKSUM}\n`)).toBe(LOWER);
  });

  it("rejects mixed case with a wrong checksum", () => {
    const broken = CHECKSUM.replace("aA", "Aa");
    expect(() => normalizeAddress(broken)).toThrow(InvalidAddressError);
    try {
      normalizeAddress(broken);
    } catch (err) {
      expect((err as InvalidAddressError).reason).toBe("checksum");
    }
  });

  it.each(["", "0x", "0x123", `${LOWER}00`, LOWER.slice(2), `0X${LOWER.slice(2)}`, `0x${"g".repeat(40)}`])(
    "rejects malformed input %j",
    (input) => {
      expect(() => normalizeAddress(input)).toThrow(InvalidAddressError);
      expect(tryNormalizeAddress(input)).toBeNull();
      expect(isValidAddress(input)).toBe(false);
    },
  );
});

describe("display helpers", () => {
  it("produces EIP-55 checksum form", () => {
    expect(toChecksumAddress(LOWER)).toBe(CHECKSUM);
  });

  it("shortens using checksum casing", () => {
    expect(shortAddress(LOWER)).toBe("0x5aAe…eAed");
  });

  it("compares addresses case-insensitively and never equals invalid input", () => {
    expect(isSameAddress(CHECKSUM, UPPER)).toBe(true);
    expect(isSameAddress(LOWER, ZERO_ADDRESS)).toBe(false);
    expect(isSameAddress("nope", "nope")).toBe(false);
  });
});

describe("normalizeHash", () => {
  it("lowercases 32-byte hashes and rejects anything else", () => {
    const hash = `0x${"AB".repeat(32)}`;
    expect(normalizeHash(hash)).toBe(`0x${"ab".repeat(32)}`);
    expect(() => normalizeHash(LOWER)).toThrow();
    expect(() => normalizeHash(`0x${"a".repeat(63)}`)).toThrow();
  });
});
