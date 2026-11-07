import type { Metadata } from "next";
import { BUILTIN_TEMPLATE_VARIABLES, TEMPLATE_LIMITS } from "@ignitra/core";
import { Code } from "@/lib/docs";

export const metadata: Metadata = { title: "Variables", description: "The {{…}} template language: variables, filters and escaping." };

const FILTERS: Array<[string, string, string]> = [
  ['default: "…"', "a fallback when the value is missing, null or empty", '{{trigger.token.symbol | default: "?"}}'],
  ["short", "shortens hex: 0x5fc5…d168", "{{trigger.from | short}}"],
  ["upper / lower", "changes case", "{{trigger.token.symbol | lower}}"],
  ["truncate: N", "cuts to N characters with …", "{{trigger.body.message | truncate: 80}}"],
  ["json", "the value as JSON", "{{trigger.args | json}}"],
  ["url", "URL-encodes the value", "https://x.example/?q={{trigger.to | url}}"],
];

export default function VariablesPage() {
  return (
    <>
      <h1>Variables</h1>
      <p>Text in actions is a template: plain text with variables in double braces. Templates are pure: no code runs, only lookups and a fixed set of filters.</p>
      <Code>{`🔥 New buy: {{trigger.amount_formatted}} {{trigger.token.symbol | default: "?"}}
From {{trigger.from | short}} · balance now {{steps.read.result}}
{{trigger.explorer_url}} · {{now_wib}}`}</Code>

      <h2>What you can use</h2>
      <table className="table card">
        <tbody>
          <tr>
            <td className="mono">trigger.*</td>
            <td>The trigger&apos;s data: every path listed under each trigger in Triggers, including nested ones like token.symbol or body.order.id.</td>
          </tr>
          <tr>
            <td className="mono">steps.&lt;step_id&gt;.*</td>
            <td>The output of an earlier step, e.g. a contract read&apos;s result or a webhook&apos;s response body. Only earlier steps: no forward references.</td>
          </tr>
          {BUILTIN_TEMPLATE_VARIABLES.map((v) => (
            <tr key={v}>
              <td className="mono">{v}</td>
              <td className="small">
                {
                  {
                    "flow.id": "the flow's id",
                    "flow.name": "the flow's name",
                    "flow.version": "the flow version that ran",
                    "run.id": "the run's id",
                    "run.idempotency_key": "the run's unique key: use it to deduplicate downstream",
                    "run.test": "true for TEST runs",
                    now_utc: "when the step runs, ISO-8601 UTC",
                    now_wib: "when the step runs, in WIB",
                  }[v]
                }
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Unknown variables are rejected when you save the flow, checked against the trigger&apos;s data and the earlier steps&apos; outputs. At run time, a variable that exists but is null renders as empty text; one that does
        not exist fails the step (unless it has a <code>default</code>), so a typo never sends a half-empty message.
      </p>

      <h2>Filters</h2>
      <table className="table card">
        <tbody>
          {FILTERS.map(([f, what, ex]) => (
            <tr key={f}>
              <td className="mono">{f}</td>
              <td className="small">{what}</td>
              <td className="mono small">{ex}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">
        Filters chain left to right: <code>{'{{trigger.body.title | default: "Untitled" | upper}}'}</code>. Write a literal <code>{"{{"}</code> as <code>{"\\{{"}</code>.
      </p>

      <h2>Escaping</h2>
      <p>Substituted values are escaped for where they land; the text you write yourself is never touched.</p>
      <ul>
        <li>
          <strong>Telegram (HTML)</strong>: values are HTML-escaped, so a token named <code>&lt;b&gt;EVIL&lt;/b&gt;</code> prints as text.
        </li>
        <li>
          <strong>HTTP JSON bodies</strong>: values are JSON-escaped (quotes, newlines). Write strings in quotes: <code>{'"to": "{{trigger.to}}"'}</code>; numbers without: <code>{'"amount": {{trigger.amount_decimal}}'}</code>.
        </li>
        <li>
          <strong>Google Sheets</strong>: a value that would start a formula (=, +, -, @) is written as text; plain numbers stay numbers.
        </li>
      </ul>

      <h2>Limits</h2>
      <p className="small">
        A template has at most {TEMPLATE_LIMITS.maxTemplateLength.toLocaleString("en-US")} characters and {TEMPLATE_LIMITS.maxPlaceholders} variables; a rendered result at most{" "}
        {TEMPLATE_LIMITS.maxOutputLength.toLocaleString("en-US")} characters.
      </p>
    </>
  );
}
