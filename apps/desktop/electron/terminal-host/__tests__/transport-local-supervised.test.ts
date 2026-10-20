/**
 * `LocalTransport` in the `remote` namespace under a supervisor: it starts and stops the daemon through it, falls back to the detached
 * spawn when the supervisor fails, and the desktop's `local` namespace never
 * asks.
 */

import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as string[][]);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    // The detached daemon spawn: record it, and stand in for the daemon by
    // writing its pid and socket files.
    spawn: vi.fn((cmd: string, args: string[], opts: unknown) => {
      if (cmd !== process.execPath) return actual.spawn(cmd, args, opts as never);
      spawned.push(args);
      const ns = args.includes("remote") ? "remote" : "local";
      void import("../../paths").then(({ daemonPidFile, daemonSocketFile }) => {
        fs.writeFileSync(daemonPidFile(ns), String(process.pid));
        fs.writeFileSync(daemonSocketFile(ns), "");
      });
      return { unref: () => {}, on: () => {} };
    }),
  };
});

import { daemonPidFile, daemonSocketFile } from "../../paths";
import type { SupervisedUnit, Supervisor } from "../../host-server/supervisor";
import { LocalTransport } from "../transport-local";

let home: string;
let calls: Array<[string, SupervisedUnit]>;
let sleeper: ChildProcess | null;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "manor-supervised-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  fs.mkdirSync(path.dirname(daemonPidFile("remote")), { recursive: true });
  fs.mkdirSync(path.dirname(daemonPidFile("local")), { recursive: true });
  calls = [];
  spawned.length = 0;
  sleeper = null;
});

afterEach(() => {
  sleeper?.kill("SIGKILL");
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function fakeSupervisor(opts: { fail?: boolean } = {}): Supervisor {
  const act = (name: string) => async (unit: SupervisedUnit) => {
    calls.push([name, unit]);
    if (opts.fail) throw new Error("Unit manor-host-daemon.service not found.");
    if (name === "start") {
      fs.writeFileSync(daemonPidFile("remote"), String(process.pid));
      fs.writeFileSync(daemonSocketFile("remote"), "");
    }
  };
  return {
    kind: "systemd",
    install: async () => {},
    uninstall: async () => {},
    status: async () => ({ kind: "systemd", running: { daemon: true, server: true } }),
    start: act("start"),
    restart: act("restart"),
    stop: act("stop"),
  };
}

describe("LocalTransport under a supervisor", () => {
  it("starts the remote daemon through the supervisor, spawning nothing", async () => {
    const supervisor = fakeSupervisor();
    await new LocalTransport({ namespace: "remote", supervisor: () => supervisor }).ensureRunning();
    expect(calls).toEqual([["start", "daemon"]]);
    expect(spawned).toEqual([]);
  });

  it("falls back to the detached spawn when the supervisor is broken", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const supervisor = fakeSupervisor({ fail: true });
    await new LocalTransport({ namespace: "remote", supervisor: () => supervisor }).ensureRunning();
    expect(calls).toEqual([["start", "daemon"]]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain("--namespace");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/spawning it detached/);
  });

  it("stops through the supervisor, and the pid too", async () => {
    sleeper = realSpawn("sleep", ["30"], { stdio: "ignore" });
    const exited = new Promise((r) => sleeper?.once("exit", r));
    fs.writeFileSync(daemonPidFile("remote"), String(sleeper.pid));
    fs.writeFileSync(daemonSocketFile("remote"), "");
    const supervisor = fakeSupervisor();
    await new LocalTransport({ namespace: "remote", supervisor: () => supervisor }).stop();
    expect(calls).toEqual([["stop", "daemon"]]);
    await exited;
    expect(fs.existsSync(daemonPidFile("remote"))).toBe(false);
  });

  it("restarts through the supervisor: stop, then start", async () => {
    const supervisor = fakeSupervisor();
    await new LocalTransport({ namespace: "remote", supervisor: () => supervisor }).restart();
    expect(calls).toEqual([
      ["stop", "daemon"],
      ["start", "daemon"],
    ]);
    expect(spawned).toEqual([]);
  });

  it("never asks a supervisor for the desktop's own daemon", async () => {
    const ask = vi.fn(() => fakeSupervisor());
    await new LocalTransport({ namespace: "local", supervisor: ask }).ensureRunning();
    expect(ask).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).not.toContain("--namespace");
  });
});
