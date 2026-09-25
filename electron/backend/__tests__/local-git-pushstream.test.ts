import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Exec } from "../exec";

// ── Mock node:child_process ──
//
// Nothing in `pushStream` may touch node:child_process — branch resolution
// and the push both go through the injected `Exec` (a remote host runs them
// on the remote). The mock makes any direct use fail loudly.

vi.mock("node:child_process", () => ({
  // exec.ts imports these at module scope (for `localExec`); local-git.ts
  // imports `localExec` as a value even though this test injects a fake
  // `Exec`, so these must exist to avoid failing at import time.
  execFile: vi.fn(() => {
    throw new Error("pushStream must not call execFile directly");
  }),
  spawn: vi.fn(() => {
    throw new Error("pushStream must not call spawn directly");
  }),
}));

import { LocalGitBackend } from "../local-git";

type StreamCb = {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onExit: (result: { exitCode: number | null; error?: string }) => void;
};

function makeFakeExec() {
  const cancel = vi.fn();
  const streamMock = vi.fn();
  let capturedCb: StreamCb | null = null;

  streamMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: { cwd?: string; env?: Record<string, string> },
      cb: StreamCb,
    ) => {
      capturedCb = cb;
      return { cancel };
    },
  );

  // Branch resolution (`git rev-parse --abbrev-ref HEAD`).
  const fileMock = vi.fn<Exec["file"]>();

  const exec: Exec = {
    file: fileMock,
    stream: streamMock,
    readFile: vi.fn(),
  };

  return {
    exec,
    fileMock,
    streamMock,
    cancel,
    emitStderr: (chunk: string) => capturedCb?.onStderr?.(chunk),
    emitExit: (exitCode: number | null) => capturedCb?.onExit({ exitCode }),
    emitError: (error: string) =>
      capturedCb?.onExit({ exitCode: null, error }),
  };
}

