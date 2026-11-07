import Link from "next/link";

/** Header of the public pages (landing, templates, docs). */
export function SiteHeader({ active }: { active?: "templates" | "docs" }) {
  return (
    <header className="topbar">
      <Link href="/" className="wordmark">
        IGNITRA<span>_</span>
      </Link>
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
  return (
    <pre className="json outline">
      {lines.map((l, i) => (
        <span key={i}>
          <span className="kw">{l.kind.padEnd(5)}</span> {l.text}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
