/**
 * Keep a host server running on this box (ADR-218 D1).
 *
 * `manor-host remote-bridge` and `server-bridge` call `ensureServerRunning()`
 * whenever the desktop connects:
 *
 * - `server.pid` live, `server.version` equal to this install's version and
 *   `server.sock` accepting -> nothing to do;
 * - the same, but another version -> SIGTERM the old server (SIGKILL after a
 *   grace period), then start one from this install. The terminal daemon is
 *   never touched: sessions survive a server upgrade;
 * - not running -> spawn `manor-host serve` detached and wait for its socket.
 *
 * Two bridges connecting at once serialise on `server.lock` (O_EXCL, with
 * stale-lock recovery); `runServe`'s refusal to start over a live pid is the
 * backstop.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { hostServerPaths, remoteServerDir, type HostServerPaths } from "../paths";

const SOCKET_WAIT_MS = 5000;
const KILL_GRACE_MS = 5000;
const LOCK_WAIT_MS = 15000;
/** A lock older than this is abandoned even if its pid is alive (pid reuse). */
const LOCK_STALE_MS = 30000;
const POLL_MS = 50;

export interface LifecycleDeps {
  paths: HostServerPaths;
  /** This install's version (`MANOR_VERSION`). */
  version: string;
  /** Start `serve` detached; resolves once spawned, not once listening. */
  spawnServer(paths: HostServerPaths): void;
  isAlive(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
  /** Whether something accepts connections on the socket. */
  probeSocket(socketPath: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

function readTrimmed(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8").trim();
  } catch {
    return null;
  }
}

function readPid(file: string): number | null {
  const raw = readTrimmed(file);
  if (!raw) return null;
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Spawn `<node> <this bundle> serve --data-dir <dir>`, detached, logging to a file. */
function spawnServe(paths: HostServerPaths, version: string): void {
  fs.mkdirSync(paths.logsDir, { recursive: true, mode: 0o700 });
  let logFd: number | "ignore" = "ignore";
  try {
    logFd = fs.openSync(path.join(paths.logsDir, "host-server-spawn.log"), "a", 0o600);
  } catch {
    // Run without a spawn log rather than not at all.
  }
  try {
    const child = spawn(
      process.execPath,
      [process.argv[1], "serve", "--data-dir", paths.dataDir],
      {
        env: { ...process.env, MANOR_VERSION: version },
        stdio: ["ignore", "ignore", logFd],
        detached: true,
      },
    );
    child.on("error", () => {});
    child.unref();
  } finally {
    if (typeof logFd === "number") fs.closeSync(logFd);
  }
}

export function defaultDeps(dataDir: string = remoteServerDir()): LifecycleDeps {
  const paths = hostServerPaths(dataDir);
  const version = process.env.MANOR_VERSION ?? "unknown";
  return {
    paths,
    version,
    spawnServer: (p) => spawnServe(p, version),
    isAlive,
    kill: (pid, signal) => process.kill(pid, signal),
    probeSocket,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

async function waitFor(
  deps: LifecycleDeps,
  timeoutMs: number,
  cond: () => boolean | Promise<boolean>,
): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (deps.now() >= deadline) return false;
    await deps.sleep(POLL_MS);
  }
}

type State = "healthy" | "stale-version" | "down";

async function inspect(deps: LifecycleDeps): Promise<{ state: State; pid: number | null }> {
  const { paths } = deps;
  const pid = readPid(paths.pid);
  if (pid === null || !deps.isAlive(pid)) return { state: "down", pid };
  // A live pid without a listening socket is not provably our server (pids
  // get reused): never signal it.
  if (!(await deps.probeSocket(paths.socket))) return { state: "down", pid };
  return {
    state: readTrimmed(paths.version) === deps.version ? "healthy" : "stale-version",
    pid,
  };
}

/** Take `server.lock`, waiting for a holder and clearing an abandoned lock. */
async function acquireLock(deps: LifecycleDeps): Promise<(() => void) | null> {
  const lockPath = path.join(deps.paths.dataDir, "server.lock");
  fs.mkdirSync(deps.paths.dataDir, { recursive: true, mode: 0o700 });
  const mine = `${process.pid}\n`;
  const deadline = deps.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, mine);
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.readFileSync(lockPath, "utf-8") === mine) fs.unlinkSync(lockPath);
        } catch {
          // Already gone.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let stale = false;
    try {
      const holder = readPid(lockPath);
      const age = deps.now() - fs.statSync(lockPath).mtimeMs;
      stale = (holder !== null && !deps.isAlive(holder)) || age > LOCK_STALE_MS;
      if (holder === null && age < 1000) stale = false; // mid-write
    } catch {
      continue; // vanished between EEXIST and stat: retry now
    }
    if (stale) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Someone else cleared it.
      }
      continue;
    }
    if (deps.now() >= deadline) return null;
    await deps.sleep(POLL_MS);
  }
}

async function stopOld(deps: LifecycleDeps, pid: number): Promise<void> {
  try {
    deps.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  if (await waitFor(deps, KILL_GRACE_MS, () => !deps.isAlive(pid))) return;
  try {
    deps.kill(pid, "SIGKILL");
  } catch {
    // Gone in between.
  }
  await waitFor(deps, KILL_GRACE_MS, () => !deps.isAlive(pid));
  // SIGKILL leaves its files behind; a dead pid is ignored, the socket is not.
  for (const f of [deps.paths.pid, deps.paths.version, deps.paths.socket]) {
    try {
      fs.unlinkSync(f);
    } catch {
      // Not there.
    }
  }
}

/** Make sure a server of this install's version is listening. Throws if it cannot. */
export async function ensureServerRunning(
  deps: LifecycleDeps = defaultDeps(),
): Promise<void> {
  if ((await inspect(deps)).state === "healthy") return;

  const release = await acquireLock(deps);
  try {
    // Someone may have finished the job while we waited for the lock.
    const { state, pid } = await inspect(deps);
    if (state === "healthy") return;
    if (release === null) throw new Error("timed out waiting for another process starting the host server");

    if (state === "stale-version" && pid !== null) await stopOld(deps, pid);
    deps.spawnServer(deps.paths);
    const up = await waitFor(deps, SOCKET_WAIT_MS, async () => {
      return (await deps.probeSocket(deps.paths.socket)) && readTrimmed(deps.paths.version) === deps.version;
    });
    if (!up) throw new Error(`host server did not start listening on ${deps.paths.socket}`);
  } finally {
    release?.();
  }
}
