// Prints a fresh VAPID key pair for Web Push (RFC 8292): P-256, base64url.
// Usage: pnpm gen:vapid   → paste into .env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pub = publicKey.export({ format: "jwk" });
const priv = privateKey.export({ format: "jwk" });
const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);
console.log(`VAPID_PUBLIC_KEY=${point.toString("base64url")}`);
console.log(`VAPID_PRIVATE_KEY=${priv.d}`);
