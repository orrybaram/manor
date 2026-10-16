/**
 * Keep a host server running on this box (ADR-225 D1).
 *
 * `manor-host server-bridge` calls `ensureServerRunning()`, and the desktop
 * opens one on every connect:
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
 *
 * Under a supervisor (`supervisor.json`, ADR-229 D4) nothing is spawned
 * detached beside it: down becomes `supervisor.start("server")`, and another
 * version becomes a stop of the old pid (it may be a detached server from
 * before `install`, which the supervisor cannot reach) then
 * `supervisor.restart("server")`. The supervised server runs the shim, so it
 * comes up as the installed version. A supervisor that fails, or starts
 * nothing that listens, falls back to the detached spawn with a warning.
 *
 * `restartServer()` (`manor-host restart-server`, ADR-236 D4) stops a live
 * server, through the supervisor when there is one, then ensures one again:
 * a fresh start re-reads `supervisor.env` and re-probes the secret backends.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { errorMessage } from "../lib/errors";
import { hostServerPaths, remoteServerDir, type HostServerPaths } from "../paths";
import { isAlive, readPid, removeIfOurs } from "./pid-file";
import { loadSupervisor, type Supervisor } from "./supervisor";

const SOCKET_WAIT_MS = 5000;
/**
 * A supervisor starts the server through the shim and a unit manager: more
 * room, but with the fallback still inside a waiting bridge's `LOCK_WAIT_MS`.
 */
const SUPERVISED_WAIT_MS = 8000;
const KILL_GRACE_MS = 5000;
/** How long a waiter waits for a lock its holder is not refreshing. */
const LOCK_WAIT_MS = 15000;
/** A lock older than this is abandoned even if its pid is alive (pid reuse). */
const LOCK_STALE_MS = 30000;
/**
 * A holder touches `server.lock` this often while it holds it. A
 * `restartServer` can hold it for longer than `LOCK_WAIT_MS`, even
 * `LOCK_STALE_MS` (a supervisor stop and its wait, SIGTERM then SIGKILL, a
 * supervised start, then the detached fallback: about 28 s at worst), so
 * the lock's age, not its holder's total time, is what tells a live holder
 * from an abandoned one: a refreshed lock is never stale, and a waiter keeps
 * waiting on it past `LOCK_WAIT_MS`.
 */
const LOCK_REFRESH_MS = 2000;
/** A lock touched within this is being refreshed by a live holder. */
const LOCK_FRESH_MS = 3 * LOCK_REFRESH_MS;
/** The most a waiter waits, refreshed lock or not: a holder that hangs must not hang it too. */
const LOCK_MAX_WAIT_MS = 60000;
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
  /**
   * The supervisor `supervisor.json` names (ADR-229 D4), asked once per
   * `ensureServerRunning`; null when nothing supervises this box. Absent
   * means none.
   */
  supervisor?(): Supervisor | null;
  /** Where the fallback from a broken supervisor is reported. Defaults to `console.warn`. */
  warn?(message: string): void;
  /**
   * Call `fn` every `ms` until the answered function is called: the lock's
   * heartbeat. Defaults to an unref'd `setInterval`.
   */
  every?(ms: number, fn: () => void): () => void;
}

function readTrimmed(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8").trim();
  } catch {
    return null;
  }
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
    supervisor: () => loadSupervisor(),
    every: defaultEvery,
  };
}

