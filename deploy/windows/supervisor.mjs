// IGNITRA on a Windows PC: keeps the backend running. The backend is ONE process with every role
// (API, listener, runner) on the embedded database (PGlite) in .data. The supervisor:
//   - restarts the backend when it stops (5 s, doubling up to 60 s while it keeps failing),
//   - restarts it when its API stops answering for 5 minutes,
//   - writes daily log files,
//   - takes a verified backup every night (from 03:00 local time, or at the next chance if the PC was off).
// The "IGNITRA" scheduled task (install.ps1) starts it at boot and re-checks every minute; a second
// copy exits at once.
//
// Files in .data/:
//   logs/ignitra-YYYY-MM-DD.log    log lines of the backend and the supervisor (kept 14 days)
//   backups/ignitra-*.ignitra.gz   nightly backups (kept 14 days). Copy them off this PC too.
//   run/state                      what the supervisor is doing (JSON)
//   run/hold                       made by deploy.mjs: stop the backend and wait until the file is gone
//   run/exit                       stop the backend and exit (the task starts the supervisor again within a minute)
//
// By hand: node deploy/windows/supervisor.mjs (Ctrl+C stops it and the backend).
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA = join(ROOT, ".data");
const RUN = join(DATA, "run");
const LOGS = join(DATA, "logs");
const BACKUPS = join(DATA, "backups");
const LISTENER = join(ROOT, "apps", "listener");
const KEEP_DAYS = 14;
const BACKUP_HOUR = 3;
/** Held only to keep one supervisor at a time; connections are closed at once. */
const GUARD_PORT = 4109;
/** A hold left behind by an interrupted deploy stops counting after this. */
const HOLD_MAX_MS = 30 * 60_000;
const ROLES = "sync,matcher,runner,api";

for (const dir of [RUN, LOGS, BACKUPS]) mkdirSync(dir, { recursive: true });

const pad = (n) => String(n).padStart(2, "0");
const day = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const flag = (name) => join(RUN, name);

// ---- logs -----------------------------------------------------------------
let logDay = "";
let logStream = null;
function sink() {
  const today = day();
  if (today !== logDay) {
    logStream?.end();
    logStream = createWriteStream(join(LOGS, `ignitra-${today}.log`), { flags: "a" });
    logDay = today;
    prune(LOGS);
  }
  return logStream;
}
/** Same shape as the backend's log lines (level 30 info, 40 warn, 50 error). */
function log(msg, level = 30) {
  sink().write(`${JSON.stringify({ level, time: new Date().toISOString(), service: "supervisor", pid: process.pid, msg })}\n`);
  if (process.stdout.isTTY) console.log(`${new Date().toTimeString().slice(0, 8)} ${msg}`);
}
function prune(dir) {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const name of readdirSync(dir)) {
    try {
      if (statSync(join(dir, name)).mtimeMs < cutoff) rmSync(join(dir, name), { force: true });
    } catch {
      // gone meanwhile
    }
  }
}
const pipe = (stream) => stream.on("data", (chunk) => sink().write(chunk));

function setState(state, extra = {}) {
  writeFileSync(flag("state"), `${JSON.stringify({ state, supervisor: process.pid, at: new Date().toISOString(), ...extra })}\n`);
}

function apiPort() {
  try {
    const match = /^API_PORT=(\d+)\s*$/m.exec(readFileSync(join(ROOT, ".env"), "utf8"));
    return match ? Number(match[1]) : 4000;
  } catch {
    return 4000;
  }
}

// ---- the backend ------------------------------------------------------------
let child = null;
let startedAt = 0;
let exited = Promise.resolve();
let stopRequested = false;
let restartAt = 0;
let backoff = 0;
let healthFailures = 0;

function start() {
  // `node --import tsx` runs the TypeScript in this one process, so the IPC channel reaches the
  // service itself: runService (packages/core) shuts down cleanly on a "shutdown" message.
  const proc = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: LISTENER,
    env: { ...process.env, LISTENER_ROLES: ROLES },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  child = proc;
  startedAt = Date.now();
  healthFailures = 0;
  pipe(proc.stdout);
  pipe(proc.stderr);
  exited = new Promise((done) => {
    let finished = false;
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      if (child === proc) child = null;
      const ran = Date.now() - startedAt;
      log(`backend exited (${signal ?? `code ${code}`}) after ${Math.round(ran / 1000)} s`, code === 0 ? 30 : 40);
      if (!stopRequested) {
        backoff = ran > 10 * 60_000 ? 5_000 : Math.min(Math.max(backoff * 2, 5_000), 60_000);
        restartAt = Date.now() + backoff;
        setState("restarting", { at_or_after: new Date(restartAt).toISOString() });
      }
      done();
    };
    proc.on("exit", finish);
    proc.on("error", (err) => {
      log(`backend failed to start: ${err.message}`, 50);
      finish(1, null);
    });
  });
  log(`backend started (pid ${proc.pid}, roles ${ROLES})`);
  setState("running", { pid: proc.pid, since: new Date(startedAt).toISOString() });
}

