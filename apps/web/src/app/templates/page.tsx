import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { label } from "@/lib/format";
import { serverGet } from "@/lib/server-api";
import { CATEGORY_LABELS, officialCards, type TemplateCard } from "@/lib/template-types";

export const metadata: Metadata = {
  title: "Templates",
  description: "Ready-made Robinhood Chain automations: big buys, new holders, treasury alerts, upgrades, daily reports. Use one in under two minutes.",
};

export const revalidate = 60;

function Card({ t }: { t: TemplateCard }) {
  return (
    <Link href={`/templates/${t.slug}`} className="card tpl-card">
      <div className="card-body stack" style={{ gap: 8 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="small muted">{CATEGORY_LABELS[t.category] ?? t.category}</span>
          <span className="row" style={{ gap: 6 }}>
            {t.min_plan !== "free" ? <span className="badge plain s-partial">{t.min_plan}</span> : null}
            {t.official ? null : <span className="badge plain s-live">community</span>}
          </span>
        </div>
        <strong>{t.name}</strong>
        <span className="small muted">{t.summary}</span>
        <span className="small mono faint">
          {label(t.trigger_type)} → {t.action_types.map(label).join(" + ")}
        </span>
        {t.uses > 0 ? <span className="small faint">used {t.uses.toLocaleString("en-US")}×</span> : null}
      </div>
    </Link>
  );
}

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const { category } = await searchParams;
  const res = await serverGet<{ data: TemplateCard[] }>("/v1/templates", 60);
  const all = res?.data ?? officialCards();
  const list = category ? all.filter((t) => t.category === category) : all;
  const official = list.filter((t) => t.official);
  const community = list.filter((t) => !t.official);
  return (
    <div className="wrap">
      <SiteHeader active="templates" />
      <main className="stack">
        <div>
          <h1>Templates</h1>
          <p className="lede" style={{ marginTop: 8 }}>
            Ready-made automations for Robinhood Chain. Pick one, paste your token or wallet, choose where it goes, activate. Every run is traceable.
          </p>
        </div>
        <nav className="row" aria-label="Categories">
          <Link href="/templates" className={`chip${category ? "" : " active"}`}>
            All
          </Link>
          {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
            <Link key={k} href={`/templates?category=${k}`} className={`chip${category === k ? " active" : ""}`}>
              {v}
            </Link>
          ))}
        </nav>
        <div className="tpl-grid">
          {official.map((t) => (
            <Card key={t.slug} t={t} />
          ))}
        </div>
        {community.length > 0 ? (
          <>
            <h2>Community</h2>
            <div className="tpl-grid">
              {community.map((t) => (
                <Card key={t.slug} t={t} />
              ))}
            </div>
          </>
        ) : null}
        <p className="small faint">
          Built a flow worth sharing? Open it in the app and use “Share as template”: your connections, URLs and spreadsheets are never included.
        </p>
      </main>
    </div>
  );
}
