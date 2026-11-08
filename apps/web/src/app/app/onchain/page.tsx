"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useSession } from "@/components/session";
import { GrantPermissions, SafeApprovalPanel } from "@/components/onchain";
import { Badge, Empty, Field, Hex, Notice, Spinner, useToast } from "@/components/ui";
import { ApiError, api, errorText, useApi } from "@/lib/api";
import { ago, when } from "@/lib/format";
import type { Connection, Grant, Issue, PermissionReview, SafeApproval } from "@/lib/types";

interface FnDraft {
  signature: string;
  capped: boolean;
  /** Which argument holds the amount, counted from 1 as people do (the API counts from 0). */
  amount_arg: string;
  max_amount_per_tx: string;
  max_amount_per_day: string;
}
interface TargetDraft {
  address: string;
  functions: FnDraft[];
}

const blankFn = (): FnDraft => ({ signature: "", capped: false, amount_arg: "2", max_amount_per_tx: "", max_amount_per_day: "" });
const blankTarget = (): TargetDraft => ({ address: "", functions: [blankFn()] });
/** ERC-20 functions that move tokens must cap their amount: which argument holds it (from 0). */
const MOVERS: Readonly<Record<string, number>> = { transfer: 1, approve: 1, transferFrom: 2, increaseAllowance: 1 };
const moverArg = (signature: string): number | null => MOVERS[signature.trim().replace(/^function\s+/, "").split("(")[0] ?? ""] ?? null;

