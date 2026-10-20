/**
 * The one seam the lifecycle code branches on: whichever of the
 * operating system's supervisors keeps this box's daemon and host server
 * running across a reboot. Kept apart from `./index.ts` so each
 * implementation can import it without importing the others.
 */

import { runExec } from "../../terminal-host/exec-runner";

export type SupervisorKind = "systemd" | "launchd" | "container";

/** The two processes a supervisor runs: the terminal daemon and the host server. */
export type SupervisedUnit = "daemon" | "server";

export const SUPERVISED_UNITS: readonly SupervisedUnit[] = ["daemon", "server"];

export interface SupervisorStatus {
  kind: SupervisorKind;
  /** Whether the supervisor itself reports each unit running. */
  running: Record<SupervisedUnit, boolean>;
  /**
   * systemd only: whether the user manager starts at boot without a login
   * (`loginctl enable-linger`). False means Manor comes back only once the
   * user logs in there.
   */
  linger?: boolean;
}

/** What `supervisor … --json` prints, and `hostServer.status()` carries. */
export interface SupervisorFacts {
  kind: SupervisorKind;
  linger?: boolean;
}

export interface Supervisor {
  readonly kind: SupervisorKind;
  /**
   * Put both units under the supervisor, so they start at boot (or login).
   * A unit whose process is already running (spawned detached before this)
   * is enabled but not started beside it: a second daemon would take over
   * the first one's socket and strand its sessions. The supervisor takes it
   * from the next restart or boot.
   */
  install(): Promise<void>;
  /**
   * Remove the units. Never stops what is running: turning supervision off
   * must not end the user's terminal sessions. Without the marker, the next
   * connect spawns detached copies as before, if these have gone.
   */
  uninstall(): Promise<void>;
  status(): Promise<SupervisorStatus>;
  /** Start `unit` if it is not running. Rejects when the supervisor cannot. */
  start(unit: SupervisedUnit): Promise<void>;
  /** Restart `unit` (start it if it is not running). */
  restart(unit: SupervisedUnit): Promise<void>;
  /** Stop `unit`. See each implementation for what follows a stop. */
  stop(unit: SupervisedUnit): Promise<void>;
}

/** What one command produced; `code` is null when it could not run or was killed. */
export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one command on this box. Never rejects: a failure to run is `code: null`. */
export type CommandRunner = (cmd: string, args: string[]) => Promise<CommandResult>;

/** A supervisor's own commands answer quickly; a stuck one must not hang a connect. */
const COMMAND_TIMEOUT_MS = 15_000;

export const runCommand: CommandRunner = async (cmd, args) => {
  const { stdout, stderr, exitCode } = await runExec(cmd, args, {
    timeout: COMMAND_TIMEOUT_MS,
  });
  return { code: exitCode, stdout, stderr };
};

/** Run `cmd args…`, rejecting with its stderr when it does not exit 0. */
export async function runOrThrow(
  run: CommandRunner,
  cmd: string,
  args: string[],
): Promise<CommandResult> {
  const result = await run(cmd, args);
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(-500);
    throw new Error(
      `\`${cmd} ${args.join(" ")}\` failed (exit ${result.code ?? "none"})${detail ? `: ${detail}` : ""}`,
    );
  }
  return result;
}
