import { describe, it, expect, vi } from "vitest";
import { runHealthChecks } from "../health-check";
import type { GitBackend, ShellBackend } from "../types";

function fakeShell(overrides: Partial<ShellBackend> = {}): ShellBackend {
  return {
    which: vi.fn(async () => null),
    exec: vi.fn(async () => ""),
    homeDir: vi.fn(async () => "/home/user"),
    ...overrides,
  } as unknown as ShellBackend;
}

function fakeGit(exec: GitBackend["exec"]): GitBackend {
  return { exec } as unknown as GitBackend;
}

describe("runHealthChecks", () => {
  it("reports origin reachable when ls-remote succeeds", async () => {
    const git = fakeGit(vi.fn(async () => "abc123\trefs/heads/main\n"));
    const shell = fakeShell();
    const [origin] = await runHealthChecks(shell, git, "/repo");
    expect(origin).toEqual({
      id: "origin",
      label: "Reach origin",
      ok: true,
      detail: "origin is reachable.",
      fixCommand: null,
    });
  });

  it("reports origin unreachable with a fix command", async () => {
    const git = fakeGit(vi.fn(async () => {
      throw new Error("Permission denied (publickey)");
    }));
    const shell = fakeShell();
    const [origin] = await runHealthChecks(shell, git, "/repo");
    expect(origin.ok).toBe(false);
    expect(origin.detail).toContain("Permission denied");
    expect(origin.fixCommand).toBe("gh auth login");
  });

  it("distinguishes claude not-installed from not-logged-in", async () => {
    const git = fakeGit(vi.fn(async () => ""));
    const notInstalled = fakeShell({ which: vi.fn(async () => null) });
    const [, claudeMissing] = await runHealthChecks(notInstalled, git, "/repo");
    expect(claudeMissing.ok).toBe(false);
    expect(claudeMissing.detail).toContain("not installed");
    expect(claudeMissing.fixCommand).not.toBe("claude setup-token");

    const notLoggedIn = fakeShell({
      which: vi.fn(async (bin: string) => (bin === "claude" ? "/usr/bin/claude" : null)),
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "sh" && args[1]?.includes("credentials.json")) return "no\n";
        return "";
      }),
    });
    const [, claudeNotLoggedIn] = await runHealthChecks(notLoggedIn, git, "/repo");
    expect(claudeNotLoggedIn.ok).toBe(false);
    expect(claudeNotLoggedIn.detail).toContain("not look logged in");
    expect(claudeNotLoggedIn.fixCommand).toBe("claude setup-token");

    const loggedIn = fakeShell({
      which: vi.fn(async (bin: string) => (bin === "claude" ? "/usr/bin/claude" : null)),
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "sh" && args[1]?.includes("credentials.json")) return "yes\n";
        return "";
      }),
    });
    const [, claudeOk] = await runHealthChecks(loggedIn, git, "/repo");
    expect(claudeOk).toEqual({
      id: "claude",
      label: "Claude CLI",
      ok: true,
      detail: "Installed and logged in.",
      fixCommand: null,
    });
  });

  it("reports codex not-installed", async () => {
    const git = fakeGit(vi.fn(async () => ""));
    const shell = fakeShell({ which: vi.fn(async () => null) });
    const [, , codex] = await runHealthChecks(shell, git, "/repo");
    expect(codex.ok).toBe(false);
    expect(codex.detail).toContain("Codex CLI is not installed");
  });

  it("reports gh not logged in when auth status fails", async () => {
    const git = fakeGit(vi.fn(async () => ""));
    const shell = fakeShell({
      which: vi.fn(async (bin: string) => (bin === "gh" ? "/usr/bin/gh" : null)),
      exec: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === "gh" && args[0] === "auth") throw new Error("not logged in");
        return "";
      }),
    });
    const [, , , gh] = await runHealthChecks(shell, git, "/repo");
    expect(gh.ok).toBe(false);
    expect(gh.fixCommand).toBe("gh auth login");
  });

  it("never throws even when every check fails", async () => {
    const git = fakeGit(vi.fn(async () => {
      throw new Error("network unreachable");
    }));
    const shell = fakeShell({
      which: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const results = await runHealthChecks(shell, git, "/repo");
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.ok === false)).toBe(true);
  });
});
