import Link from "next/link";
import { formatInTimeZone } from "@ignitra/core";

export const dynamic = "force-dynamic";

interface Health {
  status: "ok" | "degraded";
  version: string;
  chain: { id: number; name: string };
  db: { driver: string; status: "ok" | "error"; latency_ms?: number };
  listener?: { status: string; head?: number; lag_blocks?: number };
}

async function fetchHealth(): Promise<Health | null> {
  const base = process.env.API_URL ?? "http://localhost:4000";
  try {
    const res = await fetch(`${base}/health`, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

function Status({ ok, label }: { ok: boolean | null; label: string }) {
  const cls = ok === null ? "s-skip" : ok ? "s-ok" : "s-fail";
  return <span className={`badge ${cls}`}>{label}</span>;
}

const EXAMPLE = `IF   TOKEN_TRANSFER on 0x7F3a…cA91
AND  percent_of_supply >= 0.5
THEN TELEGRAM → #alerts            ("🔥 {{trigger.amount_formatted}} {{trigger.token.symbol}}")
THEN SHEETS   → "Buys" tab          (one row per buy)
THEN WEBHOOK  → https://myapp.com   (HMAC signed, idempotent, retried)`;

export default async function Home() {
  const health = await fetchHealth();
  return (
    <div className="wrap">
      <header className="topbar">
        <Link href="/" className="wordmark">
          IGNITRA<span>_</span>
        </Link>
        <nav className="nav" aria-label="Site">
          <Link href="/app">App</Link>
        </nav>
        <Link href="/app" className="btn primary sm">
          Open the app
        </Link>
      </header>
      <main className="landing">
        <h1>Onchain automation for Robinhood Chain.</h1>
        <p className="lede">
          Connect anything that happens on Robinhood Chain to the tools you already use: Telegram, webhooks, email, Google Sheets, any HTTP API, push notifications. Reliably, traceably, without running a single bot.
        </p>

        <h2>How a flow reads</h2>
        <pre className="json">{EXAMPLE}</pre>

        <h2>Why it holds up</h2>
        <dl className="card kv">
          <dt>Every run is traceable</dt>
          <dd>Trigger evidence (tx, block, log), each condition with its actual value, every request and response.</dd>
          <dt>Exactly-once intent</dt>
          <dd>One run per event (unique key), the same idempotency key on every retry.</dd>
          <dt>Reorg-safe</dt>
          <dd>Confirmed events by default; fast mode records reorgs and tells your webhooks.</dd>
          <dt>No custody</dt>
          <dd>Sign in with your wallet. IGNITRA never asks for a private key.</dd>
        </dl>

        <h2>System status</h2>
        <dl className="card kv">
          <dt>API</dt>
          <dd>{health ? <Status ok={health.status === "ok"} label={`${health.status} · v${health.version}`} /> : <Status ok={false} label="unreachable" />}</dd>
          <dt>Chain listener</dt>
          <dd>
            {health?.listener && health.listener.status !== "unknown" ? (
              <Status ok={health.listener.status === "ok"} label={`${health.listener.status}${health.listener.head ? ` · head ${health.listener.head.toLocaleString("en-US")}` : ""}`} />
            ) : (
              <Status ok={null} label="unknown" />
            )}
          </dd>
          <dt>Chain</dt>
          <dd className="mono">{health ? `${health.chain.name} (${health.chain.id})` : "—"}</dd>
          <dt>Server time</dt>
          <dd className="mono">{formatInTimeZone(new Date())}</dd>
        </dl>

        <footer className="site">One event. Every action.</footer>
      </main>
    </div>
  );
}
