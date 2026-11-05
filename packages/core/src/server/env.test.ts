import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EnvError, apiEnvSchema, chainConfigFromEnv, encryptionEnvSchema, parseEnv, workerEnvSchema } from "./env";

const DB = { DATABASE_URL: "pglite://memory" };

describe("env parsing", () => {
  it("applies defaults and treats empty strings as unset", () => {
    const env = parseEnv(apiEnvSchema, { ...DB, RPC_URL_FALLBACK: "", WS_URL: "  ", API_PORT: "" });
    expect(env.CHAIN_ID).toBe(4663);
    expect(env.API_PORT).toBe(4000);
    expect(env.RPC_URL_FALLBACK).toBeUndefined();
    expect(env.WS_URL).toBeUndefined();
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("feeds the chain config", () => {
    const env = parseEnv(workerEnvSchema, { ...DB, CHAIN_ID: "46630" });
    expect(chainConfigFromEnv(env).name).toBe("Robinhood Chain Testnet");
  });

  it("reports every invalid variable by name, never by value", () => {
    const secretish = "postgres-ish-but-wrong://user:hunter2@host";
    try {
      parseEnv(apiEnvSchema, { DATABASE_URL: secretish, RPC_URL_PRIMARY: "ftp://x", WS_URL: "https://x", API_PORT: "99999" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      const message = (err as EnvError).message;
      for (const name of ["DATABASE_URL", "RPC_URL_PRIMARY", "WS_URL", "API_PORT"]) expect(message).toContain(name);
      expect(message).not.toContain("hunter2");
    }
  });

  it("requires DATABASE_URL", () => {
    expect(() => parseEnv(workerEnvSchema, {})).toThrow(/DATABASE_URL/);
  });

  it("validates encryption keys and previous-key lists", () => {
    const k = () => randomBytes(32).toString("base64");
    const env = parseEnv(encryptionEnvSchema, { ENCRYPTION_KEY: k(), ENCRYPTION_KEYS_PREVIOUS: `k0:${k()}, k00:${k()}` });
    expect(env.ENCRYPTION_KEY_ID).toBe("k1");
    expect(env.ENCRYPTION_KEYS_PREVIOUS?.map((p) => p.kid)).toEqual(["k0", "k00"]);

    expect(() => parseEnv(encryptionEnvSchema, {})).toThrow(/ENCRYPTION_KEY/);
    expect(() => parseEnv(encryptionEnvSchema, { ENCRYPTION_KEY: randomBytes(16).toString("base64") })).toThrow(
      /32 bytes/,
    );
    expect(() => parseEnv(encryptionEnvSchema, { ENCRYPTION_KEY: k(), ENCRYPTION_KEYS_PREVIOUS: "nokid" })).toThrow(
      EnvError,
    );
  });
});
