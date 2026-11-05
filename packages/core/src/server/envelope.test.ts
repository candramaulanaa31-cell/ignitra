import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DecryptionError,
  KeyringError,
  createKeyring,
  decryptJson,
  decryptSecret,
  encryptJson,
  encryptSecret,
  keyringFromEnv,
  needsRewrap,
  rewrapSecret,
} from "./envelope";

const key = () => randomBytes(32);
const CTX = "connection:conn_01jabcdefghjkmnpqrstvwxyz0";

describe("envelope encryption", () => {
  const keyring = createKeyring({ kid: "k1", key: key() });

  it("round-trips UTF-8 secrets", () => {
    const secret = "https://discord.com/api/webhooks/123/abc — rahasia 🔥";
    const env = encryptSecret(keyring, secret, CTX);
    expect(env.kid).toBe("k1");
    expect(JSON.stringify(env)).not.toContain("abc");
    expect(decryptSecret(keyring, env, CTX)).toBe(secret);
  });

  it("round-trips JSON payloads", () => {
    const value = { refresh_token: "r-1", scopes: ["sheets"] };
    expect(decryptJson(keyring, encryptJson(keyring, value, CTX), CTX)).toEqual(value);
  });

  it("uses a fresh DEK and IV per encryption", () => {
    const a = encryptSecret(keyring, "same", CTX);
    const b = encryptSecret(keyring, "same", CTX);
    expect(a.ct).not.toBe(b.ct);
    expect(a.wdek).not.toBe(b.wdek);
    expect(a.iv).not.toBe(b.iv);
  });

  it("binds ciphertext to its context (no row swapping)", () => {
    const env = encryptSecret(keyring, "secret", CTX);
    expect(() => decryptSecret(keyring, env, "connection:conn_other")).toThrow(DecryptionError);
  });

  it("detects tampering of data and wrapped key", () => {
    const env = encryptSecret(keyring, "secret", CTX);
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, "base64");
      buf[0] = (buf[0] ?? 0) ^ 0xff;
      return buf.toString("base64");
    };
    expect(() => decryptSecret(keyring, { ...env, ct: flip(env.ct) }, CTX)).toThrow(DecryptionError);
    expect(() => decryptSecret(keyring, { ...env, tag: flip(env.tag) }, CTX)).toThrow(DecryptionError);
    expect(() => decryptSecret(keyring, { ...env, wdek: flip(env.wdek) }, CTX)).toThrow(DecryptionError);
  });

  it("rejects malformed envelopes and unknown key ids", () => {
    const env = encryptSecret(keyring, "secret", CTX);
    expect(() => decryptSecret(keyring, { ...env, v: 2 }, CTX)).toThrow("malformed envelope");
    expect(() => decryptSecret(keyring, "not an envelope", CTX)).toThrow(DecryptionError);
    expect(() => decryptSecret(keyring, { ...env, kid: "k9" }, CTX)).toThrow('no key for kid "k9"');
  });

  it("fails with a different master key", () => {
    const env = encryptSecret(keyring, "secret", CTX);
    const other = createKeyring({ kid: "k1", key: key() });
    expect(() => decryptSecret(other, env, CTX)).toThrow(DecryptionError);
  });

  it("refuses an empty context", () => {
    expect(() => encryptSecret(keyring, "secret", " ")).toThrow(KeyringError);
  });
});

describe("key rotation", () => {
  it("decrypts with previous keys and re-wraps under the active key", () => {
    const oldKey = key();
    const before = createKeyring({ kid: "k1", key: oldKey });
    const env = encryptSecret(before, "secret", CTX);

    const after = createKeyring({ kid: "k2", key: key() }, [{ kid: "k1", key: oldKey }]);
    expect(needsRewrap(after, env)).toBe(true);
    expect(decryptSecret(after, env, CTX)).toBe("secret");

    const rewrapped = rewrapSecret(after, env, CTX);
    expect(rewrapped.kid).toBe("k2");
    expect(rewrapped.ct).toBe(env.ct); // data untouched, only the DEK is re-wrapped
    expect(needsRewrap(after, rewrapped)).toBe(false);

    const onlyNew = createKeyring({ kid: "k2", key: Buffer.from(after.keys.get("k2") ?? []) });
    expect(decryptSecret(onlyNew, rewrapped, CTX)).toBe("secret");
  });
});

describe("keyring construction", () => {
  it("validates key length and unique ids", () => {
    expect(() => createKeyring({ kid: "k1", key: randomBytes(16) })).toThrow(KeyringError);
    expect(() => createKeyring({ kid: "k1", key: key() }, [{ kid: "k1", key: key() }])).toThrow("duplicate");
  });

  it("builds from env values", () => {
    const active = key().toString("base64");
    const prev = key().toString("base64");
    const ring = keyringFromEnv({
      ENCRYPTION_KEY: active,
      ENCRYPTION_KEY_ID: "k2",
      ENCRYPTION_KEYS_PREVIOUS: [{ kid: "k1", key: prev }],
    });
    expect(ring.activeKid).toBe("k2");
    expect([...ring.keys.keys()]).toEqual(["k2", "k1"]);
  });
});
