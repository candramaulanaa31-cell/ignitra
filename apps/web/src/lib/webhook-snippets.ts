/**
 * Receiver-side code shown in the docs. Kept here (not inline in the page) so a
 * test can run the Node version against IGNITRA's real signer.
 */

export const NODE_VERIFY = `import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the request body exactly as received (a string), before JSON parsing.
export function verifyIgnitra(rawBody, headers, secret, toleranceSeconds = 300) {
  const timestamp = Number(headers["x-ignitra-timestamp"]);
  if (!Number.isInteger(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false; // replayed or stale
  const mac = createHmac("sha256", secret).update(timestamp + "." + rawBody).digest("hex");
  const expected = Buffer.from("v1=" + mac);
  // During a secret rotation several signatures are sent, comma-separated.
  return String(headers["x-ignitra-signature"] ?? "").split(",").some((candidate) => {
    const given = Buffer.from(candidate.trim());
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}`;

export const NODE_EXPRESS = `import express from "express";

const app = express();
const seen = new Set(); // use your database in production

app.post("/ignitra", express.text({ type: "application/json" }), (req, res) => {
  if (!verifyIgnitra(req.body, req.headers, process.env.IGNITRA_WEBHOOK_SECRET)) return res.sendStatus(401);
  const key = req.headers["x-ignitra-idempotency-key"];
  if (seen.has(key)) return res.sendStatus(200); // a retry of something already handled
  seen.add(key);

  const event = JSON.parse(req.body);
  if (event.type === "run.action" && !event.test) {
    console.log(event.flow.name, event.trigger.tx_hash);
  }
  res.sendStatus(200); // answer fast: slow work belongs in your own queue
});`;

export const PYTHON_VERIFY = `import hashlib
import hmac
import time


def verify_ignitra(raw_body: bytes, headers, secret: str, tolerance_seconds: int = 300) -> bool:
    """raw_body: the request body exactly as received, before JSON parsing."""
    try:
        timestamp = int(headers.get("x-ignitra-timestamp", ""))
    except ValueError:
        return False
    if abs(time.time() - timestamp) > tolerance_seconds:
        return False  # replayed or stale
    mac = hmac.new(secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256).hexdigest()
    expected = f"v1={mac}"
    # During a secret rotation several signatures are sent, comma-separated.
    return any(hmac.compare_digest(c.strip(), expected) for c in headers.get("x-ignitra-signature", "").split(","))


# Flask:
#   @app.post("/ignitra")
#   def hook():
#       if not verify_ignitra(request.get_data(), request.headers, os.environ["IGNITRA_WEBHOOK_SECRET"]):
#           abort(401)
#       event = request.get_json()
#       ...
#       return "", 200`;

export const CURL_INBOUND = `curl -X POST "https://…/v1/hooks/fl_…/<token>" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1042" \\
  -d '{"order": "1042", "total": 99.5, "customer": {"wallet": "0x8366a39cc670b4001a1121b8f6a443a643e40951"}}'`;
