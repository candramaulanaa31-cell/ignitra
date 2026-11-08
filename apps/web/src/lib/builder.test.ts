import { describe, expect, it } from "vitest";
import { cleanParams, defaultsFor, fromConditions, insertAtCursor, issuesUnder, newStepId, toConditions, toDefinition, variableGroups, type Draft } from "./builder";
import { ACTION_FORMS, TRIGGER_FORMS } from "./forms";
import { ago, shortHex, statusClass } from "./format";
import type { CatalogFields } from "./types";

const fields = [
  { path: "amount_decimal", type: "decimal", description: "Amount" },
  { path: "percent_of_supply", type: "number", description: "% of supply" },
  { path: "is_mint", type: "boolean", description: "Mint" },
  { path: "to", type: "address", description: "Recipient" },
  { path: "token", type: "object", description: "Token" },
  { path: "token.symbol", type: "string", description: "Symbol" },
] as const;

describe("params", () => {
  it("starts from form defaults", () => {
    expect(defaultsFor(TRIGGER_FORMS.BALANCE_THRESHOLD ?? [])).toEqual({ asset: "native", direction: "below" });
    expect(defaultsFor(ACTION_FORMS.TELEGRAM ?? [])).toMatchObject({ parse_mode: "html", disable_link_preview: true, silent: false });
  });

  it("drops empty optional values and fields hidden by other params", () => {
    const form = TRIGGER_FORMS.TOKEN_TRANSFER ?? [];
    expect(cleanParams(form, { token: "0xabc", wallet: "", direction: "in" })).toEqual({ token: "0xabc" }); // direction needs a wallet
    expect(cleanParams(form, { token: "0xabc", wallet: "0xdef", direction: "in" })).toEqual({ token: "0xabc", wallet: "0xdef", direction: "in" });
    const webhook = ACTION_FORMS.WEBHOOK ?? [];
    expect(cleanParams(webhook, { url: "https://x.example", connection_id: "conn_1" })).toEqual({ connection_id: "conn_1" });
    const http = ACTION_FORMS.HTTP_REQUEST ?? [];
    expect(cleanParams(http, { method: "GET", url: "https://x.example", body_type: "json", body: "{}", headers: [{ name: "", value: "x" }, { name: "X-A", value: "1" }] })).toEqual({
      method: "GET",
      url: "https://x.example",
      headers: [{ name: "X-A", value: "1" }],
    });
    // Sheet columns keep their positions; only trailing empty ones go.
    expect(cleanParams(ACTION_FORMS.GOOGLE_SHEETS ?? [], { values: ["a", "", "c", "", ""] })).toEqual({ values: ["a", "", "c"] });
  });

  it("names steps uniquely in snake_case", () => {
    expect(newStepId("TELEGRAM", [])).toBe("telegram");
    expect(newStepId("TELEGRAM", ["telegram", "telegram_2"])).toBe("telegram_3");
    expect(newStepId("HTTP_REQUEST", [])).toBe("http_request");
  });
});

describe("conditions", () => {
  it("parses values by field type: exact decimals stay strings, booleans and lists convert", () => {
    const group = toConditions(
      {
        mode: "all",
        rows: [
          { field: "amount_decimal", op: ">=", value: "1000000000000000000000.5" },
          { field: "percent_of_supply", op: ">", value: "0.5" },
          { field: "is_mint", op: "==", value: "false" },
          { field: "to", op: "IN", value: "0xaa, 0xbb\n0xcc" },
          { field: "token.symbol", op: "EXISTS", value: "" },
          { field: "", op: "==", value: "ignored" },
        ],
      },
      fields,
    );
    expect(group).toEqual({
      all: [
        { field: "amount_decimal", op: ">=", value: "1000000000000000000000.5" },
        { field: "percent_of_supply", op: ">", value: 0.5 },
        { field: "is_mint", op: "==", value: false },
        { field: "to", op: "IN", value: ["0xaa", "0xbb", "0xcc"] },
        { field: "token.symbol", op: "EXISTS" },
      ],
    });
    expect(toConditions({ mode: "any", rows: [] }, fields)).toBeUndefined();
  });

  it("round-trips flat groups and keeps nested ones as JSON", () => {
    const flat = { any: [{ field: "to", op: "NOT_IN" as const, value: ["0x1", "0x2"] }] };
    expect(fromConditions(flat)).toEqual({ mode: "any", rows: [{ field: "to", op: "NOT_IN", value: "0x1, 0x2" }] });
    const nested = { all: [{ field: "a", op: "==", value: 1 }, { any: [{ field: "b", op: "==", value: 2 }] }] };
    expect(fromConditions(nested).mode).toBe("json");
    expect(toConditions({ mode: "json", json: "{ nope" }, fields)).toEqual({ error: "conditions JSON is not valid" });
  });
});

