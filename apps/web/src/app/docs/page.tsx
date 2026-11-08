import type { Metadata } from "next";
import Link from "next/link";
import { PLAN_LIMITS } from "@ignitra/core";
import { Code } from "@/lib/docs";

export const metadata: Metadata = { title: "Docs", description: "How IGNITRA flows work: triggers, conditions, actions, variables, webhooks and the API." };

export default function DocsHome() {
  return (
    <>
      <h1>IGNITRA docs</h1>
      <p>
        IGNITRA runs <strong>flows</strong> for you: when something happens on Robinhood Chain (chain id 4663), it checks your conditions and runs your actions. You never run a bot or a server, and every run keeps a trace that
        explains what happened.
      </p>
      <Code>{`FLOW = TRIGGER → CONDITIONS → ACTIONS

WHEN  Token transfer · token 0x5fc5…d168       ← trigger: what starts a run
IF    percent_of_supply ≥ 0.5                   ← conditions: filters on the trigger data
AND   is_mint = false
THEN  Read contract → balanceOf(address)        ← actions, in order; later ones use
THEN  Telegram → "🔥 {{trigger.amount_formatted}} {{trigger.token.symbol}}"   earlier outputs`}</Code>

      <h2>Quick start</h2>
      <ol>
        <li>
          <strong>Sign in</strong> with your wallet at <Link href="/app">/app</Link>. You sign a message (Sign-In with Ethereum): no transaction, no gas, no private key ever leaves your wallet.
        </li>
        <li>
          <strong>Add a connection</strong> (where messages go): a Telegram chat, a webhook, an email address, a Google account or HTTP secret headers. Secrets are stored encrypted and never shown again.
        </li>
        <li>
          <strong>Pick a template</strong> from the <Link href="/templates">gallery</Link>, or build a flow from scratch. Paste an address and IGNITRA detects the token or contract.
        </li>
        <li>
          <strong>Test it</strong>: “Load the latest real event” shows real data from the chain, and “Test flow” runs the actions once with it. Test runs are labelled TEST and never count towards your plan.
        </li>
        <li>
          <strong>Activate.</strong> Runs appear in the flow&apos;s history with a step-by-step trace, and “Why it did not run” lists matches the conditions or limits filtered out.
        </li>
      </ol>

      <h2>Guarantees</h2>
      <table className="table card">
        <tbody>
          <tr>
            <td>Traceable</td>
            <td>Every run stores the trigger evidence (transaction, block, log index), each condition with its actual value, and every action attempt with its request summary, response, duration and status.</td>
          </tr>
          <tr>
            <td>Exactly-once intent</td>
            <td>
              One run per event and flow: the database enforces a unique key such as <code>4663:&lt;tx hash&gt;:&lt;log index&gt;:&lt;flow id&gt;</code>. Restarts and replays never run a flow twice for the same event.
            </td>
          </tr>
          <tr>
            <td>At-least-once delivery</td>
            <td>
              Actions are retried with backoff. Every retry carries the same <code>X-Ignitra-Idempotency-Key</code>, so receivers can deduplicate.
            </td>
          </tr>
          <tr>
            <td>Reorg-safe</td>
            <td>Flows run on confirmed events by default. In fast mode, a run whose event is reorged out is marked, and webhooks get a signed <code>run.reverted</code> notice.</td>
          </tr>
          <tr>
            <td>Safe by default</td>
            <td>Outbound requests cannot reach private networks (SSRF guard, DNS pinning, no redirects), templates cannot run code, and a flow far over its hourly cap pauses itself.</td>
          </tr>
        </tbody>
      </table>

      <h2>Plans</h2>
      <table className="table card">
        <thead>
          <tr>
            <th>Plan</th>
            <th>Active flows</th>
            <th>Runs / month</th>
            <th>Includes</th>
          </tr>
        </thead>
        <tbody>
          {(["free", "builder", "team"] as const).map((plan) => {
            const l = PLAN_LIMITS[plan];
            return (
              <tr key={plan}>
                <td className="mono">{plan}</td>
                <td>{l.activeFlows ?? "unlimited"}</td>
                <td>
                  {l.runsPerMonth.toLocaleString("en-US")}
                  {l.overage ? " + metered overage" : " (then matches wait for next month)"}
                </td>
                <td className="small">{plan === "free" ? "Telegram, webhooks, Web Push, HTTP requests, contract reads, every chain trigger, inbound webhooks" : plan === "builder" ? "+ email, Google Sheets, schedules (every minute)" : "everything in Builder, with unlimited active flows"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="small muted">Usage resets on the 1st of each month (UTC). Test runs are never counted.</p>

      <h2>Conventions</h2>
      <ul>
        <li>Times are stored in UTC and shown in your timezone (WIB, Asia/Jakarta, by default). Template variables offer both, e.g. <code>{"{{trigger.time.iso}}"}</code> and <code>{"{{now_wib}}"}</code>.</li>
        <li>Addresses and hashes are lowercase hex in data and conditions. Comparisons with hex values are case-insensitive.</li>
        <li>
          Token amounts come three ways: <code>amount</code> in raw base units (exact), <code>amount_decimal</code> in token units (exact) and <code>amount_formatted</code> for display.
        </li>
      </ul>

      <h2>Reference</h2>
      <ul>
        <li>
          <Link href="/docs/triggers">Triggers</Link>: every trigger, its params and the data it provides.
        </li>
        <li>
          <Link href="/docs/conditions">Conditions</Link>: operators, AND / OR groups and exact semantics.
        </li>
        <li>
          <Link href="/docs/actions">Actions</Link>: every action, its params, outputs, retries and TEST labels.
        </li>
        <li>
          <Link href="/docs/variables">Variables</Link>: the <code>{"{{…}}"}</code> template language.
        </li>
        <li>
          <Link href="/docs/webhooks">Webhooks</Link>: signatures, the envelope, idempotency, and inbound webhooks.
        </li>
        <li>
          <Link href="/docs/integrations">Integrations</Link>: VIGIL alerts, TRUST LAYER scores, MANDATE policies, Pons launches.
        </li>
        <li>
          <Link href="/docs/onchain">Onchain actions</Link>: transactions from your Safe through a scoped, revocable session key.
        </li>
        <li>
          <Link href="/docs/api">API</Link>: sign-in, endpoints, errors.
        </li>
        <li>
          <Link href="/docs/sdk">SDK &amp; API keys</Link>: <code>@ignitra/sdk</code>, keys and rate limits.
        </li>
      </ul>
    </>
  );
}
