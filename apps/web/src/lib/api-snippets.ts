/** Client code shown in the API docs (exercised against a live API in the Phase 7 validation). */

const WEB_URL = (process.env.WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export const SIWE_SIGN_IN = `// Node 20+, with viem (npm i viem). Sign in with the wallet that owns your flows:
// the key stays on your machine, IGNITRA only ever receives the signature.
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const API = "${WEB_URL}/api";
const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY); // or any viem wallet (hardware, WalletConnect…)

const { nonce, domains, chain_id } = await (await fetch(\`\${API}/v1/auth/nonce\`)).json();
const message = createSiweMessage({
  address: account.address,
  chainId: chain_id, // 4663, Robinhood Chain
  domain: domains[0],
  uri: "${WEB_URL}",
  nonce,
  version: "1",
  issuedAt: new Date(),
  statement: "Sign in to IGNITRA",
});
const signature = await account.signMessage({ message });

const res = await fetch(\`\${API}/v1/auth/verify\`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message, signature, return_token: true }),
});
const { token, expires_at } = await res.json();

// Every other call: Authorization: Bearer <token>
const flows = await (await fetch(\`\${API}/v1/flows\`, { headers: { authorization: \`Bearer \${token}\` } })).json();
console.log(expires_at, flows.data.map((f) => \`\${f.name}: \${f.status}\`));`;
