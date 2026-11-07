import type { ReactNode } from "react";
import { DocsNav } from "@/components/docs-nav";
import { SiteHeader } from "@/components/site-header";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="wrap">
      <SiteHeader active="docs" />
      <div className="docs">
        <DocsNav />
        <main className="prose">{children}</main>
      </div>
    </div>
  );
}
