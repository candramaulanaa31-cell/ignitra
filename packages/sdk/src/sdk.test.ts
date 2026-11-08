import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Ignitra, IgnitraApiError, IgnitraNetworkError, IgnitraSignatureError, parseWebhook, signWebhookPayload, verifyWebhookSignature, withStepIds } from "./index.js";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

function fakeFetch(answers: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch = (async (input: URL | string, init: RequestInit = {}) => {
    const call: Call = { method: init.method ?? "GET", url: String(input), headers: Object.fromEntries(Object.entries(init.headers ?? {})), body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const answer = answers.shift();
    if (!answer) throw new Error("unexpected request");
    return answer(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("client", () => {
  it("creates a flow the way the spec writes it: steps without ids are named", async () => {
    const { fetch, calls } = fakeFetch([() => json(201, { data: { id: "fl_1", name: "Big buys → my server" } })]);
    const ignitra = new Ignitra({ apiKey: "igk_test", baseUrl: "https://app.example/api/", fetch });
    const flow = await ignitra.flows.create({
      name: "Big buys → my server",
      trigger: { type: "TOKEN_TRANSFER", params: { token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" } },
      conditions: { all: [{ field: "percent_of_supply", op: ">=", value: 1 }] },
      actions: [{ type: "WEBHOOK", params: { url: "https://myapp.com/hook" } }],
    });
    expect(flow.id).toBe("fl_1");
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://app.example/api/v1/flows", headers: { authorization: "Bearer igk_test", "content-type": "application/json" } });
    expect(calls[0]?.body).toEqual({
      name: "Big buys → my server",
      definition: {
        trigger: { type: "TOKEN_TRANSFER", params: { token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" } },
        conditions: { all: [{ field: "percent_of_supply", op: ">=", value: 1 }] },
        actions: [{ type: "WEBHOOK", params: { url: "https://myapp.com/hook" }, step_id: "webhook" }],
      },
    });
  });

  it("names steps uniquely and keeps the ones given", () => {
    expect(withStepIds([{ type: "WEBHOOK", params: {} }, { type: "WEBHOOK", params: {} }, { step_id: "webhook_2", type: "TELEGRAM", params: {} }, { type: "CHAIN_READ", params: {} }]).map((s) => s.step_id)).toEqual([
      "webhook",
      "webhook_3",
      "webhook_2",
      "chain_read",
    ]);
  });

  it("turns error bodies into IgnitraApiError with issues and details", async () => {
    const { fetch } = fakeFetch([
      () => json(422, { error: { code: "invalid_flow", message: "the flow definition is invalid", issues: [{ path: "actions.0.params.url", message: "must be an http(s) URL" }] } }),
      () => json(402, { error: { code: "plan_limit_reached", message: "3 active flows", limit: "active_flows", plan: "free", max: 3 } }),
    ]);
    const ignitra = new Ignitra({ apiKey: "igk_test", baseUrl: "https://app.example/api", fetch });
    const invalid = await ignitra.flows.validate({ trigger: { type: "SCHEDULE", params: {} }, actions: [{ type: "WEBHOOK", params: {} }] }).catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(IgnitraApiError);
    expect(invalid).toMatchObject({ status: 422, code: "invalid_flow", issues: [{ path: "actions.0.params.url" }] });
    const limited = await ignitra.flows.resume("fl_1").catch((e: unknown) => e);
    expect(limited).toMatchObject({ status: 402, code: "plan_limit_reached", details: { limit: "active_flows", plan: "free", max: 3 } });
  });

  it("retries 429 (any method) after Retry-After and 503 only when idempotent", async () => {
    const { fetch, calls } = fakeFetch([
      () => json(429, { error: { code: "rate_limited", message: "slow down" } }, { "retry-after": "0" }),
      () => json(201, { data: { id: "fl_2" } }),
      () => json(503, { error: { code: "unavailable", message: "busy" } }),
      () => json(200, { data: [] }),
      () => json(503, { error: { code: "unavailable", message: "busy" } }),
    ]);
    const ignitra = new Ignitra({ apiKey: "igk_test", baseUrl: "https://app.example/api", fetch });
    expect((await ignitra.flows.create({ name: "x", trigger: { type: "SCHEDULE", params: {} }, actions: [{ type: "WEB_PUSH", params: {} }] })).id).toBe("fl_2");
    expect(await ignitra.flows.list()).toEqual([]);
    // A POST that may have been processed is not repeated on a 503.
    await expect(ignitra.flows.test("fl_2")).rejects.toMatchObject({ status: 503 });
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST", "GET", "GET", "POST"]);
  });

  it("pages runs with an async iterator", async () => {
    const { fetch, calls } = fakeFetch([() => json(200, { data: [{ id: "run_3" }, { id: "run_2" }], next_before: "run_2" }), () => json(200, { data: [{ id: "run_1" }], next_before: null })]);
    const ignitra = new Ignitra({ apiKey: "igk_test", baseUrl: "https://app.example/api", fetch });
    const ids: string[] = [];
    for await (const run of ignitra.flows.iterateRuns("fl_1", { pageSize: 2 })) ids.push(run.id);
    expect(ids).toEqual(["run_3", "run_2", "run_1"]);
    expect(calls[1]?.url).toBe("https://app.example/api/v1/flows/fl_1/runs?limit=2&before=run_2");
  });

  it("reports timeouts as IgnitraNetworkError", async () => {
    const fetch = ((_: unknown, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof globalThis.fetch;
    const ignitra = new Ignitra({ apiKey: "igk_test", baseUrl: "https://app.example/api", fetch, timeoutMs: 20, maxRetries: 0 });
    const err = await ignitra.account.me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IgnitraNetworkError);
    expect((err as IgnitraNetworkError).timedOut).toBe(true);
  });

  it("needs a key and a base URL", () => {
    expect(() => new Ignitra({ baseUrl: "https://app.example/api" })).toThrow(/apiKey/);
    expect(() => new Ignitra({ apiKey: "igk_x", baseUrl: "ftp://nope" })).toThrow(/http/);
  });
});

describe("webhooks", () => {
  const secret = "whsec_sdk_test";
  const body = '{"type":"run.action","run_id":"run_1","test":false}';
  // IGNITRA's runner signs with node:crypto; the SDK verifies with WebCrypto.
  const sign = (ts: number, b = body, s = secret) => `v1=${createHmac("sha256", s).update(`${ts}.${b}`).digest("hex")}`;

  it("verifies what IGNITRA signs, from plain objects or fetch Headers", async () => {
    const now = 1_762_480_800_000;
    const ts = now / 1000;
    expect(await verifyWebhookSignature(body, { "X-Ignitra-Signature": sign(ts), "x-ignitra-timestamp": String(ts) }, secret, { now })).toBe(true);
    const headers = new Headers({ "x-ignitra-signature": `v1=${"0".repeat(64)}, ${sign(ts)}`, "x-ignitra-timestamp": String(ts) });
    expect(await verifyWebhookSignature(new TextEncoder().encode(body), headers, secret, { now })).toBe(true);
    expect(await signWebhookPayload(body, secret, ts)).toBe(sign(ts));
  });

  it("rejects tampering, wrong secrets, stale timestamps and junk", async () => {
    const now = 1_762_480_800_000;
    const ts = now / 1000;
    const h = { "x-ignitra-signature": sign(ts), "x-ignitra-timestamp": String(ts) };
    expect(await verifyWebhookSignature(body.replace("false", "true"), h, secret, { now })).toBe(false);
    expect(await verifyWebhookSignature(body, h, "whsec_other", { now })).toBe(false);
    expect(await verifyWebhookSignature(body, h, secret, { now: now + 301_000 })).toBe(false);
    expect(await verifyWebhookSignature(body, { "x-ignitra-signature": "v1=zz", "x-ignitra-timestamp": String(ts) }, secret, { now })).toBe(false);
    expect(await verifyWebhookSignature(body, {}, secret, { now })).toBe(false);
    await expect(parseWebhook(body, h, "whsec_other", { now })).rejects.toBeInstanceOf(IgnitraSignatureError);
    expect(await parseWebhook(body, h, secret, { now })).toMatchObject({ type: "run.action", run_id: "run_1" });
  });
});
