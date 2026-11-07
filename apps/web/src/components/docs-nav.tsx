"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const PAGES = [
  ["/docs", "Overview"],
  ["/docs/triggers", "Triggers"],
  ["/docs/conditions", "Conditions"],
  ["/docs/actions", "Actions"],
  ["/docs/variables", "Variables"],
  ["/docs/webhooks", "Webhooks"],
  ["/docs/api", "API"],
] as const;

export function DocsNav() {
  const path = usePathname();
  return (
    <nav className="docs-nav" aria-label="Docs">
      {PAGES.map(([href, label]) => (
        <Link key={href} href={href} aria-current={path === href ? "page" : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
