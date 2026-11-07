"use client";

import { useEffect, useState } from "react";
import { shortHex, when } from "@/lib/format";
import { Badge } from "./ui";

export interface DemoData {
  name: string;
  status: string;
  trigger_type: string;
  outline: Array<{ kind: string; text: string }>;
  stats: { runs: number; matched: number; last_run_at: string | null };
  latency_ms: { p50: number | null; p90: number | null; samples: number };
  runs: Array<{ at: string; status: string; summary: string | null; tx_hash: string | null; block_number: number | null; latency_ms: number | null }>;
}

const EXPLORER = "https://robinhoodchain.blockscout.com";
const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);

/**
 * The landing page's live feed: a real flow on mainnet, refreshed every 5 s while the
 * tab is visible. The page itself is cached (ISR), so the first refresh runs at once.
 */
export function LiveDemo({ initial }: { initial: DemoData }) {
  const [data, setData] = useState(initial);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void fetch("/api/v1/demo", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ data: DemoData }>) : null))
        .then((r) => r && setData(r.data))
        .catch(() => {});
    };
    refresh();
    const t = setInterval(refresh, 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  return (
    <section className="card">
      <div className="card-head">
        <span className="row">
          <span className="live-dot" aria-hidden="true" />
          <span className="label">Live on Robinhood Chain</span>
        </span>
        <span className="small muted">
          {data.stats.runs.toLocaleString("en-US")} runs · median block → done {secs(data.latency_ms.p50)}
        </span>
      </div>
      <div className="card-body">
        <pre className="json outline">
          {data.outline.map((l, i) => (
            <span key={i}>
              <span className="kw">{l.kind.padEnd(5)}</span> {l.text}
              {"\n"}
            </span>
          ))}
        </pre>
      </div>
      {data.runs.length === 0 ? (
        <div className="card-body muted small">Waiting for the next matching transfer…</div>
      ) : (
        <ul className="feed">
          {data.runs.map((r, i) => (
            <li key={`${r.tx_hash ?? i}-${r.at}`}>
              <span className="mono small faint when">{when(r.at).slice(11, 19)} WIB</span>
              <span className="mono ellipsis">
                {r.tx_hash ? (
                  <a href={`${EXPLORER}/tx/${r.tx_hash}`} target="_blank" rel="noreferrer">
                    {r.summary ?? shortHex(r.tx_hash)}
                  </a>
                ) : (
                  (r.summary ?? "—")
                )}
              </span>
              <span className="row small" style={{ gap: 6 }}>
                <Badge status={r.status} text={r.status} />
                <span className="faint">{secs(r.latency_ms)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
