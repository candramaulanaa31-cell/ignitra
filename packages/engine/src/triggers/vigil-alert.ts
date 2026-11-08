import { z } from "zod";
import { CHAIN_EVIDENCE_FIELDS, normalizeAddress, type FieldSpec } from "@ignitra/core";
import type { JsonValue } from "@ignitra/chain";
import { TRUST_ROLES, trustFields } from "../enrich/trust";
import { timeFields } from "../evidence";
import { addressParam } from "../params";
import type { InboundTriggerModule } from "../types";

/**
 * VIGIL_ALERT — an alert from VIGIL, contract monitoring for Robinhood Chain (Phase 8).
 *
 * VIGIL delivers its alerts as signed webhooks (`x-vigil-signature: sha256=HMAC(secret,
 * "<timestamp>.<raw body>")`) to the connection's receiver URL, which stores one inbound
 * event per flow that listens to that connection. Event types: `alert.created`,
 * `alert.confirmed` (a pending finding reached confirmation) and `alert.retracted` (a reorg
 * removed it). Alerts state facts with evidence (tx hash, block, actor, before / after).
 *
 * Stages:
 *   confirmed (default) — run once per alert, when its finding is confirmed (reorg-safe)
 *   pending             — run once per alert, as soon as VIGIL sees it (0 confirmations)
 * Retractions start a run only with `include_retracted` (to undo what a pending run did).
 */

export const VIGIL_SEVERITIES = ["low", "medium", "high", "critical"] as const;
type Severity = (typeof VIGIL_SEVERITIES)[number];
const RANK: Readonly<Record<Severity, number>> = { low: 1, medium: 2, high: 3, critical: 4 };

export const vigilAlertParams = z
  .object({
    connection_id: z.string().regex(/^conn_[0-9a-z]{26}$/, { message: "pick a VIGIL connection" }),
    stage: z.enum(["confirmed", "pending"]).default("confirmed"),
    min_severity: z.enum(VIGIL_SEVERITIES).default("low"),
    /** Only these VIGIL rules, e.g. PROXY_UPGRADE_V1. */
    rules: z.array(z.string().regex(/^[A-Z0-9_]{3,64}$/, { message: "a VIGIL rule id such as PROXY_UPGRADE_V1" })).min(1).max(50).optional(),
    /** Only alerts about these contracts. */
    contracts: z.array(addressParam).min(1).max(100).optional(),
    include_retracted: z.boolean().default(false),
  })
  .strict();
export type VigilAlertParams = z.output<typeof vigilAlertParams>;

const FIELDS: readonly FieldSpec[] = [
  { path: "event", type: "string", description: "alert.created · alert.confirmed · alert.retracted" },
  { path: "alert_id", type: "string", description: "VIGIL alert id" },
  { path: "finding_id", type: "string", description: "VIGIL finding id (the public chain fact)" },
  { path: "rule_id", type: "string", description: "The VIGIL rule, e.g. PROXY_UPGRADE_V1" },
  { path: "severity", type: "string", description: "low · medium · high · critical" },
  { path: "status", type: "string", description: "pending · confirmed · retracted" },
  { path: "title", type: "string", description: "Alert title" },
  { path: "summary", type: "string", description: "What changed, stated as a fact" },
  { path: "contract", type: "address", description: "The contract the alert is about" },
  { path: "label", type: "string", description: "Your VIGIL watch label", nullable: true },
  { path: "tx_hash", type: "hash", description: "Transaction that made the change" },
  { path: "block_number", type: "uint", description: "Block of the change" },
  { path: "actor", type: "address", description: "Who sent the transaction" },
  { path: "counterparty", type: "address", description: "The actor (for TRUST LAYER scores)" },
  { path: "before", type: "string", description: "Value before the change (rule-specific)", nullable: true },
  { path: "after", type: "string", description: "Value after the change (rule-specific)", nullable: true },
  { path: "evidence", type: "object", description: "VIGIL's full evidence object" },
  { path: "explorer_url", type: "string", description: "Explorer link for the transaction", nullable: true },
  { path: "delivery_id", type: "string", description: "VIGIL delivery id" },
  ...CHAIN_EVIDENCE_FIELDS.filter((f) => f.path.startsWith("time.")),
  ...trustFields(TRUST_ROLES.VIGIL_ALERT ?? []),
];

