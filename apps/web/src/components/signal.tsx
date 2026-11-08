/**
 * A flow read as a signal path — WHEN → IF/AND/OR → THEN — one node per line on a wire.
 * `live` sends a spark down the wire (a flow that is running right now); reduced-motion
 * users get a still wire.
 */
export interface SignalLine {
  kind: string;
  text: string;
}

export function SignalPath({ lines, live = false, className = "" }: { lines: readonly SignalLine[]; live?: boolean; className?: string }) {
  return (
    <ol className={`signal${live ? " live" : ""} ${className}`.trim()}>
      {lines.map((l, i) => (
        <li key={i} className={`signal-step k-${l.kind.toLowerCase()}`}>
          <span className="signal-kind">{l.kind}</span>
          <span className="signal-text">{l.text}</span>
        </li>
      ))}
    </ol>
  );
}
