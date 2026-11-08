import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { closeServer, startHealthServer } from "./health";

describe("health server", () => {
  it("serves /health, and /metrics as Prometheus text when the process has metrics", async () => {
    let fail = false;
    const server = await startHealthServer(
      {
        health: () => ({ status: "ok", roles: ["sync"] }),
        metrics: async () => {
          if (fail) throw new Error("db down");
          return '# TYPE ignitra_listener_lag_blocks gauge\nignitra_listener_lag_blocks{chain="4663"} 3\n';
        },
      },
      "127.0.0.1",
      0,
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: "ok", roles: ["sync"] });
      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
      expect(await metrics.text()).toContain('ignitra_listener_lag_blocks{chain="4663"} 3');
      fail = true;
      const broken = await fetch(`${base}/metrics`);
      expect([broken.status, await broken.text()]).toEqual([500, "# metrics unavailable: db down\n"]);
    } finally {
      await closeServer(server);
    }
    // A process without metrics answers 404 there.
    const plain = await startHealthServer({ health: () => ({ status: "ok" }) }, "127.0.0.1", 0);
    try {
      expect((await fetch(`http://127.0.0.1:${(plain.address() as AddressInfo).port}/metrics`)).status).toBe(404);
    } finally {
      await closeServer(plain);
    }
  });
});
