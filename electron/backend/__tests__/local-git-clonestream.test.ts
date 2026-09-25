import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Exec } from "../exec";

// `cloneStream` must run entirely through the injected `Exec` (a remote host
// runs the clone on the remote), never `node:child_process` directly.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(() => {
    throw new Error("cloneStream must not call execFile directly");
  }),
  spawn: vi.fn(() => {
    throw new Error("cloneStream must not call spawn directly");
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
  let capturedOpts: { cwd?: string; env?: Record<string, string> } | null = null;

  streamMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      opts: { cwd?: string; env?: Record<string, string> },
      cb: StreamCb,
    ) => {
      capturedCb = cb;
      capturedOpts = opts;
      return { cancel };
    },
  );

  const exec: Exec = {
    file: vi.fn(),
    stream: streamMock,
    readFile: vi.fn(),
  };

  return {
    exec,
    streamMock,
    cancel,
    opts: () => capturedOpts,
    emitStderr: (chunk: string) => capturedCb?.onStderr?.(chunk),
    emitExit: (exitCode: number | null) => capturedCb?.onExit({ exitCode }),
    emitError: (error: string) => capturedCb?.onExit({ exitCode: null, error }),
  };
}

describe("LocalGitBackend.cloneStream", () => {
  let backend: LocalGitBackend;
  let fake: ReturnType<typeof makeFakeExec>;

  beforeEach(() => {
    fake = makeFakeExec();
    backend = new LocalGitBackend(fake.exec);
  });

  it("runs `git clone --progress -- <repoUrl> <targetDir>`", () => {
    backend.cloneStream("git@github.com:org/repo.git", "/home/user/repo", {
      onLine: vi.fn(),
      onDone: vi.fn(),
    });

    expect(fake.streamMock).toHaveBeenCalledOnce();
    const [cmd, args] = fake.streamMock.mock.calls[0];
    expect(cmd).toBe("git");
    // `--` keeps a repo URL that starts with `-` from being misread as a
    // git option (ADR-178 ticket 5 review).
    expect(args).toEqual([
      "clone",
      "--progress",
      "--",
      "git@github.com:org/repo.git",
      "/home/user/repo",
    ]);
  });

  it("disables the terminal prompt so a missing credential fails fast", () => {
    backend.cloneStream("https://example.com/repo.git", "/tmp/repo", {
      onLine: vi.fn(),
      onDone: vi.fn(),
    });
    expect(fake.opts()?.env).toEqual({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/true",
    });
  });

  it("splits progress on \\r as well as \\n (git redraws clone progress in place)", () => {
    const onLine = vi.fn();
    backend.cloneStream("https://example.com/repo.git", "/tmp/repo", {
      onLine,
      onDone: vi.fn(),
    });

    fake.emitStderr("Receiving objects:  10%\rReceiving objects:  50%\r");
    fake.emitStderr("Receiving objects: 100%, done.\n");

    expect(onLine.mock.calls.map((c) => c[0])).toEqual([
      "Receiving objects:  10%",
      "Receiving objects:  50%",
      "Receiving objects: 100%, done.",
    ]);
  });

  it("reports success on exit code 0", () => {
    const onDone = vi.fn();
    backend.cloneStream("https://example.com/repo.git", "/tmp/repo", {
      onLine: vi.fn(),
      onDone,
    });
    fake.emitStderr("Cloning into '/tmp/repo'...");
    fake.emitExit(0);
    expect(onDone).toHaveBeenCalledWith({
      exitCode: 0,
      stderr: "Cloning into '/tmp/repo'...",
    });
  });

  it("reports a spawn failure through `error`, not stderr", () => {
    const onDone = vi.fn();
    const onLine = vi.fn();
    backend.cloneStream("https://example.com/repo.git", "/tmp/repo", {
      onLine,
      onDone,
    });
    fake.emitError("ENOENT: git not found");
    expect(onLine).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith({
      exitCode: null,
      stderr: "ENOENT: git not found",
    });
  });

  it("cancel forwards to the stream's cancel handle", () => {
    const { cancel } = backend.cloneStream(
      "https://example.com/repo.git",
      "/tmp/repo",
      { onLine: vi.fn(), onDone: vi.fn() },
    );
    cancel();
    expect(fake.cancel).toHaveBeenCalledOnce();
  });
});
