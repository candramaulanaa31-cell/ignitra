import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OFFICIAL_TEMPLATES } from "@ignitra/core";
import { Outline, SiteHeader } from "@/components/site-header";
import { CopyButton } from "@/components/ui";
import { label, shortHex } from "@/lib/format";
import { ApiUnavailableError, serverGetCached } from "@/lib/server-api";
import { SITE_URL } from "@/lib/site";
import { CATEGORY_LABELS, officialDetail, shareOnX, type TemplateDetail } from "@/lib/template-types";

export const revalidate = 60;

// Official templates are pre-rendered at build; community ones render on first visit and are cached like these.
export function generateStaticParams(): Array<{ slug: string }> {
  return OFFICIAL_TEMPLATES.map((t) => ({ slug: t.slug }));
}

const WEB_URL = SITE_URL;

async function load(slug: string): Promise<TemplateDetail | null> {
  try {
    const res = await serverGetCached<{ data: TemplateDetail }>(`/v1/templates/${encodeURIComponent(slug)}`, 60);
    return res?.data ?? officialDetail(slug, WEB_URL);
  } catch (err) {
    // API down: official templates live in code; a community one must not be cached as missing (the error keeps the last good page).
    const official = officialDetail(slug, WEB_URL);
    if (official && err instanceof ApiUnavailableError) return official;
    throw err;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const t = await load((await params).slug);
  // A page's openGraph replaces the layout's, so it repeats the site-wide fields.
  return t ? { title: t.name, description: t.summary, openGraph: { type: "website", siteName: "IGNITRA", locale: "en_US", title: t.name, description: t.summary } } : { title: "Template not found" };
}

const TYPE_HINT: Record<string, string> = {
  address: "an address",
  decimal: "a number",
  number: "a number",
  text: "text",
  connection: "one of your connections",
  cron: "a schedule",
  url: "a URL",
  spreadsheet: "a Google spreadsheet",
  select: "a choice",
};

export default async function TemplatePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = await load(slug);
  if (!t) notFound();
  return (
    <div className="wrap">
      <SiteHeader active="templates" />
      <main className="stack" style={{ maxWidth: 860 }}>
        <div className="small muted">
          <Link href="/templates">Templates</Link> / {CATEGORY_LABELS[t.category] ?? t.category}
        </div>
        <div className="page-head" style={{ margin: 0 }}>
          <div>
            <h1>{t.name}</h1>
            <div className="sub">{t.summary}</div>
          </div>
          <div className="row">
            <a className="btn" href={shareOnX(t.share_text, t.url)} target="_blank" rel="noreferrer">
              Share on X
            </a>
            <CopyButton value={t.url} text="Copy link" />
            <Link href={`/app/templates/${t.slug}`} className="btn primary">
              Use this template
            </Link>
          </div>
        </div>
        <div className="row small">
          {t.official ? <span className="badge plain s-ok">official</span> : <span className="badge plain s-live">community · by {shortHex(t.author ?? "")}</span>}
          <span className={`badge plain ${t.min_plan === "free" ? "s-skip" : "s-partial"}`}>{t.min_plan === "free" ? "Free plan" : `${t.min_plan} plan`}</span>
          {t.uses > 0 ? <span className="faint">used {t.uses.toLocaleString("en-US")}×</span> : null}
          {t.tags.map((x) => (
            <span key={x} className="chip">
              {x}
            </span>
          ))}
        </div>
        {t.description ? <p>{t.description}</p> : null}

        <section className="card">
          <div className="card-head">
            <span className="label">How it works</span>
            <span className="small muted mono">
              {label(t.trigger_type)} → {t.action_types.map(label).join(" + ")}
            </span>
          </div>
          <div className="card-body">
            <Outline lines={t.outline} />
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <span className="label">You fill in</span>
            <span className="small muted">{t.placeholders.length} fields · about two minutes</span>
          </div>
          <dl className="kv">
            {t.placeholders.flatMap((p) => [
              <dt key={`${p.key}-t`}>{p.label}</dt>,
              <dd key={`${p.key}-d`}>
                <span className="muted">{TYPE_HINT[p.type] ?? p.type}</span>
                {p.default !== undefined ? <span className="mono"> · default {String(p.default)}</span> : null}
                {p.optional ? <span className="faint"> · optional</span> : null}
                {p.help ? <div className="small faint">{p.help}</div> : null}
              </dd>,
            ])}
          </dl>
        </section>
        <p className="small faint">
          Runs on confirmed Robinhood Chain data, never twice for the same event, with a full trace of every run. Messages and destinations stay yours: the template carries no one else&apos;s connections.
        </p>
      </main>
    </div>
  );
}
