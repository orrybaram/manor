/**
 * Supervision that survives a reboot: the unit files and
 * plists, picking a supervisor, `supervisor.env`, the install and uninstall
 * steps against fake commands, and the `supervisor` CLI's JSON.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applySupervisorEnv,
  createSupervisorFactsCache,
  installSupervisor,
  parseSupervisorEnv,
  pickSupervisor,
  readSupervisorMarker,
  runSupervisorCommand,
  supervisorEnvText,
  takeSecretEnv,
  uninstallSupervisor,
  writeSupervisorEnv,
  type SupervisorCommandDeps,
} from "../supervisor";
import { ContainerSupervisor } from "../supervisor/container";
import { LaunchdSupervisor, launchdPlist } from "../supervisor/launchd";
import { SystemdSupervisor, detectSystemd, systemdUnitFile } from "../supervisor/systemd";
import type {
  CommandResult,
  CommandRunner,
  SupervisedUnit,
  Supervisor,
  SupervisorKind,
} from "../supervisor/types";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-supervisor-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Records every command; answers from `answer`, else exit 0 with no output. */
function fakeRunner(answer: (cmd: string, args: string[]) => Partial<CommandResult> | undefined = () => undefined) {
  const calls: string[] = [];
  const run: CommandRunner = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    return { code: 0, stdout: "", stderr: "", ...answer(cmd, args) };
  };
  return { run, calls };
}

describe("unit files and plists", () => {
  it("writes the daemon's systemd unit", () => {
    expect(systemdUnitFile("daemon")).toMatchInlineSnapshot(`
      "# Written by \`manor-host supervisor install\`;
      # \`manor-host supervisor uninstall\` removes it.
      [Unit]
      Description=Manor host daemon (terminal sessions)

      [Service]
      ExecStart=%h/.manor/bin/manor-host --namespace remote
      Restart=on-failure
      RestartSec=2
      EnvironmentFile=-%h/.manor/remote/supervisor.env

      [Install]
      WantedBy=default.target
      "
    `);
  });

  it("writes the server's systemd unit", () => {
    expect(systemdUnitFile("server")).toMatchInlineSnapshot(`
      "# Written by \`manor-host supervisor install\`;
      # \`manor-host supervisor uninstall\` removes it.
      [Unit]
      Description=Manor host server

      [Service]
      ExecStart=%h/.manor/bin/manor-host serve
      Restart=on-failure
      RestartSec=2
      EnvironmentFile=-%h/.manor/remote/supervisor.env

      [Install]
      WantedBy=default.target
      "
    `);
  });

  it("writes the server's LaunchAgent", () => {
    expect(launchdPlist("server", "/Users/me/.manor/remote/server/logs/host-server-spawn.log"))
      .toMatchInlineSnapshot(`
        "<?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <!-- Written by \`manor-host supervisor install\`. -->
        <plist version="1.0">
        <dict>
          <key>Label</key><string>sh.manor.host-server</string>
          <key>ProgramArguments</key>
          <array>
            <string>/bin/sh</string>
            <string>-c</string>
            <string>set -a; if [ -r "$HOME/.manor/remote/supervisor.env" ]; then . "$HOME/.manor/remote/supervisor.env"; fi; set +a; exec "$HOME/.manor/bin/manor-host" serve</string>
          </array>
          <key>RunAtLoad</key><true/>
          <key>KeepAlive</key><true/>
          <key>StandardOutPath</key><string>/Users/me/.manor/remote/server/logs/host-server-spawn.log</string>
          <key>StandardErrorPath</key><string>/Users/me/.manor/remote/server/logs/host-server-spawn.log</string>
        </dict>
        </plist>
        "
      `);
  });

  it("runs the daemon attached from its LaunchAgent", () => {
    expect(launchdPlist("daemon", "/tmp/d.log")).toContain(
      'exec "$HOME/.manor/bin/manor-host" --namespace remote</string>',
    );
  });
});

describe("pickSupervisor", () => {
  const probes = (systemd: boolean, launchd: boolean, container: boolean) => ({
    systemd: async () => systemd,
    launchd: () => launchd,
    container: () => container,
  });

  it("prefers systemd, then launchd, then a running supervise", async () => {
    expect(await pickSupervisor(probes(true, true, true))).toBe("systemd");
    expect(await pickSupervisor(probes(false, true, true))).toBe("launchd");
    expect(await pickSupervisor(probes(false, false, true))).toBe("container");
    expect(await pickSupervisor(probes(false, false, false))).toBeNull();
  });

  it("detects a systemd user manager from is-system-running's state", async () => {
    const answer = (stdout: string, code = 0) => fakeRunner(() => ({ stdout, code })).run;
    expect(await detectSystemd(answer("running\n"))).toBe(true);
    expect(await detectSystemd(answer("degraded\n", 1))).toBe(true);
    expect(await detectSystemd(answer("offline\n", 1))).toBe(false);
    expect(await detectSystemd(answer("", 1))).toBe(false);
    expect(await detectSystemd(fakeRunner(() => ({ code: null, stderr: "ENOENT" })).run)).toBe(false);
  });
});