describe("LocalGitBackend.pushStream", () => {
  let backend: LocalGitBackend;
  let fake: ReturnType<typeof makeFakeExec>;

  beforeEach(() => {
    fake = makeFakeExec();
    backend = new LocalGitBackend(fake.exec);
    // Default: branch resolution returns "main".
    fake.fileMock.mockResolvedValue({ stdout: "main\n", stderr: "" });
  });

  /** Let a pending branch resolution settle. */
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  describe("argument composition", () => {
    it("uses default remote 'origin' and resolved branch", async () => {
      backend.pushStream("/repo", {}, { onLine: vi.fn(), onDone: vi.fn() });

      expect(fake.fileMock).toHaveBeenCalledWith(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        expect.objectContaining({ cwd: "/repo" }),
      );
      // The push waits for the branch.
      expect(fake.streamMock).not.toHaveBeenCalled();
      await flush();
      expect(fake.streamMock).toHaveBeenCalledOnce();
      const [cmd, args] = fake.streamMock.mock.calls[0];
      expect(cmd).toBe("git");
      expect(args).toEqual(["push", "origin", "main"]);
    });

    it("uses explicit branch and remote without resolving", () => {
      backend.pushStream(
        "/repo",
        { remote: "upstream", branch: "feature" },
        { onLine: vi.fn(), onDone: vi.fn() },
      );

      expect(fake.fileMock).not.toHaveBeenCalled();
      const [, args] = fake.streamMock.mock.calls[0];
      expect(args).toEqual(["push", "upstream", "feature"]);
    });

    it("includes --set-upstream when opts.setUpstream is true", () => {
      backend.pushStream(
        "/repo",
        { branch: "feature", setUpstream: true },
        { onLine: vi.fn(), onDone: vi.fn() },
      );

      const [, args] = fake.streamMock.mock.calls[0];
      expect(args).toEqual(["push", "--set-upstream", "origin", "feature"]);
    });
  });

  describe("environment", () => {
    it("sets GIT_TERMINAL_PROMPT=0 and GIT_ASKPASS=/bin/true", () => {
      backend.pushStream(
        "/repo",
        { branch: "main" },
        { onLine: vi.fn(), onDone: vi.fn() },
      );

      const opts = fake.streamMock.mock.calls[0][2] as {
        cwd: string;
        env: Record<string, string>;
      };
      expect(opts.cwd).toBe("/repo");
      // Overrides only: the Exec merges them onto its own base env, so the
      // caller must not ship its whole process.env (wrong for a remote Exec).
      expect(opts.env).toEqual({
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/true",
      });
    });
  });

  describe("line buffering", () => {
    it("emits complete lines and holds partial chunks", () => {
      const onLine = vi.fn();
      const onDone = vi.fn();
      backend.pushStream("/repo", { branch: "main" }, { onLine, onDone });

      fake.emitStderr("foo\nbar");
      // No newline after 'bar' yet — only 'foo' should be flushed.
      expect(onLine).toHaveBeenCalledTimes(1);
      expect(onLine).toHaveBeenNthCalledWith(1, "foo");

      fake.emitStderr("\nbaz\n");
      // Now we expect 'bar' and 'baz' to flush.
      expect(onLine).toHaveBeenCalledTimes(3);
      expect(onLine).toHaveBeenNthCalledWith(2, "bar");
      expect(onLine).toHaveBeenNthCalledWith(3, "baz");

      // onDone should not yet have fired.
      expect(onDone).not.toHaveBeenCalled();
    });
  });

  describe("drain on close", () => {
    it("emits trailing partial line before onDone", () => {
      const calls: string[] = [];
      const onLine = vi.fn((line: string) => calls.push(`line:${line}`));
      const onDone = vi.fn(() => calls.push("done"));

      backend.pushStream("/repo", { branch: "main" }, { onLine, onDone });

      fake.emitStderr("partial");
      // No newline — pending should hold it.
      expect(onLine).not.toHaveBeenCalled();

      fake.emitExit(0);

      expect(calls).toEqual(["line:partial", "done"]);
      expect(onDone).toHaveBeenCalledWith({ exitCode: 0, stderr: "partial" });
    });

    it("does not emit a final empty line when stderr ended cleanly", () => {
      const onLine = vi.fn();
      const onDone = vi.fn();

      backend.pushStream("/repo", { branch: "main" }, { onLine, onDone });

      fake.emitStderr("done\n");
      expect(onLine).toHaveBeenCalledTimes(1);
      expect(onLine).toHaveBeenCalledWith("done");

      fake.emitExit(0);
      // Pending was empty, so no extra line should fire.
      expect(onLine).toHaveBeenCalledTimes(1);
      expect(onDone).toHaveBeenCalledWith({ exitCode: 0, stderr: "done\n" });
    });

    it("forwards non-zero exit codes", () => {
      const onDone = vi.fn();
      backend.pushStream(
        "/repo",
        { branch: "main" },
        { onLine: vi.fn(), onDone },
      );
      fake.emitStderr("nope\n");
      fake.emitExit(1);
      expect(onDone).toHaveBeenCalledWith({ exitCode: 1, stderr: "nope\n" });
    });
  });

  describe("cancel", () => {
    it("returns a function that sends SIGTERM", () => {
      const { cancel } = backend.pushStream(
        "/repo",
        { branch: "main" },
        { onLine: vi.fn(), onDone: vi.fn() },
      );

      cancel();
      expect(fake.cancel).toHaveBeenCalledTimes(1);
    });
  });

  describe("spawn / runtime errors", () => {
    it("calls onDone with the error message when the exec stream errors", () => {
      const onLine = vi.fn();
      const onDone = vi.fn();
      backend.pushStream("/repo", { branch: "main" }, { onLine, onDone });

      fake.emitError("spawn git ENOENT");

      expect(onDone).toHaveBeenCalledWith({
        exitCode: null,
        stderr: "spawn git ENOENT",
      });
      // The spawn error is not push progress.
      expect(onLine).not.toHaveBeenCalled();
    });

    it("reports only the error, not partial stderr, when the stream errors", () => {
      const onLine = vi.fn();
      const onDone = vi.fn();
      backend.pushStream("/repo", { branch: "main" }, { onLine, onDone });

      fake.emitStderr("partial");
      fake.emitError("boom");

      expect(onLine).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledWith({ exitCode: null, stderr: "boom" });
    });

    it("does not double-fire onDone when exit fires twice", () => {
      const onDone = vi.fn();
      backend.pushStream(
        "/repo",
        { branch: "main" },
        { onLine: vi.fn(), onDone },
      );

      fake.emitExit(null);
      fake.emitExit(null);

      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  describe("branch resolution failure", () => {
    it("invokes onDone with the error and returns a no-op cancel", async () => {
      fake.fileMock.mockRejectedValue(new Error("not a git repository"));

      const onDone = vi.fn();
      const { cancel } = backend.pushStream(
        "/notrepo",
        {},
        { onLine: vi.fn(), onDone },
      );
      await flush();

      expect(onDone).toHaveBeenCalledWith({
        exitCode: null,
        stderr: "not a git repository",
      });
      // No stream should have been started.
      expect(fake.streamMock).not.toHaveBeenCalled();
      // Cancel must still be callable without error.
      expect(() => cancel()).not.toThrow();
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  describe("cancel before the branch resolves", () => {
    it("never starts the push and reports a killed push once", async () => {
      let resolveBranch!: (v: { stdout: string; stderr: string }) => void;
      fake.fileMock.mockReturnValue(
        new Promise((r) => {
          resolveBranch = r;
        }),
      );
      const onDone = vi.fn();
      const { cancel } = backend.pushStream(
        "/repo",
        {},
        { onLine: vi.fn(), onDone },
      );

      cancel();
      expect(onDone).toHaveBeenCalledWith({ exitCode: null, stderr: "" });

      resolveBranch({ stdout: "main\n", stderr: "" });
      await flush();
      expect(fake.streamMock).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it("forwards cancel to the push once it has started", async () => {
      const { cancel } = backend.pushStream(
        "/repo",
        {},
        { onLine: vi.fn(), onDone: vi.fn() },
      );
      await flush();
      cancel();
      expect(fake.cancel).toHaveBeenCalledTimes(1);
    });
  });
});
