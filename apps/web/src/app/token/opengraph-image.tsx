import { ImageResponse } from "next/og";
import { C, Card, DISPLAY, Masthead, OG_SIZE, Spark, ogFonts, siteHost } from "@/lib/og";
import { TOKEN, TOKEN_LAUNCH, shortAddress } from "@/lib/site";

// ignitra.run/token shared on X or Telegram: the token, its status, and where to check the address.
export const alt = "$IGNITRA, the community token of IGNITRA";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image() {
  const host = siteHost() ?? "ignitra.run";
  const status = TOKEN ? `Live on Pons · ${shortAddress(TOKEN.address)}` : TOKEN_LAUNCH ? `Launches ${TOKEN_LAUNCH} on Pons` : "Community token · Robinhood Chain";
  return new ImageResponse(
    (
      <Card>
        <div style={{ position: "absolute", right: -40, top: 150, display: "flex" }}>
          <Spark size={400} yaw={0.2} pitch={0.34} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "64px 72px 58px", width: "100%", height: "100%" }}>
          <Masthead section="TOKEN" />
          <div style={{ display: "flex", flexDirection: "column", maxWidth: 760 }}>
            <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 112, lineHeight: 1, letterSpacing: "0.02em", backgroundImage: C.heat, backgroundClip: "text", color: "transparent" }}>$IGNITRA</span>
            <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 36, marginTop: 24 }}>The community token of IGNITRA</span>
            <span style={{ fontSize: 24, color: C.emberStrong, marginTop: 18 }}>{status}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", fontSize: 21, color: C.muted }}>
            <span>{`The only official address: ${host}/token`}</span>
          </div>
        </div>
      </Card>
    ),
    { ...OG_SIZE, fonts: await ogFonts() },
  );
}
