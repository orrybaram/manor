import { describe, it, expect, vi } from "vitest";
import {
  createRemoteExec,
  WRITE_FILE_CHUNK_CHARS,
  type RemoteExecClient,
} from "../remote-exec";
import type { ExecError } from "../exec";

function fakeClient() {
  const cancel = vi.fn();
  const client = {
    exec: vi.fn<RemoteExecClient["exec"]>(),
    execStream: vi.fn<RemoteExecClient["execStream"]>(() => ({ cancel })),
    readFile: vi.fn<RemoteExecClient["readFile"]>(),
    writeFile: vi.fn<RemoteExecClient["writeFile"]>(),
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

  describe("writeFile", () => {
    /**
     * A fake daemon `exec` that applies the fallback's commands to in-memory
     * files, so a test can check the chunks reassemble to the original bytes.
     */
    function applyToFiles(files: Map<string, Buffer>): RemoteExecClient["exec"] {
      return async (cmd, args) => {
        const ok = { stdout: "", stderr: "", exitCode: 0 };
        if (cmd === "sh" && args[1].includes(": >")) {
          files.set(args[3], Buffer.alloc(0));
        } else if (cmd === "sh" && args[1].includes("base64 -d")) {
          const [, , , chunk, tmp] = args;
          const prev = files.get(tmp) ?? Buffer.alloc(0);
          files.set(tmp, Buffer.concat([prev, Buffer.from(chunk, "base64")]));
        } else if (cmd === "mv") {
          const [, from, to] = args;
          files.set(to, files.get(from)!);
          files.delete(from);
        } else if (cmd === "rm") {
          files.delete(args[1]);
        } else {
          throw new Error(`unexpected command: ${cmd}`);
        }
        return ok;
      };
    }

    const unknownRequest = new Error("unknown request type: writeFile");

    it("goes through the client's writeFile when the daemon has it", async () => {
      const { client, exec } = fakeClient();
      client.writeFile.mockResolvedValue(undefined);
      const data = Buffer.from("png bytes");

      await exec.writeFile("/home/me/.manor/pasted-images/a.png", data);

      expect(client.writeFile).toHaveBeenCalledWith("/home/me/.manor/pasted-images/a.png", data);
      expect(client.exec).not.toHaveBeenCalled();
    });

    it("propagates any other writeFile error without falling back", async () => {
      const { client, exec } = fakeClient();
      client.writeFile.mockRejectedValue(new Error("writeFile failed: EACCES"));

      await expect(exec.writeFile("/x/a.png", Buffer.from("x"))).rejects.toThrow("EACCES");
      expect(client.exec).not.toHaveBeenCalled();
    });

    it("falls back to chunked exec on an old daemon, and remembers it", async () => {
      const { client, exec } = fakeClient();
      const files = new Map<string, Buffer>();
      client.writeFile.mockRejectedValue(unknownRequest);
      client.exec.mockImplementation(applyToFiles(files));
      // Enough bytes for several chunks, and not a multiple of 3 so the last
      // chunk carries padding.
      const data = Buffer.alloc(WRITE_FILE_CHUNK_CHARS * 2 + 1001);
      for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff;

      await exec.writeFile("/home/me/img/a.png", data);

      expect(files.get("/home/me/img/a.png")?.equals(data)).toBe(true);
      expect(files.has("/home/me/img/a.png.upload.tmp")).toBe(false);
      const calls = client.exec.mock.calls;
      expect(calls[0]).toEqual([
        "sh",
        ["-c", 'mkdir -p "$(dirname "$1")" && : > "$1"', "sh", "/home/me/img/a.png.upload.tmp"],
        {},
      ]);
      // Every chunk but the last is full-sized and so decodes on its own.
      const chunks = calls.slice(1, -1).map(([, args]) => args[3]);
      expect(chunks.length).toBeGreaterThan(2);
      for (const chunk of chunks.slice(0, -1)) {
        expect(chunk.length).toBe(WRITE_FILE_CHUNK_CHARS);
      }
      expect(calls[calls.length - 1]).toEqual([
        "mv",
        ["-f", "/home/me/img/a.png.upload.tmp", "/home/me/img/a.png"],
        {},
      ]);

      // A second write skips the request the daemon does not know.
      await exec.writeFile("/home/me/img/b.png", Buffer.from("small"));
      expect(client.writeFile).toHaveBeenCalledOnce();
      expect(files.get("/home/me/img/b.png")?.toString()).toBe("small");
    });

    it("rejects with an ExecError and removes the temp file when a step fails", async () => {
      const { client, exec } = fakeClient();
      client.writeFile.mockRejectedValue(unknownRequest);
      client.exec.mockImplementation(async (cmd) =>
        cmd === "mv"
          ? { stdout: "", stderr: "mv: permission denied", exitCode: 1 }
          : { stdout: "", stderr: "", exitCode: 0 },
      );

      const err = (await exec
        .writeFile("/ro/a.png", Buffer.from("x"))
        .catch((e: unknown) => e)) as ExecError;
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(1);
      expect(err.stderr).toBe("mv: permission denied");
      expect(client.exec).toHaveBeenLastCalledWith("rm", ["-f", "/ro/a.png.upload.tmp"], {});
    });
  });
});
