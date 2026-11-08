import { createServer, type Server } from "node:http";

/**
 * Minimal health endpoint for process supervisors (systemd, pm2, uptime
 * checks). Binds to localhost by default. 503 when the snapshot is degraded.
 */
export function startHealthServer(source: { health(): { status: string }; metrics?: () => Promise<string> }, host: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    // Prometheus text exposition (Phase 9). Internal port only: metrics name flows.
    if (req.method === "GET" && req.url === "/metrics" && source.metrics) {
      source.metrics().then(
        (text) => {
          res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
          res.end(text);
        },
        (err: unknown) => {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(`# metrics unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
        },
      );
      return;
    }
    if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
      const snapshot = source.health();
      res.writeHead(snapshot.status === "degraded" ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(snapshot));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not_found", message: "not found" } }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

export function closeServer(server: Server | null): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}