describe("variables", () => {
  const catalog: CatalogFields = {
    trigger: [...fields],
    steps: { read: [{ path: "result", type: "uint", description: "Return value" }], notify: [{ path: "message_id", type: "number", description: "Message id" }] },
    builtins: ["now_wib"],
  };
  const actions = [
    { step_id: "read", type: "CHAIN_READ", params: {} },
    { step_id: "notify", type: "TELEGRAM", params: {} },
  ];

  it("offers trigger fields (with sample values), EARLIER steps only, and built-ins", () => {
    const groups = variableGroups(catalog, actions, 1, { amount_decimal: "250", token: { symbol: "USDG" } });
    expect(groups.map((g) => g.title)).toEqual(["Trigger", "Step read", "Built-in"]); // notify is not earlier than itself
    const trigger = groups[0]?.items ?? [];
    expect(trigger.find((i) => i.path === "trigger.amount_decimal")?.sample).toBe("250");
    expect(trigger.find((i) => i.path === "trigger.token.symbol")?.sample).toBe('USDG');
    expect(trigger.some((i) => i.path === "trigger.token")).toBe(false); // containers with children are not listed
    expect(variableGroups(catalog, actions, 0, null).map((g) => g.title)).toEqual(["Trigger", "Built-in"]);
  });

  it("inserts at the caret, replacing a selection", () => {
    expect(insertAtCursor("Hello !", 6, 6, "{{trigger.to}}")).toEqual({ text: "Hello {{trigger.to}}!", caret: 20 });
    expect(insertAtCursor("Hello XX!", 6, 8, "{{now_wib}}")).toEqual({ text: "Hello {{now_wib}}!", caret: 17 });
    expect(insertAtCursor("", null, null, "{{x}}")).toEqual({ text: "{{x}}", caret: 5 });
  });
});

describe("server issues and definitions", () => {
  it("maps issue paths onto fields", () => {
    const issues = [
      { path: "actions.0.params.text", message: "unknown variable" },
      { path: "actions.0.params.text", message: "another" },
      { path: "actions.1.params", message: "whole step" },
      { path: "trigger.params.token", message: "bad address" },
    ];
    const step0 = issuesUnder(issues, "actions.0.params");
    expect(step0.get("text")).toEqual(["unknown variable", "another"]);
    expect(issuesUnder(issues, "actions.1.params").get("")).toEqual(["whole step"]);
    expect(issuesUnder(issues, "trigger.params").get("token")).toEqual(["bad address"]);
  });

  it("builds the definition the API accepts", () => {
    const draft: Draft = {
      name: "Big buys",
      trigger: { type: "TOKEN_TRANSFER", params: { token: "0xabc", wallet: "", direction: "any" } },
      conditions: { mode: "all", rows: [{ field: "percent_of_supply", op: ">=", value: "0.5" }] },
      actions: [{ step_id: "notify", type: "TELEGRAM", params: { connection_id: "conn_1", text: "hi", parse_mode: "html", silent: false } }],
      settings: { mode: "confirmed", max_runs_per_hour: 60, onchain: false },
    };
    const built = toDefinition(draft, { trigger: TRIGGER_FORMS.TOKEN_TRANSFER, action: (t) => ACTION_FORMS[t] }, fields);
    expect(built).toEqual({
      definition: {
        trigger: { type: "TOKEN_TRANSFER", params: { token: "0xabc" } },
        conditions: { all: [{ field: "percent_of_supply", op: ">=", value: 0.5 }] },
        actions: [{ step_id: "notify", type: "TELEGRAM", params: { connection_id: "conn_1", text: "hi", parse_mode: "html", silent: false } }],
        settings: { mode: "confirmed", max_runs_per_hour: 60, onchain: false },
      },
    });
  });
});

describe("format", () => {
  it("shortens hex, colors statuses, says how long ago", () => {
    expect(shortHex("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe("0x5aae…eaed");
    expect(shortHex("USDG")).toBe("USDG");
    expect([statusClass("succeeded"), statusClass("partial"), statusClass("failed"), statusClass("skipped"), statusClass("queued")]).toEqual(["s-ok", "s-partial", "s-fail", "s-skip", "s-live"]);
    const now = Date.parse("2026-11-07T10:00:00Z");
    expect(ago("2026-11-07T09:59:30Z", now)).toBe("30 s ago");
    expect(ago("2026-11-07T09:15:00Z", now)).toBe("45 min ago");
    expect(ago(null, now)).toBe("never");
  });
});
