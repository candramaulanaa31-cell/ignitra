import type { Metadata } from "next";
import Link from "next/link";
import { LIMITS, type FieldSpec } from "@ignitra/core";
import { Code, FieldsTable, ParamsTable, exampleFor } from "@/lib/docs";
import { serverGetCached } from "@/lib/server-api";

export const metadata: Metadata = { title: "Actions", description: "Every IGNITRA action: params, outputs, retries and how test runs are labelled." };
export const revalidate = 300;

interface Action {
  type: string;
  label: string;
  description: string;
  connection_type: string | null;
  connection_optional: boolean;
  min_plan: string;
  params_schema: unknown;
  output_fields: FieldSpec[];
}

const HTTP_EXAMPLE = {
  method: "POST",
  url: "https://api.example.com/orders/{{trigger.body.order}}",
  headers: [{ name: "X-Source", value: "ignitra" }],
  body_type: "json",
  body: '{ "wallet": "{{trigger.to}}", "amount": {{trigger.amount_decimal}} }',
  connection_id: "conn_…",
};

const NOTES: Record<string, string> = {
  TELEGRAM: "HTML formatting (<b>, <i>, <a href>, <code>…) is checked when you save; every substituted value is escaped so on-chain data cannot inject markup. Messages over Telegram's 4096 characters go out as plain text.",
  WEBHOOK: "POSTs IGNITRA's signed run.action envelope; see Webhooks. Use a URL (signed with your webhook secret) or a webhook connection (its own secret).",
  WEB_PUSH: "Notifies every device you enabled in Settings (browsers and the installed app). Skipped, not failed, when you have no devices.",
  CHAIN_READ: "eth_call against Robinhood Chain: a full function signature, arguments as literals or variables, at the latest block or the trigger's block. The result is typed for later steps.",
  HTTP_REQUEST:
    "Any method and headers, with a JSON, text or form body built from templates. Values are JSON-escaped in JSON bodies and the rendered body must parse. Requests carry X-Ignitra-Idempotency-Key and are signed like webhooks (over the raw body) unless sign is false. API keys belong in an HTTP connection: encrypted, and only ever sent to its host.",
  EMAIL: "Sent from IGNITRA's address to an email connection you verified with a code. Plain text with a safe HTML version.",
  GOOGLE_SHEETS: "Appends one row: one template per column. Values that would start a formula (=, +, -, @) are written as text. Add {{run.idempotency_key}} as a column to deduplicate retries.",
};

export default async function ActionsPage() {
  const res = await serverGetCached<{ data: Action[] }>("/v1/actions", 300);
  const actions = res?.data ?? [];
  return (
    <>
      <h1>Actions</h1>
      <p>
        Actions run in order (up to {LIMITS.maxActions} per flow). Each one sees the trigger data and the outputs of the steps before it as <code>{"{{steps.<step_id>.…}}"}</code>. A step that fails permanently does not stop
        the next ones: the run ends <code>partial</code> (or <code>failed</code> when nothing went out), and the trace shows exactly which step failed and why.
      </p>
      <h2>Delivery</h2>
      <ul>
        <li>
          Temporary failures (timeouts, network errors, 408, 425, 429 and 5xx) are retried after about 10 s, 30 s, 90 s… (×3 each time with jitter, capped at 15 min; a <code>Retry-After</code> of up to an hour is honoured),
          five attempts in total. Other 4xx answers and redirects are permanent: redirects are never followed.
        </li>
        <li>
          Every attempt of a step carries the same idempotency key, <code>&lt;run key&gt;:&lt;step id&gt;</code>, so receivers can deduplicate.
        </li>
        <li>After five failed runs in a row, the flow pauses itself and you get a notice.</li>
        <li>
          <strong>Test runs</strong> say so everywhere: <code>🧪 TEST</code> before Telegram messages, <code>[TEST]</code> in email subjects and push titles, <code>&quot;test&quot;: true</code> in webhook envelopes,{" "}
          <code>X-Ignitra-Test: true</code> on webhooks and HTTP requests, and a trailing <code>🧪 TEST run</code> cell in Google Sheets rows.
        </li>
      </ul>
      <ul className="small">
        {actions.map((a) => (
          <li key={a.type}>
            <a href={`#${a.type}`}>{a.label}</a> <span className="mono faint">{a.type}</span>
          </li>
        ))}
      </ul>
      {actions.length === 0 ? <p className="muted">The live catalog is unavailable right now; try again in a minute.</p> : null}
      {actions.map((a) => {
        const example = a.type === "HTTP_REQUEST" ? { template: null, params: HTTP_EXAMPLE } : exampleFor("action", a.type);
        return (
          <section key={a.type} id={a.type}>
            <h2>{a.label}</h2>
            <p className="small mono faint">
              {a.type}
              {a.connection_type ? ` · connection: ${a.connection_type}${a.connection_optional ? " (optional)" : ""}` : ""}
              {a.min_plan !== "free" ? ` · ${a.min_plan} plan` : ""}
            </p>
            <p>{a.description}</p>
            {NOTES[a.type] ? <p className="small muted">{NOTES[a.type]}</p> : null}
            <h3>Params</h3>
            <ParamsTable schema={a.params_schema} />
            {example ? (
              <>
                <h3>Example</h3>
                <Code>{JSON.stringify({ step_id: a.type.toLowerCase(), type: a.type, params: example.params }, null, 2)}</Code>
                {example.template ? (
                  <p className="small faint">
                    From the <Link href={`/templates/${example.template}`}>{example.template}</Link> template.
                  </p>
                ) : null}
              </>
            ) : null}
            <h3>Output</h3>
            <FieldsTable fields={a.output_fields} prefix={`steps.${a.type.toLowerCase()}.`} />
          </section>
        );
      })}
    </>
  );
}
