import type { Metadata, Viewport } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { ServiceWorker } from "@/components/service-worker";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

// Self-hosted at build time (no request to Google at runtime). Archivo's width axis gives the
// wide display cuts; JetBrains Mono carries chain data: addresses, hashes, blocks, payloads.
const sans = Archivo({ subsets: ["latin"], axes: ["wdth"], display: "swap", variable: "--font-archivo" });
const mono = JetBrains_Mono({ subsets: ["latin"], display: "swap", variable: "--font-jetbrains" });

export const metadata: Metadata = {
  title: { default: "IGNITRA — onchain automation for Robinhood Chain", template: "%s · IGNITRA" },
  description: "Connect anything that happens on Robinhood Chain to the tools you already use — reliably, traceably, without running a single bot.",
  applicationName: "IGNITRA",
  manifest: "/manifest.webmanifest",
  // iOS: installable to the home screen; Web Push works there (iOS 16.4+) once installed.
  appleWebApp: { capable: true, title: "IGNITRA", statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  // Absolute URLs for share cards. Each page's title and description become its og:/twitter: tags;
  // the image is app/opengraph-image.tsx unless a page has its own (templates do).
  metadataBase: new URL(SITE_URL),
  openGraph: { type: "website", siteName: "IGNITRA", locale: "en_US" },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f0e8" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0b0a" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
