import Link from "next/link";
import { ACTION_TYPES, OFFICIAL_TEMPLATES, TRIGGER_TYPES, formatInTimeZone } from "@ignitra/core";
import { Brand } from "@/components/brand";
import { LiveDemo, type DemoData } from "@/components/live-demo";
import { SignalPath } from "@/components/signal";
import { SiteHeader } from "@/components/site-header";
import { LABELS, label } from "@/lib/format";
import { serverGet } from "@/lib/server-api";

// Regenerated at most every 5 s however many people visit (the live demo then polls on the client).
export const revalidate = 5;

interface Health {
  status: "ok" | "degraded";
  version: string;
  chain: { id: number; name: string };
  listener?: { status: string; head?: number };
}

const EXAMPLE = [
  { kind: "WHEN", text: "Token transfer · USDG" },
  { kind: "IF", text: "amount_decimal ≥ 10,000" },
  { kind: "THEN", text: "Telegram → #desk" },
  { kind: "THEN", text: "Google Sheets → “Big moves”" },
  { kind: "THEN", text: "Webhook → your API (signed, retried)" },
];

const FEATURED = ["big-buy-telegram", "new-holder-sheets", "treasury-low-email", "proxy-upgraded-webhook", "daily-supply-sheets", "whale-sell-push"];

// Real fields of real triggers: what conditions read.
const CONDITIONS = [
  ["amount_decimal", "≥ 10,000"],
  ["percent_of_supply", "≥ 0.5"],
  ["to", "in your watchlist"],
  ["from_trust_score", "≥ 700"],
  ["body.status", "= “paid”"],
] as const;

const GUARANTEES = [
  ["One run per event", "A unique key per event and flow, in Postgres. A replayed stream or a restarted listener never runs anything twice."],
  ["Every run explains itself", "The transaction, block and log; each condition with the value it saw; every request and response. Skips and failures say why."],
  ["Confirmed by default", "Runs start after confirmations, so reorgs do not reach your tools. Fast mode acts at the head and tells your webhooks about reorgs."],
  ["Delivered, or retried", "Signed webhooks with the same idempotency key on every retry. Steps that fail for good wait for you, never repeat what succeeded."],
  ["Nothing to custody", "Sign in with your wallet. Secrets are encrypted, outbound calls guarded against SSRF, runaway flows pause themselves."],
] as const;

function Gauge({ ok, label: name, value }: { ok: boolean | null; label: string; value: string }) {
  return (
    <div className="gauge">
      <span className={`gauge-dot ${ok === null ? "idle" : ok ? "on" : "off"}`} aria-hidden="true" />
      <span className="gauge-label">{name}</span>
      <span className="gauge-value">{value}</span>
    </div>
  );
}

