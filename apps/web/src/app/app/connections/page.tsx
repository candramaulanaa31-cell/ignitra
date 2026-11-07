"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { CopyButton, Empty, Field, Notice, Spinner, useToast } from "@/components/ui";
import { api, errorText, useApi } from "@/lib/api";
import { when } from "@/lib/format";
import { CONNECTION_LABELS } from "@/lib/forms";
import { useSession } from "@/components/session";
import type { Connection } from "@/lib/types";

type Kind = "telegram" | "webhook" | "email" | "http" | "google";

function describe(c: Connection): string {
  const m = c.metadata;
  switch (c.type) {
    case "telegram":
      return [m.chat_title ?? m.chat_id, m.chat_type, m.bot_username ? `@${String(m.bot_username)}` : null].filter(Boolean).join(" · ");
    case "webhook":
      return String(m.host ?? "");
    case "email":
      return `${String(m.address ?? "")}${m.verified === false ? " · not verified" : " · verified"}`;
    case "google":
      return String(m.email ?? "Google account");
    case "http":
      return `${String(m.host ?? "")} · ${(m.header_names as string[] | undefined)?.join(", ") ?? ""}`;
    default:
      return "";
  }
}

function VerifyEmail({ conn, onDone }: { conn: Connection; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api(`/v1/connections/${conn.id}/verify`, { body: { code } });
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="row" style={{ marginTop: 6 }}>
      <input className="mono" style={{ width: 120 }} inputMode="numeric" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
      <button type="submit" className="btn sm primary" disabled={code.length !== 6}>
        Verify
      </button>
      <button
        type="button"
        className="btn sm ghost"
        onClick={() =>
          void api(`/v1/connections/${conn.id}/resend`, { method: "POST" })
            .then(() => setInfo("A new code is on its way."))
            .catch((err: unknown) => setError(errorText(err)))
        }
      >
        Send a new code
      </button>
      {error ? <span className="small failc">{error}</span> : null}
      {info ? <span className="small pass">{info}</span> : null}
    </form>
  );
}

function AddConnection({ onAdded }: { onAdded: (secret: string | null) => void }) {
  const [kind, setKind] = useState<Kind>("telegram");
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (kind === "google") {
        const res = await api<{ data: { url: string } }>("/v1/connections/google/start", { method: "POST" });
        window.location.assign(res.data.url);
        return;
      }
      const label = form.label?.trim() ? { label: form.label.trim() } : {};
      const body =
        kind === "telegram"
          ? { type: "telegram", bot_token: form.bot_token ?? "", chat_id: form.chat_id ?? "", ...(form.thread_id ? { thread_id: Number(form.thread_id) } : {}), ...label }
          : kind === "webhook"
            ? { type: "webhook", url: form.url ?? "", ...label }
            : kind === "email"
              ? { type: "email", address: form.address ?? "", ...label }
              : { type: "http", host: form.host ?? "", headers: [{ name: form.header_name ?? "Authorization", value: form.header_value ?? "" }], ...label };
      const res = await api<{ data: Connection; signing_secret?: string }>("/v1/connections", { body });
      setForm({});
      onAdded(res.signing_secret ?? null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={(e) => void submit(e)}>
      <div className="card-head">
        <span className="label">Add a connection</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} style={{ width: "auto" }}>
          {(["telegram", "webhook", "email", "google", "http"] as const).map((k) => (
            <option key={k} value={k}>
              {CONNECTION_LABELS[k]}
            </option>
          ))}
        </select>
      </div>
      <div className="card-body stack">
        {kind === "telegram" ? (
          <>
            <p className="small muted">
              1. Create a bot with <span className="mono">@BotFather</span>. 2. Add it to the group or channel (as admin for channels) and send it one message. 3. Paste its token and the chat id here: IGNITRA checks both with Telegram, then stores the token encrypted. It is never shown again.
            </p>
            <div className="grid2">
              <Field name="Bot token" help="Looks like 123456789:AA…">
                <input className="mono" autoComplete="off" value={form.bot_token ?? ""} onChange={set("bot_token")} />
              </Field>
              <Field name="Chat id" help="-1001234567890, or @channelname">
                <input className="mono" value={form.chat_id ?? ""} onChange={set("chat_id")} />
              </Field>
              <Field name="Topic id (optional)">
                <input className="mono" inputMode="numeric" value={form.thread_id ?? ""} onChange={set("thread_id")} />
              </Field>
            </div>
          </>
        ) : null}
        {kind === "webhook" ? (
          <Field name="URL" help="You get a signing secret once: configure your receiver with it.">
            <input className="mono" placeholder="https://myapp.com/hooks/ignitra" value={form.url ?? ""} onChange={set("url")} />
          </Field>
        ) : null}
        {kind === "email" ? (
          <Field name="Email address" help="We send a 6-digit code; flows can mail it once it is verified.">
            <input type="email" value={form.address ?? ""} onChange={set("address")} />
          </Field>
        ) : null}
        {kind === "google" ? <p className="small muted">You go to Google to allow IGNITRA to edit spreadsheets, then come back here. The access is stored encrypted; revoke it any time in your Google account.</p> : null}
        {kind === "http" ? (
          <>
            <p className="small muted">For API keys used by HTTP request steps. Headers are stored encrypted and only ever sent to this host.</p>
            <div className="grid3">
              <Field name="Host">
                <input className="mono" placeholder="api.example.com" value={form.host ?? ""} onChange={set("host")} />
              </Field>
              <Field name="Header">
                <input className="mono" placeholder="Authorization" value={form.header_name ?? ""} onChange={set("header_name")} />
              </Field>
              <Field name="Value">
                <input className="mono" autoComplete="off" placeholder="Bearer …" value={form.header_value ?? ""} onChange={set("header_value")} />
              </Field>
            </div>
          </>
        ) : null}
        {kind !== "google" ? (
          <Field name="Label (optional)">
            <input value={form.label ?? ""} onChange={set("label")} />
          </Field>
        ) : null}
        {error ? <Notice kind="error">{error}</Notice> : null}
        <div>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "Checking…" : kind === "google" ? "Connect Google" : "Add"}
          </button>
        </div>
      </div>
    </form>
  );
}

