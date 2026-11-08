"use client";

import Link from "next/link";
import { use, useState, type FormEvent } from "react";
import { SafeApprovalPanel } from "@/components/onchain";
import { useSession } from "@/components/session";
import { Badge, CopyButton, Empty, Hex, Notice, Spinner, TestBadge, useToast } from "@/components/ui";
import { ApiError, api, errorText, useApi } from "@/lib/api";
import { when } from "@/lib/format";
import type { Connection, Grant, GrantDetail, SafeApproval } from "@/lib/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Proves the Safe transaction set up exactly this grant; then the grant is active. */
function useVerify(id: string, onDone: () => void) {
  const [busy, setBusy] = useState<null | "check" | "wait">(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const verify = async (txHash: string, waitForMining: boolean) => {
    setBusy(waitForMining ? "wait" : "check");
    setError(null);
    setProblems([]);
    try {
      // A transaction just sent is not mined yet: ask again for a minute.
      for (let i = 0; ; i++) {
        try {
          await api(`/v1/onchain/grants/${id}/verify`, { body: { tx_hash: txHash } });
          onDone();
          return;
        } catch (err) {
          const found = err instanceof ApiError && Array.isArray(err.details.problems) ? (err.details.problems as string[]) : [];
          if (waitForMining && i < 30 && found.length === 1 && /not mined/.test(found[0] ?? "")) {
            await sleep(2000);
            continue;
          }
          setProblems(found);
          setError(errorText(err));
          return;
        }
      }
    } finally {
      setBusy(null);
    }
  };
  return { busy, problems, error, verify };
}

function VerifyForm({ v }: { v: ReturnType<typeof useVerify> }) {
  const [hash, setHash] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void v.verify(hash.trim(), false);
  };
  return (
    <form className="stack" onSubmit={submit}>
      <span className="small muted">Executed it in the Safe app? Paste the transaction hash: IGNITRA checks that it sets up exactly this grant, nothing broader.</span>
      <div className="row">
        <input className="mono grow" placeholder="0x… transaction hash" value={hash} onChange={(e) => setHash(e.target.value.trim())} spellCheck={false} />
        <button type="submit" className="btn" disabled={v.busy !== null || !/^0x[0-9a-fA-F]{64}$/.test(hash)}>
          {v.busy === "check" ? "Checking…" : "Verify"}
        </button>
      </div>
      {v.busy === "wait" ? <span className="small muted">Waiting for the transaction to be mined, then checking it…</span> : null}
      {v.error ? (
        <Notice kind="error">
          {v.error}
          {v.problems.length > 0 ? (
            <ul>
              {v.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
    </form>
  );
}

function Scope({ g, mandate }: { g: Grant; mandate: Connection | null }) {
  return (
    <div className="stack">
      {g.scope.targets.map((t) => (
        <div key={t.address} className="stack" style={{ gap: 4 }}>
          <Hex value={t.address} kind="address" full />
          <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
            {t.functions.map((f) => (
              <li key={f.selector}>
                <span className="mono">{f.signature}</span>
                {f.amount ? (
                  <span className="muted">
                    {" "}
                    · argument {f.amount.arg + 1} ≤ {f.amount.max_per_tx} per call, {f.amount.max_per_day} per day
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <dl className="kv">
        <dt>ETH per call</dt>
        <dd className="mono">{g.scope.max_value_per_tx}</dd>
        <dt>ETH per day</dt>
        <dd className="mono">{g.scope.max_value_per_day}</dd>
        <dt>MANDATE</dt>
        <dd>{g.mandate_connection_id ? mandate ? mandate.label : <span className="mono small">{g.mandate_connection_id}</span> : <span className="muted">none</span>}</dd>
      </dl>
    </div>
  );
}

export default function GrantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { me } = useSession();
  const [toast, notify] = useToast();
  const grant = useApi<{ data: GrantDetail }>(`/v1/onchain/grants/${id}`);
  const connections = useApi<{ data: Connection[] }>("/v1/connections");
  const [removal, setRemoval] = useState<SafeApproval | null>(null);
  const verification = useVerify(id, () => void grant.reload().then(() => notify("Verified: the grant is active.")));

  if (grant.error) return <Notice kind="error">{grant.error.message}</Notice>;
  if (!grant.data) return <Spinner />;
  const g = grant.data.data;

  const revoke = async () => {
    if (!window.confirm(`Revoke "${g.label}" now? IGNITRA deletes the session key at once: nothing more can be sent through this grant.`)) return;
    try {
      const res = await api<{ data: Grant; onchain: SafeApproval }>(`/v1/onchain/grants/${g.id}/revoke`, { method: "POST" });
      setRemoval(res.onchain);
      await grant.reload();
      notify("Revoked. The session key no longer exists.");
    } catch (err) {
      notify(errorText(err), "error");
    }
  };

  return (
    <main className="stack">
      {toast}
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <div className="row">
            <h1>{g.label}</h1>
            <Badge status={g.status} text={g.status} />
          </div>
          <div className="sub">
            <Link href="/app/onchain">Onchain</Link> · <span className="mono">{g.id}</span> · Safe <Hex value={g.safe} kind="address" /> · expires {when(g.expires_at, me.timezone).slice(0, 16)}
          </div>
        </div>
        {g.status === "pending" || g.status === "active" ? (
          <button type="button" className="btn danger" onClick={() => void revoke()}>
            Revoke now
          </button>
        ) : null}
      </div>

      {g.status === "pending" ? (
        <section className="card">
          <div className="card-head">
            <span className="label">Approve on your Safe</span>
            <span className="small muted">one transaction, every call listed</span>
          </div>
          <div className="card-body stack">
            {g.approval ? (
              <SafeApprovalPanel approval={g.approval} name={`ignitra-grant-${g.id}`} onSent={(h) => void verification.verify(h, true)} />
            ) : (
              <Notice kind="warn">The Safe could not be read right now: reload in a moment.</Notice>
            )}
            <VerifyForm v={verification} />
          </div>
        </section>
      ) : null}

      {removal ? (
        <section className="card">
          <div className="card-head">
            <span className="label">Also remove the role from your Safe</span>
            <span className="small muted">optional: the key is already gone</span>
          </div>
          <div className="card-body">
            <SafeApprovalPanel approval={removal} name={`ignitra-revoke-${g.id}`} />
          </div>
        </section>
      ) : null}

      <div className="grid2">
        <section className="card">
          <div className="card-head">
            <span className="label">What it allows</span>
          </div>
          <div className="card-body">
            <Scope g={g} mandate={connections.data?.data.find((c) => c.id === g.mandate_connection_id) ?? null} />
          </div>
        </section>
        <section className="card">
          <div className="card-head">
            <span className="label">IGNITRA&apos;s session key</span>
          </div>
          <div className="card-body stack">
            <div className="row">
              <Hex value={g.session_key} kind="address" full />
              <CopyButton value={g.session_key} />
            </div>
            {g.status === "pending" || g.status === "active" ? (
              <>
                <span className="small">
                  Gas balance: <span className="mono">{g.session_key_balance ?? "?"} ETH</span>
                </span>
                <span className="small muted">
                  It pays the gas of its own transactions: keep a little ETH on it (Robinhood Chain). It can never spend the Safe&apos;s funds beyond this grant. Its private key exists only encrypted on IGNITRA&apos;s servers, and is deleted on revoke or expiry.
                </span>
              </>
            ) : (
              <span className="small muted">Deleted: this key can no longer sign anything.</span>
            )}
            {g.grant_tx_url ? (
              <span className="small">
                Granted by{" "}
                <a href={g.grant_tx_url} target="_blank" rel="noreferrer">
                  this transaction
                </a>
                .
              </span>
            ) : null}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <span className="label">Transactions</span>
          <span className="small muted">every attempt, with its hash</span>
        </div>
        {g.actions.length === 0 ? (
          <Empty>Nothing sent through this grant yet.</Empty>
        ) : (
          <table className="table responsive">
            <thead>
              <tr>
                <th>When</th>
                <th>Call</th>
                <th>Status</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {g.actions.map((a) => (
                <tr key={a.id}>
                  <td className="small nowrap">
                    {when(a.created_at, me.timezone).slice(0, 16)}
                    <div>
                      <Link href={`/app/runs/${a.run_id}`} className="small faint">
                        run
                      </Link>
                    </div>
                  </td>
                  <td data-label="call" className="small">
                    <span className="mono">{a.function}</span> on <Hex value={a.to} kind="address" />
                    {a.value !== "0" ? <span className="mono"> · {a.value} ETH</span> : null}
                    {a.error ? <div className="failc">{a.error}</div> : null}
                  </td>
                  <td data-label="status">
                    <Badge status={a.status} text={a.status} /> {a.test ? <TestBadge /> : null}
                  </td>
                  <td data-label="tx">{a.tx_hash ? <Hex value={a.tx_hash} kind="tx" /> : <span className="faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
