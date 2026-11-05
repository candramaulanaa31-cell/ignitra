import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addr } from "@ignitra/chain/testing";
import { createDb, flowVersions, flows, triggerState, users, watches, type DbHandle } from "@ignitra/db";
import { FlowValidationError, createFlow, ensureUser, setFlowStatus, updateFlowDefinition, validateFlowDefinition, type FlowServiceDeps } from "./flows";
import { createTriggerModules } from "./triggers/index";

const TOKEN = addr(0x70c);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

let h: DbHandle;
let deps: FlowServiceDeps;

beforeAll(async () => {
  h = await createDb("pglite://memory");
  await h.migrate();
  deps = { db: h.db, chainId: 4663, triggers: createTriggerModules(), prepare: { abis: null } };
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.db.delete(users);
  await h.db.delete(watches);
});

const bigBuys = {
  trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } },
  conditions: { all: [{ field: "percent_of_supply", op: ">=", value: 0.5 }] },
  actions: [{ step_id: "notify", type: "DISCORD", params: { connection_id: "conn_x", template: "🔥 {{trigger.amount_formatted}}" } }],
};

const issuesOf = async (input: unknown) => {
  try {
    await validateFlowDefinition(input, deps);
    return [];
  } catch (err) {
    if (!(err instanceof FlowValidationError)) throw err;
    return err.issues.map((i) => `${i.path}: ${i.message}`);
  }
};

describe("validateFlowDefinition", () => {
  it("normalizes params and applies defaults", async () => {
    const def = await validateFlowDefinition({ ...bigBuys, trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN.toUpperCase().replace("0X", "0x") } } }, deps);
    expect(def.trigger.params).toEqual({ token: TOKEN, direction: "any" });
    expect(def.settings).toEqual({ mode: "confirmed", max_runs_per_hour: 60 });
  });

  it("rejects unknown condition fields with a suggestion — the classic silent misconfiguration", async () => {
    const issues = await issuesOf({ ...bigBuys, conditions: { all: [{ field: "symbol", op: "==", value: "USDG" }] } });
    expect(issues[0]).toMatch(/conditions\.all\.0: unknown field "symbol".*"token\.symbol"/);
  });

  it("rejects bad trigger params with their path", async () => {
    expect(await issuesOf({ ...bigBuys, trigger: { type: "TOKEN_TRANSFER", params: { token: "0xnope" } } })).toEqual([
      expect.stringMatching(/^trigger\.params\.token: must be a valid address/),
    ]);
    expect(await issuesOf({ ...bigBuys, trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN, extra: 1 } } })).toHaveLength(1);
  });

  it("rejects fast mode for triggers that need confirmed data", async () => {
    const issues = await issuesOf({ ...bigBuys, trigger: { type: "NEW_HOLDER", params: { token: TOKEN } }, conditions: undefined, settings: { mode: "fast" } });
    expect(issues).toEqual([expect.stringMatching(/^settings\.mode: NEW_HOLDER needs confirmed data/)]);
  });

  it("rejects triggers that are not implemented yet", async () => {
    expect(await issuesOf({ ...bigBuys, trigger: { type: "SCHEDULE", params: {} }, conditions: undefined })).toEqual(["trigger.type: SCHEDULE is not available yet"]);
  });

  it("surfaces prepare() failures (unresolvable event names)", async () => {
    const issues = await issuesOf({ ...bigBuys, trigger: { type: "CONTRACT_EVENT", params: { address: TOKEN, event: "Transfer" } }, conditions: undefined });
    expect(issues[0]).toMatch(/^trigger\.params: event "Transfer" is ambiguous/);
  });
});

describe("flow lifecycle", () => {
  it("creates, versions, activates and pauses — keeping watches in sync", async () => {
    const owner = await ensureUser(h.db, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    expect(await ensureUser(h.db, "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(owner); // same wallet, same user

    const created = await createFlow(deps, { ownerId: owner, name: "  Big buys → Discord ", definition: bigBuys });
    let [flow] = await h.db.select().from(flows).where(eq(flows.id, created.flowId));
    expect(flow).toMatchObject({ name: "Big buys → Discord", status: "paused", currentVersion: 1, activatedAt: null });
    expect(await h.db.select().from(watches)).toMatchObject([{ address: TOKEN, topic0: TRANSFER, fast: false, source: "flow", flowId: created.flowId }]);

    await setFlowStatus(deps, created.flowId, "active");
    [flow] = await h.db.select().from(flows).where(eq(flows.id, created.flowId));
    expect(flow?.status).toBe("active");
    expect(flow?.activatedAt).toBeInstanceOf(Date);

    await h.db.insert(triggerState).values({ flowId: created.flowId, flowVersion: 1, state: { x: 1 } });
    const { version } = await updateFlowDefinition(deps, created.flowId, { ...bigBuys, settings: { mode: "fast", max_runs_per_hour: 10 } });
    expect(version).toBe(2);
    expect((await h.db.select().from(flowVersions).where(eq(flowVersions.flowId, created.flowId))).map((v) => v.version)).toEqual([1, 2]);
    expect(await h.db.select().from(watches)).toMatchObject([{ fast: true }]);
    expect(await h.db.select().from(triggerState)).toHaveLength(0); // new version → poll state restarts

    await setFlowStatus(deps, created.flowId, "paused", "maintenance");
    [flow] = await h.db.select().from(flows).where(eq(flows.id, created.flowId));
    expect(flow).toMatchObject({ status: "paused", statusReason: "maintenance" });
  });

  it("poll triggers create no watches", async () => {
    const owner = await ensureUser(h.db, addr(0xabc));
    await createFlow(deps, {
      ownerId: owner,
      name: "Treasury low",
      activate: true,
      definition: {
        trigger: { type: "BALANCE_THRESHOLD", params: { wallet: addr(0x7), threshold: "2" } },
        actions: [{ step_id: "mail", type: "EMAIL", params: {} }],
      },
    });
    expect(await h.db.select().from(watches)).toHaveLength(0);
  });

  it("refuses an invalid name", async () => {
    const owner = await ensureUser(h.db, addr(0xabd));
    await expect(createFlow(deps, { ownerId: owner, name: " ", definition: bigBuys })).rejects.toBeInstanceOf(FlowValidationError);
  });
});
