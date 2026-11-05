import { formatInTimeZone } from "@ignitra/core";

export const dynamic = "force-dynamic";

interface Health {
  status: "ok" | "degraded";
  version: string;
  chain: { id: number; name: string };
  db: { driver: string; status: "ok" | "error"; latency_ms?: number };
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
  const cls = ok === null ? "status-skip" : ok ? "status-ok" : "status-fail";
  return <span className={`status ${cls}`}>{label}</span>;
}

const EXAMPLE = `IF   TOKEN_TRANSFER on 0x7F3a…cA91
AND  percent_of_supply >= 0.5
THEN DISCORD  → #alerts
THEN WEBHOOK  → https://myapp.com/hook   (HMAC signed, idempotent)`;

export default async function Home() {
  const health = await fetchHealth();

  return (
    <main>
      <h1>Onchain automation for Robinhood Chain.</h1>
      <p className="lede">
        Connect anything that happens on Robinhood Chain to the tools you already use — reliably, traceably, without
        running a single bot.
      </p>

      <h2>How a flow reads</h2>
      <pre className="panel">{EXAMPLE}</pre>

      <h2>System status</h2>
      <dl className="panel kv">
        <dt>API</dt>
        <dd>
          {health ? (
            <Status ok={health.status === "ok"} label={`${health.status} · v${health.version}`} />
          ) : (
            <Status ok={false} label="unreachable" />
          )}
        </dd>
        <dt>Database</dt>
        <dd>
          {health ? (
            <Status
              ok={health.db.status === "ok"}
              label={`${health.db.driver} · ${health.db.status}${health.db.latency_ms !== undefined ? ` · ${health.db.latency_ms} ms` : ""}`}
            />
          ) : (
            <Status ok={null} label="unknown" />
          )}
        </dd>
        <dt>Chain</dt>
        <dd>{health ? `${health.chain.name} (${health.chain.id})` : "—"}</dd>
        <dt>Server time</dt>
        <dd>{formatInTimeZone(new Date())}</dd>
      </dl>

      <footer>One event. Every action.</footer>
    </main>
  );
}
