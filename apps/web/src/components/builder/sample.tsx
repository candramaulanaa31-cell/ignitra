"use client";

import { useState } from "react";
import { api, errorText } from "@/lib/api";
import type { Sample } from "@/lib/types";
import { Json, Notice, Spinner } from "../ui";

/**
 * Live sample: the latest REAL matching event (or current state / scheduled
 * time / latest request). Its values feed the variable picker and the
 * conditions preview, and "Test flow" runs with it.
 */
export function SamplePanel({
  trigger,
  kind,
  conditions,
  flowId,
  sample,
  onSample,
}: {
  trigger: { type: string; params: Record<string, unknown> };
  kind: string | undefined;
  conditions: unknown;
  flowId: string | null;
  sample: Sample | null;
  onSample: (s: Sample | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [body, setBody] = useState('{\n  "order": "A-1",\n  "total": 120\n}');

  const load = async () => {
    setBusy(true);
    setError(null);
    setHint(null);
    try {
      let pasted: unknown;
      if (kind === "inbound" && body.trim()) {
        try {
          pasted = JSON.parse(body);
        } catch {
          throw new Error("the sample body is not valid JSON");
        }
      }
      const res = await api<{ data: Sample | null; hint?: string }>("/v1/samples", {
        body: { trigger, ...(conditions ? { conditions } : {}), ...(flowId ? { flow_id: flowId } : {}), ...(pasted !== undefined ? { body: pasted } : {}) },
      });
      onSample(res.data);
      if (!res.data) setHint(res.hint ?? "nothing found");
    } catch (err) {
      onSample(null);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {kind === "inbound" ? (
        <label className="field">
          <span className="name">Sample request body (JSON) — what your sender will POST</span>
          <textarea className="mono" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
      ) : null}
      <div className="row">
        <button type="button" className="btn" onClick={() => void load()} disabled={busy || !trigger.type}>
          {kind === "log" ? "Load the latest real event" : kind === "poll" ? "Load the current state" : kind === "schedule" ? "Load the next / last time" : "Use as sample"}
        </button>
        {busy ? <Spinner label={kind === "log" ? "Scanning recent blocks…" : "Reading…"} /> : null}
        {sample ? (
          <button type="button" className="linkish small" onClick={() => onSample(null)}>
            clear sample
          </button>
        ) : null}
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {hint ? <Notice kind="warn">{hint}</Notice> : null}
      {sample ? (
        <div className="stack" style={{ gap: 6 }}>
          <div className="small">
            <span className="badge plain s-live">{sample.kind}</span> <span className="muted">{sample.note}</span>
            {sample.scanned_blocks ? <span className="faint"> · scanned {sample.scanned_blocks.toLocaleString("en-US")} blocks</span> : null}
          </div>
          <Json value={sample.payload} collapsed summary="Sample data — values appear next to variables and conditions" />
        </div>
      ) : null}
    </div>
  );
}
