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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("agents:reconcileStale handler", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    deps = makeDeps();
    register(deps as never);
  });

  it("marks active agents with dead sessions as abandoned", async () => {
    deps.agentManager.getAllAgents.mockReturnValue([
      makeAgent({ id: "t1", status: "active", paneId: "pane-1" }), // dead
      makeAgent({ id: "t2", status: "active", paneId: "pane-2" }), // alive
    ]);
    // listSessions() returns pane IDs — only pane-2 is live
    deps.backend.pty.listSessions.mockResolvedValue([{ sessionId: "pane-2" }]);

    const handler = handlers.get("agents:reconcileStale")!;
    await handler({} as never);

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

    const handler = handlers.get("agents:reconcileStale")!;
    await handler({} as never);

    expect(deps.agentManager.getAllAgents).not.toHaveBeenCalled();
    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("skips agents with null paneId", async () => {
    deps.agentManager.getAllAgents.mockReturnValue([
      makeAgent({ id: "t1", status: "active", paneId: null }),
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([]);

    const handler = handlers.get("agents:reconcileStale")!;
    await handler({} as never);

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("skips non-active agents", async () => {
    deps.agentManager.getAllAgents.mockReturnValue([
      makeAgent({ id: "t1", status: "completed", paneId: "pane-1" }),
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([]);

    const handler = handlers.get("agents:reconcileStale")!;
    await handler({} as never);

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("regression: does not abandon an agent when paneId is live but agentSessionId is not", async () => {
    // This is the original namespace bug: the old code compared agentSessionId
    // against listSessions().sessionId, which actually returns pane IDs.
    // An agent with paneId "pane-1" should be considered live when listSessions()
    // returns [{ sessionId: "pane-1" }], even if agentSessionId is a different UUID.
    deps.agentManager.getAllAgents.mockReturnValue([
      makeAgent({
        id: "t1",
        status: "active",
        agentSessionId: "agent-uuid-1", // different namespace — NOT in listSessions results
        paneId: "pane-1",              // correct namespace — IS in listSessions results
      }),
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([{ sessionId: "pane-1" }]);

    const handler = handlers.get("agents:reconcileStale")!;
    await handler({} as never);

    // paneId "pane-1" is live → agent must NOT be abandoned
    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });
});
