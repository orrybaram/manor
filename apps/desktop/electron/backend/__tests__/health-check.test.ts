import { describe, it, expect, vi } from "vitest";
import { runHealthChecks } from "../health-check";
import type { GitBackend, ShellBackend } from "../types";

/**
 * A fake `ShellBackend.exec` that answers the script shapes
 * `health-check.ts` sends through `sh -c`: a login-shell `command -v <cli>`
 * probe (`findCliOnHost`), its `~/.local/bin` fallback, and `ls-remote`.
 * `bins` maps a cli name to its resolved path (or `undefined` for "not
 * found").
 */
function fakeShell(opts: {
  bins?: Record<string, string | undefined>;
  localBinBins?: Record<string, string | undefined>;
  originExec?: (args: string[]) => Promise<string>;
  ghExec?: (args: string[]) => Promise<string>;
} = {}): ShellBackend {
  const bins = opts.bins ?? {};
  const localBinBins = opts.localBinBins ?? {};
  return {
    which: vi.fn(async () => null),
    homeDir: vi.fn(async () => "/home/user"),
    exec: vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "sh" && args[0] === "-c") {
        const script = args[1] ?? "";
        const cliMatch = /-lc '?command -v ([^'\s]+)'?$/.exec(script);
        if (cliMatch) {
          const cli = cliMatch[1];
          return bins[cli] ?? "";
        }
        if (script.startsWith("test -x")) {
          const cli = script.split("/").pop()?.replace(/'/g, "") ?? "";
          const path = localBinBins[cli];
          return path ? path : "";
        }
        if (script.includes("ls-remote")) {
          return opts.originExec?.(args) ?? "";
        }
      }
      if ((cmd === "gh" || cmd.endsWith("/gh")) && args[0] === "auth") {
        return opts.ghExec?.(args) ?? "";
      }
      throw new Error(`fakeShell: unexpected exec ${cmd} ${args.join(" ")}`);
    }),
  } as unknown as ShellBackend;
}

function fakeGit(overrides: {
  originUrl?: string;
  lsRemoteError?: Error;
} = {}): GitBackend {
  return {
    exec: vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "remote" && args[1] === "get-url") {
        if (overrides.originUrl) return overrides.originUrl;
        throw new Error("no such remote");
      }
      throw new Error(`fakeGit: unexpected exec ${args.join(" ")}`);
    }),
  } as unknown as GitBackend;
}

