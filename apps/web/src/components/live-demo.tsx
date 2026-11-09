"use client";

import { useEffect, useRef, useState } from "react";
import { shortHex, when } from "@/lib/format";
import { RUNS_EVENT, type RunsSignal } from "./ignition-field";
import { Odometer } from "./odometer";
import { SignalPath } from "./signal";
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

type Run = DemoData["runs"][number];

const EXPLORER = "https://robinhoodchain.blockscout.com";
const secs = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);
const runId = (r: Run) => `${r.tx_hash ?? "—"}:${r.at}`;
/** What the hero's field shows on a port when this run reaches it: the amount, two decimals. */
const fieldLabel = (r: Run) => (r.summary?.split(" · ")[0] ?? shortHex(r.tx_hash ?? "")).replace(/(\.\d{2})\d+/, "$1");
const signal = (runs: Run[], total: number) => window.dispatchEvent(new CustomEvent<RunsSignal>(RUNS_EVENT, { detail: { labels: runs.map(fieldLabel), total } }));

/** Recent real runs flowing past, under the hero. Hover (or focus) holds the tape still to click through. */
function ChainTape({ runs }: { runs: Run[] }) {
  const items = runs.filter((r) => r.block_number !== null).slice(0, 12);
  if (items.length < 4) return null;
  const row = (copy: "a" | "b") =>
    items.map((r) => (
      <li key={`${copy}-${runId(r)}`} aria-hidden={copy === "b" ? true : undefined}>
        <span className="tape-block">#{r.block_number?.toLocaleString("en-US")}</span>
        {r.tx_hash ? (
          <a href={`${EXPLORER}/tx/${r.tx_hash}`} target="_blank" rel="noreferrer" tabIndex={copy === "b" ? -1 : undefined}>
            {r.summary ?? shortHex(r.tx_hash)}
          </a>
        ) : (
          <span>{r.summary ?? "—"}</span>
        )}
        <span className="tape-took">{secs(r.latency_ms)}</span>
      </li>
    ));
  return (
    <div className="tape" role="region" aria-label="Recent runs on Robinhood Chain">
      <ul className="tape-track">
        {row("a")}
        {row("b")}
      </ul>
    </div>
  );
}

/**
 * The landing page's live instrument: a real flow on mainnet, refreshed every 5 s while the tab is
 * visible. The page itself is cached (ISR), so the first refresh runs at once. Motion only follows
 * real runs: each refresh that brings new ones sends a spark down the flow and slides them in.
 */
export function LiveDemo({ initial }: { initial: DemoData }) {
  const [data, setData] = useState(initial);
  const [pulse, setPulse] = useState(0);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const seen = useRef<Set<string>>(new Set(initial.runs.map(runId)));

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void fetch("/api/v1/demo", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ data: DemoData }>) : null))
        .then((r) => {
          if (!r) return;
          const addedRuns = r.data.runs.filter((run) => !seen.current.has(runId(run)));
          const added = addedRuns.map(runId);
          for (const id of added) seen.current.add(id);
          setData(r.data);
          if (added.length > 0) {
            setFresh(new Set(added));
            setPulse((p) => p + 1);
            signal(addedRuns, r.data.stats.runs);
          }
        })
        .catch(() => {});
    };
    // First impression: replay the newest real run once (here and in the hero's field), then follow the chain.
    const first = setTimeout(() => {
      const newest = initial.runs[0];
      if (!newest) return;
      setPulse((p) => (p === 0 ? 1 : p));
      signal([newest], initial.stats.runs);
    }, 900);
    refresh();
    const t = setInterval(refresh, 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [initial.runs.length]);

  return (
    <>
      <section className="card panel live-panel">
        <div className="card-head">
          <span className="row" style={{ gap: 8 }}>
            <span className="live-dot" aria-hidden="true" />
            <span className="label">Live on Robinhood Chain</span>
          </span>
          <span className="panel-stats mono">
            <span>
              <strong>
                <Odometer value={data.stats.runs} />
              </strong>{" "}
              runs
            </span>
            <span>
              <strong>{secs(data.latency_ms.p50)}</strong> block → done
            </span>
          </span>
        </div>
        <div className="card-body">
          <SignalPath lines={data.outline} pulse={data.status === "active" ? pulse : 0} />
        </div>
        {data.runs.length === 0 ? (
          <div className="card-body muted small">Waiting for the next matching transfer…</div>
        ) : (
          <ul className="feed">
            {data.runs.slice(0, 8).map((r, i) => (
              <li key={runId(r)} className={fresh.has(runId(r)) ? "fresh" : undefined} style={{ animationDelay: fresh.has(runId(r)) ? `${i * 70}ms` : undefined }}>
                <span className="mono faint when">{when(r.at).slice(11, 19)}</span>
                <span className="mono ellipsis">
                  {r.tx_hash ? (
                    <a href={`${EXPLORER}/tx/${r.tx_hash}`} target="_blank" rel="noreferrer">
                      {r.summary ?? shortHex(r.tx_hash)}
                    </a>
                  ) : (
                    (r.summary ?? "—")
                  )}
                </span>
                <span className="feed-end">
                  <span className="mono faint">{secs(r.latency_ms)}</span>
                  <Badge status={r.status} text={r.status === "succeeded" ? "done" : r.status} />
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="panel-foot mono">times in WIB · each row is a real run, refreshed every 5 s</div>
      </section>
      <ChainTape runs={data.runs} />
    </>
  );
}
