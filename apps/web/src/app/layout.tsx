import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ServiceWorker } from "@/components/service-worker";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "IGNITRA — onchain automation for Robinhood Chain", template: "%s · IGNITRA" },
  description: "Connect anything that happens on Robinhood Chain to the tools you already use — reliably, traceably, without running a single bot.",
  applicationName: "IGNITRA",
  manifest: "/manifest.webmanifest",
  // iOS: installable to the home screen; Web Push works there (iOS 16.4+) once installed.
  appleWebApp: { capable: true, title: "IGNITRA", statusBarStyle: "default" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f5" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0e10" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
