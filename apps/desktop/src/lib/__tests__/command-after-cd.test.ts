import { describe, expect, it } from "vitest";
import { commandAfterCd } from "../command-after-cd";
import { getAgentKindForCommand } from "../../agent-defaults";

describe("commandAfterCd", () => {
  it("skips leading cds, quoted or not", () => {
    expect(commandAfterCd("cd '/repo/my api' && codex resume t1")).toBe("codex resume t1");
    expect(commandAfterCd(`cd /a && cd "/b c" && pi --session x`)).toBe("pi --session x");
    expect(commandAfterCd(`cd '/it'"'"'s' && claude`)).toBe("claude");
    expect(commandAfterCd("claude --resume s")).toBe("claude --resume s");
  });
});

describe("getAgentKindForCommand", () => {
  it("names the agent after a leading cd, not cd", () => {
    expect(getAgentKindForCommand("cd /repo/api && codex resume t1")).toBe("codex");
    expect(getAgentKindForCommand("cd /repo && opencode --session s")).toBe("opencode");
  });
});
