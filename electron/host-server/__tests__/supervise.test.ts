/**
 * `manor-host supervise` (ADR-229 D4) against fake children: restart with
 * backoff, adopting a running unit, the restart and start signals, and
 * SIGTERM fan-out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADOPT_POLL_MS,
  KILL_GRACE_MS,
  MAX_BACKOFF_MS,
  Supervise,
  type SuperviseChild,
  type SuperviseDeps,
} from "../supervisor/supervise";
import type { SupervisedUnit } from "../supervisor/types";

class FakeChild implements SuperviseChild {
  readonly signals: NodeJS.Signals[] = [];
  private listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | null = null;
  exited = false;

  constructor(
    readonly unit: SupervisedUnit,
    readonly pid: number,
    private readonly onSignal: (child: FakeChild, signal: NodeJS.Signals) => void,
  ) {}

  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    this.onSignal(this, signal);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.listener = listener;
  }

  exit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.listener?.(code, signal);
  }
}

describe("Supervise", () => {
  let children: FakeChild[];
  let nextPid: number;
  /** Pids already running when `supervise` looks, by unit. */
  let running: Partial<Record<SupervisedUnit, number>>;
  let alive: Set<number>;
  let killed: Array<[number, string]>;
  /** Whether a child dies at once when signalled. */
  let diesOnSignal: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    nextPid = 100;
    running = {};
    alive = new Set();
    killed = [];
    diesOnSignal = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function deps(): SuperviseDeps {
    return {
      spawn: (unit) => {
        const child = new FakeChild(unit, nextPid++, (c, signal) => {
          if (diesOnSignal || signal === "SIGKILL") c.exit(null, signal);
        });
        children.push(child);
        return child;
      },
      unitPid: (unit) => running[unit] ?? null,
      socketPath: (unit) => `/tmp/${unit}.sock`,
      // A daemon socket always answers, so `start` goes straight on to the server.
      probeSocket: async (p) => p === "/tmp/daemon.sock" || running.server !== undefined,
      isAlive: (pid) => alive.has(pid),
      kill: (pid, signal) => {
        killed.push([pid, signal]);
        if (signal === "SIGTERM" || signal === "SIGKILL") alive.delete(pid);
      },
      log: () => {},
      now: () => Date.now(),
    };
  }

  const spawnedUnits = () => children.map((c) => c.unit);
  const lastServer = () => {
    const servers = children.filter((c) => c.unit === "server");
    return servers[servers.length - 1];
  };

  it("starts the daemon, then the server", async () => {
    const s = new Supervise(deps());
    await s.start();
    expect(spawnedUnits()).toEqual(["daemon", "server"]);
  });

  it("restarts an exiting child with a doubling backoff, capped at 30 s", async () => {
    const s = new Supervise(deps());
    await s.start();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = children.length;
      lastServer().exit(1);
      let waited = 0;
      while (children.length === before) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    expect(spawnedUnits().filter((u) => u === "server")).toHaveLength(8);
  });

  it("resets the backoff once a child has stayed up", async () => {
    const s = new Supervise(deps());
    await s.start();
    const server = lastServer;
    server().exit(1);
    await vi.advanceTimersByTimeAsync(1000);
    server().exit(1);
    await vi.advanceTimersByTimeAsync(2000);
    // Up for a minute: the next restart is after the minimum again.
    await vi.advanceTimersByTimeAsync(60_000);
    const before = children.length;
    server().exit(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(children.length).toBe(before + 1);
  });

  it("adopts a running unit, polls it, and starts its own once it is gone", async () => {
    running = { server: 42 };
    alive.add(42);
    const s = new Supervise(deps());
    await s.start();
    expect(spawnedUnits()).toEqual(["daemon"]);
    alive.delete(42);
    delete running.server;
    await vi.advanceTimersByTimeAsync(ADOPT_POLL_MS);
    expect(spawnedUnits()).toEqual(["daemon"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawnedUnits()).toEqual(["daemon", "server"]);
  });

  it("restarts a unit at once on its restart signal", async () => {
    const s = new Supervise(deps());
    await s.start();
    s.restart("server");
    await vi.advanceTimersByTimeAsync(0);
    expect(children[1].signals).toEqual(["SIGTERM"]);
    expect(spawnedUnits()).toEqual(["daemon", "server", "server"]);
  });

  it("restarts an adopted unit by signalling its pid", async () => {
    running = { server: 42 };
    alive.add(42);
    const s = new Supervise(deps());
    await s.start();
    s.restart("server");
    delete running.server;
    expect(killed).toEqual([[42, "SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(ADOPT_POLL_MS);
    expect(spawnedUnits()).toEqual(["daemon", "server"]);
  });

  it("starts a unit waiting out its backoff on the start signal", async () => {
    const s = new Supervise(deps());
    await s.start();
    children[1].exit(1);
    s.startNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnedUnits()).toEqual(["daemon", "server", "server"]);
  });

  it("passes SIGTERM on to both units and resolves once they have exited", async () => {
    diesOnSignal = false;
    const s = new Supervise(deps());
    await s.start();
    let stopped = false;
    void s.shutdown("SIGTERM").then(() => {
      stopped = true;
    });
    expect(children.map((c) => c.signals)).toEqual([["SIGTERM"], ["SIGTERM"]]);
    children[0].exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    children[1].exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(true);
    // Nothing is restarted on the way out.
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    expect(children).toHaveLength(2);
  });

  it("SIGKILLs a unit that ignores SIGTERM past the grace period", async () => {
    diesOnSignal = false;
    const s = new Supervise(deps());
    await s.start();
    const stopped = s.shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    await stopped;
    expect(children.map((c) => c.signals)).toEqual([
      ["SIGTERM", "SIGKILL"],
      ["SIGTERM", "SIGKILL"],
    ]);
  });
});
