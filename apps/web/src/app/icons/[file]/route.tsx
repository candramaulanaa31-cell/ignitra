import { ImageResponse } from "next/og";

/** App icons, drawn at build time: "I_" in the wordmark style (no binary assets in the repo). */
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
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0e0e10",
          borderRadius: maskable ? 0 : size * 0.18,
          fontFamily: "monospace",
          fontWeight: 700,
          fontSize: size * (maskable ? 0.36 : 0.46),
          color: "#ececee",
          letterSpacing: -size * 0.01,
        }}
      >
        I<span style={{ color: "#ff7a33" }}>_</span>
      </div>
    ),
    { width: size, height: size },
  );
}
