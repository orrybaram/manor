import { beforeEach, describe, expect, it, vi } from "vitest";
import { paneHasNoAgent, resumeAgentInPane } from "../agent-resume-in-pane";
import { makeAgent } from "../../test-utils/fixtures";

const buildResumeCommand = vi.fn();
const markResumed = vi.fn();
const write = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    ...((window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI ?? {}),
    agents: { buildResumeCommand, markResumed },
    pty: { write },
  };
});

describe("paneHasNoAgent", () => {
  it("is true only for a pane published with no Agent kind", () => {
    expect(paneHasNoAgent({ status: "idle", reason: "agent process exited", kind: null })).toBe(true);
    expect(paneHasNoAgent({ status: "working", reason: "PreToolUse hook", kind: "claude" })).toBe(false);
    expect(paneHasNoAgent(undefined)).toBe(false);
  });
});

describe("resumeAgentInPane", () => {
  it("types the resume command into the Agent's pane and marks it resumed", async () => {
    buildResumeCommand.mockResolvedValue("claude --resume s1");
    const agent = makeAgent({ id: "a1", paneId: "pane-1" });
    expect(await resumeAgentInPane(agent)).toBe(true);
    expect(write).toHaveBeenCalledWith("pane-1", "claude --resume s1\r");
    expect(markResumed).toHaveBeenCalledWith("a1");
  });

  it("does nothing without a pane or a command", async () => {
    buildResumeCommand.mockResolvedValue(null);
    expect(await resumeAgentInPane(makeAgent({ paneId: "pane-1" }))).toBe(false);
    expect(await resumeAgentInPane(makeAgent({ paneId: null }))).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
