import { createLogger, databaseEnvSchema, loadDotEnv, parseEnv } from "@ignitra/core/server";
import { createDb } from "./client";

// `pnpm db:migrate` — applies pending SQL migrations from packages/db/migrations.
// Idempotent: applied migrations are tracked in drizzle.__drizzle_migrations.
const logger = createLogger("db-migrate");
loadDotEnv();
const { DATABASE_URL } = parseEnv(databaseEnvSchema);
const handle = await createDb(DATABASE_URL, { applicationName: "ignitra-migrate" });
try {
  await handle.migrate();
  logger.info({ driver: handle.driver }, "migrations applied");
} finally {
  await handle.close();
}
