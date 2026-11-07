"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { SessionGate, useSession } from "@/components/session";
import { shortHex } from "@/lib/format";

const NAV = [
  { href: "/app", label: "Flows", match: (p: string) => p === "/app" || (p.startsWith("/app/flows") && !p.endsWith("/new")) || p.startsWith("/app/runs") },
  { href: "/app/flows/new", label: "New flow", match: (p: string) => p === "/app/flows/new" },
  { href: "/app/connections", label: "Connections", match: (p: string) => p.startsWith("/app/connections") },
  { href: "/app/settings", label: "Settings", match: (p: string) => p.startsWith("/app/settings") },
];

function Shell({ children }: { children: ReactNode }) {
  const { me, signOut } = useSession();
  const path = usePathname() ?? "/app";
  return (
    <>
      <header className="topbar">
        <Link href="/" className="wordmark">
          IGNITRA<span>_</span>
        </Link>
        <nav className="nav" aria-label="App">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={n.match(path) ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="account">
          <span className="badge plain s-skip" title="Plan">
            {me.plan}
          </span>
          <span className="mono addr-label" title={me.address}>
            {shortHex(me.address)}
          </span>
          <button type="button" className="btn sm ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      {children}
    </>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="wrap">
      <SessionGate>
        <Shell>{children}</Shell>
      </SessionGate>
    </div>
  );
}
