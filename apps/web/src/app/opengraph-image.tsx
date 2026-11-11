import { ImageResponse } from "next/og";
import { C, Card, DISPLAY, Masthead, OG_SIZE, Spark, ogFonts, siteHost } from "@/lib/og";

// The card every page shares unless it has its own (templates do).
export const alt = "IGNITRA: when the chain moves, everything follows. Onchain automation for Robinhood Chain.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function Image() {
  const host = siteHost();
  return new ImageResponse(
    (
      <Card>
        <div style={{ position: "absolute", right: -95, top: 150, display: "flex" }}>
          <Spark size={460} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "64px 72px 58px", width: "100%", height: "100%" }}>
          <Masthead />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 19, fontWeight: 700, color: C.ember, letterSpacing: "0.2em", marginBottom: 26 }}>ONCHAIN AUTOMATION · ROBINHOOD CHAIN</span>
            <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 74, lineHeight: 1.02, letterSpacing: "-0.02em" }}>When the chain moves,</span>
            <div style={{ display: "flex", flexDirection: "column", alignSelf: "flex-start", marginTop: 4 }}>
              <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 74, lineHeight: 1.02, letterSpacing: "-0.02em" }}>everything follows.</span>
              <div style={{ height: 8, marginTop: 6, backgroundImage: C.heat, borderRadius: 2 }} />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 21, color: C.muted }}>
            <span style={{ color: C.text, fontWeight: 700 }}>WHEN → IF → THEN</span>
            <span>Telegram · webhooks · email · Sheets · HTTP · push</span>
            {host ? <span style={{ marginLeft: "auto", color: C.faint }}>{host}</span> : null}
          </div>
        </div>
      </Card>
    ),
    { ...OG_SIZE, fonts: await ogFonts() },
  );
}