interface VigilAlertBody {
  type: "alert.created" | "alert.confirmed" | "alert.retracted";
  delivery_id: string;
  sent_at?: string;
  alert: {
    alert_id: string;
    finding_id: string;
    chain_id?: number;
    rule_id: string;
    severity: Severity;
    status: "pending" | "confirmed" | "retracted";
    title: string;
    summary: string;
    contract: string;
    label?: string | null;
    block_timestamp?: string;
    evidence: { tx_hash: string; block_number: number; actor: string; before?: unknown; after?: unknown; [k: string]: unknown };
  };
}

const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

function readAlert(body: unknown): VigilAlertBody | null {
  const b = body as Partial<VigilAlertBody> | null;
  if (!b || typeof b !== "object" || (b.type !== "alert.created" && b.type !== "alert.confirmed" && b.type !== "alert.retracted")) return null;
  const a = b.alert;
  if (!a || typeof a.alert_id !== "string" || typeof a.rule_id !== "string" || !(a.severity in RANK) || !isAddress(a.contract)) return null;
  if (!a.evidence || typeof a.evidence.tx_hash !== "string" || typeof a.evidence.block_number !== "number") return null;
  return b as VigilAlertBody;
}

const scalar = (v: unknown): string | null => (v === undefined || v === null ? null : typeof v === "string" ? v : JSON.stringify(v));

export const vigilAlertTrigger: InboundTriggerModule<VigilAlertParams> = {
  type: "VIGIL_ALERT",
  kind: "inbound",
  label: "VIGIL alert",
  description: "An alert from VIGIL contract monitoring: ownership, upgrades, roles, pauses, supply, large transfers.",
  source: "inbound",
  supportsFast: false,
  connectionType: "vigil",
  paramsSchema: vigilAlertParams,
  fields: () => FIELDS,

  match(event, p) {
    const body = readAlert(event.body);
    if (!body) return null; // pings and event types IGNITRA does not know
    const a = body.alert;
    const contract = normalizeAddress(a.contract);
    if (RANK[a.severity] < RANK[p.min_severity]) return null;
    if (p.rules && !p.rules.includes(a.rule_id)) return null;
    if (p.contracts && !p.contracts.includes(contract)) return null;
    let stage: string;
    if (body.type === "alert.retracted") {
      if (!p.include_retracted) return null;
      stage = "retracted";
    } else if (p.stage === "pending") {
      stage = "seen"; // the first event of the alert, whatever its status
    } else {
      if (a.status !== "confirmed") return null;
      stage = "confirmed";
    }
    const tx = a.evidence.tx_hash.toLowerCase();
    const actor = isAddress(a.evidence.actor) ? normalizeAddress(a.evidence.actor) : null;
    const seconds = a.block_timestamp ? Math.floor(Date.parse(a.block_timestamp) / 1000) : Math.floor(event.receivedAt.getTime() / 1000);
    return {
      kind: "match",
      key: `vigil:${a.alert_id}:${stage}`,
      payload: {
        event: body.type,
        delivery_id: body.delivery_id,
        alert_id: a.alert_id,
        finding_id: a.finding_id,
        rule_id: a.rule_id,
        severity: a.severity,
        status: a.status,
        title: a.title,
        summary: a.summary,
        contract,
        label: a.label ?? null,
        tx_hash: tx,
        block_number: a.evidence.block_number,
        actor,
        counterparty: actor,
        before: scalar(a.evidence.before),
        after: scalar(a.evidence.after),
        evidence: a.evidence as JsonValue,
        explorer_url: (a.chain_id ?? 4663) === 4663 ? `https://robinhoodchain.blockscout.com/tx/${tx}` : null,
        time: timeFields(Number.isFinite(seconds) ? seconds : Math.floor(event.receivedAt.getTime() / 1000)),
      },
    };
  },
};
