import type { CSSProperties, ReactNode } from "react";

/**
 * Solids for the landing's 3D scenes (CSS 3D, no WebGL): one material and one light everywhere, so
 * every object on the page reads as part of the same machine.
 */

/**
 * A slab standing on its scene's floor: a top face and the two sides these views show. Size comes
 * from --sw (width), --sd (depth) and --sh (height); the faces shade from CSS. Decorative: the
 * figures that use it are aria-hidden.
 */
export function Slab({ className, style, top, front }: { className?: string; style?: CSSProperties; top?: ReactNode; front?: ReactNode }) {
  return (
    <div className={className ? `slab ${className}` : "slab"} style={style}>
      <div className="slab-face slab-top">{top}</div>
      <div className="slab-face slab-front">{front}</div>
      <div className="slab-face slab-left" />
    </div>
  );
}

/**
 * A panel that lifts off the page as it scrolls in: it starts tilted back on its bottom edge and
 * stands up to face the reader before it reaches the middle of the screen. At rest its transform is
 * the identity, so the live text in it renders as crisply as anywhere else.
 */
export function Lift({ children }: { children: ReactNode }) {
  return (
    <div className="lift" data-scene="0.72">
      <div className="lift-body">{children}</div>
    </div>
  );
}
