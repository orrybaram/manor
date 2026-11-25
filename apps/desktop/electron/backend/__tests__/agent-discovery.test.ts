import { describe, it, expect, vi } from "vitest";
import { discoverAgentsOnHost } from "../agent-discovery";
import type { ShellBackend } from "../types";

/**
 * A host where `loginPath` CLIs are on the login shell's PATH and
 * `userBin` CLIs sit only in a per-user folder (`path -> exists`), the way
 * a GUI-launched app's login PATH misses `~/.local/bin` set in `.zshrc`.
 */
function host(opts: { loginPath: Record<string, string>; userBin: string[] }): ShellBackend {
  return {
    which: vi.fn(async () => null),
    homeDir: vi.fn(async () => "/home/user"),
    writeFile: vi.fn(),
    exec: vi.fn(async (_cmd: string, args: string[]) => {
      const script = args[1] ?? "";
      const login = /command -v (\S+?)'?$/.exec(script);
      if (login) return opts.loginPath[login[1]] ?? "";
      const list = /^for p in (.*?); do/.exec(script)?.[1] ?? "";
      const candidates = list.split(" ").map((p) => p.replace(/'/g, ""));
      return candidates.find((path) => opts.userBin.includes(path)) ?? "";
    }),
  } as unknown as ShellBackend;
}

describe("discoverAgentsOnHost", () => {
  it("lists agents found by the login shell or only in a per-user folder, in a fixed order", async () => {
    const shell = host({
      loginPath: { codex: "/opt/homebrew/bin/codex", pi: "/usr/local/bin/pi" },
      userBin: ["/home/user/.local/bin/claude", "/home/user/.opencode/bin/opencode"],
    });
    await expect(discoverAgentsOnHost(shell)).resolves.toEqual([
      { name: "Claude Code", command: "claude" },
      { name: "Codex", command: "codex --yolo" },
      { name: "Pi", command: "pi" },
      { name: "OpenCode", command: "opencode" },
    ]);
  });

  it("leaves out agents the host doesn't have", async () => {
    const shell = host({ loginPath: { codex: "/usr/bin/codex" }, userBin: [] });
    await expect(discoverAgentsOnHost(shell)).resolves.toEqual([
      { name: "Codex", command: "codex --yolo" },
    ]);
  });

  it("returns an empty list when every probe fails", async () => {
    const shell = host({ loginPath: {}, userBin: [] });
    vi.mocked(shell.exec).mockRejectedValue(new Error("host away"));
    await expect(discoverAgentsOnHost(shell)).resolves.toEqual([]);
  });
});
