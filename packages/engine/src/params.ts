import { z } from "zod";
import { isDecimalString, isValidAddress, normalizeAddress, numberToDecimal, type NormalizedAddress } from "@ignitra/core";

/** Address param: any valid input form in, canonical lowercase out (rule 13). */
export const addressParam = z
  .string()
  .refine(isValidAddress, { message: "must be a valid address (0x + 40 hex; mixed case must match its checksum)" })
  .transform((v): NormalizedAddress => normalizeAddress(v));

/** Non-negative human-unit decimal like "2" or "0.5" (kept as a string: no float rounding). */
export const decimalParam = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "number" ? (numberToDecimal(v) ?? "") : v.trim()))
  .refine((v) => isDecimalString(v) && !v.startsWith("-"), { message: "must be a non-negative decimal like \"2\" or \"0.5\"" });
