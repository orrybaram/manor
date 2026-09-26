import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { localRole, remoteRole, type DaemonRole } from "../daemon-role";
import { daemonDir, hooksDir } from "../../paths";
import { ShellManager } from "../../shell";

const CLIENT_MACHINE_KEYS = [
  "MANOR_HOOK_PORT",
  "MANOR_HOOK_PORT_FILE",
  "MANOR_WEBVIEW_PORT",
  "MANOR_PORTLESS_PORT",
];

describe("localRole", () => {
  it("lives in the local namespace and keeps no hook journal", () => {
    const role = localRole();
    expect(role.namespace).toBe("local");
    expect(role.paths.dir).toBe(daemonDir("local"));
    expect(role.hookJournal).toBeNull();
  });

  it("accepts every env key the app pushes", () => {
    const role = localRole();
    for (const key of [...CLIENT_MACHINE_KEYS, "FOO"]) {
      expect(role.acceptsEnvKey(key)).toBe(true);
    }
  });

  it("leaves bootstrapping to Electron main", async () => {
    await expect(localRole().bootstrap()).rejects.toThrow(/bootstraps this host itself/);
  });

  it("clears a stale remote-mode flag at startup", () => {
    const role = localRole();
    fs.mkdirSync(role.paths.dir, { recursive: true });
    const flag = path.join(role.paths.dir, "remote-mode");
    fs.writeFileSync(flag, "stale\n");
    role.onStartup({ onHookEntry: () => {} });
    expect(fs.existsSync(flag)).toBe(false);
  });
});

describe("remoteRole", () => {
  let role: DaemonRole | null = null;
  const savedEnv = {
    port: process.env.MANOR_HOOK_PORT,
    portFile: process.env.MANOR_HOOK_PORT_FILE,
  };

  afterEach(() => {
    role?.shutdown();
    role = null;
    for (const [key, value] of [
      ["MANOR_HOOK_PORT", savedEnv.port],
      ["MANOR_HOOK_PORT_FILE", savedEnv.portFile],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("lives in the remote namespace", () => {
    const r = remoteRole(() => {});
    expect(r.namespace).toBe("remote");
    expect(r.paths.dir).toBe(daemonDir("remote"));
  });

  it("refuses env naming ports on the client's machine (ADR-178 §2)", () => {
    const r = remoteRole(() => {});
    for (const key of CLIENT_MACHINE_KEYS) expect(r.acceptsEnvKey(key)).toBe(false);
    expect(r.acceptsEnvKey("FOO")).toBe(true);
  });

  it("bootstraps at startup, and `bootstrap` reports the cached result", async () => {
    role = remoteRole(() => {});
    fs.rmSync(ShellManager.zdotdirPath(), { recursive: true, force: true });
    fs.rmSync(hooksDir(), { recursive: true, force: true });

    role.onStartup({ onHookEntry: () => {} });
    // Before any `bootstrap` request: a shell spawned now gets the zdotdir.
    expect(fs.existsSync(path.join(ShellManager.zdotdirPath(), ".zshrc"))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir(), "notify.sh"))).toBe(true);
    expect(role.hookJournal).not.toBeNull();

    // Not run again: what it wrote is left alone.
    fs.rmSync(hooksDir(), { recursive: true, force: true });
    const first = await role.bootstrap();
    const second = await role.bootstrap();
    expect(first.agents).toEqual(expect.arrayContaining(["claude", "codex"]));
    expect(second).toEqual(first);
    expect(fs.existsSync(hooksDir())).toBe(false);

    // The hook listener is up once `bootstrap` answers.
    expect(Number(process.env.MANOR_HOOK_PORT)).toBeGreaterThan(0);
  });
});
