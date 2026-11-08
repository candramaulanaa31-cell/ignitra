import { describe, expect, it } from "vitest";
import { toChecksumAddress } from "./address";
import { checkTemplate, deriveTemplate, instantiateTemplate, outlineDefinition, templateMarkers, type FlowTemplate } from "./flow-templates";
import { planFor } from "./plans";
import { OFFICIAL_TEMPLATES, findOfficialTemplate } from "./template-catalog";

const CONN = `conn_${"a".repeat(26)}`;

/** Example values for every placeholder of a template (fake private destinations). */
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

describe("official templates", () => {
  it("are at least 10, uniquely named, consistent and complete", () => {
    expect(OFFICIAL_TEMPLATES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(OFFICIAL_TEMPLATES.map((t) => t.slug)).size).toBe(OFFICIAL_TEMPLATES.length);
    for (const t of OFFICIAL_TEMPLATES) {
      expect([t.slug, checkTemplate(t)]).toEqual([t.slug, []]);
      expect(t.slug).toMatch(/^[a-z0-9-]{3,60}$/);
      expect(t.summary.length).toBeLessThanOrEqual(160);
      expect(t.shareText).toBeTruthy();
      const built = instantiateTemplate(t, exampleValues(t));
      expect([t.slug, "issues" in built ? built.issues : []]).toEqual([t.slug, []]);
      if ("definition" in built) expect(templateMarkers(built.definition)).toEqual([]);
    }
  });

  it("mark which plan they need", () => {
    const needsBuilder = OFFICIAL_TEMPLATES.filter((t) => {
      const d = t.definition as { trigger: { type: string }; actions: Array<{ type: string }> };
      return [d.trigger.type, ...d.actions.map((a) => a.type)].some((type) => planFor(type as never) !== "free");
    }).map((t) => t.slug);
    expect(needsBuilder).toEqual(["new-holder-sheets", "treasury-low-email", "daily-supply-sheets"]);
    expect(findOfficialTemplate("big-buy-telegram")?.name).toBe("Big buy alert → Telegram");
  });
});

