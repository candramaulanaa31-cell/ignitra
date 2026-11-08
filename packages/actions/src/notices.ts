import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { ActionRegistry, FlowDefinition, SafeHttpClient } from "@ignitra/core";
import type { Keyring } from "@ignitra/core/server";
import { flowVersions, flows, ownerNotifications, runSteps, runs, type Database } from "@ignitra/db";
import { deliverWebhook, resolveWebhookTarget, webhookParams } from "./actions/webhook";
import { loadConnection } from "./connections";
import { expireGrants } from "./onchain/grants";
import type { WebPushSender } from "./push";
import { deriveOwnerSigningSecret } from "./signing";

/**
 * Background notices:
 *  - `run.reverted`: a fast-mode run delivered webhooks, then its event was
 *    reorged out → each delivered webhook receives a signed `run.reverted`
 *    (principle 2.3). Best-effort, one attempt, outcome recorded on the run.
 *  - owner notifications (auto-pause, …) → Web Push to the owner's devices.
 */
export class Notifier {
  readonly #db: Database;
  readonly #keyring: Keyring | null;
  readonly #http: SafeHttpClient;
  readonly #push: WebPushSender | null;
  readonly #webhookMaster: string | null;
  readonly #log: Logger;

  constructor(deps: { db: Database; keyring: Keyring | null; http: SafeHttpClient; push: WebPushSender | null; webhookMaster: string | null; actions: ActionRegistry; logger: Logger }) {
    this.#db = deps.db;
    this.#keyring = deps.keyring;
    this.#http = deps.http;
    this.#push = deps.push;
    this.#webhookMaster = deps.webhookMaster;
    this.#log = deps.logger;
  }

  /** Grants past their expiry: status expired, session key wiped. */
  async expireOnchainGrants(): Promise<number> {
    return expireGrants(this.#db, new Date());
  }

  async revertNotices(limit = 20): Promise<number> {
    const candidates = await this.#db
      .select({ run: runs, ownerId: flows.ownerId, definition: flowVersions.definition })
      .from(runs)
      .innerJoin(flows, eq(flows.id, runs.flowId))
      .innerJoin(flowVersions, and(eq(flowVersions.flowId, runs.flowId), eq(flowVersions.version, runs.flowVersion)))
      .where(and(isNotNull(runs.revertedAt), isNull(runs.revertNotice), inArray(runs.status, ["succeeded", "partial"])))
      .orderBy(asc(runs.revertedAt))
      .limit(limit);
    for (const { run, ownerId, definition } of candidates) {
      const delivered = new Set(
        (await this.#db.select().from(runSteps).where(and(eq(runSteps.runId, run.id), eq(runSteps.status, "succeeded")))).map((s) => s.stepId),
      );
      const deliveries: Array<Record<string, unknown>> = [];
      for (const step of (definition as FlowDefinition).actions) {
        if (step.type !== "WEBHOOK" || !delivered.has(step.step_id)) continue;
        const params = webhookParams.safeParse(step.params);
        if (!params.success) continue;
        let connection = null;
        if (params.data.connection_id && this.#keyring) connection = await loadConnection(this.#db, this.#keyring, params.data.connection_id);
        const target = resolveWebhookTarget(params.data, {
          connection,
          ownerSigningSecret: this.#webhookMaster ? deriveOwnerSigningSecret(this.#webhookMaster, ownerId) : null,
        });
        if (typeof target === "string") {
          deliveries.push({ step_id: step.step_id, status: "failed", error: target });
          continue;
        }
        const key = `${run.idempotencyKey}:${step.step_id}`;
        const result = await deliverWebhook(this.#http, target, "run.reverted", `${key}:reverted`, {
          type: "run.reverted",
          run_id: run.id,
          flow_id: run.flowId,
          step_id: step.step_id,
          idempotency_key: key,
          reason: run.revertReason,
          reverted_at: run.revertedAt?.toISOString() ?? null,
          trigger: { tx_hash: run.triggerEvent.tx_hash ?? null, block_number: run.triggerEvent.block_number ?? null },
          sent_at: new Date().toISOString(),
        });
        deliveries.push({
          step_id: step.step_id,
          status: result.status,
          ...("httpStatus" in result && result.httpStatus !== undefined ? { http_status: result.httpStatus } : {}),
          ...(result.status === "failed" ? { error: result.error } : {}),
        });
      }
      await this.#db.update(runs).set({ revertNotice: { sent_at: new Date().toISOString(), deliveries } }).where(eq(runs.id, run.id));
      if (deliveries.length > 0) this.#log.info({ runId: run.id, deliveries }, "run.reverted notices sent");
    }
    return candidates.length;
  }

  async ownerNotifications(limit = 20): Promise<number> {
    const pending = await this.#db.select().from(ownerNotifications).where(isNull(ownerNotifications.pushedAt)).orderBy(asc(ownerNotifications.createdAt)).limit(limit);
    for (const n of pending) {
      if (this.#push) {
        try {
          await this.#push.sendToUser(n.userId, { title: "IGNITRA", body: n.message, tag: `${n.kind}:${n.flowId ?? ""}` });
        } catch (err) {
          this.#log.warn({ err, notification: n.id }, "owner notification push failed");
        }
      }
      // Recorded either way: the inbox shows it; push is a courtesy.
      await this.#db.update(ownerNotifications).set({ pushedAt: sql`now()` }).where(eq(ownerNotifications.id, n.id));
    }
    return pending.length;
  }
}
