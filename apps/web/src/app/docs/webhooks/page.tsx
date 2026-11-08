import type { Metadata } from "next";
import Link from "next/link";
import { Code } from "@/lib/docs";
import { CURL_INBOUND, NODE_EXPRESS, NODE_VERIFY, PYTHON_VERIFY } from "@/lib/webhook-snippets";

export const metadata: Metadata = { title: "Webhooks", description: "Signed outbound webhooks, run.reverted notices and inbound webhook triggers." };

const ENVELOPE = `{
  "type": "run.action",
  "run_id": "run_…",
  "flow_id": "fl_…",
  "flow": { "id": "fl_…", "name": "Big USDG buys", "version": 3 },
  "step_id": "notify",
  "idempotency_key": "4663:0x…:12:fl_…:notify",
  "run_idempotency_key": "4663:0x…:12:fl_…",
  "test": false,
  "attempt": 1,
  "trigger": {
    "tx_hash": "0x…",
    "block_number": 1234567,
    "log_index": 12,
    "from": "0x…",
    "to": "0x…",
    "amount_decimal": "25000",
    "token": { "address": "0x…", "symbol": "USDG", "decimals": 6 },
    "explorer_url": "https://…/tx/0x…"
    // … every data field of the trigger (see Triggers)
  },
  "sent_at": "2026-11-07T02:00:00.000Z"
}`;

const REVERTED = `{
  "type": "run.reverted",
  "run_id": "run_…",
  "flow_id": "fl_…",
  "step_id": "notify",
  "idempotency_key": "4663:0x…:12:fl_…:notify",
  "reason": "reorg",
  "reverted_at": "2026-11-07T02:00:41.000Z",
  "trigger": { "tx_hash": "0x…", "block_number": 1234567 },
  "sent_at": "2026-11-07T02:00:42.000Z"
}`;

const HEADERS: Array<[string, string]> = [
  ["X-Ignitra-Signature", 'v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>; several, comma-separated, while a secret rotates'],
  ["X-Ignitra-Timestamp", "Unix seconds when the request was signed. Reject anything more than 5 minutes off (replays)."],
  ["X-Ignitra-Idempotency-Key", "<run key>:<step id>, identical on every retry: deduplicate on it"],
  ["X-Ignitra-Delivery", "A fresh UUID per attempt, for your logs"],
  ["X-Ignitra-Event", "run.action or run.reverted"],
  ["X-Ignitra-Test", "true on TEST runs (also \"test\": true in the body)"],
];

const RESPONSES: Array<[string, string]> = [
  ["202", '{ "accepted": true, "duplicate": false, "request_id": "req_…" }: stored, the flow runs on it'],
  ["202 (duplicate)", "the Idempotency-Key was seen before: same request_id, no second run"],
  ["404", "unknown flow or wrong token (deliberately the same answer)"],
  ["409", "the flow is paused: resume it to accept requests"],
  ["402", "the owner's free plan has used this month's runs (nothing would run)"],
  ["413", "the body is over 64 KB"],
  ["429", "over the hook's rate (per minute) or the daily intake cap; honour Retry-After"],
];