describe("instantiateTemplate", () => {
  const big = findOfficialTemplate("big-buy-telegram") as FlowTemplate;

  it("fills placeholders with normalized values and defaults", () => {
    const built = instantiateTemplate(big, { token: toChecksumAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168"), chat: CONN });
    expect("definition" in built && built.definition).toMatchObject({
      trigger: { type: "TOKEN_TRANSFER", params: { token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" } },
      conditions: { all: [{ field: "percent_of_supply", op: ">=", value: "0.5" }, { field: "is_mint", op: "==", value: false }] },
      actions: [{ params: { connection_id: CONN } }],
    });
  });

  it("explains every bad or missing value", () => {
    const built = instantiateTemplate(big, { token: "0x123", threshold: "-1", extra: 1 });
    expect("issues" in built && built.issues).toEqual([
      { path: "values.token", message: "Token: must be an address (0x + 40 hex)" },
      { path: "values.threshold", message: 'Minimum % of supply: must be a non-negative number like "0.5"' },
      { path: "values.chat", message: "Telegram chat: required" },
      { path: "values.extra", message: "unknown placeholder" },
    ]);
  });

  it("leaves out optional placeholders the user did not fill", () => {
    const t: FlowTemplate = {
      ...big,
      placeholders: [...big.placeholders, { key: "wallet", label: "Wallet", type: "address", optional: true }],
      definition: { ...(big.definition as object), trigger: { type: "TOKEN_TRANSFER", params: { token: { $param: "token" }, wallet: { $param: "wallet" } } } },
    };
    const built = instantiateTemplate(t, { token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", chat: CONN });
    expect("definition" in built && (built.definition.trigger as { params: object }).params).toEqual({ token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" });
  });

  it("refuses inconsistent templates and defaults on private destinations", () => {
    expect(checkTemplate({ placeholders: [{ key: "a", label: "A", type: "text" }], definition: { x: { $param: "b" } } })).toEqual([
      'placeholder "a" is not used in the definition',
      'the definition uses "b" but no placeholder declares it',
    ]);
    expect(checkTemplate({ placeholders: [{ key: "u", label: "U", type: "url", default: "https://mine.example/hook" }], definition: { x: { $param: "u" } } })).toEqual([
      'placeholder "u" is a private destination and cannot have a default',
    ]);
  });
});

describe("deriveTemplate (share a flow)", () => {
  const flow = {
    trigger: { type: "TOKEN_TRANSFER", params: { token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", direction: "any" } },
    conditions: { all: [{ field: "amount_decimal", op: ">=", value: "1000" }, { field: "is_mint", op: "==", value: false }] },
    actions: [
      { step_id: "notify", type: "TELEGRAM", params: { connection_id: "conn_01m6ttw446jwqv7wj4fn65rxkz", text: "🔥 {{trigger.amount_formatted}}" } },
      { step_id: "hook", type: "WEBHOOK", params: { url: "https://private.example/hook?token=s3cret" } },
      { step_id: "row", type: "GOOGLE_SHEETS", params: { connection_id: "conn_01m6ttw478ynwbtzyxxgwn6yqx", spreadsheet: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms", values: ["{{trigger.to}}"] } },
    ],
    settings: { mode: "confirmed", max_runs_per_hour: 60 },
  };

  it("turns private destinations into empty placeholders and public values into defaults", () => {
    const t = deriveTemplate(flow);
    const text = JSON.stringify(t);
    expect(text).not.toContain("conn_01m6");
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("1BxiMVs0");
    expect(t.placeholders.map((p) => [p.key, p.type, p.default ?? null])).toEqual([
      ["token", "address", "0x5fc5360d0400a0fd4f2af552add042d716f1d168"],
      ["amount_decimal_min", "decimal", "1000"],
      ["telegram_chat", "connection", null],
      ["webhook_url", "url", null],
      ["google_connection", "connection", null],
      ["spreadsheet", "spreadsheet", null],
    ]);
    expect(checkTemplate(t)).toEqual([]);
    expect(t.definition.actions[0]?.params.text).toBe("🔥 {{trigger.amount_formatted}}"); // content is kept
  });

  it("round-trips: someone else fills it with their own destinations", () => {
    const t = deriveTemplate(flow);
    const built = instantiateTemplate(t, { telegram_chat: CONN, webhook_url: "https://theirs.example/hook", google_connection: CONN, spreadsheet: "https://docs.google.com/spreadsheets/d/1ZZZZZZZZZZZZZZZZZZZZZZZZZZZ/edit" });
    expect("definition" in built && built.definition).toMatchObject({ trigger: { params: { token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" } }, actions: [{}, { params: { url: "https://theirs.example/hook" } }, {}] });
  });

  it("names condition fields like a form: words for the operator, readable known fields", () => {
    const t = deriveTemplate({
      ...flow,
      conditions: {
        all: [
          { field: "amount_decimal", op: ">=", value: "1000" },
          { field: "percent_of_supply", op: "<", value: 2 },
          { field: "body.order.total", op: "<=", value: "500" },
          { field: "time.weekday_wib", op: "==", value: 1 },
        ],
      },
    });
    expect(t.placeholders.filter((p) => p.type === "decimal" || p.type === "number").map((p) => [p.key, p.label])).toEqual([
      ["amount_decimal_min", "Minimum amount (token units)"],
      ["percent_of_supply_below", "Less than % of supply"],
      ["total_max", "Maximum body.order.total"],
      ["weekday_wib_value", "Weekday (WIB, 1 = Monday)"],
    ]);
    expect(outlineDefinition(t.definition, t.placeholders)[1]).toEqual({ kind: "IF", text: "amount_decimal ≥ ‹Minimum amount (token units)›" });
  });

  it("keeps an integration trigger's connection private", () => {
    const t = deriveTemplate({
      trigger: { type: "VIGIL_ALERT", params: { connection_id: "conn_01m6ttw446jwqv7wj4fn65rxkz", stage: "confirmed", min_severity: "high" } },
      actions: [{ step_id: "notify", type: "TELEGRAM", params: { connection_id: "conn_01m6ttw478ynwbtzyxxgwn6yqx", text: "{{trigger.title}}" } }],
    });
    expect(JSON.stringify(t)).not.toContain("conn_01m6");
    expect(t.placeholders.map((p) => [p.key, p.type, p.connectionType ?? null, p.default ?? null])).toEqual([
      ["vigil_connection", "connection", "vigil", null],
      ["telegram_chat", "connection", "telegram", null],
    ]);
    expect(t.definition.trigger.params).toMatchObject({ connection_id: { $param: "vigil_connection" }, stage: "confirmed", min_severity: "high" });
    expect(checkTemplate(t)).toEqual([]);
  });

  it("refuses flows with onchain transactions: users would move funds through calls someone else wrote", () => {
    const onchain = deriveTemplate({
      ...flow,
      actions: [{ step_id: "pay", type: "ONCHAIN_TX", params: { grant_id: `grt_${"a".repeat(26)}`, to: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", function: "transfer(address,uint256)", args: ["0x2222222222222222222222222222222222222222", "1000"] } }],
      settings: { mode: "confirmed", onchain: true },
    });
    expect(checkTemplate(onchain)).toContain("flows with onchain transactions cannot be shared as templates");
    // The opt-in alone is refused too, whatever the steps are.
    expect(checkTemplate({ placeholders: [], definition: { ...flow, settings: { onchain: true } } })).toContain("flows with onchain transactions cannot be shared as templates");
  });
});

describe("outlineDefinition", () => {
  it("reads like the flow: WHEN / IF / AND / THEN, placeholders as ‹labels›", () => {
    const t = findOfficialTemplate("big-buy-telegram") as FlowTemplate;
    expect(outlineDefinition(t.definition, t.placeholders)).toEqual([
      { kind: "WHEN", text: "Token transfer · token ‹Token›" },
      { kind: "IF", text: "percent_of_supply ≥ ‹Minimum % of supply›" },
      { kind: "AND", text: "is_mint = false" },
      { kind: "THEN", text: "Telegram → ‹Telegram chat›" },
    ]);
  });

  it("shows signatures without keywords, modifiers or return types; hideTargets keeps destinations out", () => {
    const def = {
      trigger: { type: "STATE_CHANGE", params: { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", function: "function paused() view returns (bool)" } },
      conditions: { all: [{ field: "current", op: "==", value: "function (not a signature)" }] },
      actions: [
        { step_id: "read", type: "CHAIN_READ", params: { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", function: "function balanceOf(address account) view returns (uint256)" } },
        { step_id: "tell", type: "TELEGRAM", params: { connection_id: "conn_secret", text: "x" } },
      ],
    };
    expect(outlineDefinition(def)).toEqual([
      { kind: "WHEN", text: "Contract state changes · address 0x5fc5…d168 · paused()" },
      { kind: "IF", text: "current = function (not a signature)" },
      { kind: "THEN", text: "Read contract → balanceOf(address account)" },
      { kind: "THEN", text: "Telegram → conn_secret" },
    ]);
    const hidden = outlineDefinition(def, [], { hideTargets: true });
    expect(hidden.map((l) => l.text)).toEqual(["Contract state changes · address 0x5fc5…d168 · paused()", "current = function (not a signature)", "Read contract → balanceOf(address account)", "Telegram"]);
  });
});
