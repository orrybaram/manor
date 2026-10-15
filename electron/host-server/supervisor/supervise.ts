/**
 * `manor-host supervise`: the supervisor for a container with no init system
 * (ADR-229 D4). It runs in the foreground as the container's entrypoint.
 *
 * - It starts the daemon (`--namespace remote`) and then the host server
 *   (`serve`) as its children, through the `~/.manor/bin/manor-host` shim, so
 *   it always runs the installed version.
 * - A unit already running when it looks (its pid file names a live process
 *   and its socket answers) is adopted instead, and polled every 2 s; once
 *   that process is gone, `supervise` starts its own.
 * - A unit that exits is started again after a backoff, 1 s doubling to
 *   30 s, reset once a child has stayed up for 30 s.
 * - SIGTERM and SIGINT are passed on to both units; it exits once they have
 *   (SIGKILL after a grace period).
 * - `SIGUSR1` restarts the server, `SIGUSR2` the daemon, and `SIGHUP` starts
 *   whichever is down without waiting out its backoff (`./container.ts`).
 * - Its pid is in `~/.manor/remote/supervise.pid` while it runs, which is
 *   how `supervisor status` knows a container is supervised.
 * - It records itself in `~/.manor/remote/supervisor.json` when nothing is
 *   recorded there (`claimContainerMarker`): a container whose entrypoint
 *   is `supervise` is supervised, whether or not `supervisor install` has
 *   run yet. The desktop's install on a fresh box's first connect races the
 *   entrypoint, which only starts `supervise` once bootstrap has put the
 *   shim there; without the marker, an upgrade would spawn a detached
 *   server beside the one `supervise` restarts.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { errorMessage } from "../../lib/errors";
import { writeFileAtomic } from "../../lib/fs-atomic";
import {
  daemonPidFile,
  daemonSocketFile,
  hostServerPaths,
  hostShimFile,
  supervisePidFile,
  supervisorMarkerFile,
} from "../../paths";
import { probeSocket } from "../lifecycle";
import { isAlive, readPid, removeIfOurs } from "../pid-file";
import { RESTART_SIGNALS, START_SIGNAL } from "./container";
import { readSupervisorMarker } from "./index";
import { SUPERVISED_UNITS, type SupervisedUnit } from "./types";

const MIN_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 30_000;
/** A child up this long has started fine; its next exit restarts after `MIN_BACKOFF_MS`. */
const STABLE_MS = 30_000;
/** How often an adopted unit's pid is checked. */
export const ADOPT_POLL_MS = 2_000;
/** How long shutdown waits for the units before SIGKILL. */
export const KILL_GRACE_MS = 10_000;
/** How long the server's start waits for the daemon's socket. */
const DAEMON_WAIT_MS = 10_000;
const DAEMON_POLL_MS = 100;

