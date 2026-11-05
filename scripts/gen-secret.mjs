// Prints a random 32-byte secret, base64-encoded.
// Usage: pnpm gen:secret            -> one secret (e.g. ENCRYPTION_KEY)
//        pnpm gen:secret 3          -> three secrets
import { randomBytes } from "node:crypto";

const count = Number.parseInt(process.argv[2] ?? "1", 10);
for (let i = 0; i < (Number.isFinite(count) && count > 0 ? count : 1); i++) {
  console.log(randomBytes(32).toString("base64"));
}
