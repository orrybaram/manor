/**
 * `agentsReconcileStale`.
 *
 * No `ipcMain` here any more: `agents` crossed to the handler table in
 * ADR-180 ticket 9, so this is a plain function over `IpcDeps` — the same
 * function the table calls, and a paired `full` device now reaches it the
 * same way the desktop does.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../notifications", () => ({
  updateDockBadge: vi.fn(),
  markAgentNotificationsRead: vi.fn(),
  sendAgentUpdate: vi.fn(),
  getUnseenSnapshot: vi.fn(() => ({ responded: [], requires_input: [] })),
}));

vi.mock("../ipc-validate", () => ({
  assertString: vi.fn(),
}));

import { agentsReconcileStale } from "../ipc/agents";

function makeAgent(
  overrides: Partial<{
    id: string;
    status: string;
    agentSessionId: string | null;
    paneId: string | null;
  }> = {},
) {
  return {
    id: "t1",
    status: "active",
    agentSessionId: "agent-uuid-default",
    paneId: "pane-default",
    ...overrides,
  };
}

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
    mainWindow: null,
    preferencesManager: {},
    paneContextMap: new Map(),
    unseenRespondedAgents: new Set(),
    unseenInputAgents: new Set(),
    ...overrides,
  };
}

describe("agents.reconcileStale", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("marks active agents with dead sessions as abandoned", async () => {
    deps.agentManager.getAllAgents.mockReturnValue([
      makeAgent({ id: "t1", status: "active", paneId: "pane-1" }), // dead
      makeAgent({ id: "t2", status: "active", paneId: "pane-2" }), // alive
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([{ sessionId: "pane-2" }]);

    await agentsReconcileStale(deps as never);

    expect(deps.agentManager.updateAgent).toHaveBeenCalledTimes(1);
    expect(deps.agentManager.updateAgent).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ status: "abandoned" }),
    );
    const [[, updates]] = (deps.agentManager.updateAgent as ReturnType<typeof vi.fn>).mock.calls;
    expect(updates).toHaveProperty("completedAt");
    expect(typeof updates.completedAt).toBe("string");
  });

  it("does nothing when daemon is unreachable", async () => {
    deps.backend.pty.listSessions.mockRejectedValue(new Error("ECONNREFUSED"));

    await agentsReconcileStale(deps as never);

    expect(deps.agentManager.getAllAgents).not.toHaveBeenCalled();
    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("skips agents with null paneId", async () => {
    deps.agentManager.getAllAgents.mockReturnValue([
      makeAgent({ id: "t1", status: "active", paneId: null }),
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([]);

    await agentsReconcileStale(deps as never);

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("skips non-active agents", async () => {
    deps.agentManager.getAllAgents.mockReturnValue([
      makeAgent({ id: "t1", status: "completed", paneId: "pane-1" }),
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([]);

    await agentsReconcileStale(deps as never);

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("regression: does not abandon an agent when paneId is live but agentSessionId is not", async () => {
    deps.agentManager.getAllAgents.mockReturnValue([
      makeAgent({
        id: "t1",
        status: "active",
        agentSessionId: "agent-uuid-1", // different namespace — NOT in listSessions results
        paneId: "pane-1",              // correct namespace — IS in listSessions results
      }),
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([{ sessionId: "pane-1" }]);

    await agentsReconcileStale(deps as never);

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });
});
