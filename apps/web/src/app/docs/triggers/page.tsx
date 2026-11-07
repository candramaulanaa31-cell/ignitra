import type { Metadata } from "next";
import Link from "next/link";
import type { FieldSpec } from "@ignitra/core";
import { Code, FieldsTable, ParamsTable, exampleFor } from "@/lib/docs";
import { serverGetCached } from "@/lib/server-api";

export const metadata: Metadata = { title: "Triggers", description: "Every IGNITRA trigger: params, the data it provides, and when it fires." };
export const revalidate = 300;

interface Trigger {
  type: string;
  kind: "log" | "poll" | "schedule" | "inbound";
  source: string;
  label: string;
  description: string;
  supports_fast: boolean;
  min_plan: string;
  params_schema: unknown;
  fields: FieldSpec[];
}

const NOTES: Record<string, string> = {
  TOKEN_TRANSFER: "Fires per Transfer log of the token (ERC-721 transfers with the same topic are ignored). With a wallet, direction says in, out or any. percent_of_supply uses the supply at the time of the event.",
  CONTRACT_EVENT:
    "Pass a full event signature, or just the name: IGNITRA resolves it from the contract's verified ABI (or the built-in ERC-20 / Ownable / AccessControl / Pausable ABIs) when you save, and stores the full signature, so matching never depends on an explorer. Arguments appear as args.<name>.",
  NEW_HOLDER:
    "An address whose balance goes from zero to non-zero. Decided per transaction, so routers and pools that receive and pass tokens on in the same transaction are not counted. Confirmed mode only.",
  BALANCE_THRESHOLD: "Samples the balance at the confirmed head on an interval and fires once per crossing, not on every sample while the balance stays on one side. The first sample after activation only records the side.",
  CONTRACT_DEPLOYED: "Follows the deployer's nonce and checks each CREATE address for code: works for wallets and CREATE factories. For CREATE2 factories, use Contract event on the factory's creation event.",
  STATE_CHANGE: "Calls a view function at the confirmed head on an interval and fires when the result changes, with previous, current and (for integers) delta. A reverting call is recorded as undetermined, never as a change.",
  SCHEDULE:
    "Standard 5-field cron in any timezone (WIB by default), plus @hourly / @daily / @weekly / @monthly and L / W / #. Each time fires at most once. After downtime only the latest time fires (within an hour) and earlier ones are recorded as missed.",
  INBOUND_WEBHOOK: "Your flow gets its own signed URL. Anything that can send an HTTP POST starts the flow; see Webhooks for the details.",
};

export default async function TriggersPage() {
  const res = await serverGetCached<{ data: Trigger[] }>("/v1/triggers", 300);
  const triggers = res?.data ?? [];
  return (
    <>
      <h1>Triggers</h1>
      <p>
        A trigger decides when a flow runs. Chain triggers read Robinhood Chain directly, confirmed by default. Every trigger provides data for{" "}
        <Link href="/docs/conditions">conditions</Link> and <Link href="/docs/variables">templates</Link> as <code>{"{{trigger.<path>}}"}</code>.
      </p>
      <ul className="small">
        {triggers.map((t) => (
          <li key={t.type}>
            <a href={`#${t.type}`}>{t.label}</a> <span className="mono faint">{t.type}</span>
          </li>
        ))}
      </ul>
      {triggers.length === 0 ? <p className="muted">The live catalog is unavailable right now; try again in a minute.</p> : null}
      {triggers.map((t) => {
        const example = exampleFor("trigger", t.type);
        return (
          <section key={t.type} id={t.type}>
            <h2>{t.label}</h2>
            <p className="small mono faint">
              {t.type} · {t.source}
              {t.supports_fast ? " · supports fast mode" : ""}
              {t.min_plan !== "free" ? ` · ${t.min_plan} plan` : ""}
            </p>
            <p>{t.description}</p>
            {NOTES[t.type] ? <p className="small muted">{NOTES[t.type]}</p> : null}
            <h3>Params</h3>
            <ParamsTable schema={t.params_schema} />
            {example ? (
              <>
                <h3>Example</h3>
                <Code>{JSON.stringify({ type: t.type, params: example.params }, null, 2)}</Code>
                <p className="small faint">
                  From the <Link href={`/templates/${example.template}`}>{example.template}</Link> template.
                </p>
              </>
            ) : null}
            <h3>Data</h3>
            <FieldsTable fields={t.fields} prefix="trigger." />
          </section>
        );
      })}
    </>
  );
}
