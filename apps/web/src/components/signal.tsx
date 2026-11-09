import type { CSSProperties } from "react";

/**
 * A flow read as a signal path — WHEN → IF/AND/OR → THEN — one node per line on a wire.
 * `pulse` counts real occurrences (a run that just happened): each new value sends one spark down
 * the wire and lights the nodes it passes. Nothing moves while nothing happens; reduced-motion
 * users get the still path.
 */
export interface SignalLine {
  kind: string;
  text: string;
}

export function SignalPath({ lines, pulse = 0, className = "" }: { lines: readonly SignalLine[]; pulse?: number; className?: string }) {
  return (
    // A new key replays the animations: one spark per real run.
    <ol key={pulse} className={`signal${pulse > 0 ? " pulsing" : ""} ${className}`.trim()} style={{ "--steps": lines.length } as CSSProperties}>
      {lines.map((l, i) => (
        <li key={i} className={`signal-step k-${l.kind.toLowerCase()}`} style={{ "--i": i } as CSSProperties}>
          <span className="signal-kind">{l.kind}</span>
          <span className="signal-text">{l.text}</span>
        </li>
      ))}
    </ol>
  );
}