export default async function Home() {
  const [answer, demo] = await Promise.all([serverGet<Partial<Health>>("/health", 10), serverGet<{ data: DemoData }>("/v1/demo", 5)]);
  // Only IGNITRA's own answer counts: another service on API_URL's port is "unreachable", not a crash.
  const health = answer && typeof answer.version === "string" && typeof answer.chain?.name === "string" && typeof answer.chain.id === "number" ? (answer as Health) : null;
  const featured = FEATURED.map((s) => OFFICIAL_TEMPLATES.find((t) => t.slug === s)).filter((t) => t !== undefined);
  const triggers = TRIGGER_TYPES.filter((t) => LABELS[t]).map(label);
  const actions = ACTION_TYPES.filter((a) => LABELS[a]).map(label);
  const listener = health?.listener && health.listener.status !== "unknown" ? health.listener : null;

  return (
    <div className="wrap">
      <SiteHeader />
      <main className="landing">
        <section className="hero">
          <div className="hero-title">
            <p className="eyebrow">Onchain automation · Robinhood Chain</p>
            <h1 className="display">
              When the chain moves,
              <br />
              <span className="heat-under">everything follows.</span>
            </h1>
          </div>
          <div className="hero-copy">
            <p className="lede">
              IGNITRA turns anything that happens on Robinhood Chain into actions in the tools you already use: Telegram, webhooks, email, Google Sheets, any HTTP API, push notifications. No bot to run, and every run explains itself.
            </p>
            <div className="row hero-cta">
              <Link href="/templates" className="btn primary lg">
                Start from a template
              </Link>
              <Link href="/app/flows/new" className="btn lg">
                Build a flow
              </Link>
              <Link href="/docs" className="btn ghost">
                Read the docs →
              </Link>
            </div>
            <ul className="hero-facts">
              <li>
                <strong>{triggers.length}</strong> triggers
              </li>
              <li>
                <strong>{actions.length}</strong> actions
              </li>
              <li>
                <strong>1</strong> run per event, ever
              </li>
            </ul>
          </div>
          <div className="hero-panel">
            {demo?.data ? (
              <LiveDemo initial={demo.data} />
            ) : (
              <section className="card panel">
                <div className="card-head">
                  <span className="label">How a flow reads</span>
                </div>
                <div className="card-body">
                  <SignalPath lines={EXAMPLE} />
                </div>
              </section>
            )}
          </div>
        </section>

        <section className="block" aria-labelledby="how">
          <header className="block-head">
            <span className="index">01</span>
            <h2 id="how">How a flow reads</h2>
            <p>Three parts, always in this order. Pick them from the catalog; nothing to code.</p>
          </header>
          <div className="schematic">
            <div className="schematic-wire" aria-hidden="true" />
            <div className="schematic-col">
              <span className="col-kind">WHEN</span>
              <h3>Something happens</h3>
              <ul>
                {triggers.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
            <div className="schematic-col">
              <span className="col-kind">IF</span>
              <h3>It matters to you</h3>
              <ul className="mono-list">
                {CONDITIONS.map(([field, test]) => (
                  <li key={field}>
                    <span className="mono">{field}</span> <span className="faint">{test}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="schematic-col">
              <span className="col-kind">THEN</span>
              <h3>Your stack follows</h3>
              <ul>
                {actions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="block" aria-labelledby="templates">
          <header className="block-head">
            <span className="index">02</span>
            <h2 id="templates">Ready in two minutes</h2>
            <p>
              Templates are complete flows: fill in a token or a wallet, pick where it goes. <Link href="/templates">All templates →</Link>
            </p>
          </header>
          <div className="tpl-grid three">
            {featured.map((t) => (
              <Link key={t.slug} href={`/templates/${t.slug}`} className="card tpl-card">
                <span className="tpl-path mono">
                  {label((t.definition as { trigger: { type: string } }).trigger.type)}
                  <span className="arrow">→</span>
                  {(t.definition as { actions: Array<{ type: string }> }).actions.map((a) => label(a.type)).join(" + ")}
                </span>
                <strong className="tpl-name">{t.name}</strong>
                <span className="tpl-summary">{t.summary}</span>
              </Link>
            ))}
          </div>
        </section>

        <section className="block" aria-labelledby="holds">
          <header className="block-head">
            <span className="index">03</span>
            <h2 id="holds">Why it holds up</h2>
            <p>Automation you can leave running: the guarantees are in the database and on the chain, not in a promise.</p>
          </header>
          <ol className="guarantees">
            {GUARANTEES.map(([title, text]) => (
              <li key={title}>
                <h3>{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="block" aria-labelledby="status">
          <header className="block-head">
            <span className="index">04</span>
            <h2 id="status">System status</h2>
            <p>Checked {formatInTimeZone(new Date())}.</p>
          </header>
          <div className="instrument">
            <Gauge ok={health ? health.status === "ok" : false} label="API" value={health ? `${health.status} · v${health.version}` : "unreachable"} />
            <Gauge ok={listener ? listener.status === "ok" : null} label="Chain listener" value={listener ? `${listener.status}${listener.head ? ` · block ${listener.head.toLocaleString("en-US")}` : ""}` : "unknown"} />
            <Gauge ok={null} label="Chain" value={health ? `${health.chain.name} · ${health.chain.id}` : "Robinhood Chain · 4663"} />
          </div>
        </section>
        <section className="statement" aria-label="Get started">
          <p className="statement-line">
            One event.
            <br />
            <span className="heat-under">Every action.</span>
          </p>
          <div className="statement-side">
            <p className="muted">Start from a template, or build a flow from the catalog. Testing a flow never counts against your plan.</p>
            <div className="row">
              <Link href="/templates" className="btn primary lg">
                Start from a template
              </Link>
              <Link href="/app/flows/new" className="btn lg">
                Build a flow
              </Link>
            </div>
          </div>
        </section>
      </main>
      <footer className="site-footer">
        <div className="footer-brand">
          <Brand />
          <p className="muted">Onchain automation for Robinhood Chain. No bot to run; every run explains itself.</p>
        </div>
        <nav aria-label="Product">
          <h4>Product</h4>
          <Link href="/templates">Templates</Link>
          <Link href="/app/flows/new">Build a flow</Link>
          <Link href="/app">Open the app</Link>
        </nav>
        <nav aria-label="Developers">
          <h4>Developers</h4>
          <Link href="/docs">Docs</Link>
          <Link href="/docs/api">API</Link>
          <Link href="/docs/sdk">SDK</Link>
          <Link href="/docs/webhooks">Webhooks</Link>
        </nav>
        <nav aria-label="Chain">
          <h4>Chain</h4>
          <a href="https://robinhoodchain.blockscout.com" target="_blank" rel="noreferrer">
            Robinhood Chain · 4663
          </a>
          <a href="#status">System status</a>
          <Link href="/docs/onchain">Onchain actions</Link>
        </nav>
      </footer>
    </div>
  );
}
