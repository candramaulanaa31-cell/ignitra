import { describe, expect, it } from "vitest";
import { validateTemplate } from "./template-check";
import { TEMPLATE_LIMITS, TemplateError, parseTemplate, renderTemplate, templateVariables } from "./templates";
import type { FieldSpec } from "./fields";

const scope = {
  trigger: {
    amount_formatted: "1,234.5",
    from: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
    explorer_url: "https://robinhoodchain.blockscout.com/tx/0xabc",
    token: { symbol: "USDG", name: null },
    args: { tiers: ["1", "2"] },
    memo: "<script>alert(1)</script> & co",
    big: 10n,
  },
  steps: { notify: { message_id: 42 } },
  flow: { id: "fl_1", name: "Big buys", version: 3 },
  run: { id: "run_1", idempotency_key: "4663:0xabc:7:fl_1", test: false },
  now_wib: "2026-11-05 08:00:00 WIB",
};

const render = (t: string, escape: "none" | "html" = "none") => renderTemplate(t, scope, { escape });
const error = (fn: () => unknown): TemplateError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof TemplateError) return err;
    throw err;
  }
  throw new Error("expected a TemplateError");
};

describe("renderTemplate", () => {
  it("substitutes variables, including nested paths and array indexes", () => {
    expect(render("🔥 New buy: {{trigger.amount_formatted}} {{ trigger.token.symbol }}")).toBe("🔥 New buy: 1,234.5 USDG");
    expect(render("tier {{trigger.args.tiers.1}} · msg {{steps.notify.message_id}} · v{{flow.version}}")).toBe("tier 2 · msg 42 · v3");
    expect(render("{{now_wib}}")).toBe("2026-11-05 08:00:00 WIB");
  });

  it("renders null as empty and objects as JSON", () => {
    expect(render("[{{trigger.token.name}}]")).toBe("[]");
    expect(render("{{trigger.token}}")).toBe('{"symbol":"USDG","name":null}');
    expect(render("{{trigger.big}}")).toBe("10");
  });

  it("fails on unknown variables instead of sending a half-empty message", () => {
    expect(error(() => render("{{trigger.amout}}")).code).toBe("unknown_variable");
    expect(error(() => render("{{trigger.args.tiers.9}}")).code).toBe("unknown_variable");
    expect(render('{{trigger.amout | default: "n/a"}}')).toBe("n/a");
  });

  it("applies filters", () => {
    expect(render("{{trigger.from | short}}")).toBe("0x5aae…eaed");
    expect(render("{{trigger.token.symbol | lower}} {{trigger.token.symbol | upper}}")).toBe("usdg USDG");
    expect(render('{{trigger.token.name | default: "Unnamed"}}')).toBe("Unnamed");
    expect(render("{{trigger.memo | truncate: 10}}")).toBe("<script>a…");
    expect(render("{{trigger.explorer_url | url}}")).toBe("https%3A%2F%2Frobinhoodchain.blockscout.com%2Ftx%2F0xabc");
    expect(render("{{trigger.token | json}}")).toBe('{"symbol":"USDG","name":null}');
    expect(render('{{trigger.token.name | default: "a | b"}}')).toBe("a | b");
  });

  it("escapes substituted values for HTML (Telegram) but keeps the user's own markup", () => {
    expect(render("<b>Memo:</b> {{trigger.memo}}", "html")).toBe("<b>Memo:</b> &lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
    expect(render("{{trigger.memo}}")).toBe("<script>alert(1)</script> & co");
  });

  it("supports literal braces", () => {
    expect(render("\\{{not a variable}} {{flow.name}}")).toBe("{{not a variable}} Big buys");
  });
});

describe("safety", () => {
  it("never executes code or walks the prototype chain", () => {
    for (const t of [
      "{{constructor}}",
      "{{trigger.constructor}}",
      "{{trigger.__proto__}}",
      "{{trigger.token.toString}}",
      "{{trigger.args.tiers.length}}",
    ]) {
      expect(error(() => render(t)).code).toBe("unknown_variable");
    }
    for (const t of ["{{trigger.amount_formatted()}}", "{{ process.exit(1) }}", "{{ 1 + 1 }}", "{{trigger['from']}}", "{{a; b}}"]) {
      expect(error(() => render(t)).code).toBe("syntax");
    }
    expect(error(() => render("{{trigger.from | eval}}")).code).toBe("unknown_filter");
  });

  it("refuses to read class instances, even with own properties", () => {
    class Secretive {
      secret = "hunter2";
    }
    expect(error(() => renderTemplate("{{x.secret}}", { x: new Secretive() })).code).toBe("unknown_variable");
    expect(error(() => renderTemplate("{{x.size}}", { x: new Map([["size", 1]]) })).code).toBe("unknown_variable");
  });

  it("bounds template size, placeholder count and output", () => {
    expect(error(() => parseTemplate("x".repeat(TEMPLATE_LIMITS.maxTemplateLength + 1))).code).toBe("too_long");
    expect(error(() => parseTemplate("{{flow.id}}".repeat(TEMPLATE_LIMITS.maxPlaceholders + 1))).code).toBe("too_long");
    const huge = { trigger: { blob: "x".repeat(15_000) } };
    expect(error(() => renderTemplate("{{trigger.blob}}{{trigger.blob}}", huge)).code).toBe("too_long");
  });

  it("reports syntax errors precisely", () => {
    expect(error(() => parseTemplate("hello {{trigger.from")).message).toContain('unclosed "{{"');
    expect(error(() => parseTemplate('{{flow.id | default: "x}}')).code).toBe("syntax");
    expect(error(() => parseTemplate("{{flow.id | truncate: x}}")).code).toBe("bad_argument");
    expect(error(() => parseTemplate("{{flow.id | default}}")).code).toBe("bad_argument");
  });
});

describe("validateTemplate", () => {
  const triggerFields: FieldSpec[] = [
    { path: "amount_formatted", type: "string", description: "" },
    { path: "token.symbol", type: "string", description: "" },
    { path: "args", type: "object", description: "" },
  ];
  const ctx = { triggerFields, earlierSteps: new Map([["notify", [{ path: "message_id", type: "number", description: "" } as FieldSpec]]]) };

  it("accepts catalog fields, earlier step outputs and built-ins", () => {
    expect(validateTemplate("{{trigger.amount_formatted}} {{trigger.token}} {{trigger.args.anything}} {{steps.notify.message_id}} {{now_wib}} {{flow.name}}", ctx)).toEqual([]);
    expect(templateVariables("a {{trigger.token.symbol | upper}} b {{run.id}}")).toEqual(["trigger.token.symbol", "run.id"]);
  });

  it("rejects typos, forward/unknown step references and unknown roots", () => {
    expect(validateTemplate("{{trigger.amout}}", ctx)).toEqual(['unknown variable "trigger.amout"']);
    expect(validateTemplate("{{steps.later.x}}", ctx)[0]).toMatch(/earlier step/);
    expect(validateTemplate("{{steps.notify.nope}}", ctx)).toEqual(['unknown variable "steps.notify.nope"']);
    expect(validateTemplate("{{env.SECRET}}", ctx)[0]).toMatch(/unknown variable "env.SECRET"/);
    expect(validateTemplate("{{trigger.from", ctx)[0]).toMatch(/unclosed/);
  });
});
