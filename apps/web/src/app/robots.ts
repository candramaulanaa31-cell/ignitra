import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/** Public pages are open to crawlers; the signed-in app and the API proxy are not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/app", "/api/"] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
