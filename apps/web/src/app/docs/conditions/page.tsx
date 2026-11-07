import type { Metadata } from "next";
import Link from "next/link";
import { LIMITS } from "@ignitra/core";
import { Code } from "@/lib/docs";

export const metadata: Metadata = { title: "Conditions", description: "Filter trigger data with exact, predictable conditions." };

const OPS: Array<[string, string, string]> = [
  ["==", "equals", '{ "field": "token.symbol", "op": "==", "value": "USDG" }'],
  ["!=", "is not", '{ "field": "from", "op": "!=", "value": "0x0000000000000000000000000000000000000000" }'],
  [">  >=  <  <=", "numeric comparisons (exact decimals)", '{ "field": "amount_decimal", "op": ">=", "value": "1000" }'],
  ["IN / NOT_IN", "one of / none of a list (up to 500 values)", '{ "field": "to", "op": "IN", "value": ["0xaa…", "0xbb…"] }'],
  ["CONTAINS", "a text contains a substring, or a list contains a value", '{ "field": "event.name", "op": "CONTAINS", "value": "Swap" }'],
  ["EXISTS", "the field is present and not null", '{ "field": "token.symbol", "op": "EXISTS" }'],
];

export default function ConditionsPage() {
  return (
    <>
      <h1>Conditions</h1>
      <p>
        Conditions filter the trigger&apos;s data. A run is created only when they pass; otherwise the match is recorded under “Why it did not run” with every condition&apos;s actual value. No conditions means every trigger
        occurrence runs.
      </p>
      <Code>{`{
  "all": [
    { "field": "percent_of_supply", "op": ">=", "value": 0.5 },
    { "field": "is_mint", "op": "==", "value": false },
    { "any": [
      { "field": "time.hour_wib", "op": ">=", "value": 8 },
      { "field": "amount_decimal", "op": ">=", "value": "100000" }
    ] }
  ]
}`}</Code>
      <p>
        The root is a group: <code>all</code> (AND) or <code>any</code> (OR). Groups nest up to {LIMITS.maxConditionDepth} levels, with at most {LIMITS.maxConditionNodes} nodes. Fields are the trigger&apos;s data paths (see{" "}
        <Link href="/docs/triggers">Triggers</Link>); a typo is rejected when you save, with a suggestion.
      </p>

      <h2>Operators</h2>
      <table className="table card">
        <thead>
          <tr>
            <th>Operator</th>
            <th>Meaning</th>
            <th>Example</th>
          </tr>
        </thead>
        <tbody>
          {OPS.map(([op, meaning, example]) => (
            <tr key={op}>
              <td className="mono">{op}</td>
              <td className="small">{meaning}</td>
              <td className="mono small">{example}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Semantics</h2>
      <ul>
        <li>
          <strong>Numbers are exact.</strong> Numbers and numeric strings compare as decimals: <code>&quot;1000000000000000000000&quot;</code> equals <code>1e21</code>, and token amounts never lose precision. Write big values as strings.
        </li>
        <li>
          <strong>Hex is case-insensitive.</strong> Addresses and hashes match in any case; other text is compared exactly.
        </li>
        <li>
          <strong>Missing data fails.</strong> A missing or null field fails every operator except <code>EXISTS</code>: a flow never runs on data it does not have.
        </li>
        <li>
          <strong>No guessing.</strong> Comparing incompatible types (text with <code>&gt;</code>) fails with <code>type_mismatch</code>, shown in the trace.
        </li>
        <li>
          <strong>Everything is evaluated.</strong> All conditions are checked (no short-circuit), so the trace always shows each result.
        </li>
      </ul>

      <h2>Useful fields</h2>
      <ul>
        <li>
          <code>time.hour_wib</code>, <code>time.minutes_wib</code> (08:00 = 480), <code>time.weekday_wib</code> (1 = Monday): business hours in WIB, from the block time.
        </li>
        <li>
          <code>percent_of_supply</code>, <code>is_mint</code>, <code>is_burn</code> on token transfers.
        </li>
        <li>
          <code>body.*</code> for inbound webhooks: any path into the JSON you posted, e.g. <code>body.order.total</code>.
        </li>
      </ul>

      <h2>Limits that also filter</h2>
      <p>
        After the conditions pass, a match can still be held back by <code>settings.max_runs_per_hour</code> (default 60) or by the plan&apos;s monthly runs. Both are recorded as evaluations (<code>rate_limited</code>,{" "}
        <code>plan_limited</code>). A flow whose events exceed three times its hourly cap pauses itself and you get a notice.
      </p>
    </>
  );
}
