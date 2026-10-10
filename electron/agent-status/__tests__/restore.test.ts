/**
 * `stateFromSavedAgent` (ADR-184): a pane's state rebuilt from its persisted
 * Agent after a main restart.
 */

import { describe, it, expect } from "vitest";
import type { AgentInfo } from "../../agent-persistence";
import { initialPaneState, RESTORED_REASON, stateFromSavedAgent } from "../reconciler";

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "agent-1",
    agentSessionId: "s1",
    name: null,
    status: "active",
    createdAt: "2026-09-26T12:00:00Z",
    updatedAt: "2026-09-26T12:00:00Z",
    completedAt: null,
    activatedAt: "2026-09-26T12:00:00Z",
    projectId: null,
    projectName: null,
    hostId: "local",
    workspacePath: null,
    cwd: "",
    agentKind: "claude",
    agentCommand: null,
    paneId: "pane-1",
    lastAgentStatus: "responded",
    resumedAt: null,
    transcriptPath: null,
    ...overrides,
  };
}

const NOW = 5_000;

describe("stateFromSavedAgent", () => {
  it.each([
    ["responded", "responded", "responded", null],
    ["thinking", "active", "thinking", null],
    ["working", "active", "working", null],
    ["requires_input", "active", "requires_input", "s1"],
    [null, "none", "idle", null],
    ["idle", "none", "idle", null],
    ["complete", "none", "idle", null],
  ] as const)(
    "last status %s → phase %s, status %s",
    (lastAgentStatus, phase, status, inputSessionId) => {
      const state = stateFromSavedAgent("pane-1", agent({ lastAgentStatus }), NOW);
      expect(state).toMatchObject({
        paneId: "pane-1",
        rootSessionId: "s1",
        hookDriven: true,
        kind: "claude",
        phase,
        status,
        statusReason: RESTORED_REASON,
        inputSessionId,
        lastHookAt: NOW,
        pendingStopAt: null,
      });
      expect(state.activeSubagents.size).toBe(0);
      expect(state.children.size).toBe(0);
    },
  );

  it.each([
    ["no agent", null],
    ["a completed agent", agent({ status: "completed" })],
    ["an abandoned agent", agent({ status: "abandoned" })],
    ["an errored agent", agent({ status: "error", lastAgentStatus: "error" })],
    ["an agent without a session id", agent({ agentSessionId: "" })],
  ])("restores nothing for %s", (_label, saved) => {
    expect(stateFromSavedAgent("pane-1", saved, NOW)).toEqual(initialPaneState("pane-1"));
  });

  it("carries the saved Agent kind", () => {
    const state = stateFromSavedAgent("pane-1", agent({ agentKind: "codex" }), NOW);
    expect(state.kind).toBe("codex");
  });
});
