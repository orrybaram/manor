import { describe, it, expect, beforeEach } from "vitest";
import { ExecShellBackend } from "./exec-shell";
import type { Exec } from "./exec";
import { execFacts } from "./machine-facts";

/** A minimal `Exec` stub that answers `sh -c 'printf %s "$HOME"'` with `home`. */
function stubExec(home: string): Exec {
  return {
    async file() {
      return { stdout: home, stderr: "" };
    },
    stream() {
      throw new Error("not implemented");
    },
    async readFile() {
      throw new Error("not implemented");
    },
  };
}

describe("ExecShellBackend", () => {
  let backend: ExecShellBackend;

  beforeEach(() => {
    backend = new ExecShellBackend();
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

describe("ExecShellBackend.homeDir", () => {
  it("answers from the machine's facts", async () => {
    const exec = stubExec("/home/orry");
    const backend = new ExecShellBackend(exec, execFacts(exec));
    expect(await backend.homeDir()).toBe("/home/orry");
  });
});
