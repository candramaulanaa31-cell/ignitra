import type { Logger } from "pino";

export type StopFn = () => Promise<void>;

export interface RunServiceOptions {
  /** Hard exit if graceful shutdown takes longer than this. */
  shutdownTimeoutMs?: number;
}

/**
 * Process lifecycle shared by api / listener / runner:
 * start → wait for SIGINT/SIGTERM → stop gracefully (bounded) → exit.
 * Startup failures and unhandled errors exit non-zero so a supervisor
 * (systemd, pm2, docker) restarts the process.
 */
export async function runService(
  logger: Logger,
  start: () => Promise<StopFn>,
  options: RunServiceOptions = {},
): Promise<void> {
  const timeoutMs = options.shutdownTimeoutMs ?? 10_000;
  let stop: StopFn | null = null;
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, "shutting down");
    const timer = setTimeout(() => {
      logger.error({ timeoutMs }, "graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    try {
      await stop?.();
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      exitCode = 1;
    }
    clearTimeout(timer);
    process.exit(exitCode);
  };

  process.once("SIGINT", () => void shutdown("SIGINT", 0));
  process.once("SIGTERM", () => void shutdown("SIGTERM", 0));
  // On Windows a signal to a child process is a hard kill, so a supervisor that spawned this process
  // with an IPC channel (deploy/windows/supervisor.mjs) sends "shutdown" instead. If the supervisor
  // itself dies, stop too: an orphan would keep the database lock and the port from its successor.
  if (process.send) {
    process.on("message", (msg) => {
      if (msg === "shutdown") void shutdown("shutdown message", 0);
    });
    process.once("disconnect", () => void shutdown("supervisor gone", 0));
  }
  process.on("unhandledRejection", (err) => {
    logger.fatal({ err }, "unhandled promise rejection");
    void shutdown("unhandledRejection", 1);
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception");
    void shutdown("uncaughtException", 1);
  });

  try {
    stop = await start();
  } catch (err) {
    logger.fatal({ err }, "failed to start");
    process.exit(1);
  }
}
