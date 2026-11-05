import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test file boots an in-memory PGlite (WASM Postgres); first boot is slow.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
