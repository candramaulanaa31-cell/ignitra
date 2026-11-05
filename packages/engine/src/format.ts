import { formatUnits, parseUnits } from "viem";

/**
 * Amount representations in trigger payloads:
 *   amount            raw base units, exact ("1234500000")      — conditions on raw values
 *   amount_decimal    token units, exact ("1234.5")              — conditions in human units
 *   amount_formatted  display ("1,234.5", ≤ 6 decimals, truncated) — templates
 */

export function toDecimalUnits(raw: bigint, decimals: number | null): string | null {
  return decimals === null ? null : formatUnits(raw, decimals);
}

export function formatDisplay(decimal: string | null, maxFraction = 6): string | null {
  if (decimal === null) return null;
  const negative = decimal.startsWith("-");
  const [int = "0", frac = ""] = (negative ? decimal.slice(1) : decimal).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = frac.slice(0, maxFraction).replace(/0+$/, "");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/** Percent of supply with 8 decimals of precision, computed in integers (no float drift). */
export function percentOf(amount: bigint, supply: bigint | null): number | null {
  if (supply === null || supply <= 0n) return null;
  const scaled = (amount * 10_000_000_000n) / supply; // percent × 1e8
  return Number(scaled) / 1e8;
}

/** Human threshold ("2.5") → base units; null when decimals are unknown or the value is malformed. */
export function toBaseUnits(decimal: string, decimals: number | null): bigint | null {
  if (decimals === null) return null;
  try {
    return parseUnits(decimal, decimals);
  } catch {
    return null;
  }
}