function OAuthResult({ notify }: { notify: (m: string, k?: "ok" | "error") => void }) {
  const params = useSearchParams();
  useEffect(() => {
    if (params.get("google") === "connected") notify("Google connected.");
    const error = params.get("google_error");
    if (error) notify(`Google: ${error}`, "error");
  }, [params, notify]);
  return null;
}

export default function ConnectionsPage() {
  const { me } = useSession();
  const [toast, notify] = useToast();
  const list = useApi<{ data: Connection[] }>("/v1/connections");
  const [secret, setSecret] = useState<string | null>(null);

  const remove = async (c: Connection) => {
    if (!window.confirm(`Delete "${c.label}"?`)) return;
    try {
      await api(`/v1/connections/${c.id}`, { method: "DELETE" });
      await list.reload();
    } catch (err) {
      notify(errorText(err), "error");
    }
  };

  return (
    <main className="stack">
      {toast}
      <Suspense>
        <OAuthResult notify={notify} />
      </Suspense>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Connections</h1>
          <div className="sub">Where actions deliver. Secrets go in and never come back out.</div>
        </div>
      </div>
      {secret ? (
        <Notice kind="warn">
          <div className="stack" style={{ gap: 6 }}>
            <strong>Signing secret: copy it now. It is not shown again.</strong>
            <div className="row">
              <code className="grow" style={{ overflowWrap: "anywhere" }}>
                {secret}
              </code>
              <CopyButton value={secret} />
            </div>
            <span className="small">Verify X-Ignitra-Signature: v1=HMAC-SHA256(secret, &quot;&lt;timestamp&gt;.&lt;raw body&gt;&quot;).</span>
            <button type="button" className="linkish small" onClick={() => setSecret(null)}>
              I stored it
            </button>
          </div>
        </Notice>
      ) : null}
      <div className="card">
        {list.loading ? (
          <div className="card-body">
            <Spinner />
          </div>
        ) : (list.data?.data.length ?? 0) === 0 ? (
          <Empty>No connections yet. Add a Telegram chat, a webhook, an email address, a Google account or HTTP secret headers.</Empty>
        ) : (
          <table className="table responsive">
            <thead>
              <tr>
                <th>Connection</th>
                <th>Type</th>
                <th>Details</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data?.data.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.label}
                    <div className="mono small faint">{c.id}</div>
                    {c.type === "email" && c.metadata.verified === false ? <VerifyEmail conn={c} onDone={() => void list.reload()} /> : null}
                  </td>
                  <td data-label="type">{CONNECTION_LABELS[c.type] ?? c.type}</td>
                  <td data-label="details" className="small">
                    {describe(c)}
                  </td>
                  <td data-label="added" className="small muted nowrap">
                    {when(c.created_at, me.timezone).slice(0, 16)}
                  </td>
                  <td className="right">
                    <button type="button" className="btn sm ghost danger" onClick={() => void remove(c)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <AddConnection
        onAdded={(s) => {
          setSecret(s);
          void list.reload();
          notify("Connection added.");
        }}
      />
    </main>
  );
}
