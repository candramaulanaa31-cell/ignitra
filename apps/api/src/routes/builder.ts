import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Abi } from "viem";
import { BUILTIN_TEMPLATE_VARIABLES, conditionsSchema, explorerAddressUrl, isValidAddress, normalizeAddress, toChecksumAddress, type FieldSpec } from "@ignitra/core";
import { BUILTIN_ABIS, formatEventFragment, formatFunctionFragment } from "@ignitra/chain";
import { FlowValidationError, TestRunLimitError, getCurrentDefinition, queueTestRun, sampleTrigger, type TriggerRuntime } from "@ignitra/engine";
import { caller } from "../auth";
import type { ApiContext } from "../context";
import { ApiError, RateLimiter, enforceRate, parse } from "../http";
import { runView } from "../views";

/**
 * Builder support (authenticated):
 *   GET  /v1/chain/addresses/:address   contract / token auto-detection on paste
 *   POST /v1/samples                    live sample for a trigger (real data, never invented)
 *   POST /v1/catalog/fields             variables for the picker: trigger fields + earlier steps' outputs
 *   POST /v1/flows/:id/test             "Test flow": a TEST run with a sample
 */

const triggerInput = z.object({ type: z.string().min(1).max(40), params: z.record(z.string(), z.unknown()).default({}) }).strict();

const sampleBody = z
  .object({
    trigger: triggerInput,
    conditions: z.unknown().optional(),
    flow_id: z.string().max(40).optional(),
    /** INBOUND_WEBHOOK: a pasted example body. */
    body: z.unknown().optional(),
  })
  .strict();

const fieldsBody = z
  .object({
    trigger: triggerInput,
    actions: z.array(z.object({ step_id: z.string().max(40), type: z.string().max(40), params: z.record(z.string(), z.unknown()).default({}) })).max(10).default([]),
  })
  .strict();

const testBody = z.object({ sample: z.record(z.string(), z.unknown()).optional() }).strict();

/** Event and view-function fragments of an ABI, for the builder's pickers. */
function abiSummary(abi: Abi) {
  const events = new Set<string>();
  const functions = new Set<string>();
  for (const item of abi) {
    try {
      if (item.type === "event" && !item.anonymous) events.add(formatEventFragment(item));
      if (item.type === "function" && (item.stateMutability === "view" || item.stateMutability === "pure") && item.outputs.length > 0) functions.add(formatFunctionFragment(item));
    } catch {
      // malformed explorer ABI item: skip it
    }
  }
  return { events: [...events].slice(0, 200), functions: [...functions].slice(0, 200) };
}