describe("runHealthChecks", () => {
  it("runs gh by the path the login shell resolved", async () => {
    const shell = fakeShell({ bins: { gh: "/opt/homebrew/bin/gh" } });
    const results = await runHealthChecks(shell, fakeGit(), "/repo");
    expect(results.find((r) => r.id === "gh")?.status).toBe("ok");
    expect(shell.exec).toHaveBeenCalledWith("/opt/homebrew/bin/gh", ["auth", "status"], expect.anything());
  });

  it("reports origin reachable", async () => {
    const git = fakeGit({ originUrl: "https://github.com/org/repo.git" });
    const shell = fakeShell();
    const [origin] = await runHealthChecks(shell, git, "/repo");
    expect(origin).toEqual({
      id: "origin",
      label: "Reach origin",
      ok: true,
      status: "ok",
      detail: "origin is reachable.",
      fixCommand: null,
    });
  });

  it("suggests gh auth login for an unreachable https origin", async () => {
    const git = fakeGit({ originUrl: "https://github.com/org/repo.git" });
    const shell = fakeShell({
      originExec: async () => {
        throw new Error("Permission denied (publickey)");
      },
    });
    const [origin] = await runHealthChecks(shell, git, "/repo");
    expect(origin.ok).toBe(false);
    expect(origin.status).toBe("fail");
    expect(origin.detail).toContain("Permission denied");
    expect(origin.fixCommand).toBe("gh auth login");
  });

  it("suggests ssh -T for an unreachable ssh/scp origin, naming its host", async () => {
    const git = fakeGit({ originUrl: "git@github.com:org/repo.git" });
    const shell = fakeShell({
      originExec: async () => {
        throw new Error("Connection refused");
      },
    });
    const [origin] = await runHealthChecks(shell, git, "/repo");
    expect(origin.ok).toBe(false);
    expect(origin.fixCommand).toContain("ssh -T git@github.com");

    const git2 = fakeGit({ originUrl: "ssh://git@example.com/org/repo.git" });
    const [origin2] = await runHealthChecks(shell, git2, "/repo");
    expect(origin2.fixCommand).toContain("ssh -T git@example.com");
  });

  it("fails the agent check when no agent CLI is installed", async () => {
    const shell = fakeShell({ bins: {} });
    const [, agent] = await runHealthChecks(shell, fakeGit(), "/repo");
    expect(agent.id).toBe("agent");
    expect(agent.status).toBe("fail");
    expect(agent.detail).toContain("claude, codex, opencode, pi");
  });

  it("passes the agent check with any one agent CLI installed", async () => {
    const shell = fakeShell({ bins: { opencode: "/usr/bin/opencode" } });
    const [, agent] = await runHealthChecks(shell, fakeGit(), "/repo");
    expect(agent).toEqual({
      id: "agent",
      label: "Agent CLI",
      ok: true,
      status: "ok",
      detail: "Installed: opencode.",
      fixCommand: null,
    });
  });

  it("finds an agent CLI under ~/.local/bin when the login-shell probe fails", async () => {
    const shell = fakeShell({
      bins: {},
      localBinBins: { claude: "/home/user/.local/bin/claude" },
    });
    const [, agent] = await runHealthChecks(shell, fakeGit(), "/repo");
    expect(agent.ok).toBe(true);
    expect(agent.detail).toBe("Installed: claude.");
  });

  it("reports gh not logged in when auth status fails", async () => {
    const git = fakeGit();
    const shell = fakeShell({
      bins: { gh: "/usr/bin/gh" },
      ghExec: async () => {
        throw new Error("not logged in");
      },
    });
    const [, , gh] = await runHealthChecks(shell, git, "/repo");
    expect(gh.ok).toBe(false);
    expect(gh.fixCommand).toBe("gh auth login");
  });

  it("never throws even when every check fails", async () => {
    const git = fakeGit({ lsRemoteError: new Error("network unreachable") });
    const shell: ShellBackend = {
      which: vi.fn(async () => null),
      homeDir: vi.fn(async () => {
        throw new Error("boom");
      }),
      exec: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as ShellBackend;
    const results = await runHealthChecks(shell, git, "/repo");
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok === false)).toBe(true);
  });

  it("runs every check concurrently, not one after another", async () => {
    const order: string[] = [];
    const git = fakeGit({ originUrl: "https://github.com/org/repo.git" });
    const shell = fakeShell({
      bins: { claude: "/usr/bin/claude", gh: "/usr/bin/gh" },
    });
    // Wrap the fake's implementation, not the mock itself: the mock calls
    // whatever implementation it currently has, so calling it from inside
    // its replacement would recurse until the stack overflows.
    const execMock = vi.mocked(shell.exec);
    const fakeExec = execMock.getMockImplementation()!;
    execMock.mockImplementation(async (cmd, args, execOpts) => {
      order.push(`start:${cmd}`);
      const result = await fakeExec(cmd, args, execOpts);
      order.push(`end:${cmd}`);
      return result;
    });
    const results = await runHealthChecks(shell, git, "/repo");
    // The probes really ran (a broken wrapper would fail every check quietly).
    expect(results.find((r) => r.id === "gh")?.ok).toBe(true);
    // Every check's probe must have started before any of them finished —
    // a serial implementation would interleave start/end pairs one at a time.
    const firstEnd = order.indexOf(order.find((e) => e.startsWith("end:")) ?? "");
    const startsBeforeFirstEnd = order.slice(0, firstEnd).filter((e) => e.startsWith("start:"));
    expect(startsBeforeFirstEnd.length).toBeGreaterThan(1);
  });
});
