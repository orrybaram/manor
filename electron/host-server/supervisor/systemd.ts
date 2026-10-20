/**
 * systemd user units for the daemon and the host server.
 *
 * Two units under `~/.config/systemd/user/`, each running the
 * `~/.manor/bin/manor-host` shim in the foreground, so a tarball upgrade
 * takes effect on the next restart. Booting without a login needs the user
 * manager to linger; `install` asks for it, and `status` says whether it got
 * it — polkit often refuses, and then only `sudo loginctl enable-linger`
 * helps.
 */

import fs from "node:fs";
import path from "node:path";

import {
  SUPERVISED_UNITS,
  runOrThrow,
  type CommandRunner,
  type SupervisedUnit,
  type Supervisor,
  type SupervisorStatus,
} from "./types";

export const SYSTEMD_UNITS: Record<SupervisedUnit, string> = {
  daemon: "manor-host-daemon.service",
  server: "manor-host-server.service",
};

const DESCRIPTIONS: Record<SupervisedUnit, string> = {
  daemon: "Manor host daemon (terminal sessions)",
  server: "Manor host server",
};

/** The shim's arguments for each unit: the daemon attached, or `serve`. */
const SHIM_ARGS: Record<SupervisedUnit, string> = {
  daemon: "--namespace remote",
  server: "serve",
};

/** The text of `unit`'s unit file. `%h` is the user's home, expanded by systemd. */
export function systemdUnitFile(unit: SupervisedUnit): string {
  return [
    "# Written by `manor-host supervisor install`;",
    "# `manor-host supervisor uninstall` removes it.",
    "[Unit]",
    `Description=${DESCRIPTIONS[unit]}`,
    "",
    "[Service]",
    `ExecStart=%h/.manor/bin/manor-host ${SHIM_ARGS[unit]}`,
    "Restart=on-failure",
    "RestartSec=2",
    "EnvironmentFile=-%h/.manor/remote/supervisor.env",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * Whether this box has a systemd user manager to install into: `systemctl
 * --user is-system-running` names a state other than `offline`. It exits
 * non-zero for `degraded` and the like, which still run units, so its
 * output is what counts.
 */
export async function detectSystemd(run: CommandRunner): Promise<boolean> {
  const { stdout } = await run("systemctl", ["--user", "is-system-running"]);
  const state = stdout.trim();
  return state !== "" && state !== "offline";
}

export interface SystemdOptions {
  run: CommandRunner;
  /** `~/.config/systemd/user` (or under `$XDG_CONFIG_HOME`). */
  unitDir: string;
  /** The user `loginctl` asks about. */
  user: string;
  /** Whether `unit`'s process is already running, supervised or not. */
  isRunning(unit: SupervisedUnit): boolean;
}

export class SystemdSupervisor implements Supervisor {
  readonly kind = "systemd" as const;

  constructor(private readonly opts: SystemdOptions) {}

  async install(): Promise<void> {
    const { run, unitDir } = this.opts;
    fs.mkdirSync(unitDir, { recursive: true });
    for (const unit of SUPERVISED_UNITS) {
      fs.writeFileSync(path.join(unitDir, SYSTEMD_UNITS[unit]), systemdUnitFile(unit));
    }
    await this.systemctl("daemon-reload");
    await this.systemctl("enable", SYSTEMD_UNITS.daemon, SYSTEMD_UNITS.server);
    // Not `enable --now`: see `Supervisor.install`.
    for (const unit of SUPERVISED_UNITS) {
      if (!this.opts.isRunning(unit)) await this.systemctl("start", SYSTEMD_UNITS[unit]);
    }
    // Usually refused without polkit's say-so; `status` reports the outcome.
    await run("loginctl", ["enable-linger"]);
  }

  async uninstall(): Promise<void> {
    const { run, unitDir } = this.opts;
    // `disable` without `--now`: see `Supervisor.uninstall`.
    await run("systemctl", ["--user", "disable", SYSTEMD_UNITS.daemon, SYSTEMD_UNITS.server]);
    for (const unit of SUPERVISED_UNITS) {
      fs.rmSync(path.join(unitDir, SYSTEMD_UNITS[unit]), { force: true });
    }
    await run("systemctl", ["--user", "daemon-reload"]);
  }

  async status(): Promise<SupervisorStatus> {
    const { run, user } = this.opts;
    const [daemon, server, linger] = await Promise.all([
      run("systemctl", ["--user", "is-active", SYSTEMD_UNITS.daemon]),
      run("systemctl", ["--user", "is-active", SYSTEMD_UNITS.server]),
      run("loginctl", ["show-user", user, "-p", "Linger"]),
    ]);
    return {
      kind: "systemd",
      running: {
        daemon: daemon.stdout.trim() === "active",
        server: server.stdout.trim() === "active",
      },
      linger: /^Linger=yes$/m.test(linger.stdout),
    };
  }

  async start(unit: SupervisedUnit): Promise<void> {
    await this.systemctl("start", SYSTEMD_UNITS[unit]);
  }

  async restart(unit: SupervisedUnit): Promise<void> {
    await this.systemctl("restart", SYSTEMD_UNITS[unit]);
  }

  /** A stopped unit stays stopped (a clean exit is not a failure) until `start`. */
  async stop(unit: SupervisedUnit): Promise<void> {
    await this.systemctl("stop", SYSTEMD_UNITS[unit]);
  }

  private async systemctl(...args: string[]): Promise<void> {
    await runOrThrow(this.opts.run, "systemctl", ["--user", ...args]);
  }
}
