import Link from "next/link";
import { Brand } from "./brand";
import { ChainHead } from "./chain-head";
import { SignalPath } from "./signal";
import { X_HANDLE, X_URL } from "@/lib/site";

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
      <ChainHead />
      <div className="topbar-actions">
        <a href={X_URL} className="btn sm x-link" target="_blank" rel="noreferrer" aria-label={`IGNITRA on X (@${X_HANDLE})`} title={`@${X_HANDLE} on X`}>
          <svg viewBox="0 0 1200 1227" aria-hidden="true" focusable="false">
            <path
              fill="currentColor"
              d="M714.163 519.284 1160.89 0H1055.03L667.137 450.887 357.328 0H0l468.492 681.821L0 1226.37h105.866l409.625-476.152 327.181 476.152H1200L714.137 519.284h.026ZM569.165 687.828l-47.468-67.894L144.011 79.694h162.604l304.797 435.991 47.468 67.894 396.2 566.721H892.476L569.165 687.854v-.026Z"
            />
          </svg>
        </a>
        <Link href="/app" className="btn primary sm">
          Open the app
        </Link>
      </div>
    </header>
  );
}

export function Outline({ lines }: { lines: ReadonlyArray<{ kind: string; text: string }> }) {
  return <SignalPath lines={lines} />;
}
