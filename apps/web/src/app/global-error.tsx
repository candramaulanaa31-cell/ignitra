"use client";

import "./globals.css";

/** The last resort, when even the root layout failed: it brings its own document. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">
          <main className="lost">
            <p className="eyebrow">Error · IGNITRA</p>
            <h1 className="display">Something failed to load.</h1>
            <p className="lede">The page could not be drawn. Your flows run on the server and keep running; nothing you saved was lost.</p>
            <div className="row hero-cta">
              <button type="button" className="btn primary lg" onClick={reset}>
                Try again
              </button>
              <a href="/" className="btn lg">
                Home
              </a>
            </div>
            {error.digest ? <p className="mono faint small lost-ref">Reference {error.digest}</p> : null}
          </main>
        </div>
      </body>
    </html>
  );
}
