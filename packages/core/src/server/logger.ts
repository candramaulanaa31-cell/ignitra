import { pino, type Logger, type LevelWithSilent } from "pino";

export type { Logger };

/** Paths whose values are replaced before a log line is written. */
export const REDACT_PATHS = [
  "secret",
  "*.secret",
  "password",
  "*.password",
  "token",
  "*.token",
  "apiKey",
  "*.apiKey",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "*.headers.authorization",
  "headers.cookie",
  "*.headers.cookie",
  'headers["x-ignitra-signature"]',
];

export function createLogger(service: string, level: LevelWithSilent = "info"): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  });
}
