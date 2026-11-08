import type { Metadata } from "next";
import Link from "next/link";
import { Code } from "@/lib/docs";

export const metadata: Metadata = { title: "Onchain actions", description: "ONCHAIN_TX: transactions from your Safe through a scoped, revocable session key (Zodiac Roles)." };

const STEP = `{
  "step_id": "pay",
  "type": "ONCHAIN_TX",
  "params": {
    "grant_id": "grt_…",
    "to": "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    "function": "transfer(address to, uint256 amount)",
    "args": ["{{trigger.from}}", "1000000"],
    "value": "0"
  }
}
// and in the flow's settings: { "mode": "confirmed", "onchain": true }`;

const STATUSES: Array<[string, string]> = [
  ["simulated", "A TEST run: estimated against the chain, never signed or sent"],
  ["denied", "MANDATE said no: never sent"],
  ["signed", "Signed and recorded, about to be sent"],
  ["sent", "Accepted by the network, waiting to be mined"],
  ["confirmed", "Mined and successful: the hash links to the explorer"],
  ["reverted", "Mined, but the call reverted (no effect beyond gas)"],
  ["failed", "Refused before sending (by the grant's limits on chain, by the node), or the grant was revoked before it went out"],
];

export default function OnchainDocsPage() {
  return (
    <>
      <h1>Onchain actions</h1>
      <p>
        The <strong>Onchain transaction</strong> action (<code>ONCHAIN_TX</code>) makes a call from your Safe when a flow runs: pay an invoice when a deposit arrives, top up a wallet that runs low, pause a contract on a VIGIL alert. It is
        off unless you set it up, and it can only do what your Safe granted. Team plan.
      </p>

      <h2>How it stays limited</h2>
      <ul>
        <li>
          <strong>Your keys stay yours.</strong> IGNITRA creates its own session key for each grant. Your Safe gives that key a role in a{" "}
          <a href="https://github.com/gnosisguild/zodiac-modifier-roles" target="_blank" rel="noreferrer">
            Zodiac Roles v2
          </a>{" "}
          modifier: specific contracts, specific functions, and nothing else.
        </li>
        <li>
          <strong>Limits on chain.</strong> ETH per call and per day, token amounts per call and per day, and the expiry are enforced by the Roles modifier and IGNITRA&apos;s stateless <code>IgnitraSessionBounds</code> check, not only by
          IGNITRA. Even a compromised server could do no more than the grant.
        </li>
        <li>
          <strong>Never the Safe itself.</strong> A grant can not target the Safe, its Roles modifier or any other enabled module, and never delegatecalls. Functions that move tokens (<code>transfer</code>, <code>approve</code>,{" "}
          <code>transferFrom</code>, <code>increaseAllowance</code>) must cap their amount. Expiry is between 10 minutes and 90 days.
        </li>
        <li>
          <strong>Off by default.</strong> A flow must opt in (<code>settings.onchain: true</code>) and run on confirmed events.
        </li>
        <li>
          <strong>Revocable at once.</strong> Revoking in IGNITRA deletes the session key immediately: nothing more is signed or sent, not even a transaction that was signed and not sent yet. Removing the role from the Safe as well is one
          more transaction, prepared for you.
        </li>
        <li>
          <strong>Logged.</strong> Every attempt is recorded with the call, the MANDATE decision and the transaction hash, on the grant&apos;s page and in the run trace.
        </li>
      </ul>

      <h2>Set it up</h2>
      <ol>
        <li>
          In <Link href="/app/onchain">Onchain</Link>, create a grant: your Safe, the contracts and functions, the limits, the expiry, and optionally a <Link href="/docs/integrations#mandate">MANDATE</Link> policy.
        </li>
        <li>
          Approve it on the Safe. It is one Safe transaction listing every call: deploying the Roles modifier and the bounds contract the first time, enabling the modifier, giving the role, scoping each function, setting the daily limits.
          If you own a 1-of-N Safe, send it from your wallet; otherwise import the Transaction Builder file in the Safe app and collect the signatures.
        </li>
        <li>
          IGNITRA verifies the mined transaction: it replays every Roles event and checks the resulting permissions are exactly the grant, nothing broader. Only then is the grant active.
        </li>
        <li>Send a little ETH to the grant&apos;s session key: it pays the gas of its own transactions.</li>
        <li>
          In a flow, add an Onchain transaction step, pick the grant, the contract and the function, and turn on <em>Onchain transactions</em> in the flow&apos;s settings.
        </li>
      </ol>
      <Code>{STEP}</Code>

      <h2>What happens when it runs</h2>
      <ol>
        <li>The call is checked against the grant: contract, function, ETH and amounts, today&apos;s totals.</li>
        <li>MANDATE is asked, when the grant names a policy: only an explicit allow continues.</li>
        <li>The call is simulated as the session key: a refusal by the Roles modifier is explained (e.g. the daily limit is used up) and nothing is sent.</li>
        <li>The transaction is signed and recorded, then sent, and its receipt awaited.</li>
      </ol>
      <ul>
        <li>
          <strong>Exactly once.</strong> A step is signed at most once. A retry re-sends the same signed transaction, never a second one, and a step that already has an outcome answers with it.
        </li>
        <li>
          <strong>TEST runs</strong> only simulate: the trace shows <code>simulated: true</code> and the estimated gas, and nothing is signed.
        </li>
        <li>
          The step&apos;s output is <code>tx_hash</code>, <code>block_number</code>, <code>gas_used</code>, <code>explorer_url</code>, <code>simulated</code> and <code>safe</code>: later steps can post the transaction link.
        </li>
      </ul>

      <h2>Action statuses</h2>
      <table className="table card">
        <tbody>
          {STATUSES.map(([s, what]) => (
            <tr key={s}>
              <td className="mono">{s}</td>
              <td className="small">{what}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>API</h2>
      <p className="small muted">
        Creating and verifying a grant needs a wallet session; listing and revoking also work with an API key. See <Link href="/docs/api">API</Link>.
      </p>
    </>
  );
}
