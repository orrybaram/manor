/**
 * Supervision that survives a reboot (ADR-229 D4).
 *
 * `manor-host supervisor install` puts this box's daemon and host server
 * under the operating system's own supervisor — a systemd user manager,
 * launchd, or `manor-host supervise` as a container's entrypoint, picked in
 * that order — and records which in `~/.manor/remote/supervisor.json`. While
 * that marker exists, the lifecycle code (`../lifecycle.ts`,
 * `LocalTransport` in the `remote` namespace) starts, stops and restarts
 * through `loadSupervisor()` instead of spawning detached copies. A marker
 * whose supervisor no longer works falls back to the detached spawn, with a
 * warning: a host must never end up with nothing running.
 *
 * `supervisor.env` carries the variables the units need and an ssh session
 * would not give them (ADR-229 D5, D6): `MANOR_SECRET_KEY_FILE`,
 * `MANOR_SECRET_KEY` and `MANOR_INSTANCE_ID`, as `install` found them.
 * `MANOR_SECRET_KEY` written there sits on the volume it is meant to protect;
 * prefer `MANOR_SECRET_KEY_FILE` naming a mounted secret.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { errorMessage } from "../../lib/errors";
import { writeFileAtomic } from "../../lib/fs-atomic";
import {
  daemonLogFile,
  daemonPidFile,
  hostServerPaths,
  supervisePidFile,
  supervisorEnvFile,
  supervisorMarkerFile,
} from "../../paths";
import { isAlive, readPid } from "../pid-file";
import { ContainerSupervisor } from "./container";
import { LaunchdSupervisor } from "./launchd";
import { SystemdSupervisor, detectSystemd } from "./systemd";
import {
  runCommand,
  type CommandRunner,
  type SupervisedUnit,
  type Supervisor,
  type SupervisorFacts,
  type SupervisorKind,
  type SupervisorStatus,
} from "./types";

export type {
  SupervisedUnit,
  Supervisor,
  SupervisorFacts,
  SupervisorKind,
  SupervisorStatus,
} from "./types";

const KINDS: readonly SupervisorKind[] = ["systemd", "launchd", "container"];

function isSupervisorKind(value: unknown): value is SupervisorKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** The kind `supervisor.json` records, or null when there is none (or it is unreadable). */
export function readSupervisorMarker(file: string = supervisorMarkerFile()): SupervisorKind | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { kind?: unknown };
    return isSupervisorKind(parsed.kind) ? parsed.kind : null;
  } catch {
    return null;
  }
}

/** The variables `supervisor.env` carries, when set (ADR-229 D5, D6). */
const SUPERVISOR_ENV_KEYS = [
  "MANOR_SECRET_KEY_FILE",
  "MANOR_SECRET_KEY",
  "MANOR_INSTANCE_ID",
] as const;

/** The `KEY='value'` lines of an existing `supervisor.env`, for the keys it may hold. */
export function parseSupervisorEnv(text: string): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)='([^']*)'$/.exec(line.trim());
    if (m && (SUPERVISOR_ENV_KEYS as readonly string[]).includes(m[1])) out[m[1]] = m[2];
  }
  return out;
}

/**
 * `supervisor.env`'s text: one single-quoted `KEY='value'` line per variable
 * set in `env`, which both systemd's `EnvironmentFile` and `sh`'s `.` read
 * the same way. A value neither could read back unchanged (a quote, a
 * backslash, a newline) is left out, with a warning.
 *
 * `env` is the environment `install` ran in merged over the file's previous
 * values (`installSupervisor`): an install from the desktop over ssh rarely
 * has the keys set, and must not drop the ones a user put there.
 */
