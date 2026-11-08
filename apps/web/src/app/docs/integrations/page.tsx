import type { Metadata } from "next";
import Link from "next/link";
import { Code } from "@/lib/docs";

export const metadata: Metadata = { title: "Integrations", description: "VIGIL alerts, TRUST LAYER scores, MANDATE policies and Pons launches in IGNITRA flows." };

const TRUST_CONDITION = `{
  "all": [
    { "field": "percent_of_supply", "op": ">=", "value": 0.5 },
    { "field": "counterparty_trust_status", "op": "==", "value": "scored" },
    { "field": "counterparty_trust_score", "op": "<", "value": 300 }
  ]
}`;

const MANDATE_REQUEST = `POST <your policy endpoint>
Content-Type: application/json
X-Ignitra-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
X-Ignitra-Timestamp: 1794060000
X-Ignitra-Idempotency-Key: 4663:0x…:12:fl_…:pay
X-Ignitra-Event: onchain.intent

{
  "type": "onchain.intent",
  "intent_id": "5b1c…",
  "chain_id": 4663,
  "grant_id": "grt_…",
  "safe": "0x…",
  "session_key": "0x…",
  "to": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  "function": "transfer(address,uint256)",
  "selector": "0xa9059cbb",
  "args": ["0x…", "1000000"],
  "value_wei": "0",
  "flow_id": "fl_…",
  "run_id": "run_…",
  "step_id": "pay",
  "idempotency_key": "4663:0x…:12:fl_…:pay",
  "test": false,
  "sent_at": "2026-11-08T02:00:00.000Z"
}`;

const MANDATE_ANSWER = `200 { "decision": "allow", "policy_id": "pol_7" }
200 { "decision": "deny", "reason": "counterparty frozen", "policy_id": "pol_7" }`;

export default function IntegrationsPage() {
  return (
    <>
      <h1>Integrations</h1>
      <p>
        IGNITRA works with other Robinhood Chain services: <strong>VIGIL</strong> alerts start flows, <strong>TRUST LAYER</strong> scores become conditions, <strong>MANDATE</strong> policies approve onchain actions, and{" "}
        <strong>Pons</strong> launches are a trigger.
      </p>

      <h2 id="vigil">VIGIL → the VIGIL alert trigger</h2>
      <p>VIGIL watches contracts and raises alerts (upgrades, ownership and role changes, pauses…). A flow can run on them.</p>
      <ol>
        <li>
          Add a VIGIL connection in <Link href="/app/connections">Connections</Link>. With a VIGIL API key (<code>vgl_…</code>), IGNITRA registers its receiver in your VIGIL account itself: the key is used once and not stored. Without a key,
          you get a receiver URL: add it as a webhook in VIGIL, then paste the signing secret VIGIL shows. Alerts are refused until then.
        </li>
        <li>
          Pick the <Link href="/docs/triggers#VIGIL_ALERT">VIGIL alert</Link> trigger: confirmed alerts (default) or new ones before confirmation, a minimum severity, and optionally only some rules or contracts.
        </li>
      </ol>
      <ul>
        <li>
          IGNITRA checks every delivery&apos;s <code>x-vigil-signature</code> (HMAC-SHA256 over <code>&quot;&lt;timestamp&gt;.&lt;raw body&gt;&quot;</code>) and refuses anything older than 5 minutes.
        </li>
        <li>An alert runs a flow once per stage, however often VIGIL retries the delivery. A retracted alert runs only flows that ask for it.</li>
        <li>
          The trigger data has the alert (rule, severity, title, summary, contract, actor, before / after, VIGIL&apos;s evidence) and <code>counterparty</code> = the actor, for TRUST LAYER scores.
        </li>
      </ul>

      <h2 id="trust-layer">TRUST LAYER → trust conditions</h2>
      <p>
        TRUST LAYER scores Robinhood Chain addresses from 0 to 1000 (higher is more trustworthy). Flows can filter on the score of a party of the event, e.g. only buys by addresses scoring under 300:
      </p>
      <Code>{TRUST_CONDITION}</Code>
      <table className="table card">
        <tbody>
          <tr>
            <td className="mono small">counterparty_trust_score · _band · _status</td>
            <td className="small">
              Token transfer (the side other than the watched wallet), New holder (the holder), Pons launch (the deployer), VIGIL alert (the actor)
            </td>
          </tr>
          <tr>
            <td className="mono small">from_trust_* · to_trust_*</td>
            <td className="small">Token transfer: the sender and the recipient</td>
          </tr>
        </tbody>
      </table>
      <ul>
        <li>
          A score is never invented. When there is no real score, <code>*_trust_score</code> is null and <code>*_trust_status</code> says why: <code>pending</code> (TRUST LAYER is still indexing the address), <code>insufficient_data</code>,{" "}
          <code>not_a_subject</code> (a system address), <code>unavailable</code> (not reachable), <code>skipped</code> (the other conditions failed, so it was not looked up) or <code>not_applicable</code> (no such party, e.g. no counterparty
          without a watched wallet). <code>scored</code> and <code>provisional</code> come with a number.
        </li>
        <li>A condition on a null score is false, so a flow that requires a high score does not run when the score is missing. Add a status condition when “unknown” should behave differently.</li>
        <li>Scores are fetched only for flows that use them, after the other conditions pass, and cached briefly per address.</li>
      </ul>

      <h2 id="mandate">MANDATE → policies for onchain actions</h2>
      <p>
        MANDATE is a policy service that must approve every <Link href="/docs/onchain">onchain action</Link> of the grants that name it. The server operator can require one for every grant. Add it in{" "}
        <Link href="/app/connections">Connections</Link> with its endpoint URL: you get a signing secret once, to verify that requests come from IGNITRA.
      </p>
      <h3>The request</h3>
      <p>Before signing a transaction, IGNITRA POSTs the exact call it would make, signed like its webhooks with the connection&apos;s own secret:</p>
      <Code>{MANDATE_REQUEST}</Code>
      <h3>The answer</h3>
      <Code>{MANDATE_ANSWER}</Code>
      <ul>
        <li>
          <strong>Fail-closed</strong>: only <code>&quot;decision&quot;: &quot;allow&quot;</code> lets the transaction through.
        </li>
        <li>
          <code>deny</code> is final: nothing is sent, the step fails with your reason and is not retried. The decision is logged with the action.
        </li>
        <li>Anything else (no answer within 5 seconds, a non-200 status, malformed JSON, another decision): nothing is sent, and the step is retried later.</li>
        <li>
          A retried step carries the same <code>idempotency_key</code>; <code>intent_id</code> is new for every request. TEST runs only simulate and do not ask MANDATE.
        </li>
      </ul>

      <h2 id="pons">Pons → the Pons launch trigger</h2>
      <p>
        The <Link href="/docs/triggers#NEW_LAUNCH">Pons launch</Link> trigger runs when a token launches on Pons (the V2 launch factory&apos;s <code>TokenLaunched</code> event), optionally only for one deployer. The data has the token (symbol,
        decimals, supply), the deployer, the bonding curve, what it trades against (ETH or a token) and its graduation threshold.
      </p>
      <p className="small muted">
        <code>socials.*</code> are links the launcher typed: unverified. Do not treat them as proof of anything. Combine with <code>counterparty_trust_score</code> (the deployer) to filter launches.
      </p>
    </>
  );
}
