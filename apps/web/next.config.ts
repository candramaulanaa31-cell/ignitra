import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript source; Next compiles them.
  transpilePackages: ["@ignitra/core"],
};

export default config;
