"use client";

import { useState } from "react";
import { errorText } from "@/lib/api";
import type { Connection, Grant, SafeApproval } from "@/lib/types";
import { discoverWallets, sendWalletTransaction, type WalletOption } from "@/lib/wallet";
import { Hex, Notice } from "./ui";

/**
 * A Safe transaction IGNITRA prepared (approving a grant, or removing its role), in the forms an
 * owner can use: sent from the owner's wallet (1-of-N Safes), or as a Safe Transaction Builder
 * batch for multisigs. The wallet / Safe shows every call before anything is signed.
 */
export function SafeApprovalPanel({ approval, name, onSent }: { approval: SafeApproval; name: string; onSent?: (hash: `0x${string}`) => void }) {
  const [wallets, setWallets] = useState<WalletOption[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const ownerTx = approval.owner_transaction ?? null;

  const send = async (wallet: WalletOption) => {
    if (!ownerTx) return;
    setWallets(null);
    setBusy(true);
    setError(null);
    try {
      const hash = await sendWalletTransaction(wallet.provider, ownerTx);
      setSent(hash);
      onSent?.(hash);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const chooseWallet = async () => {
    setError(null);
    const found = await discoverWallets();
    const [only] = found;
    if (!only) setError("No browser wallet found: use the Transaction Builder file instead.");
    else if (found.length === 1) await send(only);
    else setWallets(found);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(approval.tx_builder, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack">
      <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
        {approval.calls.map((c, i) => (
          <li key={`${c.to}-${i}`}>
            {c.description} <span className="faint">→</span> <Hex value={c.to} kind="address" />
          </li>
        ))}
      </ol>
      {approval.note ? <p className="small muted">{approval.note}</p> : null}
      <div className="row">
        {ownerTx ? (
          <button type="button" className="btn primary" disabled={busy || sent !== null} onClick={() => void chooseWallet()}>
            {busy ? "Confirm in your wallet…" : "Send from my wallet"}
          </button>
        ) : null}
        {approval.tx_builder ? (
          <button type="button" className="btn" onClick={download}>
            Download for Safe Transaction Builder
          </button>
        ) : null}
      </div>
      {wallets ? (
        <div className="row">
          <span className="small muted">Which wallet?</span>
          {wallets.map((w) => (
            <button key={w.id} type="button" className="btn sm" onClick={() => void send(w)}>
              {w.name}
            </button>
          ))}
        </div>
      ) : null}
      {sent ? (
        <Notice kind="ok">
          Sent: <Hex value={sent} kind="tx" />
        </Notice>
      ) : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </div>
  );
}

/** What a grant lets the session key do: contracts, functions, amount caps, ETH limits, MANDATE. */
export function GrantPermissions({ g, mandate }: { g: Grant; mandate: Connection | null }) {
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
