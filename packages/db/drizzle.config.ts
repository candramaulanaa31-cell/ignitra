import { defineConfig } from "drizzle-kit";

// `pnpm db:generate` diffs src/schema.ts against migrations/ and writes a new
// SQL migration. It never connects to a database. Review every generated file.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  strict: true,
  verbose: true,
});
