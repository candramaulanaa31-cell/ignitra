"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Brand } from "@/components/brand";
import { ChainHead } from "@/components/chain-head";
import { SessionGate, useSession } from "@/components/session";
import { shortHex } from "@/lib/format";

const NAV = [
  { href: "/app", label: "Flows", match: (p: string) => p === "/app" || (p.startsWith("/app/flows") && !p.endsWith("/new")) || p.startsWith("/app/runs") },
  { href: "/app/flows/new", label: "New flow", match: (p: string) => p === "/app/flows/new" },
  { href: "/app/templates", label: "Templates", match: (p: string) => p.startsWith("/app/templates") },
  { href: "/app/connections", label: "Connections", match: (p: string) => p.startsWith("/app/connections") },
  { href: "/app/onchain", label: "Onchain", match: (p: string) => p.startsWith("/app/onchain") },
  { href: "/app/settings", label: "Settings", match: (p: string) => p.startsWith("/app/settings") },
];

function Shell({ children }: { children: ReactNode }) {
  const { me, signOut } = useSession();
  const path = usePathname() ?? "/app";
  return (
    <>
      <header className="topbar">
        <Brand href="/app" />
        <nav className="nav" aria-label="App">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={n.match(path) ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="account">
          <ChainHead />
          <span className="account-id" title={me.address}>
            <span className="plan-tag">{me.plan}</span>
            <span className="mono addr-label">{shortHex(me.address)}</span>
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
