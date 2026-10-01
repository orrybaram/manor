import { describe, it, expect, beforeEach, vi } from "vitest";

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

import { agentsReconcileStale } from "../bridge/handlers/agents";
import { localCtx } from "../bridge/method";
import { LOCAL_HOST_ID } from "../backend/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeAgent(
  overrides: Partial<{
    id: string;
    status: string;
    agentSessionId: string | null;
    paneId: string | null;
    hostId: string;
    projectId: string | null;
  }> = {},
) {
  return {
    id: "t1",
    status: "active",
    agentSessionId: "agent-uuid-default",
    paneId: "pane-default",
    hostId: LOCAL_HOST_ID,
    projectId: null,
    ...overrides,
  };
}

/** Pane id → the host that owns its session (`SessionOwners`). */
const paneOwners = new Map<string, string>();

/**
 * An `HostDeps`-shaped fixture (ADR-183): every field `bridge/handlers/agents.ts`
 * reaches, including the pane owners and host status
 * `isAgentHostConnected` reads — rather than a bag the handler had to
 * guard against being partial.
 */
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
    backendRegistry: {
      status: vi.fn().mockReturnValue("connected"),
    },
    getPaneHostId: (paneId: string) => paneOwners.get(paneId),
    // The Status reconciler's driver (ADR-184).
    agentStatus: {
      signal: vi.fn(() => ({ effects: [] })),
      isPaneLossExpected: vi.fn((_paneId: string) => false),
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
    paneOwners.clear();
    deps = makeDeps();
  });

  it("sends an abandon signal for active agents with dead sessions", async () => {
    deps.agentManager.getAllAgents.mockReturnValue([
      makeAgent({ id: "t1", status: "active", paneId: "pane-1" }), // dead
      makeAgent({ id: "t2", status: "active", paneId: "pane-2" }), // alive
    ]);
    // listSessions() returns pane IDs — only pane-2 is live
    deps.backend.pty.listSessions.mockResolvedValue([{ sessionId: "pane-2" }]);

    await agentsReconcileStale(localCtx(deps as never));

    // The reconciler writes the lifecycle (ADR-184); the handler does not.
    expect(deps.agentStatus.signal).toHaveBeenCalledTimes(1);
    expect(deps.agentStatus.signal).toHaveBeenCalledWith("pane-1", {
      type: "user",
      action: "abandon",
    });
    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("skips an agent whose pane a daemon replacement just killed (ADR-185 §A)", async () => {
    deps.agentManager.getAllAgents.mockReturnValue([
      makeAgent({ id: "t1", status: "active", paneId: "pane-1" }), // replaced
      makeAgent({ id: "t2", status: "active", paneId: "pane-2" }), // dead
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([]);
    deps.agentStatus.isPaneLossExpected.mockImplementation((paneId) => paneId === "pane-1");

    await agentsReconcileStale(localCtx(deps as never));

    // Left active with its pane, for the cold restore to resume.
    expect(deps.agentStatus.signal).toHaveBeenCalledTimes(1);
    expect(deps.agentStatus.signal).toHaveBeenCalledWith("pane-2", {
      type: "user",
      action: "abandon",
    });
  });

  it("does nothing when daemon is unreachable", async () => {
    deps.backend.pty.listSessions.mockRejectedValue(new Error("ECONNREFUSED"));

    await agentsReconcileStale(localCtx(deps as never));

    expect(deps.agentManager.getAllAgents).not.toHaveBeenCalled();
    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
    expect(deps.agentStatus.signal).not.toHaveBeenCalled();
  });

  it("skips agents with null paneId", async () => {
    deps.agentManager.getAllAgents.mockReturnValue([
      makeAgent({ id: "t1", status: "active", paneId: null }),
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([]);

    await agentsReconcileStale(localCtx(deps as never));

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
    expect(deps.agentStatus.signal).not.toHaveBeenCalled();
  });

  it("skips non-active agents", async () => {
    deps.agentManager.getAllAgents.mockReturnValue([
      makeAgent({ id: "t1", status: "completed", paneId: "pane-1" }),
    ]);
    deps.backend.pty.listSessions.mockResolvedValue([]);

    await agentsReconcileStale(localCtx(deps as never));

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
    expect(deps.agentStatus.signal).not.toHaveBeenCalled();
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

    await agentsReconcileStale(localCtx(deps as never));

    // paneId "pane-1" is live → agent must NOT be abandoned
    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
    expect(deps.agentStatus.signal).not.toHaveBeenCalled();
  });
});

describe("agents:reconcileStale host connectivity (ADR-191 §5)", () => {
  let deps: ReturnType<typeof makeDeps>;
  const reconcile = () => agentsReconcileStale(localCtx(deps as never));
  const abandoned = () => deps.agentStatus.signal.mock.calls.map((c) => (c as unknown[])[0]);

  beforeEach(() => {
    paneOwners.clear();
    deps = makeDeps();
    // The box has dropped: none of its sessions are listed.
    deps.backendRegistry.status.mockImplementation((hostId: string) =>
      hostId === "box" ? "disconnected" : "connected",
    );
    deps.backend.pty.listSessions.mockResolvedValue([]);
  });

  it("keeps a remote agent when its host drops, and abandons a dead local one in the same repo", async () => {
    // Both agents belong to one project: judging by the project's host (the
    // bug) gives them the same answer.
    paneOwners.set("pane-remote", "box");
    paneOwners.set("pane-local", LOCAL_HOST_ID);
    deps.agentManager.getAllAgents.mockReturnValue([
      makeAgent({ id: "remote", paneId: "pane-remote", hostId: "box", projectId: "app" }),
      makeAgent({ id: "local", paneId: "pane-local", hostId: LOCAL_HOST_ID, projectId: "app" }),
    ]);

    await reconcile();

    expect(abandoned()).toEqual(["pane-local"]);
  });

  it("follows the pane's session owner over the agent's recorded host", async () => {
    // Recorded local, but its pane moved to the box (ADR-183), which dropped.
    paneOwners.set("pane-to-box", "box");
    // Recorded on the box, but its pane now runs locally, and is gone.
    paneOwners.set("pane-to-local", LOCAL_HOST_ID);
    deps.agentManager.getAllAgents.mockReturnValue([
      makeAgent({ id: "a", paneId: "pane-to-box", hostId: LOCAL_HOST_ID }),
      makeAgent({ id: "b", paneId: "pane-to-local", hostId: "box" }),
    ]);

    await reconcile();

    expect(abandoned()).toEqual(["pane-to-local"]);
  });

  it("uses the recorded host for a pane no host has claimed yet", async () => {
    // After a restart the box never connected, so nothing claimed its panes.
    deps.agentManager.getAllAgents.mockReturnValue([
      makeAgent({ id: "remote", paneId: "pane-remote", hostId: "box" }),
      makeAgent({ id: "local", paneId: "pane-local", hostId: LOCAL_HOST_ID }),
    ]);

    await reconcile();

    expect(abandoned()).toEqual(["pane-local"]);
  });
});
