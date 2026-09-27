import { describe, it, expect, beforeEach } from "vitest";
import { LocalShellBackend, execShellHost } from "./local-shell";
import type { Exec } from "./exec";

/** A minimal `Exec` stub that answers `sh -c 'printf %s "$HOME"'` with `home`. */
function stubExec(home: string | (() => string)): Exec {
  let calls = 0;
  return {
    async file() {
      calls++;
      const resolved = typeof home === "function" ? home() : home;
      return { stdout: resolved, stderr: "" };
    },
    stream() {
      throw new Error("not implemented");
    },
    async readFile() {
      throw new Error("not implemented");
    },
    get callCount() {
      return calls;
    },
  } as Exec & { callCount: number };
}

describe("LocalShellBackend", () => {
  let backend: LocalShellBackend;

  beforeEach(() => {
    backend = new LocalShellBackend();
  });

  describe("which", () => {
    it("resolves a known binary", async () => {
      const result = await backend.which("git");
      expect(result).toBeTruthy();
      expect(result).toContain("/git");
    });

    it("returns null for a nonexistent binary", async () => {
      const result = await backend.which("definitely-not-a-real-binary-xyz");
      expect(result).toBeNull();
    });
  });

  describe("exec", () => {
    it("executes a command and returns stdout", async () => {
      const result = await backend.exec("echo", ["hello"]);
      expect(result.trim()).toBe("hello");
    });

    it("passes cwd option", async () => {
      const result = await backend.exec("pwd", [], { cwd: "/tmp" });
      // /tmp may resolve to /private/tmp on macOS
      expect(result.trim()).toMatch(/\/?tmp$/);
    });
  });
});

describe("execShellHost", () => {
  it("resolves and caches a valid absolute home directory", async () => {
    const exec = stubExec("/home/orry") as Exec & { callCount: number };
    const host = execShellHost(exec);
    expect(await host.homeDir()).toBe("/home/orry");
    expect(await host.homeDir()).toBe("/home/orry");
    expect(exec.callCount).toBe(1);
  });

  it("rejects an empty $HOME and does not cache the failure", async () => {
    const exec = stubExec("") as Exec & { callCount: number };
    const host = execShellHost(exec);
    await expect(host.homeDir()).rejects.toThrow(/absolute path/);
    // A retry re-runs the command instead of replaying a cached rejection.
    await expect(host.homeDir()).rejects.toThrow(/absolute path/);
    expect(exec.callCount).toBe(2);
  });

  it('rejects a $HOME of exactly "/" and does not cache the failure', async () => {
    const exec = stubExec("/") as Exec & { callCount: number };
    const host = execShellHost(exec);
    await expect(host.homeDir()).rejects.toThrow(/absolute path/);
    await expect(host.homeDir()).rejects.toThrow(/absolute path/);
    expect(exec.callCount).toBe(2);
  });

  it("rejects a relative $HOME", async () => {
    const exec = stubExec("relative/path");
    const host = execShellHost(exec);
    await expect(host.homeDir()).rejects.toThrow(/absolute path/);
  });
});
