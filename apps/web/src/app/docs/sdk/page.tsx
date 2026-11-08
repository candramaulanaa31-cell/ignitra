import type { Metadata } from "next";
import Link from "next/link";
import { Code } from "@/lib/docs";

export const metadata: Metadata = { title: "SDK & API keys", description: "The @ignitra/sdk TypeScript SDK, API keys and rate limits." };

const WEB_URL = (process.env.WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");

const SETUP = `npm install @ignitra/sdk

import { Ignitra } from "@ignitra/sdk";

const ignitra = new Ignitra({
  apiKey: process.env.IGNITRA_API_KEY, // igk_… (or set IGNITRA_API_KEY)
  baseUrl: "${WEB_URL}/api",           // or set IGNITRA_API_URL
});`;

const FLOW = `const flow = await ignitra.flows.create({
  name: "Big buys → my server",
  trigger: { type: "TOKEN_TRANSFER", params: { token: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" } },
  conditions: { all: [{ field: "percent_of_supply", op: ">=", value: 1 }] },
  actions: [{ type: "WEBHOOK", params: { url: "https://myapp.com/hook" } }], // step_id: "webhook"
  activate: true,
});

for await (const run of ignitra.flows.iterateRuns(flow.id)) {
  if (run.status === "failed") console.log(run.id, (await ignitra.runs.get(run.id)).steps);
}`;

const ERRORS = `import { IgnitraApiError, IgnitraNetworkError } from "@ignitra/sdk";

try {
  await ignitra.flows.create(input);
} catch (err) {
  if (err instanceof IgnitraApiError && err.status === 422) {
    for (const issue of err.issues) console.log(issue.path, issue.message);
  }
  throw err;
}`;

const VERIFY = `import { parseWebhook, IgnitraSignatureError } from "@ignitra/sdk";

// Express: app.post("/ignitra", express.text({ type: "application/json" }), handler)
async function handler(req, res) {
  let event;
  try {
    event = await parseWebhook(req.body, req.headers, process.env.IGNITRA_WEBHOOK_SECRET);
  } catch (err) {
    if (err instanceof IgnitraSignatureError) return res.sendStatus(401);
    throw err;
  }
  // At-least-once: ignore an X-Ignitra-Idempotency-Key you have handled before.
  res.sendStatus(200);
}`;

const LIMITS: Array<[string, string]> = [
  ["API key", "600 requests per minute per key (token bucket)"],
  ["Wallet session", "600 requests per minute per account"],
  ["Public routes", "300 per minute per client address (catalogs, templates, sign-in); the landing page's live demo has its own budget"],
  ["Inbound webhooks, VIGIL deliveries", "Per hook or connection; failed lookups (unknown URL, bad token or signature) also cost the sender's address 120 per minute"],
];

export default function SdkPage() {
  return (
    <>
      <h1>SDK &amp; API keys</h1>
      <p>
        <code>@ignitra/sdk</code> is the TypeScript client for the <Link href="/docs/api">API</Link>: flows, runs and their traces, connections, templates, and verification of the webhooks IGNITRA sends you. It has no dependencies and runs
        in Node 20+, Deno, Bun, browsers and edge runtimes.
      </p>

      <h2>API keys</h2>
      <ul>
        <li>
          Create one under <Link href="/app/settings">Settings → API keys</Link> (Team plan). It looks like <code>igk_…</code> and is shown once: IGNITRA stores only its hash.
        </li>
        <li>
          Send it as <code>Authorization: Bearer igk_…</code>. A key acts as your account, except for what needs your wallet: creating keys, and creating or verifying onchain grants. Revoking a grant works with a key (stopping things should
          be easy).
        </li>
        <li>Revoke a key in Settings: anything using it stops at once. Keep keys on servers, never in a browser or a repository.</li>
        <li>
          On any plan, a wallet session token (<code>igs_…</code>, from <code>POST /v1/auth/verify</code> with <code>return_token: true</code>) works the same way.
        </li>
      </ul>

      <h2>Set up</h2>
      <Code>{SETUP}</Code>

      <h2>Flows and runs</h2>
      <p>
        Steps without a <code>step_id</code> are named for you (<code>webhook</code>, <code>webhook_2</code>, …). <code>iterateRuns</code> pages through every run as you go.
      </p>
      <Code>{FLOW}</Code>
      <table className="table card">
        <tbody>
          {[
            ["flows.list / get / create / update / delete", "A new definition becomes a new version"],
            ["flows.pause / resume / validate / test", "test runs once with the latest real event, labelled TEST"],
            ["flows.runs / iterateRuns / evaluations", "Runs newest first; evaluations say why something did not run"],
            ["runs.get", "The full trace: trigger evidence, every condition, every step attempt"],
            ["connections.list / create / delete / verify / setVigilSecret", "Secrets go in and never come out"],
            ["templates.list / get / use / publish / mine / delete", "The template gallery"],
            ["catalog.triggers / actions, account.me / usage / webhookSecret", "Catalogs and your account"],
          ].map(([call, what]) => (
            <tr key={call}>
              <td className="mono small">{call}</td>
              <td className="small">{what}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Errors and retries</h2>
      <p>
        <code>IgnitraApiError</code> carries <code>status</code>, <code>code</code>, <code>issues</code> (on 422), <code>details</code> and <code>retryAfter</code>. <code>IgnitraNetworkError</code> means no answer arrived. A 429 is retried
        after <code>Retry-After</code>; 502, 503, 504 and network errors are retried only for requests that are safe to repeat.
      </p>
      <Code>{ERRORS}</Code>

      <h2>Verify webhooks</h2>
      <p>
        Verify over the raw body, before parsing JSON. On edge runtimes, pass the <code>Request</code>&apos;s headers and <code>await request.text()</code>. See <Link href="/docs/webhooks">Webhooks</Link> for the format.
      </p>
      <Code>{VERIFY}</Code>

      <h2>Rate limits</h2>
      <p>
        Answers carry <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and <code>RateLimit-Reset</code>; a 429 adds <code>Retry-After</code> (seconds).
      </p>
      <table className="table card">
        <tbody>
          {LIMITS.map(([who, limit]) => (
            <tr key={who}>
              <td className="small">{who}</td>
              <td className="small">{limit}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
