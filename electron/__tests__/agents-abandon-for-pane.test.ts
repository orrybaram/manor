import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock electron ──────────────────────────────────────────────────────────────
const handlers: Map<string, (...args: unknown[]) => unknown> = new Map();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

// ── Mock notifications ─────────────────────────────────────────────────────────
vi.mock("../notifications", () => ({
  updateDockBadge: vi.fn(),
  markAgentNotificationsRead: vi.fn(),
  sendAgentUpdate: vi.fn(),
  getUnseenSnapshot: vi.fn(() => ({ responded: [], requires_input: [] })),
}));

// ── Mock ipc-validate ──────────────────────────────────────────────────────────
vi.mock("../ipc-validate", () => ({
  assertString: vi.fn(),
}));

import { register } from "../ipc/agents";

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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("agents:abandonForPane handler", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    deps = makeDeps();
    register(deps as never);
  });

  it("sends the reconciler an abandon signal and writes no status itself", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue({
      id: "t1",
      agentSessionId: "s1",
      status: "active",
    });

    const handler = handlers.get("agents:abandonForPane")!;
    handler({} as never, "pane-1");

    expect(deps.agentStatus.signal).toHaveBeenCalledTimes(1);
    expect(deps.agentStatus.signal).toHaveBeenCalledWith("pane-1", {
      type: "user",
      action: "abandon",
    });
    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("does nothing if no agent for that pane", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue(undefined);

    const handler = handlers.get("agents:abandonForPane")!;
    handler({} as never, "pane-99");

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
    expect(deps.agentStatus.signal).not.toHaveBeenCalled();
  });

  it("does nothing if agent is not active", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue({
      id: "t1",
      status: "completed",
    });

    const handler = handlers.get("agents:abandonForPane")!;
    handler({} as never, "pane-1");

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
    expect(deps.agentStatus.signal).not.toHaveBeenCalled();
  });

  it("sets agent name from title when agent has no name", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue({
      id: "t1",
      status: "active",
      name: null,
    });

    const handler = handlers.get("agents:abandonForPane")!;
    handler({} as never, "pane-1", "Fix conversation naming after slash clear command ⠻");

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

    const handler = handlers.get("agents:abandonForPane")!;
    handler({} as never, "pane-1", "Some other title");

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("does not set name when title is a generic agent name", () => {
    deps.agentManager.getAgentByPaneId.mockReturnValue({
      id: "t1",
      status: "active",
      name: null,
    });

    const handler = handlers.get("agents:abandonForPane")!;
    handler({} as never, "pane-1", "claude ⠋");

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

        const handler = handlers.get("agents:abandonForPane")!;
        handler({} as never, "pane-1");

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

      const handler = handlers.get("agents:abandonForPane")!;
      handler({} as never, "pane-1");

      expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
      expect(deps.statsStore.record).toHaveBeenCalledWith("agentsKilled");
    });

    it("does not record a kill for an active agent that never reported a status", () => {
      deps.agentManager.getAgentByPaneId.mockReturnValue({
        id: "t1",
        status: "active",
        lastAgentStatus: null,
      });

      const handler = handlers.get("agents:abandonForPane")!;
      handler({} as never, "pane-1");

      expect(deps.statsStore.record).not.toHaveBeenCalled();
    });

    it("does not record a kill for a non-active agent", () => {
      deps.agentManager.getAgentByPaneId.mockReturnValue({
        id: "t1",
        status: "completed",
        lastAgentStatus: "working",
      });

      const handler = handlers.get("agents:abandonForPane")!;
      handler({} as never, "pane-1");

      expect(deps.statsStore.record).not.toHaveBeenCalled();
    });
  });
});
