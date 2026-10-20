import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBusyTracker,
  createHookRunner,
  HOOKS_LOG_MAX_BYTES,
  IDLE_DEBOUNCE_MS,
} from "../busy";

describe("busy tracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    let active = false;
    const changes: boolean[] = [];
    const tracker = createBusyTracker({
      isBusy: () => active,
      onChange: (b) => changes.push(b),
    });
    return {
      tracker,
      changes,
      set(v: boolean) {
        active = v;
        tracker.recompute();
      },
    };
  }

  it("goes busy at once and idle after the debounce", () => {
    const t = setup();
    t.set(true);
    expect(t.changes).toEqual([true]);
    expect(t.tracker.state()).toEqual({ busy: true, idleSince: null });
    t.set(false);
    vi.advanceTimersByTime(IDLE_DEBOUNCE_MS - 1);
    expect(t.changes).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(t.changes).toEqual([true, false]);
    expect(t.tracker.state()).toEqual({ busy: false, idleSince: Date.now() });
  });

  it("a flap inside the window is no event", () => {
    const t = setup();
    t.set(true);
    t.set(false);
    vi.advanceTimersByTime(IDLE_DEBOUNCE_MS / 2);
    t.set(true);
    vi.advanceTimersByTime(IDLE_DEBOUNCE_MS * 2);
    expect(t.changes).toEqual([true]);
    expect(t.tracker.state().busy).toBe(true);
  });
});

class FakeChild extends EventEmitter {
  pid = undefined;
  kill = vi.fn();
}

describe("hook runner", () => {
  let dir: string;
  let logFile: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-hooks-"));
    logFile = path.join(dir, "logs", "hooks.log");
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function hook(name: string, body = "#!/bin/sh\nexit 0\n", mode = 0o755): void {
    fs.writeFileSync(path.join(dir, name), body, { mode });
    fs.chmodSync(path.join(dir, name), mode);
  }

  function fakeSpawn() {
    const calls: Array<{ file: string; busy: string | undefined; child: FakeChild }> = [];
    const spawn = vi.fn((file: string, _args: unknown, o: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild();
      calls.push({ file: path.basename(file), busy: o.env.MANOR_BUSY, child });
      return child;
    });
    return { calls, spawn: spawn as never };
  }

  it("runs the hook for the transition with MANOR_BUSY", async () => {
    hook("on-busy");
    hook("on-idle");
    const f = fakeSpawn();
    const runner = createHookRunner({ dir, logFile, spawn: f.spawn });
    const done = runner.run(true);
    expect(f.calls.map((c) => [c.file, c.busy])).toEqual([["on-busy", "1"]]);
    f.calls[0].child.emit("exit", 0, null);
    await done;
    const next = runner.run(false);
    expect(f.calls[1]).toMatchObject({ file: "on-idle", busy: "0" });
    f.calls[1].child.emit("exit", 0, null);
    await next;
  });

  it("ignores a missing or non-executable hook", async () => {
    hook("on-idle", "#!/bin/sh\n", 0o644);
    const f = fakeSpawn();
    const runner = createHookRunner({ dir, logFile, spawn: f.spawn });
    await runner.run(true);
    await runner.run(false);
    expect(f.calls).toEqual([]);
    expect(runner.available()).toEqual({ onBusy: false, onIdle: false });
  });

  it("times out a hook and kills it", async () => {
    vi.useFakeTimers();
    hook("on-busy");
    const f = fakeSpawn();
    const warn = vi.fn();
    const runner = createHookRunner({ dir, logFile, spawn: f.spawn, timeoutMs: 30_000, log: { warn } });
    const done = runner.run(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    expect(f.calls[0].child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });

  it("never overlaps, and a newer transition supersedes a waiting one", async () => {
    hook("on-busy");
    hook("on-idle");
    const f = fakeSpawn();
    const runner = createHookRunner({ dir, logFile, spawn: f.spawn });
    void runner.run(true);
    void runner.run(false);
    void runner.run(true);
    void runner.run(false);
    expect(f.calls).toHaveLength(1);
    f.calls[0].child.emit("exit", 0, null);
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    // The waiting one is the newest: on-idle; the older ones were dropped.
    expect(f.calls[1].file).toBe("on-idle");
    f.calls[1].child.emit("exit", 0, null);
    await runner.idle();
    expect(f.calls).toHaveLength(2);
  });

  it("a failing hook is logged and ignored", async () => {
    hook("on-busy");
    const f = fakeSpawn();
    const warn = vi.fn();
    const runner = createHookRunner({ dir, logFile, spawn: f.spawn, log: { warn } });
    const done = runner.run(true);
    f.calls[0].child.emit("exit", 3, null);
    await expect(done).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exited with 3"));
  });

  it("runs a real script with its output in the capped log", async () => {
    hook("on-busy", '#!/bin/sh\necho "busy=$MANOR_BUSY"\n');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, "x".repeat(HOOKS_LOG_MAX_BYTES + 10));
    const runner = createHookRunner({ dir, logFile });
    await runner.run(true);
    const text = fs.readFileSync(logFile, "utf-8");
    expect(text).toContain("busy=1");
    expect(text.length).toBeLessThan(HOOKS_LOG_MAX_BYTES);
  });
});
