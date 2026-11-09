/**
 * A number whose digits roll to a new value: for counters that change because the chain did
 * (block height, runs). Digits keep their identity by place value, so 999 → 1,000 rolls each
 * column instead of re-rendering. Screen readers get the plain number; under reduced motion the
 * digits change without rolling.
 */
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

export function Odometer({ value, className = "" }: { value: number; className?: string }) {
  const text = value.toLocaleString("en-US");
  const chars = [...text];
  return (
    <span className={`odo ${className}`.trim()}>
      <span className="sr-only">{text}</span>
      <span className="odo-face" aria-hidden="true">
        {chars.map((ch, i) => {
          const place = chars.length - i; // stable per column, counted from the right
          return /\d/.test(ch) ? (
            <span key={`d${place}`} className="odo-digit">
              <span className="odo-strip" style={{ transform: `translateY(${-Number(ch) * 10}%)` }}>
                {DIGITS.map((d) => (
                  <span key={d}>{d}</span>
                ))}
              </span>
            </span>
          ) : (
            <span key={`s${place}`} className="odo-sep">
              {ch}
            </span>
          );
        })}
      </span>
    </span>
  );
}