export function registerBuilderRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const chainLimiter = new RateLimiter(60, 60_000, ctx.now);
  const rt = (): TriggerRuntime => {
    if (!ctx.reader || !ctx.tokens) throw new ApiError(503, "not_configured", "chain access is not configured on this server");
    return { chain: ctx.chain, reader: ctx.reader, tokens: ctx.tokens, logger: ctx.logger };
  };
  const confirmedHead = async (): Promise<number> => {
    try {
      return Math.max(0, (await rt().reader.blockNumber()) - ctx.confirmationDepth);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(503, "chain_unavailable", "the chain RPC did not answer; try again");
    }
  };

  /** Normalizes trigger params exactly like a save would (prepare included). */
  async function prepared(type: string, params: Record<string, unknown>) {
    const module = ctx.triggers.has(type) ? ctx.triggers.get(type) : undefined;
    if (!module) throw new FlowValidationError([{ path: "trigger.type", message: `${type} is not available` }]);
    const parsed = module.paramsSchema.safeParse(params);
    if (!parsed.success) {
      throw new FlowValidationError(parsed.error.issues.map((i) => ({ path: ["trigger", "params", ...i.path.map(String)].join("."), message: i.message })));
    }
    let value: unknown = parsed.data;
    if (module.prepare) {
      try {
        value = await module.prepare(parsed.data, ctx.flowDeps.prepare);
      } catch (err) {
        throw new FlowValidationError([{ path: "trigger.params", message: (err as Error).message }]);
      }
    }
    return { module, params: value };
  }

  app.get<{ Params: { address: string } }>("/v1/chain/addresses/:address", async (req, reply) => {
    const me = caller(req);
    enforceRate(chainLimiter, me.userId, reply, "chain lookups");
    if (!isValidAddress(req.params.address)) throw new ApiError(400, "invalid_address", "not a valid address (0x + 40 hex; mixed case must match its checksum)");
    const address = normalizeAddress(req.params.address);
    const runtime = rt();
    let code: `0x${string}`;
    try {
      code = await runtime.reader.getCode(address);
    } catch {
      throw new ApiError(503, "chain_unavailable", "the chain RPC did not answer; try again");
    }
    const base = { address, checksum: toChecksumAddress(address), explorer_url: explorerAddressUrl(ctx.chain, address) };
    if (code === "0x") {
      let balance: string | null = null;
      try {
        balance = (await runtime.reader.getBalance(address)).toString();
      } catch {
        balance = null;
      }
      return { data: { ...base, kind: "wallet", is_contract: false, balance_wei: balance, token: null, abi: null } };
    }
    const meta = await runtime.tokens.meta(address).catch(() => null);
    const supply = meta?.decimals !== null && meta?.decimals !== undefined ? await runtime.tokens.totalSupply(address).catch(() => null) : null;
    const isToken = Boolean(meta && meta.symbol && meta.decimals !== null && supply !== null);
    const stored = ctx.abis ? await ctx.abis.refresh(address).catch(() => null) : null;
    const verified = stored?.status === "verified" && stored.abi ? abiSummary(stored.abi) : null;
    const builtin = isToken ? abiSummary(BUILTIN_ABIS.erc20) : null;
    return {
      data: {
        ...base,
        kind: isToken ? "token" : "contract",
        is_contract: true,
        code_bytes: (code.length - 2) / 2,
        token: isToken && meta ? { symbol: meta.symbol, name: meta.name, decimals: meta.decimals, total_supply: supply?.toString() ?? null } : null,
        abi: {
          status: stored?.status ?? "unknown",
          source: stored?.source ?? null,
          implementation: stored?.implementation ?? null,
          events: [...new Set([...(verified?.events ?? []), ...(builtin?.events ?? [])])],
          functions: [...new Set([...(verified?.functions ?? []), ...(builtin?.functions ?? [])])],
        },
      },
    };
  });

  app.post("/v1/samples", async (req, reply) => {
    const me = caller(req);
    enforceRate(chainLimiter, me.userId, reply, "sample lookups");
    const body = parse(sampleBody, req.body);
    const { module, params } = await prepared(body.trigger.type, body.trigger.params);
    const conditions = body.conditions === undefined ? undefined : conditionsSchema.safeParse(body.conditions);
    if (conditions && !conditions.success) throw new ApiError(400, "invalid_request", "conditions are invalid");
    if (body.flow_id) {
      const owner = await getCurrentDefinition(ctx.db, body.flow_id).catch(() => null);
      if (!owner || owner.ownerId !== me.userId) throw new ApiError(404, "not_found", "flow not found");
    }
    const needsChain = module.kind === "log" || module.kind === "poll";
    const sample = await sampleTrigger(module, params, {
      rt: needsChain ? rt() : null,
      head: needsChain ? await confirmedHead() : 0,
      conditions: conditions?.data,
      db: ctx.db,
      flowId: body.flow_id,
      ...(body.body !== undefined ? { body: body.body } : {}),
    }).catch((err: unknown) => {
      if (err instanceof ApiError) throw err;
      ctx.logger.warn({ err, type: module.type }, "sample lookup failed");
      throw new ApiError(503, "chain_unavailable", "could not read the chain for a sample; try again");
    });
    if (!sample) {
      const hint =
        module.kind === "inbound"
          ? "no request yet: POST something to the hook URL, or paste a sample body"
          : module.kind === "log"
            ? "no matching event in the last ~2.8 hours (≈100k blocks)"
            : "nothing to sample yet";
      return { data: null, hint };
    }
    return {
      data: {
        kind: sample.kind,
        note: sample.note,
        payload: sample.payload,
        conditions: sample.conditions ?? null,
        scanned_blocks: sample.scannedBlocks ?? null,
      },
    };
  });

  app.post("/v1/catalog/fields", async (req) => {
    caller(req);
    const body = parse(fieldsBody, req.body);
    const module = ctx.triggers.has(body.trigger.type) ? ctx.triggers.get(body.trigger.type) : undefined;
    let trigger: readonly FieldSpec[] = [];
    if (module) {
      const parsed = module.paramsSchema.safeParse(body.trigger.params);
      try {
        // Without network access to ABIs: full signatures give typed args, bare names give the generic fields.
        trigger = module.fields(parsed.success ? parsed.data : ({} as never));
      } catch {
        trigger = [];
      }
    }
    const steps: Record<string, readonly FieldSpec[]> = {};
    for (const step of body.actions) {
      const action = ctx.actions.has(step.type) ? ctx.actions.get(step.type) : undefined;
      if (!action) continue;
      const parsed = action.paramsSchema.safeParse(step.params);
      steps[step.step_id] = parsed.success && action.outputFieldsFor ? action.outputFieldsFor(parsed.data) : action.outputFields;
    }
    return { data: { trigger, steps, builtins: BUILTIN_TEMPLATE_VARIABLES } };
  });

  app.post<{ Params: { id: string } }>("/v1/flows/:id/test", async (req, reply) => {
    const me = caller(req);
    const body = parse(testBody, req.body);
    const current = await getCurrentDefinition(ctx.db, req.params.id).catch(() => null);
    if (!current || current.ownerId !== me.userId) throw new ApiError(404, "not_found", "flow not found");
    let payload = body.sample;
    let sampleInfo: { kind: string; note: string } = { kind: "custom", note: "sample you provided" };
    if (payload) {
      if (Buffer.byteLength(JSON.stringify(payload)) > 32 * 1024) throw new ApiError(413, "sample_too_large", "the sample must be at most 32 KB");
    } else {
      const module = ctx.triggers.require(current.definition.trigger.type);
      const needsChain = module.kind === "log" || module.kind === "poll";
      const sample = await sampleTrigger(module, current.definition.trigger.params, {
        rt: needsChain ? rt() : null,
        head: needsChain ? await confirmedHead() : 0,
        conditions: current.definition.conditions,
        db: ctx.db,
        flowId: req.params.id,
      }).catch((err: unknown) => {
        ctx.logger.warn({ err }, "test sample lookup failed");
        throw new ApiError(503, "chain_unavailable", "could not read the chain for a sample; try again");
      });
      if (!sample) throw new ApiError(409, "no_sample", "no recent real event to test with; pass a sample (POST /v1/samples shows what one looks like)");
      payload = sample.payload as Record<string, unknown>;
      sampleInfo = { kind: sample.kind, note: sample.note };
    }
    try {
      const { run, conditionsPassed } = await queueTestRun(ctx.db, { flowId: req.params.id, ownerId: me.userId, payload });
      ctx.onRunQueued();
      ctx.logger.info({ runId: run.id, flowId: req.params.id }, "test run queued");
      return reply.code(202).send({ data: { run: runView(run), conditions_passed: conditionsPassed, sample: sampleInfo } });
    } catch (err) {
      if (err instanceof TestRunLimitError) throw new ApiError(429, "test_limit", err.message);
      throw err;
    }
  });
}
