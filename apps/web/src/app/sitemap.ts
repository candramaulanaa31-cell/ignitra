import type { MetadataRoute } from "next";
import { OFFICIAL_TEMPLATES } from "@ignitra/core";
import { serverGetCached } from "@/lib/server-api";
import { DOC_PAGES, SITE_URL, TOKEN, TOKEN_LAUNCH } from "@/lib/site";

// Rebuilt hourly so public community templates join the official ones.
export const revalidate = 3600;

/** The landing, the template gallery (official and public community templates) and the docs. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const page = (path: string, priority: number, changeFrequency: "daily" | "weekly" | "monthly") => ({ url: `${SITE_URL}${path}`, lastModified: now, changeFrequency, priority });
  let community: string[] = [];
  try {
    const res = await serverGetCached<{ data: Array<{ slug: string; official?: boolean; visibility?: string }> }>("/v1/templates", 3600);
    community = (res?.data ?? []).filter((t) => !t.official && t.visibility === "public").map((t) => t.slug);
  } catch {
    // API down: the official templates and the docs are still listed.
  }
  const official = new Set(OFFICIAL_TEMPLATES.map((t) => t.slug));
  return [
    page("/", 1, "daily"),
    page("/templates", 0.9, "weekly"),
    ...OFFICIAL_TEMPLATES.map((t) => page(`/templates/${t.slug}`, 0.7, "monthly")),
    ...community.filter((slug) => !official.has(slug)).map((slug) => page(`/templates/${slug}`, 0.5, "monthly")),
    ...DOC_PAGES.map(([href]) => page(href, href === "/docs" ? 0.8 : 0.6, "monthly")),
    ...(TOKEN || TOKEN_LAUNCH ? [page("/token", 0.6, "weekly")] : []),
  ];
}
