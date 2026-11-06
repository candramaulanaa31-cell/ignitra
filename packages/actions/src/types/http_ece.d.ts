// Minimal typings for the parts of http_ece used in tests (RFC 8188 / 8291 decryption).
declare module "http_ece" {
  import type { ECDH } from "node:crypto";
  interface DecryptParams {
    version: "aes128gcm" | "aesgcm";
    privateKey?: ECDH;
    authSecret?: string | Buffer;
    dh?: string | Buffer;
    key?: string | Buffer;
  }
  const ece: { decrypt(buffer: Buffer, params: DecryptParams): Buffer };
  export default ece;
}