function defaultEvery(ms: number, fn: () => void): () => void {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
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

/** Set `lockPath`'s mtime to `deps.now()`: the holder is alive and still at it. */
function touchLock(deps: LifecycleDeps, lockPath: string): void {
  const at = new Date(deps.now());
  try {
    fs.utimesSync(lockPath, at, at);
  } catch {
    // Gone (cleared as stale after all): the release is a no-op then too.
  }
}

/**
 * Take `server.lock`, waiting for a holder and clearing an abandoned lock.
 * While held, the lock is touched every `LOCK_REFRESH_MS` (see there); the
 * release stops that. A waiter gives up after `LOCK_WAIT_MS` only once the
 * lock has gone unrefreshed for `LOCK_FRESH_MS` (an older holder that does
 * not refresh), and after `LOCK_MAX_WAIT_MS` regardless.
 */
async function acquireLock(deps: LifecycleDeps): Promise<(() => void) | null> {
  const lockPath = path.join(deps.paths.dataDir, "server.lock");
  fs.mkdirSync(deps.paths.dataDir, { recursive: true, mode: 0o700 });
  const mine = `${process.pid}\n`;
  const start = deps.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, mine);
      fs.closeSync(fd);
      touchLock(deps, lockPath);
      const stop = (deps.every ?? defaultEvery)(LOCK_REFRESH_MS, () => touchLock(deps, lockPath));
      return () => {
        stop();
        removeIfOurs(lockPath, mine);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let stale: boolean;
    let age: number;
    try {
      const holder = readPid(lockPath);
      age = deps.now() - fs.statSync(lockPath).mtimeMs;
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
    const waited = deps.now() - start;
    if (waited >= LOCK_MAX_WAIT_MS || (waited >= LOCK_WAIT_MS && age > LOCK_FRESH_MS)) return null;
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
    await startLocked(deps, state, pid);
  } finally {
    release?.();
  }
}

/** With `server.lock` held: bring up a server of this version from `state`. */
async function startLocked(
  deps: LifecycleDeps,
  state: Exclude<State, "healthy">,
  pid: number | null,
): Promise<void> {
  if (state === "stale-version" && pid !== null) await stopOld(deps, pid);
  const supervisor = deps.supervisor?.() ?? null;
  if (supervisor && (await startSupervised(deps, supervisor, state))) return;
  deps.spawnServer(deps.paths);
  if (!(await listening(deps, SOCKET_WAIT_MS))) {
    throw new Error(`host server did not start listening on ${deps.paths.socket}`);
  }
}

/** Whether a server of this version is listening within `timeoutMs`. */
function listening(deps: LifecycleDeps, timeoutMs: number): Promise<boolean> {
  return waitFor(deps, timeoutMs, async () => {
    return (await deps.probeSocket(deps.paths.socket)) && readTrimmed(deps.paths.version) === deps.version;
  });
}

/**
 * Start (down) or restart (another version, already stopped) the server
 * through `supervisor`. False, with a warning, when that did not bring up a
 * server of this version: the caller spawns one detached instead.
 */
async function startSupervised(
  deps: LifecycleDeps,
  supervisor: Supervisor,
  state: Exclude<State, "healthy">,
): Promise<boolean> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  try {
    if (state === "stale-version") await supervisor.restart("server");
    else await supervisor.start("server");
  } catch (err) {
    warn(
      `[host-server] the ${supervisor.kind} supervisor could not start the server (${errorMessage(err)}); spawning it detached`,
    );
    return false;
  }
  if (await listening(deps, SUPERVISED_WAIT_MS)) return true;
  warn(
    `[host-server] the ${supervisor.kind} supervisor started no server on ${deps.paths.socket}; spawning it detached`,
  );
  return false;
}

/**
 * Stop the live server, then start one of this version (ADR-236 D4). Under
 * a supervisor the stop goes through it, so a unit with `Restart=` does not
 * bring the old process straight back; a supervisor that fails, or leaves
 * the pid alive, falls back to SIGTERM then SIGKILL. With no server running
 * this only ensures one. The whole stop and start holds `server.lock`, so a
 * bridge connecting meanwhile waits for the new server rather than racing
 * the stop. Throws as `ensureServerRunning` does.
 */
export async function restartServer(deps: LifecycleDeps = defaultDeps()): Promise<void> {
  const release = await acquireLock(deps);
  if (release === null) throw new Error("timed out waiting for another process starting the host server");
  try {
    const { state, pid } = await inspect(deps);
    if (state !== "down" && pid !== null) {
      const supervisor = deps.supervisor?.() ?? null;
      let stopped = false;
      if (supervisor) {
        try {
          await supervisor.stop("server");
          stopped = await waitFor(deps, KILL_GRACE_MS, () => !deps.isAlive(pid));
        } catch (err) {
          (deps.warn ?? ((m: string) => console.warn(m)))(
            `[host-server] the ${supervisor.kind} supervisor could not stop the server (${errorMessage(err)}); signalling it`,
          );
        }
      }
      if (!stopped) await stopOld(deps, pid);
    }
    // A supervisor may already have brought one back (`Restart=` after a SIGKILL).
    const after = await inspect(deps);
    if (after.state === "healthy") return;
    await startLocked(deps, after.state, after.pid);
  } finally {
    release();
  }
}
