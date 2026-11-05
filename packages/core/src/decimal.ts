/**
 * Exact decimal handling for conditions. On-chain amounts exceed 2^53, so
 * values travel as decimal strings and are compared digit-wise — never as
 * floats. `0.1 + 0.2` problems cannot occur here.
 */

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function isDecimalString(value: string): boolean {
  return DECIMAL_RE.test(value);
}

/** JS number → exact decimal string, without exponent notation. */
export function numberToDecimal(n: number): string | null {
  if (!Number.isFinite(n)) return null;
  if (Number.isInteger(n)) return Math.abs(n) < 1e21 ? n.toFixed(0) : BigInt(n).toString();
  const s = String(n);
  if (!/e/i.test(s)) return s;
  // Tiny non-integers like 1e-7: expand, then trim.
  return trimFraction(n.toFixed(20));
}

/** Number or numeric string → canonical decimal string; anything else → null. */
export function toDecimal(value: unknown): string | null {
  if (typeof value === "number") return numberToDecimal(value);
  if (typeof value === "string" && DECIMAL_RE.test(value)) return value;
  if (typeof value === "bigint") return value.toString();
  return null;
}

function trimFraction(s: string): string {
  if (!s.includes(".")) return s;
  const trimmed = s.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}

function parts(d: string): { neg: boolean; int: string; frac: string } {
  const neg = d.startsWith("-");
  const body = neg ? d.slice(1) : d;
  const [rawInt = "0", rawFrac = ""] = body.split(".");
  const int = rawInt.replace(/^0+(?=\d)/, "");
  const frac = rawFrac.replace(/0+$/, "");
  const isZero = /^0*$/.test(int) && frac === "";
  return { neg: neg && !isZero, int, frac };
}

function compareAbs(a: { int: string; frac: string }, b: { int: string; frac: string }): -1 | 0 | 1 {
  if (a.int.length !== b.int.length) return a.int.length < b.int.length ? -1 : 1;
  if (a.int !== b.int) return a.int < b.int ? -1 : 1;
  const len = Math.max(a.frac.length, b.frac.length);
  const fa = a.frac.padEnd(len, "0");
  const fb = b.frac.padEnd(len, "0");
  if (fa === fb) return 0;
  return fa < fb ? -1 : 1;
}

/** Compares two canonical decimal strings exactly. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const pa = parts(a);
  const pb = parts(b);
  if (pa.neg !== pb.neg) return pa.neg ? -1 : 1;
  const abs = compareAbs(pa, pb);
  return (pa.neg ? -abs : abs) as -1 | 0 | 1;
}
