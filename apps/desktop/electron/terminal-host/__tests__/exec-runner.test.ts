import { describe, it, expect, vi } from "vitest";
import {
  runExec,
  ExecRunner,
  normalizeTimeout,
  normalizeMaxBuffer,
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_MAX_BUFFER,
} from "../exec-runner";

const NODE = process.execPath;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, withinMs = 5000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} still alive`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("timeout / maxBuffer normalization", () => {
  it("treats 0 as no timeout, like execFile", () => {
    expect(normalizeTimeout(0)).toBeNull();
    expect(normalizeTimeout(-5)).toBeNull();
  });

  it("defaults an absent timeout", () => {
    expect(normalizeTimeout(undefined)).toBe(DEFAULT_EXEC_TIMEOUT_MS);
  });

  it("clamps timeouts a timer cannot hold", () => {
    expect(normalizeTimeout(2 ** 40)).toBe(2 ** 31 - 1);
  });

  it("caps a client-supplied maxBuffer", () => {
    expect(normalizeMaxBuffer(2 ** 40)).toBe(MAX_MAX_BUFFER);
    expect(normalizeMaxBuffer(-1)).toBe(0);
  });
});

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

  it("timeout: 0 means no timeout rather than an instant kill", async () => {
    const result = await runExec(
      NODE,
      ["-e", "setTimeout(() => console.log('ok'), 100)"],
      { timeout: 0 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("times out even when a grandchild holds the pipes open", async () => {
    const started = Date.now();
    const result = await runExec(
      "sh",
      ["-c", "sleep 100 & echo $!; sleep 100"],
      { timeout: 200 },
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.stderr).toContain("timed out");
    // The backgrounded grandchild dies with its process group.
    const grandchild = Number(result.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    await waitUntilDead(grandchild);
  }, 10000);

  it("resolves shortly after exit even if a grandchild keeps the pipes", async () => {
    const started = Date.now();
    const result = await runExec("sh", ["-c", "sleep 30 & echo $!"]);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.exitCode).toBe(0);
    const grandchild = Number(result.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    process.kill(grandchild, "SIGKILL");
  }, 10000);

  it("escalates to SIGKILL when the group ignores SIGTERM", async () => {
    const started = Date.now();
    const result = await runExec(
      "sh",
      ["-c", "trap '' TERM; sleep 100"],
      { timeout: 100 },
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(6000);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("timed out");
  }, 10000);

  it("an aborted signal kills the command and resolves", async () => {
    const aborter = new AbortController();
    const pending = runExec("sh", ["-c", "sleep 100 & sleep 100"], {
      signal: aborter.signal,
    });
    setTimeout(() => aborter.abort(), 100);
    const result = await pending;
    expect(result.exitCode).toBeNull();
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

  it("cancel kills grandchildren too, and only signals once", async () => {
    const runner = new ExecRunner();
    let grandchild = 0;
    const exited = new Promise<number | null>((resolve) => {
      runner.start(
        "exec-g",
        "sh",
        ["-c", "sleep 100 & echo $!; sleep 100"],
        {},
        {
          onStdout: (_id, data) => {
            grandchild = Number(data.trim());
            runner.cancel("exec-g");
            runner.cancel("exec-g");
          },
          onStderr: vi.fn(),
          onExit: (_id, code) => resolve(code),
        },
      );
    });
    expect(await exited).toBeNull();
    expect(grandchild).toBeGreaterThan(0);
    await waitUntilDead(grandchild);
  }, 10000);

  it("answers a duplicate execId instead of dropping it", async () => {
    const runner = new ExecRunner();
    const noop = { onStdout: vi.fn(), onStderr: vi.fn(), onExit: vi.fn() };
    runner.start("dup", NODE, ["-e", "setTimeout(() => {}, 5000)"], {}, noop);

    const onStderr = vi.fn();
    const onExit = vi.fn();
    runner.start("dup", NODE, ["-e", ""], {}, {
      onStdout: vi.fn(),
      onStderr,
      onExit,
    });

    expect(onStderr).toHaveBeenCalledWith(
      "dup",
      expect.stringContaining("already running"),
    );
    expect(onExit).toHaveBeenCalledWith("dup", null);
    // The original is untouched.
    expect(runner.has("dup")).toBe(true);
    runner.disposeAll();
  });

  it("merges env overrides onto the daemon's environment", async () => {
    const runner = new ExecRunner();
    let out = "";
    await new Promise<void>((resolve) => {
      runner.start(
        "env",
        NODE,
        [
          "-e",
          "process.stdout.write(process.env.MANOR_TEST_ENV + ':' + Boolean(process.env.PATH))",
        ],
        { env: { MANOR_TEST_ENV: "yes" } },
        {
          onStdout: (_id, data) => {
            out += data;
          },
          onStderr: vi.fn(),
          onExit: () => resolve(),
        },
      );
    });
    expect(out).toBe("yes:true");
  });

  it("pauses output under backpressure and resumes on demand", async () => {
    const runner = new ExecRunner();
    const chunks: string[] = [];
    let exited = false;
    const done = new Promise<void>((resolve) => {
      runner.start(
        "bp",
        NODE,
        [
          "-e",
          "let i = 0; const t = setInterval(() => { process.stdout.write(String(i++)); if (i === 10) clearInterval(t); }, 60);",
        ],
        {},
        {
          onStdout: (_id, data) => {
            chunks.push(data);
            // Report a full buffer on the first chunk only.
            return chunks.length > 1;
          },
          onStderr: vi.fn(),
          onExit: () => {
            exited = true;
            resolve();
          },
        },
      );
    });

    // While paused (and the child still running), nothing more is read; the
    // child's writes wait in the pipe.
    await new Promise((r) => setTimeout(r, 250));
    expect(chunks).toHaveLength(1);
    expect(exited).toBe(false);

    runner.resumeOutput();
    await done;
    expect(chunks.join("")).toBe("0123456789");
  }, 10000);

  it("disposeAll kills every tracked child, grandchildren included", async () => {
    const runner = new ExecRunner();
    const onExit = vi.fn();
    const grandchildren: number[] = [];

    await new Promise<void>((resolve) => {
      for (const id of ["exec-a", "exec-b"]) {
        runner.start(
          id,
          "sh",
          ["-c", "sleep 100 & echo $!; sleep 100"],
          {},
          {
            onStdout: (_id, data) => {
              grandchildren.push(Number(data.trim()));
              if (grandchildren.length === 2) resolve();
            },
            onStderr: vi.fn(),
            onExit,
          },
        );
      }
    });

    expect(runner.has("exec-a")).toBe(true);
    expect(runner.has("exec-b")).toBe(true);
    runner.disposeAll();
    expect(runner.has("exec-a")).toBe(false);
    expect(runner.has("exec-b")).toBe(false);

    for (const pid of grandchildren) await waitUntilDead(pid);
    // Nobody is left to tell: the socket that started them is gone.
    expect(onExit).not.toHaveBeenCalled();
  }, 10000);
});
