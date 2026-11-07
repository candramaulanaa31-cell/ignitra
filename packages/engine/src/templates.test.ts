import { describe, expect, it } from "vitest";
import { OFFICIAL_TEMPLATES, instantiateTemplate, type FlowTemplate } from "@ignitra/core";
import { createActionModules } from "@ignitra/actions";
import { FlowValidationError, validateFlowDefinition } from "./flows";
import { createTriggerModules } from "./triggers/index";

/** Every official template, filled with its examples, is a valid flow for the real modules (no template rot). */

const deps = { triggers: createTriggerModules(), actions: createActionModules(), prepare: { abis: null } };
const CONN = `conn_${"a".repeat(26)}`;

function exampleValues(t: FlowTemplate): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const ph of t.placeholders) {
    if (ph.type === "connection") out[ph.key] = CONN;
    else if (ph.type === "url") out[ph.key] = "https://hooks.example.com/ignitra";
    else if (ph.type === "spreadsheet") out[ph.key] = "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit";
    else if (ph.example !== undefined) out[ph.key] = ph.example;
  }
  return out;
}

describe("official templates against the real trigger and action modules", () => {
  for (const t of OFFICIAL_TEMPLATES) {
    it(t.slug, async () => {
      const built = instantiateTemplate(t, exampleValues(t));
      if ("issues" in built) throw new Error(JSON.stringify(built.issues));
      try {
        await validateFlowDefinition(built.definition, deps);
      } catch (err) {
        if (err instanceof FlowValidationError) expect(err.issues).toEqual([]);
        throw err;
      }
    });
  }
});
