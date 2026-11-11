import type { Metadata } from "next";
import Link from "next/link";
import { SignalPath } from "@/components/signal";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = { title: "Not found" };

/** 404, read as a flow that ran: the page was asked for, the condition failed, nothing ran. */
export default function NotFound() {
  return (
    <div className="wrap">
      <SiteHeader />
      <main className="lost">
        <p className="eyebrow">404 · No match</p>
        <h1 className="display">Nothing at this address.</h1>
        <p className="lede">This page does not exist, or it moved. The flow below ran like any other and stopped where it should.</p>
        <SignalPath
          className="lost-path"
          lines={[
            { kind: "WHEN", text: "You opened this page" },
            { kind: "IF", text: "the page exists  ·  false" },
            { kind: "THEN", text: "Nothing ran. Pick a way back:" },
          ]}
        />
        <div className="row hero-cta">
          <Link href="/" className="btn primary lg">
            Home
          </Link>
          <Link href="/templates" className="btn lg">
            Templates
          </Link>
          <Link href="/docs" className="btn ghost">
            Read the docs →
          </Link>
        </div>
      </main>
    </div>
  );
}
