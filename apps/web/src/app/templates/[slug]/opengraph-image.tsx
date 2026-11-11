import { ImageResponse } from "next/og";
import { C, Card, DISPLAY, Masthead, OG_SIZE, Spark, clip, ogFonts, siteHost } from "@/lib/og";
import { serverGetCached } from "@/lib/server-api";
import { SITE_URL } from "@/lib/site";
import { CATEGORY_LABELS, officialDetail, type TemplateDetail } from "@/lib/template-types";

// A template shared on X or Telegram shows what it does: its name and its flow, WHEN → IF → THEN.
export const alt = "An IGNITRA template: a ready-made flow for Robinhood Chain";
export const size = OG_SIZE;
export const contentType = "image/png";
export const revalidate = 3600;

async function load(slug: string): Promise<TemplateDetail | null> {
  const official = officialDetail(slug, SITE_URL);
  if (official) return official;
  try {
    return (await serverGetCached<{ data: TemplateDetail }>(`/v1/templates/${encodeURIComponent(slug)}`, 3600))?.data ?? null;
  } catch {
    return null; // API down: the generic card below
  }
}

/** The node each kind of step gets on the wire: a ring for WHEN, an open diamond for a test, a lit one for THEN. */
function Node({ kind }: { kind: string }) {
  if (kind === "WHEN") return <div style={{ width: 16, height: 16, borderRadius: 8, border: `3px solid ${C.text}`, background: C.bg }} />;
  if (kind === "THEN") return <div style={{ width: 14, height: 14, transform: "rotate(45deg)", backgroundImage: C.heat }} />;
  return <div style={{ width: 13, height: 13, transform: "rotate(45deg)", border: `2.5px solid ${C.muted}`, background: C.bg }} />;
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const t = await load((await params).slug);
  const host = siteHost();
  const name = t ? clip(t.name, 58) : "A ready-made flow";
  const lines = (t?.outline ?? []).slice(0, 4);
  const titleSize = name.length <= 26 ? 66 : name.length <= 42 ? 56 : 48;
  return new ImageResponse(
    (
      <Card>
        <div style={{ position: "absolute", right: -70, top: 170, display: "flex" }}>
          <Spark size={380} yaw={0.95} pitch={0.3} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "64px 72px 58px", width: "100%", height: "100%" }}>
          <Masthead section={`TEMPLATE${t ? ` · ${(CATEGORY_LABELS[t.category] ?? t.category).toUpperCase()}` : ""}`} />
          <div style={{ display: "flex", flexDirection: "column", maxWidth: 860 }}>
            <span style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: titleSize, lineHeight: 1.05, letterSpacing: "-0.02em", marginBottom: 34 }}>{name}</span>
            <div style={{ display: "flex", flexDirection: "column", position: "relative", paddingLeft: 40 }}>
              {lines.length > 1 ? <div style={{ position: "absolute", left: 7, top: 18, bottom: 18, width: 2, backgroundImage: "linear-gradient(180deg, #3d3630, #ff6a13)" }} /> : null}
              {lines.map((l, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", marginTop: i === 0 ? 0 : 14, position: "relative" }}>
                  <div style={{ position: "absolute", left: -40, width: 18, display: "flex", justifyContent: "center" }}>
                    <Node kind={l.kind} />
                  </div>
                  <span style={{ width: 84, fontSize: 18, fontWeight: 700, letterSpacing: "0.14em", color: l.kind === "THEN" ? C.emberStrong : C.faint }}>{l.kind}</span>
                  <span style={{ fontSize: 25, color: C.text }}>{clip(l.text, 46)}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 21, color: C.muted }}>
            <span>Ready-made flow for Robinhood Chain · no bot to run</span>
            {host ? <span style={{ marginLeft: "auto", color: C.faint }}>{host}</span> : null}
          </div>
        </div>
      </Card>
    ),
    { ...OG_SIZE, fonts: await ogFonts() },
  );
}
