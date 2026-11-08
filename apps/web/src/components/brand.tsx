import Link from "next/link";

/**
 * The IGNITRA mark: a node, a wire and a spark — an event on the chain igniting an action.
 * The wire carries the one heat gradient of the identity. Identical defs repeated on a page
 * resolve to the same gradient, so the id can be static.
 */
export function Mark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={(size * 28) / 16} height={size} viewBox="0 0 28 16" aria-hidden="true" focusable="false">
      <defs>
        {/* User-space units: the wire is a horizontal line, and a bounding-box gradient on a zero-height box paints nothing. */}
        <linearGradient id="ignitra-heat" gradientUnits="userSpaceOnUse" x1="0" y1="8" x2="28" y2="8">
          <stop offset="0" stopColor="#ff3b1f" />
          <stop offset="0.55" stopColor="#ff6a13" />
          <stop offset="1" stopColor="#ffb547" />
        </linearGradient>
      </defs>
      <circle cx="4" cy="8" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7.4 8H18.2" stroke="url(#ignitra-heat)" strokeWidth="2" strokeLinecap="round" />
      <path d="M23.2 2.6 28 8l-4.8 5.4L18.4 8z" fill="url(#ignitra-heat)" transform="translate(-0.4 0)" />
    </svg>
  );
}

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="brand" aria-label="IGNITRA home">
      <Mark />
      <span className="wordmark">IGNITRA</span>
    </Link>
  );
}