export function supervisorEnvText(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void = console.warn,
): string {
  const lines = [
    "# Written by `manor-host supervisor install` (ADR-229 D4, D5). Mode 0600.",
    "# MANOR_SECRET_KEY here is on the volume it protects: prefer",
    "# MANOR_SECRET_KEY_FILE naming a mounted secret outside ~/.manor.",
  ];
  for (const key of SUPERVISOR_ENV_KEYS) {
    const value = env[key];
    if (value === undefined || value === "") continue;
    if (/['\\\n\r]/.test(value)) {
      warn(`[supervisor] ${key} has a character supervisor.env cannot hold; left out`);
      continue;
    }
    lines.push(`${key}='${value}'`);
  }
  return `${lines.join("\n")}\n`;
}

function unitPid(unit: SupervisedUnit): number | null {
  return readPid(unit === "daemon" ? daemonPidFile("remote") : hostServerPaths().pid);
}

function unitRunning(unit: SupervisedUnit): boolean {
  const pid = unitPid(unit);
  return pid !== null && isAlive(pid);
}

function systemdUnitDir(env: NodeJS.ProcessEnv = process.env): string {
  const config = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(config, "systemd", "user");
}

function containerSupervisor(): ContainerSupervisor {
  return new ContainerSupervisor({
    supervisePid: () => readPid(supervisePidFile()),
    unitPid,
    isAlive,
    kill: (pid, signal) => process.kill(pid, signal),
  });
}

/** The supervisor of `kind`, over this box's real paths and commands. */
function createSupervisor(kind: SupervisorKind, run: CommandRunner = runCommand): Supervisor {
  switch (kind) {
    case "systemd":
      return new SystemdSupervisor({
        run,
        unitDir: systemdUnitDir(),
        user: os.userInfo().username,
        isRunning: unitRunning,
      });
    case "launchd":
      return new LaunchdSupervisor({
        run,
        agentsDir: path.join(os.homedir(), "Library", "LaunchAgents"),
        uid: os.userInfo().uid,
        logFiles: {
          daemon: daemonLogFile("remote"),
          server: path.join(hostServerPaths().logsDir, "host-server-spawn.log"),
        },
        isRunning: unitRunning,
      });
    case "container":
      return containerSupervisor();
  }
}

/**
 * The supervisor the marker names, or null when nothing supervises this
 * box. Read on every call, so an `install` takes effect without a restart.
 */
export function loadSupervisor(file: string = supervisorMarkerFile()): Supervisor | null {
  const kind = readSupervisorMarker(file);
  return kind ? createSupervisor(kind) : null;
}

export interface SupervisorProbes {
  systemd(): Promise<boolean>;
  launchd(): boolean;
  /** `supervise` is running: its pid file names a live process. */
  container(): boolean;
}

/** systemd, then launchd, then a running `supervise`; null when none is here. */
export async function pickSupervisor(probes: SupervisorProbes): Promise<SupervisorKind | null> {
  if (await probes.systemd()) return "systemd";
  if (probes.launchd()) return "launchd";
  if (probes.container()) return "container";
  return null;
}

function defaultProbes(run: CommandRunner = runCommand): SupervisorProbes {
  return {
    systemd: () =>
      process.platform === "linux" ? detectSystemd(run) : Promise.resolve(false),
    launchd: () => process.platform === "darwin",
    container: () => containerSupervisor().available(),
  };
}

function supervisorFacts(status: SupervisorStatus): SupervisorFacts {
  return status.linger === undefined
    ? { kind: status.kind }
    : { kind: status.kind, linger: status.linger };
}

export interface SupervisorCommandDeps {
  probes: SupervisorProbes;
  create(kind: SupervisorKind): Supervisor;
  env: NodeJS.ProcessEnv;
  markerFile: string;
  envFile: string;
}

function defaultCommandDeps(): SupervisorCommandDeps {
  return {
    probes: defaultProbes(),
    create: (kind) => createSupervisor(kind),
    env: process.env,
    markerFile: supervisorMarkerFile(),
    envFile: supervisorEnvFile(),
  };
}

/**
 * Pick a supervisor, write `supervisor.env`, install the units, then record
 * the kind. Rejects with "No supervisor on this host" when none is here.
 */
export async function installSupervisor(
  deps: SupervisorCommandDeps = defaultCommandDeps(),
): Promise<SupervisorStatus> {
  const kind = await pickSupervisor(deps.probes);
  if (!kind) throw new Error("No supervisor on this host");
  let previous: Partial<Record<string, string>> = {};
  try {
    previous = parseSupervisorEnv(fs.readFileSync(deps.envFile, "utf8"));
  } catch {
    // None yet.
  }
  const env: NodeJS.ProcessEnv = { ...previous };
  for (const key of SUPERVISOR_ENV_KEYS) {
    if (deps.env[key]) env[key] = deps.env[key];
  }
  writeFileAtomic(deps.envFile, supervisorEnvText(env), { mode: 0o600, dirMode: 0o700 });
  const supervisor = deps.create(kind);
  await supervisor.install();
  writeFileAtomic(deps.markerFile, `${JSON.stringify({ kind })}\n`, { mode: 0o600, dirMode: 0o700 });
  return supervisor.status();
}

/** Remove the marker's units, `supervisor.env` and the marker. A no-op without one. */
export async function uninstallSupervisor(
  deps: SupervisorCommandDeps = defaultCommandDeps(),
): Promise<void> {
  const kind = readSupervisorMarker(deps.markerFile);
  if (kind) {
    try {
      await deps.create(kind).uninstall();
    } catch (err) {
      // The marker goes regardless: a half-removed unit is the lesser harm
      // than a lifecycle still deferring to it.
      console.warn(`[supervisor] removing the ${kind} units failed: ${errorMessage(err)}`);
    }
  }
  fs.rmSync(deps.envFile, { force: true });
  fs.rmSync(deps.markerFile, { force: true });
}

/** The marker's supervisor and what it says, or null when nothing supervises this box. */
async function readSupervisorStatus(
  deps: Pick<SupervisorCommandDeps, "create" | "markerFile"> = defaultCommandDeps(),
): Promise<SupervisorStatus | null> {
  const kind = readSupervisorMarker(deps.markerFile);
  return kind ? deps.create(kind).status() : null;
}

/**
 * The supervisor facts the host server reports (`hostServer.status()`): the
 * kind from the marker, read each time, and `linger` from the last
 * `status()` of that kind, refreshed in the background at most once a
 * minute — `status()` is synchronous, and lingering seldom changes.
 */
export function createSupervisorFactsCache(
  opts: {
    markerFile?: string;
    create?: (kind: SupervisorKind) => Supervisor;
    now?: () => number;
  } = {},
): { current(): SupervisorFacts | null; refresh(): Promise<void> } {
  const markerFile = opts.markerFile ?? supervisorMarkerFile();
  const create = opts.create ?? ((kind: SupervisorKind) => createSupervisor(kind));
  const now = opts.now ?? Date.now;
  let last: SupervisorFacts | null = null;
  let readAt = -Infinity;
  let inFlight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    const kind = readSupervisorMarker(markerFile);
    readAt = now();
    if (!kind) {
      last = null;
      return Promise.resolve();
    }
    inFlight = create(kind)
      .status()
      .then(
        (status) => {
          last = supervisorFacts(status);
        },
        (err) => {
          console.warn(`[host-server] reading the ${kind} supervisor failed: ${errorMessage(err)}`);
        },
      )
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    current() {
      const kind = readSupervisorMarker(markerFile);
      if (now() - readAt > 60_000) void refresh();
      if (!kind) return null;
      return last?.kind === kind ? last : { kind };
    },
    refresh,
  };
}

