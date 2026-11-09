"use client";

import { useEffect, useState } from "react";
import { Odometer } from "./odometer";

interface Health {
  listener?: { status?: string; head?: number };
}

/**
 * The chain's height as IGNITRA's listener sees it, polled every few seconds while the tab is
 * visible: proof that it is watching right now. Only real values: nothing is interpolated between
 * polls, the odometer simply rolls to the next one.
 */
export function ChainHead({ every = 4000 }: { every?: number }) {
  const [state, setState] = useState<{ head: number; status: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      void fetch("/api/health", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<Health>) : null))
        .then((h) => {
          if (alive && h?.listener && typeof h.listener.head === "number") setState({ head: h.listener.head, status: h.listener.status ?? "unknown" });
        })
        .catch(() => {});
    };
    poll();
    const t = setInterval(poll, every);
    document.addEventListener("visibilitychange", poll);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [every]);

  if (!state) return null;
  const live = state.status === "ok";
  return (
    <span className={`chain-head${live ? " is-live" : ""}`} title={`Robinhood Chain · listener ${state.status}`}>
      <span className="chain-dot" aria-hidden="true" />
      <span className="chain-label">block</span>
      <Odometer value={state.head} />
    </span>
  );
}
