// Deploys this repo's committed code (HEAD) to IGNITRA's run directory on this Windows PC: the
// Windows counterpart of deploy/push.sh. From the repo, in a normal (not administrator) terminal:
//
//   node deploy/windows/deploy.mjs --domain example.com    first time: also writes the settings
//   node deploy/windows/deploy.mjs                         every update
//
// The run directory (C:\ignitra-prod, or --dir) is a git clone of this repo checked out at the
// deployed commit, so work in this copy never touches the running one. Its .env and .data
// (database, logs, backups) are ignored by git and stay. With the backend held by the supervisor,
// it installs dependencies and runs the preflight (`ops doctor`). The backend starts again only if
// the preflight passes; otherwise the previous version is put back. Then it waits for the API.
//
// The first time, settings are written with fresh secrets: the web app at https://<domain>, the API
// at https://api.<domain> through a Cloudflare Tunnel to 127.0.0.1:<port> (4100), and every role in
// one process on the embedded database (PGlite).
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    dir: { type: "string", default: "C:\\ignitra-prod" },
    domain: { type: "string" },
    port: { type: "string", default: "4100" },
  },
});
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = resolve(values.dir);
const RUN = join(DIR, ".data", "run");
const DEPLOYED = join(DIR, ".data", "deployed");
const ENV_FILE = join(DIR, ".env");
const GUARD_PORT = 4109; // the supervisor's single-instance port

