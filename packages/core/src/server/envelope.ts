import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Envelope encryption for connection secrets (API keys, webhook URLs with
 * tokens, OAuth refresh tokens).
 *
 *   plaintext ──AES-256-GCM(DEK, AAD=context)──▶ ct
 *   DEK (random per secret) ──AES-256-GCM(KEK[kid], AAD=kid+context)──▶ wdek
 *
 * - The KEK (ENCRYPTION_KEY) never touches data directly; rotating it only
 *   re-wraps DEKs (`rewrapSecret`) — ciphertexts stay untouched.
 * - `context` binds a ciphertext to its owner record (e.g. `connection:conn_…`),
 *   so copying an envelope onto another row makes decryption fail.
 * - GCM auth tags make any tampering fail loudly instead of decrypting garbage.
 */

const ALG = "AES-256-GCM";
const CIPHER = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface Keyring {
  readonly activeKid: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyringError";
  }
}

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

export function createKeyring(
  active: { kid: string; key: Buffer },
  previous: ReadonlyArray<{ kid: string; key: Buffer }> = [],
): Keyring {
  const keys = new Map<string, Buffer>();
  for (const { kid, key } of [active, ...previous]) {
    if (key.length !== KEY_BYTES) throw new KeyringError(`key "${kid}" must be ${KEY_BYTES} bytes`);
    if (keys.has(kid)) throw new KeyringError(`duplicate key id "${kid}"`);
    keys.set(kid, Buffer.from(key));
  }
  return { activeKid: active.kid, keys };
}

export function keyringFromEnv(env: {
  ENCRYPTION_KEY: string;
  ENCRYPTION_KEY_ID: string;
  ENCRYPTION_KEYS_PREVIOUS?: ReadonlyArray<{ kid: string; key: string }> | undefined;
}): Keyring {
  return createKeyring(
    { kid: env.ENCRYPTION_KEY_ID, key: Buffer.from(env.ENCRYPTION_KEY, "base64") },
    (env.ENCRYPTION_KEYS_PREVIOUS ?? []).map(({ kid, key }) => ({ kid, key: Buffer.from(key, "base64") })),
  );
}

const b64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

export const encryptedEnvelopeSchema = z
  .object({
    v: z.literal(1),
    alg: z.literal(ALG),
    kid: z.string().min(1),
    /** wrapped DEK */
    wiv: b64,
    wdek: b64,
    wtag: b64,
    /** data */
    iv: b64,
    ct: b64,
    tag: b64,
  })
  .strict();

export type EncryptedEnvelope = z.infer<typeof encryptedEnvelopeSchema>;

const dekAad = (kid: string, context: string): Buffer => Buffer.from(`ignitra:dek:v1:${kid}:${context}`, "utf8");
const dataAad = (context: string): Buffer => Buffer.from(`ignitra:data:v1:${context}`, "utf8");

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}

function open(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv(CIPHER, key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function requireContext(context: string): void {
  if (context.trim() === "") throw new KeyringError("encryption context must not be empty");
}

function unwrapDek(keyring: Keyring, env: EncryptedEnvelope, context: string): Buffer {
  const kek = keyring.keys.get(env.kid);
  if (!kek) throw new DecryptionError(`no key for kid "${env.kid}"`);
  try {
    return open(
      kek,
      Buffer.from(env.wiv, "base64"),
      Buffer.from(env.wdek, "base64"),
      Buffer.from(env.wtag, "base64"),
      dekAad(env.kid, context),
    );
  } catch {
    throw new DecryptionError("failed to unwrap data key (wrong key, context, or tampered envelope)");
  }
}

function wrapDek(keyring: Keyring, dek: Buffer, context: string) {
  const kid = keyring.activeKid;
  const kek = keyring.keys.get(kid);
  if (!kek) throw new KeyringError(`active key "${kid}" missing from keyring`);
  const wrapped = seal(kek, dek, dekAad(kid, context));
  return {
    kid,
    wiv: wrapped.iv.toString("base64"),
    wdek: wrapped.ct.toString("base64"),
    wtag: wrapped.tag.toString("base64"),
  };
}

export function encryptSecret(keyring: Keyring, plaintext: string, context: string): EncryptedEnvelope {
  requireContext(context);
  const dek = randomBytes(KEY_BYTES);
  try {
    const data = seal(dek, Buffer.from(plaintext, "utf8"), dataAad(context));
    return {
      v: 1,
      alg: ALG,
      ...wrapDek(keyring, dek, context),
      iv: data.iv.toString("base64"),
      ct: data.ct.toString("base64"),
      tag: data.tag.toString("base64"),
    };
  } finally {
    dek.fill(0);
  }
}

export function decryptSecret(keyring: Keyring, envelope: unknown, context: string): string {
  requireContext(context);
  const parsed = encryptedEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) throw new DecryptionError("malformed envelope");
  const env = parsed.data;
  const dek = unwrapDek(keyring, env, context);
  try {
    return open(
      dek,
      Buffer.from(env.iv, "base64"),
      Buffer.from(env.ct, "base64"),
      Buffer.from(env.tag, "base64"),
      dataAad(context),
    ).toString("utf8");
  } catch {
    throw new DecryptionError("failed to decrypt secret (wrong context or tampered envelope)");
  } finally {
    dek.fill(0);
  }
}

export function encryptJson(keyring: Keyring, value: unknown, context: string): EncryptedEnvelope {
  return encryptSecret(keyring, JSON.stringify(value), context);
}

export function decryptJson(keyring: Keyring, envelope: unknown, context: string): unknown {
  return JSON.parse(decryptSecret(keyring, envelope, context));
}

/** True when the envelope's DEK is wrapped by a non-active key (rotation pending). */
export function needsRewrap(keyring: Keyring, envelope: EncryptedEnvelope): boolean {
  return envelope.kid !== keyring.activeKid;
}

/** Re-wraps the DEK under the active key. Data ciphertext is unchanged. */
export function rewrapSecret(keyring: Keyring, envelope: unknown, context: string): EncryptedEnvelope {
  requireContext(context);
  const parsed = encryptedEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) throw new DecryptionError("malformed envelope");
  const dek = unwrapDek(keyring, parsed.data, context);
  try {
    return { ...parsed.data, ...wrapDek(keyring, dek, context) };
  } finally {
    dek.fill(0);
  }
}