async function stop(reason) {
  const proc = child;
  if (!proc) return;
  stopRequested = true;
  log(`stopping the backend: ${reason}`);
  try {
    proc.send("shutdown");
  } catch {
    proc.kill();
  }
  // runService allows itself 10 s to finish in-flight work.
  const timer = setTimeout(() => {
    log("the backend did not stop within 20 s: killing it", 40);
    proc.kill();
  }, 20_000);
  await exited;
  clearTimeout(timer);
  stopRequested = false;
}

/** Runs the ops CLI (apps/listener/src/cli.ts) with the backend stopped; PGlite allows one process. */
function cli(args) {
  return new Promise((done) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: LISTENER, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on("error", () => done(1));
    proc.on("exit", (code) => done(code ?? 1));
  });
}

function backupDue() {
  const now = new Date();
  if (now.getHours() < BACKUP_HOUR) return false;
  const today = `ignitra-${day(now)}`;
  return !readdirSync(BACKUPS).some((name) => name.startsWith(today) && name.endsWith(".ignitra.gz"));
}

async function backup() {
  const now = new Date();
  const file = join(BACKUPS, `ignitra-${day(now)}-${pad(now.getHours())}${pad(now.getMinutes())}.ignitra.gz`);
  await stop("nightly backup");
  setState("backup", { file });
  const ok = (await cli(["db", "export", file])) === 0 && (await cli(["db", "verify", file])) === 0;
  if (ok) {
    log(`backup written and verified: ${file}`);
  } else {
    log("backup FAILED: next try in an hour", 50);
    rmSync(file, { force: true });
  }
  prune(BACKUPS);
  start();
}

async function checkHealth() {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort()}/health`, { signal: AbortSignal.timeout(10_000) });
    await res.arrayBuffer();
    // Any HTTP answer counts: a 503 (say, the RPC is down) is not something a restart fixes.
    healthFailures = 0;
  } catch (err) {
    healthFailures++;
    log(`API health check failed (${healthFailures}/5): ${err.message}`, 40);
    if (healthFailures >= 5) await stop("the API stopped answering"); // the next tick starts it again
  }
}

// ---- control loop -------------------------------------------------------------
function holdActive() {
  try {
    if (Date.now() - statSync(flag("hold")).mtimeMs < HOLD_MAX_MS) return true;
    log("ignoring a hold older than 30 minutes (left by an interrupted deploy?)", 40);
    rmSync(flag("hold"), { force: true });
  } catch {
    // no hold
  }
  return false;
}

async function exit(reason) {
  await stop(reason);
  setState("stopped");
  log(`supervisor exiting: ${reason}`);
  await new Promise((done) => logStream.end(done));
  process.exit(0);
}

let busy = false;
let lastBackupTry = 0;
let lastHealth = 0;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    if (existsSync(flag("exit"))) {
      rmSync(flag("exit"), { force: true });
      await exit("exit requested (the scheduled task starts the supervisor again within a minute)");
    }
    if (holdActive()) {
      if (child) await stop("held (deploy)");
      setState("held");
      return;
    }
    if (!child) {
      if (Date.now() >= restartAt) start();
      return;
    }
    const up = Date.now() - startedAt;
    if (up > 5 * 60_000 && Date.now() - lastBackupTry > 3_600_000 && backupDue()) {
      lastBackupTry = Date.now();
      await backup();
      return;
    }
    if (up > 3 * 60_000 && Date.now() - lastHealth > 60_000) {
      lastHealth = Date.now();
      await checkHealth();
    }
  } catch (err) {
    log(`supervisor error: ${err?.stack ?? err}`, 50);
  } finally {
    busy = false;
  }
}

const guard = createServer((socket) => socket.destroy());
guard.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log("another IGNITRA supervisor is running: exiting");
    process.exit(0);
  }
  throw err;
});
guard.listen(GUARD_PORT, "127.0.0.1", () => {
  rmSync(flag("exit"), { force: true }); // an old exit request must not stop this supervisor
  log(`supervisor started (pid ${process.pid}) in ${ROOT}`);
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.once(signal, () => void exit(signal));
  setInterval(() => void tick(), 1000);
  void tick();
});
