import { describe, expect, it } from "vitest";
import { cleanAgentTitle } from "../title-utils";

describe("cleanAgentTitle", () => {
  it("keeps an agent's own title, without spinner frames or done markers", () => {
    expect(cleanAgentTitle("⠋ Fix the login bug")).toBe("Fix the login bug");
    expect(cleanAgentTitle("✳ Fix the login bug")).toBe("Fix the login bug");
  });

  it("drops generic agent titles", () => {
    expect(cleanAgentTitle("✳ Claude Code")).toBeNull();
    expect(cleanAgentTitle("codex")).toBeNull();
  });

  it("drops the shell's prompt title, which names a directory, not the agent", () => {
    expect(cleanAgentTitle("orrybaram@Mac:~/.manor/worktrees/tango/appsweb-drop-flag")).toBeNull();
    expect(cleanAgentTitle("me@box:/home/me/code")).toBeNull();
  });

  it("returns null for nothing", () => {
    expect(cleanAgentTitle(null)).toBeNull();
    expect(cleanAgentTitle("⠋ ")).toBeNull();
  });
});
