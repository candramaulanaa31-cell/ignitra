import Link from "next/link";
import { OFFICIAL_TEMPLATES, formatInTimeZone } from "@ignitra/core";
import { LiveDemo, type DemoData } from "@/components/live-demo";
import { SiteHeader } from "@/components/site-header";
import { label } from "@/lib/format";
import { serverGet } from "@/lib/server-api";

// Regenerated at most every 5 s however many people visit (the live demo then polls on the client).
export const revalidate = 5;

interface Health {
  status: "ok" | "degraded";
  version: string;
  chain: { id: number; name: string };
  listener?: { status: string; head?: number };
}

function Status({ ok, text }: { ok: boolean | null; text: string }) {
  return <span className={`badge ${ok === null ? "s-skip" : ok ? "s-ok" : "s-fail"}`}>{text}</span>;
}

const EXAMPLE = [
  { kind: "WHEN", text: "Token transfer · token 0x7F3a…cA91" },
  { kind: "IF", text: "percent_of_supply ≥ 0.5" },
  { kind: "THEN", text: 'Telegram → #alerts  ("🔥 {{trigger.amount_formatted}} {{trigger.token.symbol}}")' },
  { kind: "THEN", text: 'Google Sheets → "Buys" tab' },
  { kind: "THEN", text: "Webhook → https://myapp.com (signed, idempotent, retried)" },
];

const FEATURED = ["big-buy-telegram", "new-holder-sheets", "treasury-low-email", "proxy-upgraded-webhook", "daily-supply-sheets", "whale-sell-push"];

export default async function Home() {
  const [answer, demo] = await Promise.all([serverGet<Partial<Health>>("/health", 10), serverGet<{ data: DemoData }>("/v1/demo", 5)]);
  // Only IGNITRA's own answer counts: another service on API_URL's port is "unreachable", not a crash.
  const health = answer && typeof answer.version === "string" && typeof answer.chain?.name === "string" && typeof answer.chain.id === "number" ? (answer as Health) : null;
  const featured = FEATURED.map((s) => OFFICIAL_TEMPLATES.find((t) => t.slug === s)).filter((t) => t !== undefined);
  return (
    <div className="wrap">
      <SiteHeader />
      <main className="landing stack" style={{ maxWidth: 960, gap: 18 }}>
        <div>
          <h1>When the chain moves, everything follows.</h1>
          <p className="lede">
            IGNITRA connects anything that happens on Robinhood Chain to the tools you already use: Telegram, webhooks, email, Google Sheets, any HTTP API, push notifications. No bot to run. Every run traceable.
          </p>
          <div className="row" style={{ marginTop: 16 }}>
            <Link href="/templates" className="btn primary">
              Start from a template
            </Link>
            <Link href="/app/flows/new" className="btn">
              Build a flow
            </Link>
            <Link href="/docs" className="btn ghost">
              Read the docs
            </Link>
          </div>
        </div>

        {demo?.data ? (
          <LiveDemo initial={demo.data} />
        ) : (
          <section className="card">
            <div className="card-head">
              <span className="label">How a flow reads</span>
            </div>
            <div className="card-body">
              <pre className="json outline">
                {EXAMPLE.map((l, i) => (
                  <span key={i}>
                    <span className="kw">{l.kind.padEnd(5)}</span> {l.text}
                    {"\n"}
                  </span>
                ))}
              </pre>
            </div>
          </section>
        )}

        <h2>Ready in two minutes</h2>
        <div className="tpl-grid">
          {featured.map((t) => (
            <Link key={t.slug} href={`/templates/${t.slug}`} className="card tpl-card">
              <div className="card-body stack" style={{ gap: 6 }}>
                <strong>{t.name}</strong>
                <span className="small muted">{t.summary}</span>
                <span className="small mono faint">
                  {label((t.definition as { trigger: { type: string } }).trigger.type)} →{" "}
                  {(t.definition as { actions: Array<{ type: string }> }).actions.map((a) => label(a.type)).join(" + ")}
                </span>
              </div>
            </Link>
          ))}
        </div>
        <Link href="/templates" className="small">
          All templates →
        </Link>

        <h2>Why it holds up</h2>
        <dl className="card kv">
          <dt>Every run is traceable</dt>
          <dd>Trigger evidence (tx, block, log), each condition with its actual value, every request and response.</dd>
          <dt>Exactly-once intent</dt>
          <dd>One run per event (a unique key in the database); the same idempotency key on every retry.</dd>
          <dt>Reorg-safe</dt>
          <dd>Confirmed events by default. Fast mode records reorgs and tells your webhooks.</dd>
          <dt>No custody</dt>
          <dd>Sign in with your wallet. IGNITRA never asks for a private key.</dd>
          <dt>Safe by default</dt>
          <dd>Secrets encrypted, outbound requests guarded against SSRF, runaway flows pause themselves.</dd>
        </dl>

        <h2>System status</h2>
        <dl className="card kv">
          <dt>API</dt>
          <dd>{health ? <Status ok={health.status === "ok"} text={`${health.status} · v${health.version}`} /> : <Status ok={false} text="unreachable" />}</dd>
          <dt>Chain listener</dt>
          <dd>
            {health?.listener && health.listener.status !== "unknown" ? (
              <Status ok={health.listener.status === "ok"} text={`${health.listener.status}${health.listener.head ? ` · head ${health.listener.head.toLocaleString("en-US")}` : ""}`} />
            ) : (
              <Status ok={null} text="unknown" />
            )}
          </dd>
          <dt>Chain</dt>
          <dd className="mono">{health ? `${health.chain.name} (${health.chain.id})` : "Robinhood Chain (4663)"}</dd>
          <dt>Last checked</dt>
          <dd className="mono">{formatInTimeZone(new Date())}</dd>
        </dl>

        <footer className="site row" style={{ justifyContent: "space-between" }}>
          <span>One event. Every action.</span>
          <span className="row">
            <Link href="/templates">Templates</Link>
            <Link href="/docs">Docs</Link>
          </span>
        </footer>
      </main>
    </div>
  );
}
