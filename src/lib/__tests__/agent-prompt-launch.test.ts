/**
 * Renderer agent launches hand the prompt to the store beside the bare
 * command, never inlined into it (ADR-209).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../store/app-store";
import { startAgentInBackground } from "../agent-prompt-launch";

vi.mock("../../agent-defaults", () => ({ getAgentCommand: () => "claude" }));

describe("startAgentInBackground", () => {
  const addTerminalTabIn = vi.fn(() => ({ tabId: "t", paneId: "p" }));

  beforeEach(() => {
    addTerminalTabIn.mockClear();
    useAppStore.setState({ addTerminalTabIn });
  });

  it("passes the prompt through opts, leaving the command bare", () => {
    startAgentInBackground("/ws", 'fix "it"\nnow');
    expect(addTerminalTabIn).toHaveBeenCalledWith(expect.anything(), "claude", {
      kind: "agent-startup",
      prompt: 'fix "it"\nnow',
    });
  });

  it("treats a whitespace-only prompt as none", () => {
    startAgentInBackground("/ws", "  \n ");
    expect(addTerminalTabIn).toHaveBeenCalledWith(expect.anything(), "claude", {
      kind: "agent-startup",
      prompt: undefined,
    });
  });
});
