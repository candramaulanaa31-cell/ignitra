import Link from "next/link";
import { Brand } from "./brand";
import { SignalPath } from "./signal";

/** Header of the public pages (landing, templates, docs). */
export function SiteHeader({ active }: { active?: "templates" | "docs" }) {
  return (
    <header className="topbar">
      <Brand />
      <nav className="nav" aria-label="Site">
        <Link href="/templates" aria-current={active === "templates" ? "page" : undefined}>
          Templates
        </Link>
        <Link href="/docs" aria-current={active === "docs" ? "page" : undefined}>
          Docs
        </Link>
      </nav>
      <Link href="/app" className="btn primary sm">
        Open the app
      </Link>
    </header>
  );
}

export function Outline({ lines }: { lines: ReadonlyArray<{ kind: string; text: string }> }) {
  return <SignalPath lines={lines} />;
}
