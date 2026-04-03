import { describe, it, expect } from "vitest";
import { LocalShellBackend } from "./local-shell";

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
