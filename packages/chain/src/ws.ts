import { parseQuantity } from "./rpc";

/**
 * `eth_subscribe("newHeads")` over a WebSocket. Used only as a wake-up signal:
 * the listener always re-reads the head over HTTP, so a lying or stale socket
 * cannot make it skip blocks. Reconnects are the caller's job.
 */

export interface HeadSubscription {
  close(): void;
}

export interface HeadHandlers {
  onHead(blockNumber: number): void;
  onError(err: Error): void;
  onClose(): void;
}

export function subscribeNewHeads(url: string, handlers: HeadHandlers): HeadSubscription {
  const ws = new WebSocket(url);
  let closed = false;

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
  });

  ws.addEventListener("message", (event) => {
    let msg: { id?: number; error?: { message?: string }; method?: string; params?: { result?: { number?: unknown } } };
    try {
      msg = JSON.parse(String(event.data)) as typeof msg;
    } catch {
      return;
    }
    if (msg.id === 1 && msg.error) {
      handlers.onError(new Error(`eth_subscribe failed: ${msg.error.message ?? "unknown error"}`));
      ws.close();
      return;
    }
    if (msg.method === "eth_subscription") {
      try {
        handlers.onHead(parseQuantity(msg.params?.result?.number, "newHeads.number"));
      } catch (err) {
        handlers.onError(err as Error);
      }
    }
  });

  ws.addEventListener("error", () => handlers.onError(new Error("websocket error")));
  ws.addEventListener("close", () => {
    if (!closed) handlers.onClose();
  });

  return {
    close() {
      closed = true;
      ws.close();
    },
  };
}
