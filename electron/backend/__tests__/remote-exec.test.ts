import { describe, it, expect, vi } from "vitest";
import { createRemoteExec, type RemoteExecClient } from "../remote-exec";
import type { ExecError } from "../exec";

function fakeClient() {
  const cancel = vi.fn();
  const client = {
    exec: vi.fn<RemoteExecClient["exec"]>(),
    execStream: vi.fn<RemoteExecClient["execStream"]>(() => ({ cancel })),
    readFile: vi.fn<RemoteExecClient["readFile"]>(),
  };
  return { client, cancel, exec: createRemoteExec(client) };
}

describe("createRemoteExec", () => {
  describe("file", () => {
    it("resolves with the output on exit code 0 and forwards the options", async () => {
      const { client, exec } = fakeClient();
      client.exec.mockResolvedValue({ stdout: "out", stderr: "warn", exitCode: 0 });

      await expect(
        exec.file("git", ["status", "--porcelain"], {
          cwd: "/repo",
          timeout: 5000,
          maxBuffer: 1024,
        }),
      ).resolves.toEqual({ stdout: "out", stderr: "warn" });
      expect(client.exec).toHaveBeenCalledWith("git", ["status", "--porcelain"], {
        cwd: "/repo",
        timeout: 5000,
        maxBuffer: 1024,
      });
    });

    it("leaves omitted options to the daemon", async () => {
      const { client, exec } = fakeClient();
      client.exec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
      await exec.file("which", ["git"]);
      expect(client.exec).toHaveBeenCalledWith("which", ["git"], {});
    });

    it("rejects a non-zero exit with an ExecError carrying stdout, stderr and code", async () => {
      const { client, exec } = fakeClient();
      client.exec.mockResolvedValue({
        stdout: "partial",
        stderr: "hook failed",
        exitCode: 1,
      });

      const err = (await exec
        .file("git", ["commit", "-m", "x"])
        .catch((e: unknown) => e)) as ExecError;
      expect(err).toBeInstanceOf(Error);
      expect(err.stdout).toBe("partial");
      expect(err.stderr).toBe("hook failed");
      expect(err.code).toBe(1);
      // Same message shape as Node's execFile, which callers strip.
      expect(err.message).toBe("Command failed: git commit -m x\nhook failed");
    });

    it("rejects a command killed by the daemon (timeout) with code null", async () => {
      const { client, exec } = fakeClient();
      client.exec.mockResolvedValue({
        stdout: "",
        stderr: "\n[timed out after 10ms]",
        exitCode: null,
      });
      const err = (await exec.file("sleep", ["5"]).catch((e: unknown) => e)) as ExecError;
      expect(err.code).toBeNull();
      expect(err.stderr).toContain("timed out");
    });

    it("rejects with an ExecError when the daemon cannot be reached", async () => {
      const { client, exec } = fakeClient();
      const cause = new Error("Disconnected");
      client.exec.mockRejectedValue(cause);

      const err = (await exec.file("git", ["status"]).catch((e: unknown) => e)) as ExecError;
      expect(err.code).toBeNull();
      expect(err.stdout).toBe("");
      expect(err.stderr).toBe("Disconnected");
      expect(err.cause).toBe(cause);
    });
  });

  describe("stream", () => {
    it("passes cwd and env overrides through and relays chunks and exit", () => {
      const { client, exec } = fakeClient();
      const onStdout = vi.fn();
      const onStderr = vi.fn();
      const onExit = vi.fn();

      exec.stream(
        "git",
        ["push", "origin", "main"],
        { cwd: "/repo", env: { GIT_TERMINAL_PROMPT: "0" } },
        { onStdout, onStderr, onExit },
      );

      expect(client.execStream).toHaveBeenCalledOnce();
      const [cmd, args, opts, cb] = client.execStream.mock.calls[0];
      expect(cmd).toBe("git");
      expect(args).toEqual(["push", "origin", "main"]);
      expect(opts).toEqual({ cwd: "/repo", env: { GIT_TERMINAL_PROMPT: "0" } });

      cb.onStdout?.("a");
      cb.onStderr?.("b");
      cb.onExit({ exitCode: 0 });
      expect(onStdout).toHaveBeenCalledWith("a");
      expect(onStderr).toHaveBeenCalledWith("b");
      expect(onExit).toHaveBeenCalledWith({ exitCode: 0 });
    });

    it("cancel reaches the client's handle", () => {
      const { exec, cancel } = fakeClient();
      const handle = exec.stream("git", ["push"], {}, { onExit: vi.fn() });
      handle.cancel();
      expect(cancel).toHaveBeenCalledOnce();
    });
  });

  it("readFile goes through the client", async () => {
    const { client, exec } = fakeClient();
    client.readFile.mockResolvedValue("contents");
    await expect(exec.readFile("/repo/a.txt", "utf-8")).resolves.toBe("contents");
    expect(client.readFile).toHaveBeenCalledWith("/repo/a.txt");
  });
});
