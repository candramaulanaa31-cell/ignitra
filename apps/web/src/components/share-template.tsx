"use client";

import { useState, type FormEvent } from "react";
import { TEMPLATE_CATEGORIES } from "@ignitra/core";
import { api, errorText } from "@/lib/api";
import { CATEGORY_LABELS } from "@/lib/template-types";
import { CopyButton, Field, Notice } from "./ui";

/** "Share as template": publishes the flow's current version without the owner's private destinations. */
export function ShareTemplate({ flowId, flowName }: { flowId: string; flowName: string }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: flowName.slice(0, 80), summary: "", description: "", category: "trading", visibility: "unlisted" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ url: string }>("/v1/templates", { body: { flow_id: flowId, ...form } });
      setUrl(res.url);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Share as template
      </button>
    );
  }
  return (
    <form className="card" onSubmit={(e) => void submit(e)} style={{ width: "100%" }}>
      <div className="card-head">
        <span className="label">Share as template</span>
        <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <div className="card-body stack">
        <p className="small muted">
          Others get a copy to fill in. <strong>Never included:</strong> your connections, webhook and API URLs, spreadsheets. <strong>Shown to anyone with the link:</strong> your wallet address as the author, the
          addresses and thresholds of the flow (as editable defaults) and your message texts as written, so check those for anything private first.
        </p>
        {url ? (
          <Notice kind="ok">
            <div className="row">
              <code className="grow" style={{ overflowWrap: "anywhere" }}>
                {url}
              </code>
              <CopyButton value={url} />
            </div>
          </Notice>
        ) : (
          <>
            <div className="grid2">
              <Field name="Name">
                <input value={form.name} onChange={set("name")} maxLength={80} />
              </Field>
              <Field name="Category">
                <select value={form.category} onChange={set("category")}>
                  {TEMPLATE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c] ?? c}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field name="One-line summary" help="10–160 characters">
              <input value={form.summary} onChange={set("summary")} maxLength={160} />
            </Field>
            <Field name="Description (optional)">
              <textarea value={form.description} onChange={set("description")} maxLength={2000} rows={3} />
            </Field>
            <Field name="Who can find it">
              <select value={form.visibility} onChange={set("visibility")}>
                <option value="unlisted">Anyone with the link</option>
                <option value="public">Listed in the public gallery (Community)</option>
              </select>
            </Field>
            {error ? <Notice kind="error">{error}</Notice> : null}
            <div>
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? "Publishing…" : "Publish"}
              </button>
            </div>
          </>
        )}
      </div>
    </form>
  );
}