/** datetime-local value (local time), a week from now. */
function inAWeek(): string {
  const d = new Date(Date.now() + 7 * 86_400_000);
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function NewGrant({ mandates }: { mandates: Connection[] }) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [safe, setSafe] = useState("");
  const [targets, setTargets] = useState<TargetDraft[]>([blankTarget()]);
  const [perTx, setPerTx] = useState("0");
  const [perDay, setPerDay] = useState("0");
  const [expires, setExpires] = useState(inAWeek);
  const [mandate, setMandate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);

  const setTarget = (i: number, patch: Partial<TargetDraft>) => setTargets((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const setFn = (i: number, k: number, patch: Partial<FnDraft>) =>
    setTargets((ts) => ts.map((t, j) => (j === i ? { ...t, functions: t.functions.map((f, m) => (m === k ? { ...f, ...patch } : f)) } : t)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setIssues([]);
    try {
      const body = {
        label: label.trim(),
        safe: safe.trim(),
        targets: targets.map((t) => ({
          address: t.address.trim(),
          functions: t.functions.map((f) => ({
            signature: f.signature.trim(),
            ...(f.capped ? { amount_arg: Math.max(0, Number(f.amount_arg) - 1), max_amount_per_tx: f.max_amount_per_tx.trim(), max_amount_per_day: f.max_amount_per_day.trim() } : {}),
          })),
        })),
        max_value_per_tx: perTx.trim() || "0",
        max_value_per_day: perDay.trim() || "0",
        expires_at: new Date(expires).toISOString(),
        ...(mandate ? { mandate_connection_id: mandate } : {}),
      };
      const res = await api<{ data: Grant }>("/v1/onchain/grants", { body });
      router.push(`/app/onchain/${res.data.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : errorText(err));
      if (err instanceof ApiError) setIssues(err.issues);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={(e) => void submit(e)}>
      <div className="card-head">
        <span className="label">New grant</span>
        <span className="small muted">nothing happens on chain until your Safe approves it</span>
      </div>
      <div className="card-body stack">
        <div className="grid2">
          <Field name="Name" help="For you, e.g. Treasury top-ups">
            <input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field name="Safe" help="A Safe on Robinhood Chain that you own (1-of-N owners can approve from their wallet).">
            <input className="mono" placeholder="0x… Safe address" value={safe} onChange={(e) => setSafe(e.target.value.trim())} spellCheck={false} />
          </Field>
        </div>

        <div className="stack" style={{ gap: 10 }}>
          <span className="small muted">
            Contracts and functions the session key may call, nothing else. Never the Safe itself or its modules. Functions that move tokens must cap their amount (in the token&apos;s base units).
          </span>
          {targets.map((t, i) => (
            <div key={i} className="card" style={{ background: "transparent" }}>
              <div className="card-body stack" style={{ gap: 8 }}>
                <div className="row">
                  <input className="mono grow" placeholder="0x… contract" value={t.address} onChange={(e) => setTarget(i, { address: e.target.value.trim() })} spellCheck={false} />
                  <button type="button" className="btn sm ghost danger" disabled={targets.length === 1} onClick={() => setTargets((ts) => ts.filter((_, j) => j !== i))}>
                    Remove contract
                  </button>
                </div>
                {t.functions.map((f, k) => (
                  <div key={k} className="stack" style={{ gap: 6, paddingLeft: 12, borderLeft: "2px solid var(--line, #333)" }}>
                    <div className="row">
                      <input
                        className="mono grow"
                        placeholder="transfer(address to, uint256 amount)"
                        value={f.signature}
                        onChange={(e) => {
                          const signature = e.target.value;
                          const arg = moverArg(signature);
                          setFn(i, k, arg === null ? { signature } : { signature, capped: true, amount_arg: String(arg + 1) });
                        }}
                        spellCheck={false}
                      />
                      <button type="button" className="btn sm ghost" disabled={t.functions.length === 1} onClick={() => setTarget(i, { functions: t.functions.filter((_, m) => m !== k) })} aria-label="Remove function">
                        ×
                      </button>
                    </div>
                    <label className="check small">
                      <input type="checkbox" checked={f.capped} disabled={moverArg(f.signature) !== null} onChange={(e) => setFn(i, k, { capped: e.target.checked })} />
                      Cap an amount argument
                    </label>
                    {f.capped ? (
                      <div className="grid3">
                        <Field name="Amount is argument #" help="1 = the first argument">
                          <input className="mono" inputMode="numeric" value={f.amount_arg} onChange={(e) => setFn(i, k, { amount_arg: e.target.value.replace(/\D/g, "") })} />
                        </Field>
                        <Field name="Max per call" help="Base units">
                          <input className="mono" inputMode="numeric" value={f.max_amount_per_tx} onChange={(e) => setFn(i, k, { max_amount_per_tx: e.target.value.replace(/\D/g, "") })} />
                        </Field>
                        <Field name="Max per day" help="Base units">
                          <input className="mono" inputMode="numeric" value={f.max_amount_per_day} onChange={(e) => setFn(i, k, { max_amount_per_day: e.target.value.replace(/\D/g, "") })} />
                        </Field>
                      </div>
                    ) : null}
                  </div>
                ))}
                <div>
                  <button type="button" className="btn sm" onClick={() => setTarget(i, { functions: [...t.functions, blankFn()] })}>
                    + Function
                  </button>
                </div>
              </div>
            </div>
          ))}
          <div>
            <button type="button" className="btn sm" onClick={() => setTargets((ts) => [...ts, blankTarget()])} disabled={targets.length >= 10}>
              + Contract
            </button>
          </div>
        </div>

        <div className="grid2">
          <Field name="ETH per call" help="0 = sends no ETH">
            <input className="mono" inputMode="decimal" value={perTx} onChange={(e) => setPerTx(e.target.value.trim())} />
          </Field>
          <Field name="ETH per day" help="At least the per-call amount">
            <input className="mono" inputMode="decimal" value={perDay} onChange={(e) => setPerDay(e.target.value.trim())} />
          </Field>
          <Field name="Expires" help="Between 10 minutes and 90 days; enforced on chain">
            <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
          <Field name="MANDATE policy" help="Asked before every transaction; it must allow it (fail-closed)">
            <select value={mandate} onChange={(e) => setMandate(e.target.value)}>
              <option value="">{mandates.length === 0 ? "None (add one in Connections)" : "None"}</option>
              {mandates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {error ? (
          <Notice kind="error">
            {error}
            {issues.length > 0 ? (
              <ul>
                {issues.map((i) => (
                  <li key={`${i.path}:${i.message}`}>
                    <span className="mono">{i.path}</span>: {i.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </Notice>
        ) : null}
        <div>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "Checking the Safe…" : "Create and get the Safe transaction"}
          </button>
        </div>
      </div>
    </form>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Permission review: every grant that can still act, what it may do, which flows use it, and what
 * to fix. "Revoke all" is the emergency stop: every session key is deleted at once.
 */
function PermissionReviewPanel({ connections, onChange }: { connections: Connection[]; onChange: () => void }) {
  const { me } = useSession();
  const [toast, notify] = useToast();
  const review = useApi<{ data: PermissionReview }>("/v1/onchain/review");
  const [busy, setBusy] = useState(false);
  const [removals, setRemovals] = useState<Array<SafeApproval & { safe: string; grant_ids: string[] }>>([]);
  const r = review.data?.data;

  const revokeAll = async () => {
    if (!r) return;
    const flowsNote = r.summary.flows_using > 0 ? ` ${plural(r.summary.flows_using, "flow")} using them will fail their onchain steps until you pick a new grant.` : "";
    if (!window.confirm(`Revoke all ${plural(r.summary.live, "grant")} now? IGNITRA deletes every session key at once.${flowsNote}`)) return;
    setBusy(true);
    try {
      const res = await api<{ data: { revoked: Grant[]; affected_flows: number }; onchain: Array<SafeApproval & { safe: string; grant_ids: string[] }> }>("/v1/onchain/grants/revoke-all", { method: "POST" });
      setRemovals(res.onchain);
      notify(`Revoked ${plural(res.data.revoked.length, "grant")}. No session key exists anymore.`);
      await review.reload();
      onChange();
    } catch (err) {
      notify(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  if (review.error) return <Notice kind="error">{review.error.message}</Notice>;
  if (!r) return null;
  const mandateOf = (id: string | null) => connections.find((c) => c.id === id) ?? null;

  return (
    <>
      {toast}
      {removals.length > 0 ? (
        <section className="card">
          <div className="card-head">
            <span className="label">Also remove the roles from your Safes</span>
            <span className="small muted">optional: the keys are already gone</span>
          </div>
          <div className="card-body stack">
            {removals.map((a) => (
              <div key={a.safe} className="stack" style={{ gap: 6 }}>
                <span className="small">
                  Safe <Hex value={a.safe} kind="address" /> · {plural(a.grant_ids.length, "grant")}
                </span>
                <SafeApprovalPanel approval={a} name={`ignitra-revoke-all-${a.safe.slice(2, 10)}`} />
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {r.summary.live === 0 ? null : (
        <section className="card">
          <div className="card-head">
            <span className="label">Permission review</span>
            <span className="small muted">
              {plural(r.summary.live, "grant")} can act ({r.summary.active} active, {r.summary.pending} pending) · used by {plural(r.summary.flows_using, "flow")}
              {r.summary.warnings > 0 ? <span className="failc"> · {plural(r.summary.warnings, "warning")}</span> : null}
            </span>
            <button type="button" className="btn sm danger" disabled={busy} onClick={() => void revokeAll()}>
              {busy ? "Revoking…" : "Revoke all"}
            </button>
          </div>
          <div className="card-body stack">
            {r.grants.map((g) => {
              const warns = g.findings.filter((f) => f.level === "warn");
              const infos = g.findings.filter((f) => f.level === "info");
              const recent = Object.entries(g.actions_7d);
              return (
                <div key={g.id} className="stack" style={{ gap: 6, paddingBottom: 12, borderBottom: "1px solid var(--line, #333)" }}>
                  <div className="row">
                    <Link href={`/app/onchain/${g.id}`}>{g.label}</Link>
                    <Badge status={g.status} text={g.status} />
                    <span className="small muted">
                      Safe <Hex value={g.safe} kind="address" /> · expires {when(g.expires_at, me.timezone).slice(0, 16)} · last transaction {g.last_action_at ? ago(g.last_action_at, Date.now(), me.timezone) : "never"}
                    </span>
                  </div>
                  {warns.map((f) => (
                    <Notice key={f.code} kind="warn">
                      {f.message}
                    </Notice>
                  ))}
                  {infos.length > 0 ? (
                    <ul className="small muted" style={{ margin: 0, paddingLeft: 20 }}>
                      {infos.map((f) => (
                        <li key={f.code}>{f.message}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="small">
                    Used by:{" "}
                    {g.used_by.length === 0 ? (
                      <span className="muted">no flow</span>
                    ) : (
                      g.used_by.map((f, i) => (
                        <span key={f.flow_id}>
                          {i > 0 ? ", " : ""}
                          <Link href={`/app/flows/${f.flow_id}`}>{f.name}</Link> <span className="muted">({f.status})</span>
                        </span>
                      ))
                    )}
                    {recent.length > 0 ? <span className="muted"> · last 7 days: {recent.map(([s, n]) => `${n} ${s}`).join(", ")}</span> : null}
                  </div>
                  <details>
                    <summary className="small">What it allows</summary>
                    <div style={{ paddingTop: 8 }}>
                      <GrantPermissions g={g} mandate={mandateOf(g.mandate_connection_id)} />
                    </div>
                  </details>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

export default function OnchainPage() {
  const { me } = useSession();
  const grants = useApi<{ data: Grant[] }>("/v1/onchain/grants");
  const connections = useApi<{ data: Connection[] }>("/v1/connections");
  const team = me.plan === "team";

  return (
    <main className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Onchain</h1>
          <div className="sub">
            Scoped, revocable permissions from your Safe. IGNITRA never holds your keys: it gets its own session key, which can call only what your Safe allows, within its limits, until you revoke it or it expires.
          </div>
        </div>
      </div>
      {!team ? <Notice kind="info">Onchain transactions are part of the Team plan.</Notice> : null}
      <PermissionReviewPanel connections={connections.data?.data ?? []} onChange={() => void grants.reload()} />
      <div className="card">
        {grants.loading ? (
          <div className="card-body">
            <Spinner />
          </div>
        ) : (grants.data?.data.length ?? 0) === 0 ? (
          <Empty>No grants yet. A flow&apos;s ONCHAIN_TX steps act through one.</Empty>
        ) : (
          <table className="table responsive">
            <thead>
              <tr>
                <th>Grant</th>
                <th>Safe</th>
                <th>Status</th>
                <th>ETH limits</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {grants.data?.data.map((g) => (
                <tr key={g.id}>
                  <td>
                    <Link href={`/app/onchain/${g.id}`}>{g.label}</Link>
                    <div className="mono small faint">{g.id}</div>
                  </td>
                  <td data-label="safe">
                    <Hex value={g.safe} kind="address" />
                  </td>
                  <td data-label="status">
                    <Badge status={g.status} text={g.status} />
                  </td>
                  <td data-label="eth" className="small mono">
                    {g.scope.max_value_per_tx} / call · {g.scope.max_value_per_day} / day
                  </td>
                  <td data-label="expires" className="small muted nowrap">
                    {when(g.expires_at, me.timezone).slice(0, 16)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {team ? <NewGrant mandates={(connections.data?.data ?? []).filter((c) => c.type === "mandate")} /> : null}
    </main>
  );
}
