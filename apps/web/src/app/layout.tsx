import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "IGNITRA — onchain automation for Robinhood Chain",
  description:
    "Connect anything that happens on Robinhood Chain to the tools you already use — reliably, traceably, without running a single bot.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">
          <header className="topbar">
            <a href="/" className="wordmark">
              IGNITRA<span>_</span>
            </a>
            <nav>
              <a href="/app">App</a>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
