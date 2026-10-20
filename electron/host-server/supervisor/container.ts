/**
 * `manor-host supervise` as the supervisor, in a container with no init
 * system.
 *
 * `supervise` runs as the container's entrypoint and owns both units; this
 * side only signals it. After a node reboot, the pod's restart policy brings
 * the container, and so `supervise`, back.
 *
 * Signals, chosen over killing the child and letting `supervise` notice,
 * because a signal also cuts short a restart backoff and reaches a unit
 * `supervise` adopted rather than started:
 * - `SIGUSR1`: restart the server; `SIGUSR2`: restart the daemon;
 * - `SIGHUP`: start whichever unit is down now, skipping its backoff.
 */

import {
  type SupervisedUnit,
  type Supervisor,
  type SupervisorStatus,
} from "./types";

export const RESTART_SIGNALS: Record<SupervisedUnit, NodeJS.Signals> = {
  server: "SIGUSR1",
  daemon: "SIGUSR2",
};

export const START_SIGNAL: NodeJS.Signals = "SIGHUP";

export interface ContainerOptions {
  /** `supervise`'s pid, from `supervise.pid`; null when there is none. */
  supervisePid(): number | null;
  /** `unit`'s running pid, from its own pid file; null when there is none. */
  unitPid(unit: SupervisedUnit): number | null;
  isAlive(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
}

export class ContainerSupervisor implements Supervisor {
  readonly kind = "container" as const;

  constructor(private readonly opts: ContainerOptions) {}

  /** Whether `supervise` is running, so this supervisor works at all. */
  available(): boolean {
    const pid = this.opts.supervisePid();
    return pid !== null && this.opts.isAlive(pid);
  }

  /** Nothing to write: `supervise` is already the entrypoint. Only valid while it runs. */
  async install(): Promise<void> {
    this.livePid();
  }

  async uninstall(): Promise<void> {
    // Nothing of its own to remove; the entrypoint is the container's.
  }

  async status(): Promise<SupervisorStatus> {
    const up = (unit: SupervisedUnit) => {
      const pid = this.opts.unitPid(unit);
      return pid !== null && this.opts.isAlive(pid);
    };
    return { kind: "container", running: { daemon: up("daemon"), server: up("server") } };
  }

  async start(_unit: SupervisedUnit): Promise<void> {
    this.opts.kill(this.livePid(), START_SIGNAL);
  }

  async restart(unit: SupervisedUnit): Promise<void> {
    this.opts.kill(this.livePid(), RESTART_SIGNALS[unit]);
  }

  /**
   * SIGTERM the unit itself. `supervise` restarts it after its backoff, so a
   * stop here is a restart a moment later; `manor-host restart` (stop, then
   * the next connect's start) means exactly that.
   */
  async stop(unit: SupervisedUnit): Promise<void> {
    const pid = this.opts.unitPid(unit);
    if (pid === null || !this.opts.isAlive(pid)) return;
    try {
      this.opts.kill(pid, "SIGTERM");
    } catch {
      // Gone in between.
    }
  }

  private livePid(): number {
    const pid = this.opts.supervisePid();
    if (pid === null || !this.opts.isAlive(pid)) {
      throw new Error("`manor-host supervise` is not running");
    }
    return pid;
  }
}
