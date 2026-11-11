"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOC_PAGES as PAGES } from "@/lib/site";

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