/** One started unit, as `supervise` sees it. */
export interface SuperviseChild {
  readonly pid: number | undefined;
  kill(signal: NodeJS.Signals): void;
  /** Called once, when the process exits or could not be started. */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface SuperviseDeps {
  /** Start `unit` through the shim. */
  spawn(unit: SupervisedUnit): SuperviseChild;
  /** The pid `unit`'s own pid file names, or null. */
  unitPid(unit: SupervisedUnit): number | null;
  socketPath(unit: SupervisedUnit): string;
  probeSocket(socketPath: string): Promise<boolean>;
  isAlive(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
  log(message: string): void;
  now(): number;
}

type UnitState =
  | { kind: "idle" }
  /** Looking for a running one to adopt, or about to spawn. */
  | { kind: "launching" }
  | { kind: "child"; child: SuperviseChild; startedAt: number; restartNow: boolean }
  | { kind: "adopted"; pid: number; timer: ReturnType<typeof setInterval>; restartNow: boolean }
  | { kind: "waiting"; timer: ReturnType<typeof setTimeout> };

interface Slot {
  state: UnitState;
  backoffMs: number;
}

export class Supervise {
  private readonly slots: Record<SupervisedUnit, Slot> = {
    daemon: { state: { kind: "idle" }, backoffMs: MIN_BACKOFF_MS },
    server: { state: { kind: "idle" }, backoffMs: MIN_BACKOFF_MS },
  };
  private stopping = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveStopped: () => void = () => {};
  private readonly stoppedPromise = new Promise<void>((resolve) => {
    this.resolveStopped = resolve;
  });

  constructor(private readonly deps: SuperviseDeps) {}

  /** Start (or adopt) the daemon, wait for its socket, then the server. */
  async start(): Promise<void> {
    await this.launch("daemon");
    const deadline = this.deps.now() + DAEMON_WAIT_MS;
    while (!this.stopping && this.deps.now() < deadline) {
      if (await this.deps.probeSocket(this.deps.socketPath("daemon"))) break;
      await new Promise((r) => setTimeout(r, DAEMON_POLL_MS));
    }
    await this.launch("server");
  }

  /** Restart `unit`: SIGTERM it and start it again at once, without backoff. */
  restart(unit: SupervisedUnit): void {
    if (this.stopping) return;
    const slot = this.slots[unit];
    const { state } = slot;
    slot.backoffMs = MIN_BACKOFF_MS;
    if (state.kind === "child") {
      state.restartNow = true;
      state.child.kill("SIGTERM");
    } else if (state.kind === "adopted") {
      state.restartNow = true;
      this.signal(state.pid, "SIGTERM");
    } else if (state.kind === "waiting") {
      clearTimeout(state.timer);
      void this.launch(unit);
    }
  }

  /** Start every unit waiting out a backoff now. */
  startNow(): void {
    if (this.stopping) return;
    for (const unit of SUPERVISED_UNITS) {
      const { state } = this.slots[unit];
      if (state.kind !== "waiting") continue;
      clearTimeout(state.timer);
      this.slots[unit].backoffMs = MIN_BACKOFF_MS;
      void this.launch(unit);
    }
  }

  /** Pass `signal` on to both units; resolves once both are gone. */
  shutdown(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.stopping) return this.stoppedPromise;
    this.stopping = true;
    for (const unit of SUPERVISED_UNITS) {
      const slot = this.slots[unit];
      const { state } = slot;
      if (state.kind === "waiting") {
        clearTimeout(state.timer);
        slot.state = { kind: "idle" };
      } else if (state.kind === "child") {
        state.child.kill(signal);
      } else if (state.kind === "adopted") {
        this.signal(state.pid, signal);
      }
    }
    this.killTimer = setTimeout(() => this.killRemaining(), KILL_GRACE_MS);
    this.checkStopped();
    return this.stoppedPromise;
  }

  // ── Internal ──

  private async launch(unit: SupervisedUnit): Promise<void> {
    const slot = this.slots[unit];
    if (this.stopping) return;
    slot.state = { kind: "launching" };
    const { deps } = this;
    const pid = deps.unitPid(unit);
    const running =
      pid !== null && deps.isAlive(pid) && (await deps.probeSocket(deps.socketPath(unit)));
    if (this.stopping) {
      slot.state = { kind: "idle" };
      this.checkStopped();
      return;
    }
    if (running && pid !== null) {
      deps.log(`adopting the running ${unit} (pid ${pid})`);
      slot.state = {
        kind: "adopted",
        pid,
        timer: setInterval(() => this.pollAdopted(unit), ADOPT_POLL_MS),
        restartNow: false,
      };
      return;
    }
    let child: SuperviseChild;
    try {
      child = deps.spawn(unit);
    } catch (err) {
      deps.log(`starting the ${unit} failed: ${errorMessage(err)}`);
      slot.state = { kind: "idle" };
      this.scheduleLaunch(unit);
      return;
    }
    slot.state = { kind: "child", child, startedAt: deps.now(), restartNow: false };
    deps.log(`started the ${unit} (pid ${child.pid ?? "?"})`);
    child.onExit((code, sig) => this.childExited(unit, child, code, sig));
  }

  private childExited(
    unit: SupervisedUnit,
    child: SuperviseChild,
    code: number | null,
    sig: NodeJS.Signals | null,
  ): void {
    const slot = this.slots[unit];
    const { state } = slot;
    if (state.kind !== "child" || state.child !== child) return;
    slot.state = { kind: "idle" };
    if (this.stopping) {
      this.checkStopped();
      return;
    }
    this.deps.log(`the ${unit} exited (${sig ?? `code ${code ?? "?"}`})`);
    if (state.restartNow) {
      void this.launch(unit);
      return;
    }
    if (this.deps.now() - state.startedAt >= STABLE_MS) slot.backoffMs = MIN_BACKOFF_MS;
    this.scheduleLaunch(unit);
  }

  private pollAdopted(unit: SupervisedUnit): void {
    const slot = this.slots[unit];
    const { state } = slot;
    if (state.kind !== "adopted" || this.deps.isAlive(state.pid)) return;
    clearInterval(state.timer);
    slot.state = { kind: "idle" };
    if (this.stopping) {
      this.checkStopped();
      return;
    }
    this.deps.log(`the adopted ${unit} (pid ${state.pid}) is gone`);
    if (state.restartNow) void this.launch(unit);
    else this.scheduleLaunch(unit);
  }

  private scheduleLaunch(unit: SupervisedUnit): void {
    const slot = this.slots[unit];
    const delay = slot.backoffMs;
    slot.backoffMs = Math.min(delay * 2, MAX_BACKOFF_MS);
    slot.state = { kind: "waiting", timer: setTimeout(() => void this.launch(unit), delay) };
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      this.deps.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }

  private killRemaining(): void {
    for (const unit of SUPERVISED_UNITS) {
      const { state } = this.slots[unit];
      if (state.kind === "child") state.child.kill("SIGKILL");
      else if (state.kind === "adopted") this.signal(state.pid, "SIGKILL");
    }
  }

  private checkStopped(): void {
    if (!this.stopping) return;
    const busy = SUPERVISED_UNITS.some((u) => this.slots[u].state.kind !== "idle");
    if (busy) return;
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
    this.resolveStopped();
  }
}

const SHIM_ARGS: Record<SupervisedUnit, string[]> = {
  daemon: ["--namespace", "remote"],
  server: ["serve"],
};

/** Start `unit` through the shim, its output on ours: the container's log. */
function spawnUnit(unit: SupervisedUnit): SuperviseChild {
  const child = spawn(hostShimFile(), SHIM_ARGS[unit], {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  let exited = false;
  const listeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const done = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    for (const l of listeners) l(code, signal);
  };
  child.once("exit", done);
  child.once("error", (err) => {
    process.stderr.write(`[supervise] ${unit}: ${err.message}\n`);
    done(null, null);
  });
  return {
    get pid() {
      return child.pid;
    },
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    },
    onExit: (listener) => listeners.push(listener),
  };
}

function defaultSuperviseDeps(): SuperviseDeps {
  const server = hostServerPaths();
  return {
    spawn: spawnUnit,
    unitPid: (unit) => readPid(unit === "daemon" ? daemonPidFile("remote") : server.pid),
    socketPath: (unit) => (unit === "daemon" ? daemonSocketFile("remote") : server.socket),
    probeSocket,
    isAlive,
    kill: (pid, signal) => process.kill(pid, signal),
    log: (message) => {
      try {
        process.stderr.write(`[supervise ${new Date().toISOString()}] ${message}\n`);
      } catch {
        // stderr is gone; logging is best-effort.
      }
    },
    now: () => Date.now(),
  };
}

/**
 * Record `container` in `supervisor.json` unless a supervisor is recorded
 * already (see the file comment). Answers whether it wrote it. Best effort:
 * a marker that cannot be written leaves `supervisor install` to do it.
 */
export function claimContainerMarker(markerFile: string = supervisorMarkerFile()): boolean {
  if (readSupervisorMarker(markerFile) !== null) return false;
  try {
    writeFileAtomic(markerFile, `${JSON.stringify({ kind: "container" })}\n`, { mode: 0o600, dirMode: 0o700 });
    return true;
  } catch (err) {
    process.stderr.write(`[supervise] could not record itself in ${markerFile}: ${errorMessage(err)}\n`);
    return false;
  }
}

/**
 * The `manor-host supervise` process: refuses to run beside another
 * `supervise`, holds `supervise.pid`, and runs until SIGTERM or SIGINT.
 */
export async function runSuperviseProcess(deps: SuperviseDeps = defaultSuperviseDeps()): Promise<void> {
  const pidFile = supervisePidFile();
  const other = readPid(pidFile);
  if (other !== null && other !== process.pid && isAlive(other)) {
    process.stderr.write(`[supervise] already running (pid ${other})\n`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  const mine = `${process.pid}\n`;
  fs.writeFileSync(pidFile, mine, { mode: 0o600 });
  claimContainerMarker();

  const supervise = new Supervise(deps);
  const stop = (signal: NodeJS.Signals) => {
    void supervise.shutdown(signal).then(() => {
      removeIfOurs(pidFile, mine);
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on(RESTART_SIGNALS.server, () => supervise.restart("server"));
  process.on(RESTART_SIGNALS.daemon, () => supervise.restart("daemon"));
  process.on(START_SIGNAL, () => supervise.startNow());
  await supervise.start();
}
