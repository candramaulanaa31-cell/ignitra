import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addr } from "@ignitra/chain/testing";
import { newId } from "@ignitra/core";
import { createActionModules } from "@ignitra/actions";
import { connections, createDb, flowVersions, flows, triggerState, users, watches, type DbHandle } from "@ignitra/db";
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

describe("action validation", () => {
  const withActions = () => ({ ...deps, actions: createActionModules() });
  const telegramDef = (text: string, connectionId: string) => ({
    trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } },
    actions: [{ step_id: "notify", type: "TELEGRAM", params: { connection_id: connectionId, text } }],
  });
  const issues = async (input: unknown, ownerId?: string) => {
    try {
      await validateFlowDefinition(input, { ...withActions(), db: h.db }, ownerId);
      return [];
    } catch (err) {
      if (!(err instanceof FlowValidationError)) throw err;
      return err.issues.map((i) => `${i.path}: ${i.message}`);
    }
  };
  async function telegramConnection(ownerId: string): Promise<string> {
    const id = newId("connection");
    await h.db.insert(connections).values({ id, ownerId, type: "telegram", label: "alerts", secretEnc: { v: 1, alg: "AES-256-GCM", kid: "k1", wiv: "", wdek: "", wtag: "", iv: "", ct: "", tag: "" }, metadata: { chat_id: "-1001" } });
    return id;
  }

  it("rejects DISCORD with a pointer to TELEGRAM", async () => {
    expect(await issues({ ...bigBuys, conditions: undefined })).toEqual(["actions.0.type: DISCORD is not available yet (use TELEGRAM)"]);
  });

  it("checks connections belong to the owner and match the action", async () => {
    const owner = await ensureUser(h.db, addr(0xc1));
    const stranger = await ensureUser(h.db, addr(0xc2));
    const mine = await telegramConnection(owner);
    const theirs = await telegramConnection(stranger);
    expect(await issues(telegramDef("hi", mine), owner)).toEqual([]);
    expect(await issues(telegramDef("hi", theirs), owner)).toEqual([`actions.0.params.connection_id: connection ${theirs} not found`]);
  });

  it("validates template variables against the trigger's fields and earlier steps", async () => {
    const owner = await ensureUser(h.db, addr(0xc3));
    const conn = await telegramConnection(owner);
    expect(await issues(telegramDef("{{trigger.amout}}", conn), owner)).toEqual(['actions.0.params.text: unknown variable "trigger.amout"']);
    expect((await issues(telegramDef("<b>{{trigger.amount_formatted}}</b> <div>", conn), owner))[0]).toMatch(/^actions\.0\.params\.text: <div> is not supported/);
    const chained = {
      trigger: { type: "TOKEN_TRANSFER", params: { token: TOKEN } },
      actions: [
        { step_id: "notify", type: "TELEGRAM", params: { connection_id: conn, text: "{{trigger.amount_formatted}} {{trigger.token.symbol}}" } },
        { step_id: "push", type: "WEB_PUSH", params: { title: "msg {{steps.notify.message_id}}", body: "{{steps.nope.x}}" } },
      ],
    };
    expect(await issues(chained, owner)).toEqual(['actions.1.params.body: "steps.nope.x": steps can only reference an earlier step\'s output']);
  });

  it("stores action params with their defaults applied", async () => {
    const owner = await ensureUser(h.db, addr(0xc4));
    const conn = await telegramConnection(owner);
    const def = await validateFlowDefinition(telegramDef("hi", conn), { ...withActions(), db: h.db }, owner);
    expect(def.actions[0]?.params).toEqual({ connection_id: conn, text: "hi", parse_mode: "html", disable_link_preview: true, silent: false });
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
