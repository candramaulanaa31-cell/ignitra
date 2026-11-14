import { ImageResponse } from "next/og";

/**
 * App icons, drawn at build time (no binary assets in the repo): the spark as a gem, the faceted
 * diamond of the mark lit from the upper left, on graphite. One drawing at every size: the gem spans
 * 64 % of the square, inside both the 80 % safe zone of maskable icons and a circular avatar crop.
 */
const SIZES: Record<string, { size: number; rounded: boolean }> = {
  "icon-192.png": { size: 192, rounded: true },
  "icon-512.png": { size: 512, rounded: true },
  "maskable-512.png": { size: 512, rounded: false },
  "apple-touch-icon.png": { size: 180, rounded: false },
  "favicon-32.png": { size: 32, rounded: false },
  // A profile picture: X and most networks crop it to a circle.
  "avatar-400.png": { size: 400, rounded: false },
};

/** Facets of the gem in a 100 × 100 box: lit top-left face, then the shaded ones. */
const FACES = [
  { points: "18,50 50,18 46,45", fill: "#ffb547" },
  { points: "50,18 82,50 46,45", fill: "#ff6a13" },
  { points: "18,50 50,82 46,45", fill: "#ff3b1f" },
  { points: "82,50 50,82 46,45", fill: "#b2300c" },
] as const;

/** The favicon as SVG: sharp at 16 and 32 px, where a scaled PNG blurs. */
const FAVICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#0c0b0a"/>` +
  FACES.map((f) => `<polygon points="${f.points}" fill="${f.fill}"/>`).join("") +
  `</svg>`;

export const dynamic = "force-static";

export function generateStaticParams() {
  return [...Object.keys(SIZES), "icon.svg"].map((file) => ({ file }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (file === "icon.svg") return new Response(FAVICON_SVG, { headers: { "content-type": "image/svg+xml" } });
  const spec = SIZES[file];
  if (!spec) return new Response("not found", { status: 404 });
  const { size, rounded } = spec;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#0c0b0a",
          borderRadius: rounded ? size * 0.22 : 0,
        }}
      >
        <svg width={size} height={size} viewBox="0 0 100 100">
          {FACES.map((f) => (
            <polygon key={f.points} points={f.points} fill={f.fill} />
          ))}
        </svg>
      </div>
    ),
    { width: size, height: size },
  );
}