/**
 * `manor-host supervisor install|uninstall|status [--json]`. With `--json`,
 * one line on stdout: `{"supervisor": {kind, linger?} | null}`, or
 * `{"error": "…"}` with a non-zero exit. Answers the exit code.
 */
export async function runSupervisorCommand(
  argv: string[],
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = process,
  deps?: SupervisorCommandDeps,
): Promise<number> {
  const [action] = argv;
  const json = argv.includes("--json");
  const report = (status: SupervisorStatus | null) => {
    if (json) {
      io.stdout.write(`${JSON.stringify({ supervisor: status ? supervisorFacts(status) : null })}\n`);
      return;
    }
    if (!status) {
      io.stdout.write("Nothing supervises Manor on this host.\n");
      return;
    }
    const running = (["daemon", "server"] as const)
      .map((unit) => `${unit} ${status.running[unit] ? "running" : "not running"}`)
      .join(", ");
    io.stdout.write(`Supervised by ${status.kind}: ${running}.\n`);
    if (status.linger === false) {
      io.stdout.write(
        `Manor starts only after you log in here. Run \`sudo loginctl enable-linger ${os.userInfo().username}\` to start it at boot.\n`,
      );
    }
  };
  try {
    switch (action) {
      case "install":
        report(await installSupervisor(deps));
        return 0;
      case "uninstall":
        await uninstallSupervisor(deps);
        report(null);
        return 0;
      case "status":
        report(await readSupervisorStatus(deps));
        return 0;
      default:
        throw new Error("usage: manor-host supervisor install|uninstall|status [--json]");
    }
  } catch (err) {
    const message = errorMessage(err);
    if (json) io.stdout.write(`${JSON.stringify({ error: message })}\n`);
    else io.stderr.write(`${message}\n`);
    return 1;
  }
}
