import type { MetadataRoute } from "next";

/** Installable PWA (Add to Home Screen): required for Web Push on iOS. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "IGNITRA — onchain automation",
    short_name: "IGNITRA",
    description: "When Robinhood Chain moves, your stack follows.",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    background_color: "#0e0e10",
    theme_color: "#0e0e10",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
