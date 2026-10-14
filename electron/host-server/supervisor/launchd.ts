/**
 * LaunchAgents for the daemon and the host server on macOS (ADR-229 D4).
 *
 * Two plists under `~/Library/LaunchAgents/`, with `RunAtLoad` and
 * `KeepAlive`, loaded into the user's GUI domain. A LaunchAgent starts at
 * login, so a headless Mac needs auto-login; a LaunchDaemon would need root
 * and is not used.
 *
 * launchd has no `EnvironmentFile`. Each agent runs a one-line `sh` that
 * sources `supervisor.env` and then execs the `~/.manor/bin/manor-host`
 * shim, so the keys stay in one file (not copied into the plists) and a
 * tarball upgrade takes effect on the next restart.
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

const LAUNCHD_LABELS: Record<SupervisedUnit, string> = {
  daemon: "sh.manor.host-daemon",
  server: "sh.manor.host-server",
};

const SHIM_ARGS: Record<SupervisedUnit, string> = {
  daemon: "--namespace remote",
  server: "serve",
};

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The `sh -c` script an agent runs: `supervisor.env`'s variables, then the shim. */
function launchdScript(unit: SupervisedUnit): string {
  const env = '"$HOME/.manor/remote/supervisor.env"';
  return `set -a; if [ -r ${env} ]; then . ${env}; fi; set +a; exec "$HOME/.manor/bin/manor-host" ${SHIM_ARGS[unit]}`;
}

/** The text of `unit`'s plist; stdout and stderr go to `logFile`. */
export function launchdPlist(unit: SupervisedUnit, logFile: string): string {
  const string = (s: string) => `<string>${xmlEscape(s)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    "<!-- Written by `manor-host supervisor install` (ADR-229 D4). -->",
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${string(LAUNCHD_LABELS[unit])}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    ${string("/bin/sh")}`,
    `    ${string("-c")}`,
    `    ${string(launchdScript(unit))}`,
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    `  <key>StandardOutPath</key>${string(logFile)}`,
    `  <key>StandardErrorPath</key>${string(logFile)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export interface LaunchdOptions {
  run: CommandRunner;
  /** `~/Library/LaunchAgents`. */
  agentsDir: string;
  /** The user's uid, naming the `gui/<uid>` domain. */
  uid: number;
  /** Where each unit already logs when spawned detached. */
  logFiles: Record<SupervisedUnit, string>;
  /** Whether `unit`'s process is already running, supervised or not. */
  isRunning(unit: SupervisedUnit): boolean;
}

export class LaunchdSupervisor implements Supervisor {
  readonly kind = "launchd" as const;

  constructor(private readonly opts: LaunchdOptions) {}

  private plistPath(unit: SupervisedUnit): string {
    return path.join(this.opts.agentsDir, `${LAUNCHD_LABELS[unit]}.plist`);
  }

  private get domain(): string {
    return `gui/${this.opts.uid}`;
  }

  private target(unit: SupervisedUnit): string {
    return `${this.domain}/${LAUNCHD_LABELS[unit]}`;
  }

  /**
   * Write both plists, and load each one whose process is not already
   * running. One that is gets loaded at the next login (see
   * `Supervisor.install`), or by `start`/`restart`.
   */
  async install(): Promise<void> {
    fs.mkdirSync(this.opts.agentsDir, { recursive: true });
    for (const unit of SUPERVISED_UNITS) {
      const logFile = this.opts.logFiles[unit];
      fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.plistPath(unit), launchdPlist(unit, logFile));
    }
    for (const unit of SUPERVISED_UNITS) {
      if (this.opts.isRunning(unit) || (await this.loaded(unit))) continue;
      await this.bootstrap(unit);
    }
  }

  /**
   * Remove the plists, leaving loaded agents running (see
   * `Supervisor.uninstall`): they are gone at the next logout, and do not
   * come back at login.
   */
  async uninstall(): Promise<void> {
    for (const unit of SUPERVISED_UNITS) fs.rmSync(this.plistPath(unit), { force: true });
  }

  async status(): Promise<SupervisorStatus> {
    const [daemon, server] = await Promise.all(
      SUPERVISED_UNITS.map((unit) => this.opts.run("launchctl", ["print", this.target(unit)])),
    );
    const running = (r: { code: number | null; stdout: string }) =>
      r.code === 0 && /^\s*state = running$/m.test(r.stdout);
    return { kind: "launchd", running: { daemon: running(daemon), server: running(server) } };
  }

  async start(unit: SupervisedUnit): Promise<void> {
    if (await this.loaded(unit)) {
      await runOrThrow(this.opts.run, "launchctl", ["kickstart", this.target(unit)]);
    } else {
      await this.bootstrap(unit);
    }
  }

  async restart(unit: SupervisedUnit): Promise<void> {
    if (await this.loaded(unit)) {
      await runOrThrow(this.opts.run, "launchctl", ["kickstart", "-k", this.target(unit)]);
    } else {
      await this.bootstrap(unit);
    }
  }

  /** Unload the agent (`KeepAlive` would restart a merely killed one); `start` loads it again. */
  async stop(unit: SupervisedUnit): Promise<void> {
    if (!(await this.loaded(unit))) return;
    await runOrThrow(this.opts.run, "launchctl", ["bootout", this.target(unit)]);
  }

  private async loaded(unit: SupervisedUnit): Promise<boolean> {
    return (await this.opts.run("launchctl", ["print", this.target(unit)])).code === 0;
  }

  private async bootstrap(unit: SupervisedUnit): Promise<void> {
    if (!fs.existsSync(this.plistPath(unit))) {
      throw new Error(`${this.plistPath(unit)} is missing`);
    }
    await runOrThrow(this.opts.run, "launchctl", ["bootstrap", this.domain, this.plistPath(unit)]);
  }
}
