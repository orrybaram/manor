import { describe, it, expect, vi } from "vitest";
import { runExec, ExecRunner } from "../exec-runner";

const NODE = process.execPath;

describe("runExec", () => {
  it("resolves stdout/stderr/exitCode on a successful command", async () => {
    const result = await runExec(NODE, ["-e", "console.log('hello')"]);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("reports a non-zero exit code", async () => {
    const result = await runExec(NODE, ["-e", "process.exit(3)"]);
    expect(result.exitCode).toBe(3);
  });

  it("kills the child and reports a timeout", async () => {
    const result = await runExec(
      NODE,
      ["-e", "setTimeout(() => {}, 5000)"],
      { timeout: 100 },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("timed out");
  }, 10000);

  it("truncates output past maxBuffer instead of throwing", async () => {
    const result = await runExec(
      NODE,
      ["-e", "process.stdout.write('a'.repeat(1000))"],
      { maxBuffer: 100 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThan(1000);
    expect(result.stdout).toContain("truncated");
  });
});

describe("ExecRunner", () => {
  it("streams stdout chunks and reports exit", async () => {
    const runner = new ExecRunner();
    const onStdout = vi.fn();
    const onStderr = vi.fn();
    const onExit = vi.fn();

    await new Promise<void>((resolve) => {
      runner.start(
        "exec-1",
        NODE,
        ["-e", "process.stdout.write('a'); process.stdout.write('b');"],
        {},
        {
          onStdout,
          onStderr,
          onExit: (execId, exitCode) => {
            onExit(execId, exitCode);
            resolve();
          },
        },
      );
    });

    expect(onStdout).toHaveBeenCalled();
    const combined = onStdout.mock.calls.map((c) => c[1]).join("");
    expect(combined).toBe("ab");
    expect(onExit).toHaveBeenCalledWith("exec-1", 0);
    expect(runner.has("exec-1")).toBe(false);
  });

  it("cancels a mid-run child and reports it as no longer running", async () => {
    const runner = new ExecRunner();
    const onExit = vi.fn();

    await new Promise<void>((resolve) => {
      runner.start(
        "exec-2",
        NODE,
        ["-e", "setTimeout(() => {}, 5000)"],
        {},
        {
          onStdout: vi.fn(),
          onStderr: vi.fn(),
          onExit: (execId, exitCode) => {
            onExit(execId, exitCode);
            resolve();
          },
        },
      );

      expect(runner.has("exec-2")).toBe(true);
      runner.cancel("exec-2");
    });

    // Killed by SIGTERM rather than exiting on its own — Node reports that
    // as a null exit code.
    expect(onExit).toHaveBeenCalledWith("exec-2", null);
    expect(runner.has("exec-2")).toBe(false);
  }, 10000);

  it("cancel is a no-op for an unknown execId", () => {
    const runner = new ExecRunner();
    expect(() => runner.cancel("does-not-exist")).not.toThrow();
  });

  it("disposeAll kills every tracked child (socket-close cleanup)", async () => {
    const runner = new ExecRunner();
    const exits: string[] = [];

    const done = new Promise<void>((resolve) => {
      let remaining = 2;
      const onExit = (execId: string) => {
        exits.push(execId);
        remaining -= 1;
        if (remaining === 0) resolve();
      };

      runner.start(
        "exec-a",
        NODE,
        ["-e", "setTimeout(() => {}, 5000)"],
        {},
        { onStdout: vi.fn(), onStderr: vi.fn(), onExit },
      );
      runner.start(
        "exec-b",
        NODE,
        ["-e", "setTimeout(() => {}, 5000)"],
        {},
        { onStdout: vi.fn(), onStderr: vi.fn(), onExit },
      );

      expect(runner.has("exec-a")).toBe(true);
      expect(runner.has("exec-b")).toBe(true);
      runner.disposeAll();
    });

    await done;
    expect(exits.sort()).toEqual(["exec-a", "exec-b"]);
    expect(runner.has("exec-a")).toBe(false);
    expect(runner.has("exec-b")).toBe(false);
  }, 10000);
});
