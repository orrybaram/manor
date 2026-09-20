/**
 * `agentsAbandonForPane`.
 *
 * No `ipcMain` here any more: `agents` crossed to the handler table in
 * ADR-180 ticket 9, so this is a plain function over `IpcDeps` — the same
 * function the table calls, and a paired `full` device now reaches it the
 * same way the desktop does.
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

import { agentsAbandonForPane } from "../ipc/agents";

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
    mainWindow: null,
    preferencesManager: {},
    paneContextMap: new Map(),
    unseenRespondedAgents: new Set(),
    unseenInputAgents: new Set(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("agents.abandonForPane", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("marks the active agent for a pane as abandoned", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue({
      id: "t1",
      status: "active",
    });

    agentsAbandonForPane(deps as never, "pane-1");

    expect(deps.agentManager.updateAgent).toHaveBeenCalledTimes(1);
    expect(deps.agentManager.updateAgent).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ status: "abandoned" }),
    );
    const [[, updates]] = (deps.agentManager.updateAgent as ReturnType<typeof vi.fn>).mock.calls;
    expect(updates).toHaveProperty("completedAt");
    expect(typeof updates.completedAt).toBe("string");
  });

  it("does nothing if no agent for that pane", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue(undefined);

    agentsAbandonForPane(deps as never, "pane-99");

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("does nothing if agent is not active", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue({
      id: "t1",
      status: "completed",
    });

    agentsAbandonForPane(deps as never, "pane-1");

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("sets agent name from title when agent has no name", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue({
      id: "t1",
      status: "active",
      name: null,
    });

    agentsAbandonForPane(deps as never, "pane-1", "Fix conversation naming after slash clear command ⠻");

    expect(deps.agentManager.updateAgent).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ name: "Fix conversation naming after slash clear command" }),
    );
  });

  it("preserves existing agent name when title is also provided", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue({
      id: "t1",
      status: "active",
      name: "Existing agent name",
    });

    agentsAbandonForPane(deps as never, "pane-1", "Some other title");

    const [[, updates]] = (deps.agentManager.updateAgent as ReturnType<typeof vi.fn>).mock.calls;
    expect(updates).not.toHaveProperty("name");
  });

  it("does not set name when title is a generic agent name", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue({
      id: "t1",
      status: "active",
      name: null,
    });

    agentsAbandonForPane(deps as never, "pane-1", "claude ⠋");

    const [[, updates]] = (deps.agentManager.updateAgent as ReturnType<typeof vi.fn>).mock.calls;
    expect(updates).not.toHaveProperty("name");
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

        agentsAbandonForPane(deps as never, "pane-1");

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

      agentsAbandonForPane(deps as never, "pane-1");

      expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
      expect(deps.statsStore.record).toHaveBeenCalledWith("agentsKilled");
    });

    it("does not record a kill for an active agent that never reported a status", () => {
      deps.agentManager.getAgentByPaneId.mockReturnValue({
        id: "t1",
        status: "active",
        lastAgentStatus: null,
      });

      agentsAbandonForPane(deps as never, "pane-1");

      expect(deps.statsStore.record).not.toHaveBeenCalled();
    });

    it("does not record a kill for a non-active agent", () => {
      deps.agentManager.getAgentByPaneId.mockReturnValue({
        id: "t1",
        status: "completed",
        lastAgentStatus: "working",
      });

      agentsAbandonForPane(deps as never, "pane-1");

      expect(deps.statsStore.record).not.toHaveBeenCalled();
    });
  });
});