export default function WebhooksPage() {
  return (
    <>
      <h1>Webhooks</h1>
      <p>
        Webhooks go both ways: the <strong>Webhook</strong> action sends signed events to your server, and the <strong>Inbound webhook</strong> trigger gives a flow its own URL that anything can POST to.
      </p>

      <h2>Outbound: the envelope</h2>
      <p>
        Every Webhook step POSTs one JSON document with the run and the full trigger data. The format is fixed and versioned by <code>type</code>; for a body of your own, use the{" "}
        <Link href="/docs/actions#HTTP_REQUEST">HTTP request</Link> action.
      </p>
      <Code>{ENVELOPE}</Code>

      <h2>Headers</h2>
      <table className="table card">
        <tbody>
          {HEADERS.map(([h, what]) => (
            <tr key={h}>
              <td className="mono">{h}</td>
              <td className="small">{what}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Which secret signs</h2>
      <ul>
        <li>
          <strong>A URL in the step</strong>: your account&apos;s webhook secret, under <Link href="/app/settings">Settings</Link>. Every inline-URL webhook of yours uses it.
        </li>
        <li>
          <strong>A webhook connection</strong>: that connection&apos;s own secret, shown once when you add it. Copy it then; IGNITRA stores it encrypted and never shows it again.
        </li>
        <li>
          <strong>HTTP requests</strong> are signed the same way (over the raw body, an empty string for GET) unless the step sets <code>&quot;sign&quot;: false</code>.
        </li>
      </ul>

      <h2>Verify the signature</h2>
      <p>
        Compute the HMAC over the <em>raw</em> body as received: parsing and re-serialising JSON changes the bytes. Compare in constant time and check the timestamp.
      </p>
      <h3>Node.js</h3>
      <Code>{NODE_VERIFY}</Code>
      <Code>{NODE_EXPRESS}</Code>
      <h3>Python</h3>
      <Code>{PYTHON_VERIFY}</Code>

      <h2>Retries and idempotency</h2>
      <ul>
        <li>Answer with any 2xx within 10 seconds. Do slow work after answering.</li>
        <li>
          Timeouts, network errors, 408, 425, 429 and 5xx are retried with backoff (about 10 s, 30 s, 90 s…, five attempts); <code>Retry-After</code> is honoured. Other 4xx answers are final.
        </li>
        <li>Redirects are not followed: point the webhook at the final URL.</li>
        <li>
          Delivery is at-least-once: a retry, or a crash between your answer and IGNITRA recording it, can deliver the same step again. Store <code>X-Ignitra-Idempotency-Key</code> and ignore repeats.
        </li>
        <li>
          After the last attempt the step is a dead letter: it shows under Needs attention on the dashboard. Once your receiver is fixed, Retry sends it again with the same <code>X-Ignitra-Idempotency-Key</code>; the run&apos;s other
          steps that already delivered are not sent again.
        </li>
        <li>
          Your answer is recorded in the run trace (status, timing, the first 500 characters), and a JSON answer is available to later steps as <code>{"{{steps.<step_id>.body}}"}</code>.
        </li>
        <li>Webhook URLs must be public: private, loopback and link-local addresses are refused, also when a hostname resolves to one.</li>
      </ul>

      <h2>run.reverted</h2>
      <p>
        By default flows run on confirmed blocks, which are not reorganised in practice. In <strong>fast mode</strong>, a flow runs on the newest block; if that block is reorganised away, every webhook the run delivered receives a signed
        notice. Undo whatever the original event did, matching on <code>idempotency_key</code>. A notice is sent once and its delivery is recorded on the run.
      </p>
      <p className="small muted">
        <code>reason</code> is <code>reorg</code> (the unconfirmed block was replaced) or <code>deep_reorg</code> (an already confirmed block was replaced, which should not happen in practice).
      </p>
      <Code>{REVERTED}</Code>

      <h2>Inbound webhooks</h2>
      <p>
        A flow with the <Link href="/docs/triggers#INBOUND_WEBHOOK">Inbound webhook</Link> trigger gets a URL of its own, shown on the flow page. The token in it is the credential: keep it private, and rotate it on the flow page (or{" "}
        <code>POST /v1/flows/:id/hook/rotate</code>) if it leaks, which invalidates the old URL at once.
      </p>
      <Code>{CURL_INBOUND}</Code>
      <ul>
        <li>
          Send JSON, form fields or text (up to 64 KB). JSON and forms become <code>{"{{trigger.body.…}}"}</code>; text arrives as <code>{"{{trigger.body.text}}"}</code>. Query parameters are under{" "}
          <code>trigger.query</code>.
        </li>
        <li>
          Non-sensitive headers (content type, user agent, and <code>X-…</code> headers that do not look like credentials) are kept as <code>trigger.headers</code>, with dashes as underscores: <code>x_order_source</code>.
        </li>
        <li>
          Send an <code>Idempotency-Key</code> header (1–200 characters) to make retries safe: a repeated key never creates a second run.
        </li>
        <li>Each hook accepts 60 requests per minute and 5,000 per day.</li>
      </ul>
      <table className="table card">
        <tbody>
          {RESPONSES.map(([code, what]) => (
            <tr key={code}>
              <td className="mono">{code}</td>
              <td className="small">{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
