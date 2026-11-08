"use client";

import { useState, type FormEvent } from "react";
import { subscribePush } from "@/components/service-worker";
import { useSession } from "@/components/session";
import { CopyButton, Empty, Field, Notice, useToast } from "@/components/ui";
import { api, errorText, useApi } from "@/lib/api";
import { ago, when } from "@/lib/format";
import type { ApiKey, AuditEntry, OwnerNotification } from "@/lib/types";

interface Device {
  id: string;
  endpoint_host: string;
  user_agent: string | null;
  created_at: string;
  last_success_at: string | null;
  disabled_at: string | null;
}

/** Keys for scripts and @ignitra/sdk. Only a hash is stored: the key is shown once. */
function ApiKeys({ notify }: { notify: (message: string, kind?: "ok" | "error" | "info") => void }) {
  const { me } = useSession();
  const keys = useApi<{ data: ApiKey[] }>("/v1/api-keys");
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const team = me.plan === "team";

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ data: ApiKey; key: string }>("/v1/api-keys", { body: { name: name.trim() } });
      setCreated(res.key);
      setName("");
      await keys.reload();
    } catch (err) {
      notify(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (k: ApiKey) => {
    if (!window.confirm(`Revoke "${k.name}"? Anything using it stops working at once.`)) return;
    try {
      await api(`/v1/api-keys/${k.id}`, { method: "DELETE" });
      await keys.reload();
      notify("Key revoked.");
    } catch (err) {
      notify(errorText(err), "error");
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <span className="label">API keys</span>
        <a href="/docs/sdk" className="small">
          SDK &amp; API docs
        </a>
      </div>
      <div className="card-body stack">
        <p className="small muted">
          For scripts and <span className="mono">@ignitra/sdk</span>: <span className="mono">Authorization: Bearer igk_…</span>. A key acts as you, except that creating keys and onchain grants always needs your wallet. Only its hash is stored, so copy it when it is shown.
        </p>
        {team ? (
          <form className="row" onSubmit={(e) => void create(e)}>
            <input className="grow" placeholder="What it is for, e.g. ci-deploy" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="btn primary" disabled={busy || name.trim().length === 0}>
              {busy ? "Creating…" : "Create key"}
            </button>
          </form>
        ) : (
          <Notice kind="info">API keys are part of the Team plan. Your wallet session works with the API on every plan.</Notice>
        )}
        {created ? (
          <Notice kind="warn">
            <div className="stack" style={{ gap: 6 }}>
              <strong>Your new key: copy it now. It is not shown again.</strong>
              <div className="row">
                <code className="grow" style={{ overflowWrap: "anywhere" }}>
                  {created}
                </code>
                <CopyButton value={created} />
              </div>
              <button type="button" className="linkish small" onClick={() => setCreated(null)}>
                I stored it
              </button>
            </div>
          </Notice>
        ) : null}
        {(keys.data?.data.length ?? 0) === 0 ? null : (
          <table className="table responsive">
            <thead>
              <tr>
                <th>Key</th>
                <th>Last used</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data?.data.map((k) => (
                <tr key={k.id} className={k.revoked_at ? "faint" : undefined}>
                  <td>
                    {k.name}
                    <div className="mono small faint">
                      {k.prefix}… · {k.rate_per_minute}/min
                    </div>
                  </td>
                  <td data-label="last used" className="small muted">
                    {k.last_used_at ? ago(k.last_used_at, Date.now(), me.timezone) : "never"}
                  </td>
                  <td data-label="created" className="small muted nowrap">
                    {when(k.created_at, me.timezone).slice(0, 16)}
                  </td>
                  <td className="right">
                    {k.revoked_at ? (
                      <span className="small faint">revoked</span>
                    ) : (
                      <button type="button" className="btn sm ghost danger" onClick={() => void revoke(k)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

const ACTIONS: Readonly<Record<string, string>> = {
  "account.signed_in": "Signed in",
  "account.updated": "Changed settings",
  "account.webhook_secret_viewed": "Revealed the webhook secret",
  "account.plan_changed": "Plan changed",
  "flow.created": "Created flow",
  "flow.updated": "Edited flow",
  "flow.paused": "Paused flow",
  "flow.resumed": "Resumed flow",
  "flow.deleted": "Deleted flow",
  "flow.hook_rotated": "Rotated the hook URL of",
  "flow.auto_paused": "Auto-paused flow",
  "connection.created": "Added connection",
  "connection.verified": "Verified connection",
  "connection.deleted": "Deleted connection",
  "api_key.created": "Created API key",
  "api_key.revoked": "Revoked API key",
  "grant.created": "Created onchain grant",
  "grant.verified": "Activated onchain grant",
  "grant.revoked": "Revoked onchain grant",
  "template.published": "Shared template",
  "template.deleted": "Unshared template",
  "template.hidden": "Template taken down",
  "template.unhidden": "Template restored",
  "push.subscribed": "Enabled notifications on a device",
  "push.unsubscribed": "Removed a notification device",
};

function who(e: AuditEntry): string {
  if (e.actor.kind === "api_key") return `API key ${e.actor.api_key_prefix ?? e.actor.api_key_id}…`;
  return e.actor.kind === "session" ? "your wallet" : e.actor.kind === "operator" ? "the operator" : "IGNITRA";
}

function what(e: AuditEntry): string {
  const d = e.details;
  const name = d.name ?? d.label ?? d.slug ?? (e.action === "account.plan_changed" ? `${String(d.from)} → ${String(d.to)}` : null) ?? (e.action === "account.updated" && d.timezone ? `timezone ${String(d.timezone)}` : null);
  return name === null || name === undefined ? "" : String(name);
}

/** Who changed what in the account, from where (the audit log). */
function Activity() {
  const { me } = useSession();
  const [pages, setPages] = useState<AuditEntry[][]>([]);
  const [next, setNext] = useState<string | null>(null);
  const first = useApi<{ data: AuditEntry[]; next_before: string | null }>("/v1/audit-log?limit=20");
  const entries = [...(first.data?.data ?? []), ...pages.flat()];
  const cursor = pages.length === 0 ? (first.data?.next_before ?? null) : next;
  const more = async () => {
    if (!cursor) return;
    const res = await api<{ data: AuditEntry[]; next_before: string | null }>(`/v1/audit-log?limit=20&before=${cursor}`);
    setPages((p) => [...p, res.data]);
    setNext(res.next_before);
  };
  return (
    <section className="card">
      <div className="card-head">
        <span className="label">Activity</span>
        <span className="small muted">every change to your account: who, what, from where</span>
      </div>
      {entries.length === 0 ? (
        <Empty>Nothing yet. Sign-ins and changes to flows, connections, keys and grants show up here.</Empty>
      ) : (
        <table className="table responsive">
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="small mono nowrap">{when(e.at, me.timezone).slice(0, 16)}</td>
                <td className="small">
                  {ACTIONS[e.action] ?? e.action} {e.target.type === "flow" && e.target.id && e.action !== "flow.deleted" ? <a href={`/app/flows/${e.target.id}`}>{what(e) || e.target.id}</a> : <strong>{what(e)}</strong>}
                  <div className="faint">
                    by {who(e)}
                    {e.ip ? ` · ${e.ip}` : ""}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {cursor ? (
        <div className="card-body">
          <button type="button" className="btn sm" onClick={() => void more()}>
            Older
          </button>
        </div>
      ) : null}
    </section>
  );
}

const ZONES = ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "Asia/Singapore", "UTC", "Europe/London", "America/New_York"];

export default function SettingsPage() {
  const { me, refresh } = useSession();
  const [toast, notify] = useToast();
  const [tz, setTz] = useState(me.timezone);
  const [secret, setSecret] = useState<{ secret: string; previous_secret: string | null } | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const devices = useApi<{ data: Device[] }>("/v1/push/subscriptions");
  const notices = useApi<{ data: OwnerNotification[] }>("/v1/notifications?limit=20");
  const u = me.usage;
  const pct = Math.min(100, Math.round((u.runs.used / Math.max(1, u.runs.included)) * 100));

  const saveTz = async () => {
    try {
      await api("/v1/me", { method: "PATCH", body: { timezone: tz } });
      await refresh();
      notify("Timezone saved.");
    } catch (err) {
      notify(errorText(err), "error");
    }
  };

  const enablePush = async () => {
    setPushBusy(true);
    try {
      const { public_key } = await api<{ public_key: string | null }>("/v1/push/vapid-public-key");
      if (!public_key) throw new Error("Web Push is not configured on this server");
      const sub = await subscribePush(public_key);
      await api("/v1/push/subscriptions", { body: sub });
      await devices.reload();
      notify("Notifications enabled on this device.");
    } catch (err) {
      notify(errorText(err), "error");
    } finally {
      setPushBusy(false);
    }
  };

  return (
    <main className="stack">
      {toast}
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Settings</h1>
          <div className="sub mono">{me.address}</div>
        </div>
      </div>

      <div className="grid2">
        <section className="card">
          <div className="card-head">
            <span className="label">Plan · {me.plan}</span>
            <span className="small muted">resets {when(u.resets_at, me.timezone).slice(0, 10)}</span>
          </div>
          <div className="card-body stack">
            <div>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span>Runs in {u.period}</span>
                <span className="mono">
                  {u.runs.used.toLocaleString("en-US")} / {u.runs.included.toLocaleString("en-US")}
                </span>
              </div>
              <div className="progress" aria-hidden="true">
                <div style={{ width: `${pct}%`, background: pct >= 100 ? "var(--fail)" : pct >= 80 ? "var(--partial)" : undefined }} />
              </div>
            </div>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span>Active flows</span>
              <span className="mono">
                {u.active_flows.used} / {u.active_flows.limit ?? "∞"}
              </span>
            </div>
            {u.runs.plan_limited > 0 ? <Notice kind="warn">{u.runs.plan_limited.toLocaleString("en-US")} matches did not run this month: the plan&apos;s runs were used up.</Notice> : null}
            {u.runs.overage > 0 ? <Notice kind="info">{u.runs.overage.toLocaleString("en-US")} runs over the included amount (metered).</Notice> : null}
            <p className="small faint">
              Free: 3 flows, 500 runs, Telegram / webhook / push. Builder: 20 flows, 10,000 runs, + Sheets, email, schedules. Team: unlimited flows, 100,000 runs.
            </p>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <span className="label">Display timezone</span>
          </div>
          <div className="card-body stack">
            <Field name="Times are shown in" help="Everything is stored in UTC.">
              <input list="zones" value={tz} onChange={(e) => setTz(e.target.value)} />
            </Field>
            <datalist id="zones">
              {ZONES.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
            <div>
              <button type="button" className="btn" onClick={() => void saveTz()} disabled={tz === me.timezone}>
                Save
              </button>
            </div>
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <span className="label">Notifications on your devices (Web Push)</span>
          <button type="button" className="btn sm primary" onClick={() => void enablePush()} disabled={pushBusy}>
            {pushBusy ? "Enabling…" : "Enable on this device"}
          </button>
        </div>
        <div className="card-body stack">
          <p className="small muted">
            WEB_PUSH steps notify every device enabled here. On iPhone / iPad: open IGNITRA in Safari, Share → Add to Home Screen, then open it from the home screen and enable notifications there (iOS 16.4+).
          </p>
          {(devices.data?.data.length ?? 0) === 0 ? (
            <span className="small faint">No devices yet.</span>
          ) : (
            <table className="table responsive">
              <tbody>
                {devices.data?.data.map((d) => (
                  <tr key={d.id}>
                    <td className="small">{d.user_agent?.slice(0, 80) ?? d.endpoint_host}</td>
                    <td data-label="service" className="small mono">
                      {d.endpoint_host}
                    </td>
                    <td data-label="last push" className="small muted">
                      {d.disabled_at ? "expired" : ago(d.last_success_at, Date.now(), me.timezone)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <span className="label">Webhook signing secret</span>
          {secret ? <CopyButton value={secret.secret} /> : null}
        </div>
        <div className="card-body stack">
          <p className="small muted">
            WEBHOOK and HTTP request steps with a URL are signed with this secret: <span className="mono">X-Ignitra-Signature: v1=HMAC-SHA256(secret, &quot;&lt;X-Ignitra-Timestamp&gt;.&lt;raw body&gt;&quot;)</span>. Reject anything older than 5 minutes.
          </p>
          {secret ? (
            <>
              <code style={{ overflowWrap: "anywhere" }}>{secret.secret}</code>
              {secret.previous_secret ? (
                <Notice kind="warn">
                  The signing secret is being rotated. Until the old one is retired, deliveries carry a second signature made with your previous secret{" "}
                  <span className="mono" style={{ overflowWrap: "anywhere" }}>{secret.previous_secret}</span>. Switch your receivers to the secret above now.
                </Notice>
              ) : null}
            </>
          ) : (
            <div>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void api<{ data: { secret: string; previous_secret: string | null } }>("/v1/me/webhook-secret")
                    .then((r) => setSecret({ secret: r.data.secret, previous_secret: r.data.previous_secret ?? null }))
                    .catch((err: unknown) => notify(errorText(err), "error"))
                }
              >
                Reveal
              </button>
            </div>
          )}
        </div>
      </section>

      <ApiKeys notify={notify} />

      <Activity />

      <section className="card">
        <div className="card-head">
          <span className="label">Notices</span>
        </div>
        {(notices.data?.data.length ?? 0) === 0 ? (
          <Empty>No notices. Auto-pauses and quota warnings appear here (and as push notifications).</Empty>
        ) : (
          <table className="table responsive">
            <tbody>
              {notices.data?.data.map((n) => (
                <tr key={n.id}>
                  <td className="small mono nowrap">{when(n.created_at, me.timezone).slice(0, 16)}</td>
                  <td className="small">
                    {n.message}
                    {n.flow_id ? (
                      <>
                        {" "}
                        <a href={`/app/flows/${n.flow_id}`}>open flow</a>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
