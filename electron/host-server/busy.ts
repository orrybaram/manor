/**
 * Whether this host is busy (ADR-229 D7): ADR-178 §1's keep-awake rule,
 * decided here, where it can be seen with the lid closed.
 *
 * - **`createBusyTracker`** turns the agent pipeline's updates into one
 *   debounced flag. Going busy is immediate; going idle waits
 *   `IDLE_DEBOUNCE_MS`, and an agent going active again inside it cancels
 *   the wait, so a prompt-and-answer is no event at all.
 * - **`createHookRunner`** runs the box's `~/.manor/remote/hooks/on-busy` or
 *   `on-idle` on each transition. That is how a recipe keeps a provider
 *   awake, or lets it sleep, with the lid closed; Manor knows no provider.
 *
 * Electron-free: the host server bundles it.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "../lib/errors";

/** How long agents must all be quiet before the host reports idle. */
export const IDLE_DEBOUNCE_MS = 60_000;
/** A hook that takes longer than this is killed. */
export const HOOK_TIMEOUT_MS = 30_000;
/** `logs/hooks.log` is trimmed to its newer half past this size. */
export const HOOKS_LOG_MAX_BYTES = 256 * 1024;

export interface BusyTrackerOptions {
  /** Whether any agent is in an active status right now. */
  isBusy(): boolean;
  /** A debounced transition. */
  onChange(busy: boolean): void;
  debounceMs?: number;
  now?: () => number;
}

export interface BusyTracker {
  /** Read the agents again; call on every update that could change the answer. */
  recompute(): void;
  /** What `hostServer.status` reports. `idleSince` is null while busy. */
  state(): { busy: boolean; idleSince: number | null };
  dispose(): void;
}

export function createBusyTracker(opts: BusyTrackerOptions): BusyTracker {
  const debounceMs = opts.debounceMs ?? IDLE_DEBOUNCE_MS;
  const now = opts.now ?? Date.now;
  let busy = false;
  // A server with no agents has been idle since it started.
  let idleSince: number | null = now();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    recompute() {
      if (opts.isBusy()) {
        cancel();
        if (busy) return;
        busy = true;
        idleSince = null;
        opts.onChange(true);
        return;
      }
      // Idle already, or the wait is running.
      if (!busy || timer) return;
      timer = setTimeout(() => {
        timer = null;
        // An agent may have gone active again without a recompute reaching us.
        if (opts.isBusy()) return;
        busy = false;
        idleSince = now();
        opts.onChange(false);
      }, debounceMs);
      timer.unref?.();
    },
    state: () => ({ busy, idleSince }),
    dispose: cancel,
  };
}

export type HookName = "on-busy" | "on-idle";

export interface HookRunnerOptions {
  /** `~/.manor/remote/hooks`. */
  dir: string;
  /** `logs/hooks.log`. */
  logFile: string;
  timeoutMs?: number;
  maxLogBytes?: number;
  /** Tests inject a fake child. */
  spawn?: typeof nodeSpawn;
  log?: Pick<Console, "warn">;
}

export interface HookRunner {
  /** Which hooks exist and can be run, for `hostServer.status`. */
  available(): { onBusy: boolean; onIdle: boolean };
  /**
   * Run the hook for a transition. Resolves once it (or a newer one it made
   * way for) has finished; never rejects.
   */
  run(busy: boolean): Promise<void>;
  /** Resolves when nothing is running or waiting. */
  idle(): Promise<void>;
}

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Keep the newer half of a log that has grown past `max`. */
function capLog(file: string, max: number): void {
  try {
    const { size } = fs.statSync(file);
    if (size <= max) return;
    const keep = Math.floor(max / 2);
    const fd = fs.openSync(file, "r");
    try {
      const tail = Buffer.alloc(keep);
      fs.readSync(fd, tail, 0, keep, size - keep);
      fs.writeFileSync(file, tail, { mode: 0o600 });
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // No log yet.
  }
}

export function createHookRunner(opts: HookRunnerOptions): HookRunner {
  const timeoutMs = opts.timeoutMs ?? HOOK_TIMEOUT_MS;
  const maxLogBytes = opts.maxLogBytes ?? HOOKS_LOG_MAX_BYTES;
  const spawn = opts.spawn ?? nodeSpawn;
  const log = opts.log ?? console;

  const fileFor = (name: HookName): string => path.join(opts.dir, name);

  // One hook at a time. A transition that arrives meanwhile waits, and a
  // newer one replaces it: only the state the box ends in is worth a hook.
  let running: Promise<void> | null = null;
  let waiting: boolean | null = null;
  let lastRan: boolean | null = null;

  function appendLog(text: string): void {
    try {
      fs.mkdirSync(path.dirname(opts.logFile), { recursive: true, mode: 0o700 });
      capLog(opts.logFile, maxLogBytes);
      fs.appendFileSync(opts.logFile, text, { mode: 0o600 });
    } catch {
      // A log that cannot be written does not stop the hook.
    }
  }

  /** Run one hook to its end, the timeout, or its failing to start. */
  function runOne(busy: boolean): Promise<void> {
    const name: HookName = busy ? "on-busy" : "on-idle";
    const file = fileFor(name);
    if (!isExecutableFile(file)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      appendLog(`[${new Date().toISOString()}] ${name}\n`);
      let fd: number;
      try {
        fd = fs.openSync(opts.logFile, "a", 0o600);
      } catch (err) {
        log.warn(`[host-server] ${name}: cannot open the hooks log: ${errorMessage(err)}`);
        resolve();
        return;
      }
      let child: ChildProcess;
      try {
        // Detached, so a server that restarts does not take a running hook
        // with it; its output goes straight to the log, no pipe to break.
        // The key sealing the pairing keys stays with the server (ADR-236 D2).
        const { MANOR_SECRET_KEY: _key, MANOR_SECRET_KEY_FILE: _keyFile, ...env } = process.env;
        child = spawn(file, [], {
          detached: true,
          stdio: ["ignore", fd, fd],
          env: { ...env, MANOR_BUSY: busy ? "1" : "0" },
        });
      } catch (err) {
        fs.closeSync(fd);
        log.warn(`[host-server] ${name} failed to start: ${errorMessage(err)}`);
        resolve();
        return;
      }
      let settled = false;
      const finish = (note: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          fs.closeSync(fd);
        } catch {
          // Already closed.
        }
        if (note) {
          appendLog(`[host-server] ${name} ${note}\n`);
          log.warn(`[host-server] ${name} ${note}`);
        }
        resolve();
      };
      const timer = setTimeout(() => {
        // The whole group: a hook is a script, and its children are its own.
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        finish(`timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      timer.unref?.();
      child.on("error", (err) => finish(`failed: ${errorMessage(err)}`));
      child.on("exit", (code, signal) => {
        finish(code === 0 ? null : `exited with ${code ?? signal}`);
      });
    });
  }

  function start(busy: boolean): Promise<void> {
    lastRan = busy;
    const current = runOne(busy).then(() => {
      if (running !== current) return;
      running = null;
      const next = waiting;
      waiting = null;
      // The box is already in the state the last hook was told about.
      if (next !== null && next !== lastRan) return start(next);
    });
    running = current;
    return current;
  }

  return {
    available: () => ({
      onBusy: isExecutableFile(fileFor("on-busy")),
      onIdle: isExecutableFile(fileFor("on-idle")),
    }),
    run(busy) {
      if (running) {
        waiting = busy;
        return running;
      }
      return start(busy);
    },
    idle: async () => {
      while (running) await running;
    },
  };
}
