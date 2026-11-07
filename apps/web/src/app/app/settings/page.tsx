"use client";

import { useState } from "react";
import { subscribePush } from "@/components/service-worker";
import { useSession } from "@/components/session";
import { CopyButton, Empty, Field, Notice, useToast } from "@/components/ui";
import { api, errorText, useApi } from "@/lib/api";
import { ago, when } from "@/lib/format";
import type { OwnerNotification } from "@/lib/types";

interface Device {
  id: string;
  endpoint_host: string;
  user_agent: string | null;
  created_at: string;
  last_success_at: string | null;
  disabled_at: string | null;
}

const ZONES = ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "Asia/Singapore", "UTC", "Europe/London", "America/New_York"];

export default function SettingsPage() {
  const { me, refresh } = useSession();
  const [toast, notify] = useToast();
  const [tz, setTz] = useState(me.timezone);
  const [secret, setSecret] = useState<string | null>(null);
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
          {secret ? <CopyButton value={secret} /> : null}
        </div>
        <div className="card-body stack">
          <p className="small muted">
            WEBHOOK and HTTP request steps with a URL are signed with this secret: <span className="mono">X-Ignitra-Signature: v1=HMAC-SHA256(secret, &quot;&lt;X-Ignitra-Timestamp&gt;.&lt;raw body&gt;&quot;)</span>. Reject anything older than 5 minutes.
          </p>
          {secret ? (
            <code style={{ overflowWrap: "anywhere" }}>{secret}</code>
          ) : (
            <div>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void api<{ data: { secret: string } }>("/v1/me/webhook-secret")
                    .then((r) => setSecret(r.data.secret))
                    .catch((err: unknown) => notify(errorText(err), "error"))
                }
              >
                Reveal
              </button>
            </div>
          )}
        </div>
      </section>

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
