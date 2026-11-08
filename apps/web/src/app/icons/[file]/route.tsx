import { ImageResponse } from "next/og";

/** App icons, drawn at build time from the mark (no binary assets in the repo): node → wire → spark. */
const SIZES: Record<string, { size: number; maskable: boolean }> = {
  "icon-192.png": { size: 192, maskable: false },
  "icon-512.png": { size: 512, maskable: false },
  "maskable-512.png": { size: 512, maskable: true },
  "apple-touch-icon.png": { size: 180, maskable: true },
};

export const dynamic = "force-static";

export function generateStaticParams() {
  return Object.keys(SIZES).map((file) => ({ file }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const spec = SIZES[file];
  if (!spec) return new Response("not found", { status: 404 });
  const { size, maskable } = spec;
  // Maskable icons keep the mark inside the 80 % safe zone.
  const markWidth = size * (maskable ? 0.58 : 0.7);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0c0b0a",
          borderRadius: maskable ? 0 : size * 0.22,
        }}
      >
        <svg width={markWidth} height={(markWidth * 16) / 28} viewBox="0 0 28 16">
          <defs>
            <linearGradient id="heat" gradientUnits="userSpaceOnUse" x1="0" y1="8" x2="28" y2="8">
              <stop offset="0" stopColor="#ff3b1f" />
              <stop offset="0.55" stopColor="#ff6a13" />
              <stop offset="1" stopColor="#ffb547" />
            </linearGradient>
          </defs>
          <circle cx="4" cy="8" r="3.1" fill="none" stroke="#f1ece5" strokeWidth="1.8" />
          <path d="M7.4 8H18.2" stroke="url(#heat)" strokeWidth="2" strokeLinecap="round" />
          <path d="M22.8 2.6 27.6 8l-4.8 5.4L18 8z" fill="url(#heat)" />
        </svg>
      </div>
    ),
    { width: size, height: size },
  );
}
