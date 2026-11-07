import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NODE_VERIFY } from "./webhook-snippets";

/**
 * The docs' receiver code must verify what IGNITRA actually sends. The vector was
 * produced by @ignitra/actions `signWebhook` (the runner's signer):
 *   signWebhook("whsec_docs_vector", 1762480800, BODY)
 */
const SECRET = "whsec_docs_vector";
const TIMESTAMP = 1762480800;
const BODY = '{"type":"run.action","test":false}';
const SIGNATURE = "v1=569c921ff96f225bc770ec62d743e3dc147d69f13e73af6662c198cac55a098e";

type Verify = (rawBody: string, headers: Record<string, string | undefined>, secret: string, tolerance?: number) => boolean;

describe("docs: Node webhook verification snippet", () => {
  let dir: string;
  let verify: Verify;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ignitra-snippet-"));
    const file = join(dir, "verify.mjs");
    writeFileSync(file, NODE_VERIFY);
    ({ verifyIgnitra: verify } = (await import(pathToFileURL(file).href)) as { verifyIgnitra: Verify });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => vi.useRealTimers());

  const at = (seconds: number) => {
    vi.useFakeTimers();
    vi.setSystemTime(seconds * 1000);
  };
  const headers = (signature: string, timestamp: number | string = TIMESTAMP) => ({ "x-ignitra-signature": signature, "x-ignitra-timestamp": String(timestamp) });

  it("accepts a genuine delivery, also among rotated signatures", () => {
    at(TIMESTAMP + 10);
    expect(verify(BODY, headers(SIGNATURE), SECRET)).toBe(true);
    expect(verify(BODY, headers(`v1=${"0".repeat(64)}, ${SIGNATURE}`), SECRET)).toBe(true);
  });

  it("rejects tampered bodies, wrong secrets, stale or missing timestamps", () => {
    at(TIMESTAMP + 10);
    expect(verify(BODY.replace("false", "true"), headers(SIGNATURE), SECRET)).toBe(false);
    expect(verify(BODY, headers(SIGNATURE), "whsec_other")).toBe(false);
    expect(verify(BODY, headers(SIGNATURE, TIMESTAMP + 1), SECRET)).toBe(false);
    expect(verify(BODY, { "x-ignitra-signature": SIGNATURE }, SECRET)).toBe(false);
    expect(verify(BODY, { "x-ignitra-timestamp": String(TIMESTAMP) }, SECRET)).toBe(false);
    at(TIMESTAMP + 301);
    expect(verify(BODY, headers(SIGNATURE), SECRET)).toBe(false);
  });
});
