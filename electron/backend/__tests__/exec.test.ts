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

import { localExec } from "../exec";

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