const say = (msg) => console.log(`== ${msg}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
/** pnpm is a .cmd shim on Windows, so it goes through the shell (as one string: no unescaped args). */
const pnpmInstall = () => spawnSync("pnpm install --frozen-lockfile", { cwd: DIR, stdio: "inherit", shell: true }).status === 0;
const checkout = (rev) => {
  git(DIR, "checkout", "--quiet", "--force", "--detach", rev);
  git(DIR, "clean", "-f", "-d", "-q"); // untracked files go; ignored ones (.env, .data, node_modules) stay
};

function listening(port) {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 1000 });
    socket.once("connect", () => (socket.destroy(), done(true)));
    socket.once("error", () => done(false));
    socket.once("timeout", () => (socket.destroy(), done(false)));
  });
}

function supervisorState() {
  try {
    return JSON.parse(readFileSync(join(RUN, "state"), "utf8")).state;
  } catch {
    return null;
  }
}

function apiPort() {
  const match = /^API_PORT=(\d+)\s*$/m.exec(readFileSync(ENV_FILE, "utf8"));
  return match ? Number(match[1]) : 4000;
}

function starterEnv(domain, port) {
  const secret = () => randomBytes(32).toString("base64url");
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const vapidPublic = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
  return `# Written by deploy/windows/deploy.mjs on ${new Date().toISOString().slice(0, 10)}. Every key is explained in .env.example.
# Keep a copy of ENCRYPTION_KEY somewhere safe and offline: without it, stored secrets cannot be decrypted.
NODE_ENV=production
LOG_LEVEL=info

# One process on this PC (deploy/windows/supervisor.mjs): API, listener and runner share the
# embedded database in .data/pglite.
DATABASE_URL=pglite://.data/pglite
LISTENER_ROLES=sync,matcher,runner,api
ENCRYPTION_KEY=${secret()}
ENCRYPTION_KEY_ID=k1
WEBHOOK_SIGNING_SECRET=${secret()}
VAPID_PUBLIC_KEY=${vapidPublic}
VAPID_PRIVATE_KEY=${privateKey.export({ format: "jwk" }).d}
VAPID_SUBJECT=mailto:ops@${domain}

# The Cloudflare Tunnel forwards https://api.${domain} to http://127.0.0.1:${port}.
API_HOST=127.0.0.1
API_PORT=${port}
LISTENER_HEALTH_PORT=${port + 1}
API_PUBLIC_URL=https://api.${domain}
WEB_URL=https://${domain}
CORS_ORIGINS=https://${domain}
TRUST_PROXY=127.0.0.1

CHAIN_ID=4663
# A provider endpoint as the primary is better: the public RPC is rate limited.
RPC_URL_PRIMARY=https://rpc.mainnet.chain.robinhood.com
RPC_URL_FALLBACK=

# Optional, add when you have them, then deploy again:
# EMAIL_PROVIDER=resend
# EMAIL_API_KEY=
# EMAIL_FROM="IGNITRA <alerts@${domain}>"
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_REDIRECT_URI=https://${domain}/api/v1/connections/google/callback
# EXPLORER_API_KEY=
`;
}

// ---- deploy -----------------------------------------------------------------------
if (DIR.toLowerCase() === SRC.toLowerCase()) throw new Error("run this from your working copy of the repo, not from the run directory");
if (values.domain !== undefined && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(values.domain)) throw new Error(`--domain ${values.domain}: expected a host name such as example.com`);
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65_000) throw new Error(`--port ${values.port}: expected 1024-65000`);

const sha = git(SRC, "rev-parse", "HEAD");
say(`deploying ${sha.slice(0, 7)} "${git(SRC, "log", "-1", "--format=%s")}" to ${DIR}`);
if (git(SRC, "status", "--porcelain", "--untracked-files=no") !== "") console.log("   note: uncommitted changes are not deployed, only the last commit");

if (!existsSync(join(DIR, ".git"))) {
  say("first deploy: cloning the repo");
  execFileSync("git", ["clone", "--quiet", "--no-checkout", SRC, DIR], { stdio: "inherit" });
}
git(DIR, "fetch", "--quiet", SRC, "HEAD");
const prev = existsSync(DEPLOYED) ? readFileSync(DEPLOYED, "utf8").trim() : null;

mkdirSync(RUN, { recursive: true });
const supervised = await listening(GUARD_PORT);
let failed = false;
let restartSupervisor = false;
try {
  if (supervised) {
    say("holding the backend");
    writeFileSync(join(RUN, "hold"), `deploy ${process.pid}\n`);
    for (let waited = 0; supervisorState() !== "held"; waited += 500) {
      if (waited > 45_000) throw new Error("the supervisor did not stop the backend within 45 s (see .data/logs)");
      await sleep(500);
    }
  }

  checkout(sha);
  if (!existsSync(ENV_FILE)) {
    if (!values.domain) throw new Error("first deploy: pass --domain <domain> (the web app's host; the API becomes api.<domain>)");
    writeFileSync(ENV_FILE, starterEnv(values.domain.toLowerCase(), port));
    say(`settings written with fresh secrets: ${ENV_FILE}`);
    console.log("   Copy ENCRYPTION_KEY from it to a safe, offline place (a password manager).");
  }

  say("installing dependencies");
  if (!pnpmInstall()) throw new Error("pnpm install failed");

  say("preflight (ops doctor)");
  const doctor = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "doctor"], { cwd: join(DIR, "apps", "listener"), stdio: "inherit" }).status;
  if (doctor !== 0) {
    failed = true;
    if (prev && prev !== sha) {
      say(`the preflight failed: putting back ${prev.slice(0, 7)}`);
      checkout(prev);
      pnpmInstall();
    }
  } else {
    writeFileSync(DEPLOYED, `${sha}\n`);
    restartSupervisor = supervised && prev !== null && prev !== sha && git(DIR, "diff", "--name-only", prev, sha, "--", "deploy/windows/supervisor.mjs") !== "";
    if (restartSupervisor) writeFileSync(join(RUN, "exit"), "deploy\n"); // the new supervisor code takes over
  }
} finally {
  rmSync(join(RUN, "hold"), { force: true });
}

if (failed) {
  console.error(`\ndeploy: the preflight failed. Fix what it lists (settings: ${ENV_FILE}), then deploy again.`);
  process.exit(1);
}
if (!supervised) {
  say("deployed. Nothing runs it yet: once, in PowerShell as administrator:");
  console.log(`   powershell -ExecutionPolicy Bypass -File ${join(DIR, "deploy", "windows", "install.ps1")}`);
  process.exit(0);
}

say(restartSupervisor ? "waiting for the new supervisor and the API (up to 3 minutes)" : "waiting for the API");
const deadline = Date.now() + (restartSupervisor ? 180_000 : 90_000);
for (;;) {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort()}/health`, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    say(`API answers: ${JSON.stringify(body).slice(0, 300)}`);
    break;
  } catch {
    if (Date.now() > deadline) {
      console.error("deploy: the API did not answer in time; see the newest file in .data/logs");
      process.exit(1);
    }
    await sleep(2000);
  }
}
