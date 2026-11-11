"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Brand } from "@/components/brand";

/** A page that failed to render: say so plainly, offer a retry, and give a reference to quote. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="wrap">
      <header className="topbar">
        <Brand />
      </header>
      <main className="lost">
        <p className="eyebrow">Error · This page stopped</p>
        <h1 className="display">This page failed to load.</h1>
        <p className="lede">Something broke on our side while drawing it. Your flows run on the server and keep running; nothing you saved was lost.</p>
        <div className="row hero-cta">
          <button type="button" className="btn primary lg" onClick={reset}>
            Try again
          </button>
          <Link href="/" className="btn lg">
            Home
          </Link>
        </div>
        {error.digest ? <p className="mono faint small lost-ref">Reference {error.digest}</p> : null}
      </main>
    </div>
  );
}
