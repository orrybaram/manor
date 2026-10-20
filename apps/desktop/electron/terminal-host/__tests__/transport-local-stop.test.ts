/**
 * `manor-host restart` (`LocalTransport.stop`): it clears the stopped
 * daemon's socket and pid file, and never the next daemon's.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { daemonPidFile, daemonSocketFile } from "../../paths";
import { LocalTransport } from "../transport-local";

let home: string;
let child: ChildProcess;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "manor-stop-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  child = spawn("sleep", ["30"], { stdio: "ignore" });
  fs.mkdirSync(path.dirname(daemonPidFile("remote")), { recursive: true });
  fs.writeFileSync(daemonPidFile("remote"), String(child.pid));
  fs.writeFileSync(daemonSocketFile("remote"), "");
});

afterEach(() => {
  child.kill("SIGKILL");
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("LocalTransport.stop", () => {
  it("clears the stopped daemon's socket and pid file", async () => {
    await new LocalTransport({ namespace: "remote" }).stop();
    expect(fs.existsSync(daemonPidFile("remote"))).toBe(false);
    expect(fs.existsSync(daemonSocketFile("remote"))).toBe(false);
  });

  it("leaves those of a daemon started while it waited", async () => {
    const stopping = new LocalTransport({ namespace: "remote" }).stop();
    // The next daemon, started at once by a client that found this one gone.
    fs.writeFileSync(daemonPidFile("remote"), String(process.pid));
    await stopping;
    expect(fs.readFileSync(daemonPidFile("remote"), "utf-8")).toBe(String(process.pid));
    expect(fs.existsSync(daemonSocketFile("remote"))).toBe(true);
  });
});
