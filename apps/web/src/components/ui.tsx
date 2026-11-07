"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CHAIN_PRESETS, ROBINHOOD_CHAIN_ID } from "@ignitra/core";
import { label, shortHex, statusClass } from "@/lib/format";

export function Badge({ status, text }: { status: string; text?: string }) {
  return <span className={`badge ${statusClass(status)}`}>{text ?? label(status)}</span>;
}

export function TestBadge() {
  return (
    <span className="badge plain s-test" title="Ran with sample data from “Test flow”">
      TEST
    </span>
  );
}

export function Spinner({ label: text }: { label?: string }) {
  return (
    <span className="row muted" role="status">
      <span className="spinner" aria-hidden="true" />
      {text ?? "Loading…"}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Notice({ kind = "info", children }: { kind?: "info" | "error" | "ok" | "warn"; children: ReactNode }) {
  return <div className={`notice ${kind === "info" ? "" : kind}`}>{children}</div>;
}

export function CopyButton({ value, text = "Copy" }: { value: string; text?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn sm ghost"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? "Copied" : text}
    </button>
  );
}

const EXPLORER = CHAIN_PRESETS[ROBINHOOD_CHAIN_ID]?.explorerUrl ?? "https://robinhoodchain.blockscout.com";

/** Address or hash, monospace, shortened, linked to the explorer, copyable. */
export function Hex({ value, kind, full = false }: { value: string | null | undefined; kind?: "address" | "tx" | "block"; full?: boolean }) {
  if (!value) return <span className="faint">—</span>;
  const text = full ? value : shortHex(value);
  const href = kind ? `${EXPLORER}/${kind === "tx" ? "tx" : kind === "block" ? "block" : "address"}/${value}` : null;
  return (
    <span className="mono nowrap" title={value}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {text}
        </a>
      ) : (
        text
      )}
    </span>
  );
}

export function Json({ value, collapsed = false, summary = "JSON" }: { value: unknown; collapsed?: boolean; summary?: string }) {
  const body = <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
  if (!collapsed) return body;
  return (
    <details>
      <summary>{summary}</summary>
      {body}
    </details>
  );
}

export function Field({ name, help, error, children }: { name: string; help?: string | undefined; error?: string[] | undefined; children: ReactNode }) {
  return (
    <label className="field">
      <span className="name">{name}</span>
      {children}
      {error?.map((e) => (
        <span key={e} className="err">
          {e}
        </span>
      ))}
      {help && !error?.length ? <span className="help">{help}</span> : null}
    </label>
  );
}

/** A transient message at the bottom of the screen. */
export function useToast(): [ReactNode, (message: string, kind?: "ok" | "error" | "info") => void] {
  const [toast, setToast] = useState<{ message: string; kind: "ok" | "error" | "info"; at: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === "error" ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);
  const node = toast ? (
    <div className="toast">
      <Notice kind={toast.kind}>{toast.message}</Notice>
    </div>
  ) : null;
  // Stable identity: callers may list it in effect dependencies.
  const show = useCallback((message: string, kind: "ok" | "error" | "info" = "ok") => setToast({ message, kind, at: Date.now() }), []);
  return [node, show];
}
