/**
 * `createAgentService` — how `LayoutStore` abandons the agent of every pane
 * it ends (ADR-182 D7). There is no bridge method for this: a pane's agent
 * ends with the pane, whoever closed it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock notifications ───────────────────────────────────────────────────────
vi.mock("../notifications", () => ({
  updateDockBadge: vi.fn(),
  markAgentNotificationsRead: vi.fn(),
  sendAgentUpdate: vi.fn(),
  getUnseenSnapshot: vi.fn(() => ({ responded: [], requires_input: [] })),
}));

// ── Mock ipc-validate ────────────────────────────────────────────────────────
vi.mock("../ipc-validate", () => ({
  assertString: vi.fn(),
}));

import { createAgentService } from "../bridge/handlers/agents";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    agentManager: {
      getAllAgents: vi.fn().mockReturnValue([]),
      updateAgent: vi.fn((id: string, updates: Record<string, unknown>) => ({
        id,
        ...updates,
      })),
      getAgentByPaneId: vi.fn().mockReturnValue(null),
      deleteAgent: vi.fn(),
    },
    backend: {
      pty: {
        listSessions: vi.fn().mockResolvedValue([]),
      },
    },
    statsStore: {
      record: vi.fn(),
    },
    // The Status reconciler's driver (ADR-184). Reports that it persisted the
    // abandon for the pane's agent, as the real one does for an active one.
    agentStatus: {
      signal: vi.fn(() => ({
        effects: [{ kind: "PersistAgentStatus", sessionId: "s1", transition: { to: "abandoned" } }],
      })),
    },
    mainWindow: null,
    preferencesManager: {},
    paneContextMap: new Map(),
    unseenRespondedAgents: new Set(),
    unseenInputAgents: new Set(),
    ...overrides,
  };
}

/** End one pane, the way `LayoutStore` does. */
function abandon(
  deps: ReturnType<typeof makeDeps>,
  paneId: string,
  title?: string,
): void {
  createAgentService(deps as never).abandonForPanes([{ paneId, title }]);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("abandoning a pane's agent", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("sends the reconciler an abandon signal and writes no status itself", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue({
      id: "t1",
      agentSessionId: "s1",
      status: "active",
    });

    abandon(deps, "pane-1");

    expect(deps.agentStatus.signal).toHaveBeenCalledTimes(1);
    expect(deps.agentStatus.signal).toHaveBeenCalledWith("pane-1", {
      type: "user",
      action: "abandon",
    });
    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("does nothing if no agent for that pane", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue(undefined);

    abandon(deps, "pane-99");

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
    expect(deps.agentStatus.signal).not.toHaveBeenCalled();
  });

  it("does nothing if agent is not active", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue({
      id: "t1",
      status: "completed",
    });

    abandon(deps, "pane-1");

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
    expect(deps.agentStatus.signal).not.toHaveBeenCalled();
  });

  it("sets agent name from title when agent has no name", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue({
      id: "t1",
      status: "active",
      name: null,
    });

    abandon(deps, "pane-1", "Fix conversation naming after slash clear command ⠻");

    expect(deps.agentManager.updateAgent).toHaveBeenCalledWith("t1", {
      name: "Fix conversation naming after slash clear command",
    });
    // The name is written before the signal, so its broadcast carries it.
    const nameOrder = deps.agentManager.updateAgent.mock.invocationCallOrder[0];
    const signalOrder = deps.agentStatus.signal.mock.invocationCallOrder[0];
    expect(nameOrder).toBeLessThan(signalOrder);
  });

  it("preserves existing agent name when title is also provided", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue({
      id: "t1",
      status: "active",
      name: "Existing agent name",
    });

    abandon(deps, "pane-1", "Some other title");

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("does not set name when title is a generic agent name", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue({
      id: "t1",
      status: "active",
      name: null,
    });

    abandon(deps, "pane-1", "claude ⠋");

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  describe("agentsKilled stat", () => {
    it.each(["working", "thinking", "requires_input"])(
      "records a kill for an active agent last seen %s",
      (lastAgentStatus) => {
        deps.agentManager.getAgentByPaneId.mockReturnValue({
          id: "t1",
          status: "active",
          lastAgentStatus,
        });

        abandon(deps, "pane-1");

        expect(deps.statsStore.record).toHaveBeenCalledTimes(2);
        expect(deps.statsStore.record).toHaveBeenCalledWith("agentsKilled");
        expect(deps.statsStore.record).toHaveBeenCalledWith("agentsKilledMidThought");
      },
    );

    it("records a kill for an active agent that already responded", () => {
      deps.agentManager.getAgentByPaneId.mockReturnValue({
        id: "t1",
        status: "active",
        lastAgentStatus: "responded",
      });

      abandon(deps, "pane-1");

      expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
      expect(deps.statsStore.record).toHaveBeenCalledWith("agentsKilled");
    });

    it("does not record a kill for an active agent that never reported a status", () => {
      deps.agentManager.getAgentByPaneId.mockReturnValue({
        id: "t1",
        status: "active",
        lastAgentStatus: null,
      });

      abandon(deps, "pane-1");

      expect(deps.statsStore.record).not.toHaveBeenCalled();
    });

    it("does not record a kill for a non-active agent", () => {
      deps.agentManager.getAgentByPaneId.mockReturnValue({
        id: "t1",
        status: "completed",
        lastAgentStatus: "working",
      });

      abandon(deps, "pane-1");

      expect(deps.statsStore.record).not.toHaveBeenCalled();
    });
  });

  describe("createAgentService (what LayoutStore calls)", () => {
    it("abandons every pane's active agent, naming it by the pane's title", () => {
      deps.agentManager.getAgentByPaneId.mockImplementation((paneId: string) =>
        paneId === "pane-1" ? { id: "t1", status: "active" } : null,
      );

      createAgentService(deps as never).abandonForPanes([
        { paneId: "pane-1", title: "Fix the build ⠻" },
        { paneId: "pane-2", title: null },
      ]);

      expect(deps.agentManager.getAgentByPaneId).toHaveBeenCalledWith("pane-2");
      // The name is written here; the lifecycle is the Status reconciler's
      // (ADR-184), told by a `user` signal.
      expect(deps.agentManager.updateAgent).toHaveBeenCalledTimes(1);
      expect(deps.agentManager.updateAgent).toHaveBeenCalledWith("t1", {
        name: "Fix the build",
      });
      expect(deps.agentStatus.signal).toHaveBeenCalledTimes(1);
      expect(deps.agentStatus.signal).toHaveBeenCalledWith("pane-1", {
        type: "user",
        action: "abandon",
      });
    });

    it("keeps going past a pane whose abandonment throws", () => {
      deps.agentManager.getAgentByPaneId.mockImplementation((paneId: string) => {
        if (paneId === "pane-1") throw new Error("boom");
        return { id: "t2", status: "active" };
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      createAgentService(deps as never).abandonForPanes([
        { paneId: "pane-1" },
        { paneId: "pane-2" },
      ]);

      expect(deps.agentStatus.signal).toHaveBeenCalledWith("pane-2", {
        type: "user",
        action: "abandon",
      });
      error.mockRestore();
    });
  });
});
