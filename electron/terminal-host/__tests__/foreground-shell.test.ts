import { describe, it, expect } from "vitest";
import { processBasename, shellForegroundName, shellScriptName } from "../foreground-shell";

const SHELL = 100;
const SCRIPT = 200;

describe("shellForegroundName (ADR-231 D5)", () => {
  it("/bin/sh led by the pane's own shell → null", () => {
    expect(
      shellForegroundName({ shellPid: SHELL, leaderPid: SHELL, leaderArgs: ["sh"], agentBelow: null }),
    ).toBeNull();
  });

  it("/bin/sh leading a script → the script's basename", () => {
    expect(
      shellForegroundName({
        shellPid: SHELL,
        leaderPid: SCRIPT,
        leaderArgs: ["sh", "/x/manor-e2e-agent", "--session", "s"],
        agentBelow: null,
      }),
    ).toBe("manor-e2e-agent");
  });

  it("/bin/sh wrapping a claude child → claude", () => {
    expect(
      shellForegroundName({
        shellPid: SHELL,
        leaderPid: SCRIPT,
        leaderArgs: ["/bin/sh", "/usr/local/bin/my-claude"],
        agentBelow: "claude",
      }),
    ).toBe("claude");
  });

  it("a failed lookup → null", () => {
    expect(
      shellForegroundName({ shellPid: SHELL, leaderPid: null, leaderArgs: null, agentBelow: null }),
    ).toBeNull();
    expect(
      shellForegroundName({ shellPid: SHELL, leaderPid: SCRIPT, leaderArgs: null, agentBelow: null }),
    ).toBeNull();
  });

  it("an interactive subshell in front → null", () => {
    expect(
      shellForegroundName({ shellPid: SHELL, leaderPid: SCRIPT, leaderArgs: ["bash", "-l"], agentBelow: null }),
    ).toBeNull();
  });
});

describe("shellScriptName", () => {
  it("skips the shell's options", () => {
    expect(shellScriptName(["/bin/bash", "-e", "--", "./deploy.sh", "x"])).toBe("deploy.sh");
  });

  it("names a -c command by its first word", () => {
    expect(shellScriptName(["sh", "-c", "/opt/bin/codex --full-auto"])).toBe("codex");
    expect(shellScriptName(["sh", "-ec", "make build"])).toBe("make");
  });

  it("a shell running a shell is still a shell", () => {
    expect(shellScriptName(["sh", "-c", "exec bash"])).toBeNull();
    expect(shellScriptName(["sh", "/bin/zsh"])).toBeNull();
  });
});

describe("processBasename", () => {
  it("strips the path and a login shell's dash", () => {
    expect(processBasename("/bin/sh")).toBe("sh");
    expect(processBasename("-zsh")).toBe("zsh");
    expect(processBasename("node")).toBe("node");
  });
});
