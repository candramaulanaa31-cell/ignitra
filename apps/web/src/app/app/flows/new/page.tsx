"use client";

import Link from "next/link";
import { OFFICIAL_TEMPLATES } from "@ignitra/core";
import { Builder } from "@/components/builder/builder";

const STARTERS = ["big-buy-telegram", "new-holder-welcome-telegram", "whale-sell-push", "treasury-low-email", "proxy-upgraded-webhook", "inbound-telegram-relay"];

export default function NewFlowPage() {
  const starters = STARTERS.map((s) => OFFICIAL_TEMPLATES.find((t) => t.slug === s)).filter((t) => t !== undefined);
  return (
    <main>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-head">
          <span className="label">Start from a template</span>
          <Link href="/templates" className="small">
            all templates →
          </Link>
        </div>
        <div className="card-body row">
          {starters.map((t) => (
            <Link key={t.slug} href={`/app/templates/${t.slug}`} className="chip">
              {t.name}
            </Link>
          ))}
        </div>
      </div>
      <Builder />
    </main>
  );
}
