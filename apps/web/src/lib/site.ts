/**
 * The site's public origin, for absolute URLs: share cards, the sitemap, links in shared templates.
 * WEB_URL is the same setting the API uses for links back to the web app; on Vercel the project's
 * production domain is the fallback, then localhost for development.
 */
export const SITE_URL = (
  process.env.WEB_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000")
).replace(/\/+$/, "");

/** The docs pages, in reading order: the docs navigation and the sitemap. */
export const DOC_PAGES = [
  ["/docs", "Overview"],
  ["/docs/triggers", "Triggers"],
  ["/docs/conditions", "Conditions"],
  ["/docs/actions", "Actions"],
  ["/docs/variables", "Variables"],
  ["/docs/webhooks", "Webhooks"],
  ["/docs/integrations", "Integrations"],
  ["/docs/onchain", "Onchain"],
  ["/docs/api", "API"],
  ["/docs/sdk", "SDK"],
] as const;
