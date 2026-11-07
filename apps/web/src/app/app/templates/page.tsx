"use client";

import Link from "next/link";
import { CopyButton, Empty, Notice, Spinner, useToast } from "@/components/ui";
import { api, errorText, useApi } from "@/lib/api";
import type { TemplateCard } from "@/lib/template-types";

type Mine = TemplateCard & { hidden: boolean; url: string };

export default function MyTemplatesPage() {
  const [toast, notify] = useToast();
  const mine = useApi<{ data: Mine[] }>("/v1/me/templates");
  const remove = async (t: Mine) => {
    if (!window.confirm(`Delete the template "${t.name}"? Its link stops working; flows made from it keep running.`)) return;
    try {
      await api(`/v1/templates/${t.slug}`, { method: "DELETE" });
      await mine.reload();
    } catch (err) {
      notify(errorText(err), "error");
    }
  };
  return (
    <main className="stack">
      {toast}
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Templates</h1>
          <div className="sub">Start from a ready-made flow, or share one of yours.</div>
        </div>
        <Link href="/templates" className="btn primary">
          Browse the gallery
        </Link>
      </div>
      <section className="card">
        <div className="card-head">
          <span className="label">Shared by you</span>
          <span className="small muted">open a flow and use “Share as template”</span>
        </div>
        {mine.loading ? (
          <div className="card-body">
            <Spinner />
          </div>
        ) : mine.error ? (
          <div className="card-body">
            <Notice kind="error">{mine.error.message}</Notice>
          </div>
        ) : (mine.data?.data.length ?? 0) === 0 ? (
          <Empty>You have not shared a template yet.</Empty>
        ) : (
          <table className="table responsive">
            <thead>
              <tr>
                <th>Template</th>
                <th>Visibility</th>
                <th className="right">Used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {mine.data?.data.map((t) => (
                <tr key={t.slug}>
                  <td>
                    <Link href={`/templates/${t.slug}`}>{t.name}</Link>
                    <div className="small muted">{t.summary}</div>
                  </td>
                  <td data-label="visibility" className="small">
                    {t.hidden ? <span className="badge plain s-fail">hidden by moderators</span> : t.visibility === "public" ? "listed in the gallery" : "link only"}
                  </td>
                  <td data-label="used" className="right mono">
                    {t.uses}
                  </td>
                  <td className="right nowrap">
                    <CopyButton value={t.url} text="Copy link" />
                    <button type="button" className="btn sm ghost danger" onClick={() => void remove(t)}>
                      Delete
                    </button>
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
