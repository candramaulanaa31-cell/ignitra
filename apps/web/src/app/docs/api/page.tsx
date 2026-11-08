import type { Metadata } from "next";
import Link from "next/link";
import { EVALUATION_OUTCOMES, RUN_STATUSES } from "@ignitra/core";
import { Code } from "@/lib/docs";
import { SIWE_SIGN_IN } from "@/lib/api-snippets";

export const metadata: Metadata = { title: "API", description: "Manage flows, runs, connections, templates and onchain grants over HTTP, with an API key or your wallet." };

const WEB_URL = (process.env.WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");

type Row = [method: string, path: string, what: string];

const GROUPS: Array<{ title: string; note?: string; rows: Row[] }> = [
  {
    title: "Public (no sign-in)",
    rows: [
      ["GET", "/v1/triggers", "Trigger catalog: params schema and data fields of every trigger"],
      ["GET", "/v1/actions", "Action catalog: params schema and outputs of every action"],
      ["GET", "/v1/templates?category=", "Template gallery (official and public community templates)"],
      ["GET", "/v1/templates/:slug", "One template: placeholders, definition and outline"],
      ["POST", "/v1/hooks/:flow_id/:token", "Inbound webhook: see Webhooks"],
      ["POST", "/v1/integrations/vigil/:connection_id", "VIGIL alert deliveries, signed by VIGIL: see Integrations"],
    ],
  },
  {
    title: "Sign-in",
    rows: [
      ["GET", "/v1/auth/nonce", "A single-use nonce (10 minutes), the accepted domains and the chain id"],
      ["POST", "/v1/auth/verify", "{ message, signature, return_token? }: starts a session"],
      ["POST", "/v1/auth/logout", "Ends the session"],
    ],
  },
  {
    title: "API keys",
    note: "Managing keys needs a wallet session: a key can not create keys.",
    rows: [
      ["GET", "/v1/api-keys", "Your keys: name, prefix, rate, last use (never the key)"],
      ["POST", "/v1/api-keys", "{ name }: a new key (Team plan), returned once as key"],
      ["DELETE", "/v1/api-keys/:id", "Revokes a key at once"],
    ],
  },
  {
    title: "Account",
    rows: [
      ["GET", "/v1/me", "You: address, plan and its limits, timezone"],
      ["PATCH", "/v1/me", "{ timezone }: an IANA zone such as Asia/Jakarta"],
      ["GET", "/v1/me/usage", "Runs this month against the plan"],
      ["GET", "/v1/me/webhook-secret", "The secret that signs your inline-URL webhooks"],
      ["GET", "/v1/notifications", "Notices such as auto-pauses"],
      ["GET", "/v1/audit-log?limit=&before=", "Every change to the account, newest first: who (your wallet, which API key, the operator or IGNITRA itself), what, and from which address"],
    ],
  },
  {
    title: "Flows",
    rows: [
      ["GET", "/v1/flows", "Your flows with status and stats"],
      ["POST", "/v1/flows/validate", "{ definition }: validates without saving; returns the normalized definition"],
      ["POST", "/v1/flows", "{ name, definition, activate? }: creates a flow (a draft unless activate is true)"],
      ["GET", "/v1/flows/:id", "One flow with its current definition (and hook_url for inbound webhooks)"],
      ["PATCH", "/v1/flows/:id", "{ name?, definition? }: a new definition becomes a new version"],
      ["DELETE", "/v1/flows/:id", "Deletes the flow and its history"],
      ["POST", "/v1/flows/:id/pause", "Stops matching new events"],
      ["POST", "/v1/flows/:id/resume", "Re-validates and activates (the plan's active-flow limit applies)"],
      ["POST", "/v1/flows/:id/test", "{ sample? }: one TEST run with the latest real event (or your sample)"],
      ["POST", "/v1/flows/:id/hook/rotate", "A new inbound webhook URL; the old one stops working"],
    ],
  },
  {
    title: "Runs",
    rows: [
      ["GET", "/v1/flows/:id/runs?limit=&before=&status=", `Newest first, up to 200 per page; status is one of ${RUN_STATUSES.join(", ")}`],
      ["GET", "/v1/runs/:id", "The full trace: trigger evidence, every condition, every step attempt"],
      ["GET", "/v1/dead-letters?limit=&before=", "Runs whose steps failed for good (a permanent error, or every retry used up), newest first"],
      ["POST", "/v1/runs/:id/retry", "Runs a failed or partial run's failed steps again, with the same idempotency keys: delivered steps are not repeated. The flow must be active"],
      ["GET", "/v1/flows/:id/evaluations?limit=&outcome=", `“Why it did not run”: ${EVALUATION_OUTCOMES.join(", ")}`],
    ],
  },
  {
    title: "Connections",
    note: "Secrets go in and never come out: responses only carry labels and safe metadata.",
    rows: [
      ["GET", "/v1/connections", "Your connections"],
      ["POST", "/v1/connections", '{ type: "telegram" | "webhook" | "email" | "http" | "vigil" | "mandate", … }: webhook, signed http and MANDATE connections return their signing_secret once; VIGIL ones their receiver_url'],
      ["POST", "/v1/connections/:id/verify", "{ code }: confirms an email address; { webhook_secret }: the secret VIGIL showed for a receiver you registered yourself"],
      ["POST", "/v1/connections/:id/resend", "Sends a new email code"],
      ["POST", "/v1/connections/google/start", "Starts Google sign-in for Sheets; returns the URL to open"],
      ["DELETE", "/v1/connections/:id", "Deletes a connection; refused (409 connection_in_use) while a flow sends through it or its trigger listens on it (flows), or while a pending or active grant must pass it (grants)"],
    ],
  },
  {
    title: "Onchain grants",
    note: "Team plan. Creating and verifying a grant needs a wallet session; listing and revoking also work with an API key. See Onchain.",
    rows: [
      ["GET", "/v1/onchain/grants", "Your grants with their scope and status"],
      ["POST", "/v1/onchain/grants", "{ label, safe, targets, max_value_per_tx, max_value_per_day, expires_at, mandate_connection_id? }: a pending grant and the Safe transaction that approves it"],
      ["GET", "/v1/onchain/grants/:id", "One grant: the session key's gas balance, the Safe transaction while pending, recent actions"],
      ["POST", "/v1/onchain/grants/:id/verify", "{ tx_hash }: proves the mined Safe transaction grants exactly this; the grant becomes active"],
      ["POST", "/v1/onchain/grants/:id/revoke", "Stops it at once (the session key is deleted); answers the Safe transaction that also removes the role"],
      ["GET", "/v1/onchain/review", "Every grant that can still act: what it allows, the flows using it, its last 7 days, and findings (unused, stale, no MANDATE, expiring)"],
      ["POST", "/v1/onchain/grants/revoke-all", "Emergency stop: revokes every live grant at once (session keys deleted); answers one optional Safe transaction per Safe that removes the roles"],
      ["GET", "/v1/onchain/actions?grant_id=&limit=", "Every onchain action with its status, MANDATE decision and transaction hash"],
    ],
  },
  {
    title: "Templates",
    rows: [
      ["POST", "/v1/templates/:slug/instantiate", "{ values, name?, activate? }: creates a flow from a template"],
      ["POST", "/v1/templates", "{ flow_id, name, summary, description?, category, tags?, visibility? }: shares one of your flows as a template"],
      ["GET", "/v1/me/templates", "Templates you shared"],
      ["DELETE", "/v1/templates/:slug", "Unshares one of your templates"],
    ],
  },
  {
    title: "Builder helpers",
    rows: [
      ["GET", "/v1/chain/addresses/:address", "What an address is: token (symbol, decimals), contract (verified ABI) or wallet"],
      ["POST", "/v1/samples", "{ trigger, conditions? }: the latest real event for a trigger, and how the conditions treat it"],
      ["POST", "/v1/catalog/fields", "The variables available to each step of a draft"],
    ],
  },
];

export default function ApiPage() {
  return (
    <>
      <h1>API</h1>
      <p>
        Everything the app does goes through this API, so scripts can do it too. Requests and responses are JSON. The web app serves the API at <code>{WEB_URL}/api</code>: every path below goes after that, e.g.{" "}
        <code>{WEB_URL}/api/v1/flows</code>.
      </p>

      <h2>Sign in</h2>
      <p>
        Two ways in, both sent as <code>Authorization: Bearer …</code>. Scripts use an <strong>API key</strong> (<code>igk_…</code>, Team plan): create one under Settings and see <Link href="/docs/sdk">SDK &amp; API keys</Link>. On any plan, a{" "}
        <strong>wallet session</strong> works too: you sign a Sign-In with Ethereum (EIP-4361) message. Signing is free, sends no transaction and needs no funds. Smart-contract wallets work too (ERC-1271).
      </p>
      <ol>
        <li>
          <code>GET /v1/auth/nonce</code> gives a single-use nonce, the accepted <code>domains</code> and <code>chain_id</code> 4663.
        </li>
        <li>Build the message with one of those domains, a URI on it, chain id 4663 and the nonce, and sign it (personal_sign).</li>
        <li>
          <code>POST /v1/auth/verify</code> with <code>{'{ "message", "signature", "return_token": true }'}</code> returns a session token, <code>igs_…</code>.
        </li>
        <li>
          Send it as <code>Authorization: Bearer igs_…</code>. Sessions expire (see <code>expires_at</code>); sign in again then.
        </li>
      </ol>
      <Code>{SIWE_SIGN_IN}</Code>
      <p className="small muted">
        Browsers get an HttpOnly <code>ignitra_session</code> cookie instead of a token. Cookie-authenticated writes must come from the IGNITRA site itself (CSRF protection). Treat a bearer token like a password: anyone who has it acts as
        you until it expires or you log out.
      </p>

      <h2>Conventions</h2>
      <ul>
        <li>
          Ids are prefixed: <code>fl_</code> flows, <code>run_</code> runs, <code>conn_</code> connections, <code>usr_</code> users, <code>key_</code> API keys, <code>grt_</code> onchain grants, <code>oca_</code> onchain actions. Times are
          ISO-8601 UTC; addresses are lowercase.
        </li>
        <li>
          Results come wrapped in <code>data</code> (the sign-in endpoints answer flat). Runs page backwards: pass the response&apos;s <code>next_before</code> as <code>before</code> until it is null.
        </li>
        <li>
          Errors are <code>{'{ "error": { "code", "message", … } }'}</code> with a meaningful status:
        </li>
      </ul>
      <table className="table card">
        <tbody>
          <tr>
            <td className="mono">400</td>
            <td className="small">Malformed request: the message says which field.</td>
          </tr>
          <tr>
            <td className="mono">401 / 403</td>
            <td className="small">Not signed in, an expired session, or a cookie write from another site.</td>
          </tr>
          <tr>
            <td className="mono">402</td>
            <td className="small">
              <code>plan_limit_reached</code> with <code>limit</code>, <code>plan</code> and <code>max</code>: active flows, or a trigger or action your plan does not include.
            </td>
          </tr>
          <tr>
            <td className="mono">404</td>
            <td className="small">Not found, or not yours (the same answer on purpose).</td>
          </tr>
          <tr>
            <td className="mono">409</td>
            <td className="small">The request conflicts with the current state, e.g. rotating the hook of a flow that has none.</td>
          </tr>
          <tr>
            <td className="mono">422</td>
            <td className="small">
              <code>invalid_flow</code> (or <code>invalid_values</code> for templates) with <code>issues</code>: a list of <code>{'{ path, message }'}</code>, e.g. an unknown field with a suggestion.
            </td>
          </tr>
          <tr>
            <td className="mono">429</td>
            <td className="small">
              Rate limited: wait for <code>Retry-After</code> seconds. Every answer carries <code>RateLimit-Limit</code>, <code>-Remaining</code> and <code>-Reset</code> (<Link href="/docs/sdk">limits</Link>).
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Example: create a flow</h2>
      <Code>{`curl -X POST "${WEB_URL}/api/v1/flows" \\
  -H "Authorization: Bearer $IGNITRA_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Big USDG transfers",
    "activate": true,
    "definition": {
      "trigger": { "type": "TOKEN_TRANSFER", "params": { "token": "0x5fc5360d0400a0fd4f2af552add042d716f1d168" } },
      "conditions": { "all": [{ "field": "amount_decimal", "op": ">=", "value": "10000" }] },
      "actions": [{ "step_id": "notify", "type": "WEB_PUSH", "params": { "title": "Big transfer", "body": "{{trigger.amount_formatted}} {{trigger.token.symbol}}" } }]
    }
  }'`}</Code>
      <p className="small muted">
        Easier: start from a <Link href="/templates">template</Link> with <code>POST /v1/templates/:slug/instantiate</code>, which only needs the placeholder values.
      </p>

      <h2>Endpoints</h2>
      {GROUPS.map((g) => (
        <section key={g.title}>
          <h3>{g.title}</h3>
          {g.note ? <p className="small muted">{g.note}</p> : null}
          <table className="table card">
            <tbody>
              {g.rows.map(([method, path, what]) => (
                <tr key={`${method} ${path}`}>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>
                    {method}
                  </td>
                  <td className="mono small" style={{ overflowWrap: "anywhere" }}>
                    {path}
                  </td>
                  <td className="small">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