describe("supervisor.env", () => {
  it("holds the key and instance variables that were set, single-quoted", () => {
    const text = supervisorEnvText({
      MANOR_SECRET_KEY_FILE: "/run/secrets/manor key",
      MANOR_INSTANCE_ID: "pod-123",
      PATH: "/usr/bin",
    });
    expect(text).toContain("MANOR_SECRET_KEY_FILE='/run/secrets/manor key'\n");
    expect(text).toContain("MANOR_INSTANCE_ID='pod-123'\n");
    expect(text).not.toContain("PATH");
    expect(text).not.toContain("MANOR_SECRET_KEY=");
    expect(parseSupervisorEnv(text)).toEqual({
      MANOR_SECRET_KEY_FILE: "/run/secrets/manor key",
      MANOR_INSTANCE_ID: "pod-123",
    });
  });

  it("leaves out a value it could not hold, with a warning", () => {
    const warnings: string[] = [];
    const text = supervisorEnvText({ MANOR_INSTANCE_ID: "it's" }, (m) => warnings.push(m));
    expect(text).not.toContain("MANOR_INSTANCE_ID");
    expect(warnings).toHaveLength(1);
  });

  it("writeSupervisorEnv merges over the previous file, 0600", () => {
    const file = path.join(dir, "remote", "supervisor.env");
    writeSupervisorEnv(file, { MANOR_INSTANCE_ID: "vm-1" });
    writeSupervisorEnv(file, { MANOR_SECRET_KEY_FILE: "/home/u/.config/manor/secret.key", MANOR_INSTANCE_ID: "" });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(parseSupervisorEnv(fs.readFileSync(file, "utf8"))).toEqual({
      MANOR_SECRET_KEY_FILE: "/home/u/.config/manor/secret.key",
      MANOR_INSTANCE_ID: "vm-1",
    });
  });

  it("writeSupervisorEnv removes a variable set to null", () => {
    const file = path.join(dir, "remote", "supervisor.env");
    writeSupervisorEnv(file, { MANOR_SECRET_KEY: "aW5saW5l", MANOR_INSTANCE_ID: "vm-1" });
    writeSupervisorEnv(file, { MANOR_SECRET_KEY_FILE: "/home/u/k", MANOR_SECRET_KEY: null });
    expect(parseSupervisorEnv(fs.readFileSync(file, "utf8"))).toEqual({
      MANOR_SECRET_KEY_FILE: "/home/u/k",
      MANOR_INSTANCE_ID: "vm-1",
    });
  });

  it("writeSupervisorEnv refuses a value it cannot hold or a key it does not carry, writing nothing", () => {
    const file = path.join(dir, "remote", "supervisor.env");
    writeSupervisorEnv(file, { MANOR_INSTANCE_ID: "vm-1" });
    const before = fs.readFileSync(file, "utf8");
    expect(() => writeSupervisorEnv(file, { MANOR_SECRET_KEY_FILE: "/tmp/it's" })).toThrow(/cannot hold/);
    expect(() => writeSupervisorEnv(file, { PATH: "/usr/bin" })).toThrow(/does not carry PATH/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

describe("applySupervisorEnv", () => {
  function envFile(text: string): string {
    const file = path.join(dir, "supervisor.env");
    fs.writeFileSync(file, text);
    return file;
  }

  it("fills only the variables the environment lacks", () => {
    const file = envFile(
      "MANOR_SECRET_KEY_FILE='/home/u/.config/manor/secret.key'\nMANOR_INSTANCE_ID='vm-1'\n",
    );
    const env: NodeJS.ProcessEnv = { MANOR_INSTANCE_ID: "from-env", PATH: "/usr/bin" };
    expect(applySupervisorEnv(env, file)).toEqual(["MANOR_SECRET_KEY_FILE"]);
    expect(env).toEqual({
      MANOR_SECRET_KEY_FILE: "/home/u/.config/manor/secret.key",
      MANOR_INSTANCE_ID: "from-env",
      PATH: "/usr/bin",
    });
  });

  it("counts an empty variable as unset", () => {
    const file = envFile("MANOR_INSTANCE_ID='vm-1'\n");
    const env: NodeJS.ProcessEnv = { MANOR_INSTANCE_ID: "" };
    applySupervisorEnv(env, file);
    expect(env.MANOR_INSTANCE_ID).toBe("vm-1");
  });

  it("keeps the environment's key source as a whole", () => {
    const file = envFile(
      "MANOR_SECRET_KEY_FILE='/from/file'\nMANOR_SECRET_KEY='aW5saW5l'\nMANOR_INSTANCE_ID='vm-1'\n",
    );
    const withFile: NodeJS.ProcessEnv = { MANOR_SECRET_KEY_FILE: "/run/secrets/k" };
    expect(applySupervisorEnv(withFile, file)).toEqual(["MANOR_INSTANCE_ID"]);
    expect(withFile.MANOR_SECRET_KEY).toBeUndefined();
    expect(withFile.MANOR_SECRET_KEY_FILE).toBe("/run/secrets/k");

    const withInline: NodeJS.ProcessEnv = { MANOR_SECRET_KEY: "ZW52" };
    expect(applySupervisorEnv(withInline, file)).toEqual(["MANOR_INSTANCE_ID"]);
    expect(withInline.MANOR_SECRET_KEY_FILE).toBeUndefined();
    expect(withInline.MANOR_SECRET_KEY).toBe("ZW52");
  });

  it("does nothing without the file", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applySupervisorEnv(env, path.join(dir, "missing.env"))).toEqual([]);
    expect(env).toEqual({});
  });
});

describe("takeSecretEnv", () => {
  function envFile(text: string): string {
    const file = path.join(dir, "supervisor.env");
    fs.writeFileSync(file, text);
    return file;
  }

  it("moves the key out of the environment, filling it from the file, and leaves the instance id", () => {
    const file = envFile("MANOR_SECRET_KEY_FILE='/home/u/.config/manor/secret.key'\nMANOR_INSTANCE_ID='vm-1'\n");
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const { secretEnv, filled } = takeSecretEnv(env, file);
    expect(secretEnv).toEqual({ MANOR_SECRET_KEY_FILE: "/home/u/.config/manor/secret.key" });
    expect(filled).toEqual(["MANOR_SECRET_KEY_FILE", "MANOR_INSTANCE_ID"]);
    expect(env).toEqual({ PATH: "/usr/bin", MANOR_INSTANCE_ID: "vm-1" });
  });

  it("takes a key a unit's EnvironmentFile already put in the environment, which wins as a whole", () => {
    const file = envFile("MANOR_SECRET_KEY='aW5saW5l'\n");
    const env: NodeJS.ProcessEnv = { MANOR_SECRET_KEY_FILE: "/run/secrets/k", MANOR_SECRET_KEY: "" };
    const { secretEnv, filled } = takeSecretEnv(env, file);
    expect(secretEnv).toEqual({ MANOR_SECRET_KEY_FILE: "/run/secrets/k" });
    expect(filled).toEqual([]);
    expect("MANOR_SECRET_KEY_FILE" in env).toBe(false);
    expect("MANOR_SECRET_KEY" in env).toBe(false);
  });
});

describe("SystemdSupervisor", () => {
  function make(running: Partial<Record<SupervisedUnit, boolean>> = {}, linger = "Linger=no\n") {
    const fake = fakeRunner((cmd, args) => {
      if (cmd === "loginctl" && args[0] === "show-user") return { stdout: linger };
      if (args[1] === "is-active") return { stdout: "active\n" };
      return undefined;
    });
    const supervisor = new SystemdSupervisor({
      run: fake.run,
      unitDir: path.join(dir, "systemd", "user"),
      user: "me",
      isRunning: (unit) => running[unit] ?? false,
    });
    return { supervisor, calls: fake.calls };
  }

  it("installs both units, enables them, starts what is not running, and asks to linger", async () => {
    const { supervisor, calls } = make({ daemon: true });
    await supervisor.install();
    expect(fs.readdirSync(path.join(dir, "systemd", "user")).sort()).toEqual([
      "manor-host-daemon.service",
      "manor-host-server.service",
    ]);
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable manor-host-daemon.service manor-host-server.service",
      // The running (detached) daemon is left alone: a second one would strand its sessions.
      "systemctl --user start manor-host-server.service",
      "loginctl enable-linger",
    ]);
  });

  it("reports running units and lingering", async () => {
    expect(await make({}, "Linger=yes\n").supervisor.status()).toEqual({
      kind: "systemd",
      running: { daemon: true, server: true },
      linger: true,
    });
    expect((await make().supervisor.status()).linger).toBe(false);
  });

  it("uninstalls without stopping anything", async () => {
    const { supervisor, calls } = make();
    await supervisor.install();
    calls.length = 0;
    await supervisor.uninstall();
    expect(calls).toEqual([
      "systemctl --user disable manor-host-daemon.service manor-host-server.service",
      "systemctl --user daemon-reload",
    ]);
    expect(fs.readdirSync(path.join(dir, "systemd", "user"))).toEqual([]);
  });

  it("rejects a start whose unit is gone", async () => {
    const supervisor = new SystemdSupervisor({
      run: fakeRunner(() => ({ code: 5, stderr: "Unit manor-host-server.service not found." })).run,
      unitDir: dir,
      user: "me",
      isRunning: () => false,
    });
    await expect(supervisor.start("server")).rejects.toThrow(/not found/);
  });
});

describe("LaunchdSupervisor", () => {
  function make(loaded: Set<string>, running: Partial<Record<SupervisedUnit, boolean>> = {}) {
    const fake = fakeRunner((cmd, args) => {
      if (args[0] === "print") {
        const label = args[1].split("/").pop() ?? "";
        return loaded.has(label) ? { stdout: "\tstate = running\n" } : { code: 113 };
      }
      return undefined;
    });
    const supervisor = new LaunchdSupervisor({
      run: fake.run,
      agentsDir: path.join(dir, "LaunchAgents"),
      uid: 501,
      logFiles: { daemon: path.join(dir, "logs", "d.log"), server: path.join(dir, "logs", "s.log") },
      isRunning: (unit) => running[unit] ?? false,
    });
    return { supervisor, calls: fake.calls };
  }

  it("writes both plists and bootstraps the ones not already running", async () => {
    const { supervisor, calls } = make(new Set(), { daemon: true });
    await supervisor.install();
    expect(fs.readdirSync(path.join(dir, "LaunchAgents")).sort()).toEqual([
      "sh.manor.host-daemon.plist",
      "sh.manor.host-server.plist",
    ]);
    expect(calls).toEqual([
      "launchctl print gui/501/sh.manor.host-server",
      `launchctl bootstrap gui/501 ${path.join(dir, "LaunchAgents", "sh.manor.host-server.plist")}`,
    ]);
  });

  it("restarts a loaded agent with kickstart -k", async () => {
    const { supervisor, calls } = make(new Set(["sh.manor.host-server"]));
    await supervisor.restart("server");
    expect(calls).toEqual([
      "launchctl print gui/501/sh.manor.host-server",
      "launchctl kickstart -k gui/501/sh.manor.host-server",
    ]);
    expect((await supervisor.status()).running).toEqual({ daemon: false, server: true });
  });
});

describe("ContainerSupervisor", () => {
  function make(supervisePid: number | null, alive: Set<number>) {
    const signals: Array<[number, string]> = [];
    const supervisor = new ContainerSupervisor({
      supervisePid: () => supervisePid,
      unitPid: (unit) => (unit === "daemon" ? 20 : 30),
      isAlive: (pid) => alive.has(pid),
      kill: (pid, signal) => {
        signals.push([pid, signal]);
      },
    });
    return { supervisor, signals };
  }

  it("is valid only while supervise runs", async () => {
    await expect(make(10, new Set()).supervisor.install()).rejects.toThrow(/not running/);
    await expect(make(null, new Set()).supervisor.install()).rejects.toThrow(/not running/);
    await expect(make(10, new Set([10])).supervisor.install()).resolves.toBeUndefined();
  });

  it("signals supervise to restart or start, and SIGTERMs a unit to stop it", async () => {
    const { supervisor, signals } = make(10, new Set([10, 20, 30]));
    await supervisor.restart("server");
    await supervisor.restart("daemon");
    await supervisor.start("daemon");
    await supervisor.stop("daemon");
    expect(signals).toEqual([
      [10, "SIGUSR1"],
      [10, "SIGUSR2"],
      [10, "SIGHUP"],
      [20, "SIGTERM"],
    ]);
  });
});

describe("install, uninstall and the CLI", () => {
  function fakeSupervisor(kind: SupervisorKind, log: string[]): Supervisor {
    return {
      kind,
      install: async () => void log.push(`install ${kind}`),
      uninstall: async () => void log.push(`uninstall ${kind}`),
      status: async () => ({
        kind,
        running: { daemon: true, server: false },
        ...(kind === "systemd" ? { linger: false } : {}),
      }),
      start: async () => {},
      restart: async () => {},
      stop: async () => {},
    };
  }

  function deps(found: SupervisorKind | null, log: string[], env: NodeJS.ProcessEnv = {}): SupervisorCommandDeps {
    return {
      probes: {
        systemd: async () => found === "systemd",
        launchd: () => found === "launchd",
        container: () => found === "container",
      },
      create: (kind) => fakeSupervisor(kind, log),
      env,
      markerFile: path.join(dir, "remote", "supervisor.json"),
      envFile: path.join(dir, "remote", "supervisor.env"),
    };
  }

  it("installs, writes the marker and a 0600 supervisor.env, and keeps its earlier keys", async () => {
    const log: string[] = [];
    const d = deps("systemd", log, { MANOR_INSTANCE_ID: "vm-1" });
    fs.mkdirSync(path.dirname(d.envFile), { recursive: true });
    fs.writeFileSync(d.envFile, "MANOR_SECRET_KEY_FILE='/run/secrets/k'\n");
    const status = await installSupervisor(d);
    expect(status.kind).toBe("systemd");
    expect(log).toEqual(["install systemd"]);
    expect(readSupervisorMarker(d.markerFile)).toBe("systemd");
    expect(JSON.parse(fs.readFileSync(d.markerFile, "utf8"))).toEqual({ kind: "systemd" });
    expect(fs.statSync(d.envFile).mode & 0o777).toBe(0o600);
    const env = parseSupervisorEnv(fs.readFileSync(d.envFile, "utf8"));
    expect(env).toEqual({ MANOR_SECRET_KEY_FILE: "/run/secrets/k", MANOR_INSTANCE_ID: "vm-1" });
  });

  it("fails without a supervisor, and writes no marker", async () => {
    const d = deps(null, []);
    await expect(installSupervisor(d)).rejects.toThrow("No supervisor on this host");
    expect(fs.existsSync(d.markerFile)).toBe(false);
  });

  it("uninstalls the marker's kind and removes the marker, keeping supervisor.env", async () => {
    const log: string[] = [];
    const d = deps("launchd", log, { MANOR_SECRET_KEY_FILE: "/home/u/.config/manor/secret.key" });
    await installSupervisor(d);
    await uninstallSupervisor(d);
    expect(log).toEqual(["install launchd", "uninstall launchd"]);
    expect(fs.existsSync(d.markerFile)).toBe(false);
    expect(parseSupervisorEnv(fs.readFileSync(d.envFile, "utf8"))).toEqual({
      MANOR_SECRET_KEY_FILE: "/home/u/.config/manor/secret.key",
    });
  });

  it("refuses to uninstall while supervise is the container's entrypoint", async () => {
    const log: string[] = [];
    const d = deps("container", log);
    await installSupervisor(d);
    await expect(uninstallSupervisor(d)).rejects.toThrow("can't be turned off in a container");
    expect(log).toEqual(["install container"]);
    expect(readSupervisorMarker(d.markerFile)).toBe("container");
  });

  it("clears a container marker once supervise is gone", async () => {
    const log: string[] = [];
    const d = deps("container", log);
    await installSupervisor(d);
    await uninstallSupervisor({ ...d, probes: { ...d.probes, container: () => false } });
    expect(fs.existsSync(d.markerFile)).toBe(false);
  });

  it("prints one JSON line for --json", async () => {
    const out: string[] = [];
    const io = {
      stdout: { write: (s: string) => out.push(s) } as unknown as NodeJS.WritableStream,
      stderr: { write: () => true } as unknown as NodeJS.WritableStream,
    };
    const log: string[] = [];
    expect(await runSupervisorCommand(["status", "--json"], io, deps("systemd", log))).toBe(0);
    expect(await runSupervisorCommand(["install", "--json"], io, deps("systemd", log))).toBe(0);
    expect(await runSupervisorCommand(["install", "--json"], io, deps(null, log))).toBe(1);
    expect(out.map((l) => JSON.parse(l))).toEqual([
      { supervisor: null },
      { supervisor: { kind: "systemd", linger: false } },
      { error: "No supervisor on this host" },
    ]);
  });

  it("reports the marker's kind in the server's facts, with linger once read", async () => {
    const log: string[] = [];
    const d = deps("systemd", log);
    const cache = createSupervisorFactsCache({
      markerFile: d.markerFile,
      create: (kind) => fakeSupervisor(kind, log),
    });
    expect(cache.current()).toBeNull();
    await installSupervisor(d);
    expect(cache.current()).toEqual({ kind: "systemd" });
    await cache.refresh();
    expect(cache.current()).toEqual({ kind: "systemd", linger: false });
  });
});
