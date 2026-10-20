import { EventEmitter } from "node:events";
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Fake child process ──
//
// `localExec.stream` only touches spawn's return value through events,
// `setEncoding`, and `kill`, so a small EventEmitter stands in for it and lets
// the tests fire `error`/`close` in whatever order they need.

class FakeStream extends EventEmitter {
  setEncoding = vi.fn();
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill = vi.fn(() => true);
}

let lastChild: FakeChild;
const spawnMock = vi.fn();
const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { localExec, streamAfter } from "../exec";

beforeEach(() => {
  spawnMock.mockReset();
  execFileMock.mockReset();
  spawnMock.mockImplementation(() => {
    lastChild = new FakeChild();
    return lastChild;
  });
});

describe("localExec.stream", () => {
  it("reports a spawn error once via onExit.error, not via onStderr", () => {
    const onStderr = vi.fn();
    const onExit = vi.fn();
    localExec.stream("nope", [], {}, { onStderr, onExit });

    lastChild.emit("error", new Error("spawn nope ENOENT"));
    // Node follows a spawn error with `close`; that must not fire onExit again.
    lastChild.emit("close", null);

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith({
      exitCode: null,
      error: "spawn nope ENOENT",
    });
    expect(onStderr).not.toHaveBeenCalled();
  });

  it("forwards chunks and the exit code on a normal close", () => {
    const onStdout = vi.fn();
    const onStderr = vi.fn();
    const onExit = vi.fn();
    localExec.stream("git", ["push"], {}, { onStdout, onStderr, onExit });

    lastChild.stdout.emit("data", "out");
    lastChild.stderr.emit("data", "err");
    lastChild.emit("close", 1);

    expect(onStdout).toHaveBeenCalledWith("out");
    expect(onStderr).toHaveBeenCalledWith("err");
    expect(onExit).toHaveBeenCalledWith({ exitCode: 1 });
  });

  it("cancel after exit is a no-op", () => {
    const { cancel } = localExec.stream("git", [], {}, { onExit: vi.fn() });
    lastChild.emit("close", 0);

    cancel();
    expect(lastChild.kill).not.toHaveBeenCalled();
  });

  it("kills the child only once however often cancel is called", () => {
    const { cancel } = localExec.stream("git", [], {}, { onExit: vi.fn() });

    cancel();
    cancel();
    cancel();
    expect(lastChild.kill).toHaveBeenCalledTimes(1);
    expect(lastChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("merges env overrides onto process.env", () => {
    localExec.stream(
      "git",
      [],
      { cwd: "/repo", env: { GIT_TERMINAL_PROMPT: "0" } },
      { onExit: vi.fn() },
    );

    const opts = spawnMock.mock.calls[0][2] as {
      cwd: string;
      env: Record<string, string>;
    };
    expect(opts.cwd).toBe("/repo");
    expect(opts.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(opts.env.PATH).toBe(process.env.PATH);
  });
});

describe("localExec.file", () => {
  it("does not pass undefined options through to execFile", async () => {
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, res: { stdout: string; stderr: string }) => void,
      ) => cb(null, { stdout: "ok", stderr: "" }),
    );

    await localExec.file("which", ["git"], {
      cwd: undefined,
      timeout: 5000,
      maxBuffer: undefined,
    });

    const opts = execFileMock.mock.calls[0][2] as Record<string, unknown>;
    // An explicit `maxBuffer: undefined` would disable execFile's 1 MiB cap.
    expect(opts).toEqual({ timeout: 5000 });
    expect("maxBuffer" in opts).toBe(false);
  });
});

describe("streamAfter", () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  it("starts once the precondition resolves, reporting through done", async () => {
    const onDone = vi.fn();
    const start = vi.fn((value: string, done: (r: { exitCode: number | null; stderr: string }) => void) => {
      done({ exitCode: 0, stderr: value });
      done({ exitCode: 1, stderr: "again" });
      return { cancel: vi.fn() };
    });
    streamAfter(Promise.resolve("main"), start, onDone);
    expect(start).not.toHaveBeenCalled();
    await flush();
    expect(start).toHaveBeenCalledWith("main", expect.any(Function));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith({ exitCode: 0, stderr: "main" });
  });

  it("reports a rejected precondition as stderr, without starting", async () => {
    const onDone = vi.fn();
    const start = vi.fn(() => ({ cancel: vi.fn() }));
    streamAfter(Promise.reject(new Error("host is down")), start, onDone);
    await flush();
    expect(start).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith({ exitCode: null, stderr: "host is down" });
  });

  it("cancelled before starting: reports a killed stream at once, and never starts", async () => {
    const onDone = vi.fn();
    const start = vi.fn(() => ({ cancel: vi.fn() }));
    const { cancel } = streamAfter(Promise.resolve(1), start, onDone);
    cancel();
    expect(onDone).toHaveBeenCalledWith({ exitCode: null, stderr: "" });
    await flush();
    cancel();
    expect(start).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("forwards a cancel once started", async () => {
    const inner = vi.fn();
    const { cancel } = streamAfter(Promise.resolve(1), () => ({ cancel: inner }), vi.fn());
    await flush();
    cancel();
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
