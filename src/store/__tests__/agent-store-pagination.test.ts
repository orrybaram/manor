import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AgentInfo } from "../../electron.d";

// ── Mock electronAPI ──────────────────────────────────────────────────────────
// The vitest setup file (src/store/__tests__/setup.ts) defines a minimal
// `window.electronAPI`. We replace `agents` with a fully-stubbed object before
// the agent-store module is imported, so its eager init picks up the stub.

const agentsApi = {
  getAll: vi.fn(),
  getActive: vi.fn(),
  getRecent: vi.fn(),
  getUnseen: vi.fn().mockResolvedValue({ responded: [], requires_input: [] }),
  consumePruneNotice: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  setPaneContext: vi.fn(),
  markSeen: vi.fn(),
  markResumed: vi.fn(),
  reconcileStale: vi.fn(),
  abandonForPane: vi.fn(),
  onUpdate: vi.fn(),
};

const notificationsApi = {
  getAll: vi.fn().mockResolvedValue([]),
  onChanged: vi.fn(() => () => {}),
  onNavigate: vi.fn(() => () => {}),
};

(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
  ...((window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI ?? {}),
  agents: agentsApi,
  notifications: notificationsApi,
};

function makeAgent(id: string, createdAt: string, status: AgentInfo["status"] = "active"): AgentInfo {
  return {
    id,
    agentSessionId: `agent-${id}`,
    name: `Agent ${id}`,
    status,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    activatedAt: null,
    projectId: null,
    projectName: null,
    workspacePath: null,
    cwd: "/",
    agentKind: "claude",
    agentCommand: null,
    paneId: null,
    lastAgentStatus: null,
    resumedAt: null,
  };
}

function makePage(prefix: string, count: number): AgentInfo[] {
  return Array.from({ length: count }, (_, i) => {
    // Newer indices first (descending createdAt)
    const ts = new Date(2024, 0, 100 - i, 0, 0, 0).toISOString();
    return makeAgent(`${prefix}-${i}`, ts);
  });
}

describe("agent-store pagination (ADR-136)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    agentsApi.consumePruneNotice.mockResolvedValue(0);
  });

  it("merges agents:getActive and agents:getAll, dedupes overlap, sorts desc", async () => {
    const active = [makeAgent("a1", "2024-01-15T00:00:00Z", "active")];
    const recentPage = [
      makeAgent("a1", "2024-01-15T00:00:00Z", "active"), // overlap with active
      makeAgent("c1", "2024-01-10T00:00:00Z", "completed"),
      makeAgent("c2", "2024-01-05T00:00:00Z", "completed"),
    ];
    agentsApi.getActive.mockResolvedValue(active);
    agentsApi.getAll.mockResolvedValue(recentPage);

    const { useAgentStore } = await import("../agent-store");

    // Wait one tick for the async init to resolve.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const state = useAgentStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.agents.map((t) => t.id)).toEqual(["a1", "c1", "c2"]);
    expect(agentsApi.getActive).toHaveBeenCalledTimes(1);
    expect(agentsApi.getAll).toHaveBeenCalledWith({ limit: 100, offset: 0 });
  });

  it("sets hasMore=true when initial getAll returns a full page", async () => {
    agentsApi.getActive.mockResolvedValue([]);
    agentsApi.getAll.mockResolvedValue(makePage("p", 100));

    const { useAgentStore } = await import("../agent-store");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(useAgentStore.getState().hasMore).toBe(true);
  });

  it("sets hasMore=false when initial getAll returns a partial page", async () => {
    agentsApi.getActive.mockResolvedValue([]);
    agentsApi.getAll.mockResolvedValue(makePage("p", 7));

    const { useAgentStore } = await import("../agent-store");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(useAgentStore.getState().hasMore).toBe(false);
  });

  it("loadMoreAgents coalesces concurrent calls and only fires once", async () => {
    agentsApi.getActive.mockResolvedValue([]);
    agentsApi.getAll.mockResolvedValueOnce(makePage("p", 100));

    const { useAgentStore } = await import("../agent-store");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(useAgentStore.getState().hasMore).toBe(true);

    // Second batch (the load-more page).
    agentsApi.getAll.mockResolvedValueOnce(makePage("q", 5));

    const store = useAgentStore.getState();
    // Fire three overlapping calls — only one should reach the API.
    const calls = [
      store.loadMoreAgents(100),
      store.loadMoreAgents(100),
      store.loadMoreAgents(100),
    ];
    await Promise.all(calls);

    // Initial getAll + one load-more call = 2 total
    expect(agentsApi.getAll).toHaveBeenCalledTimes(2);
    expect(agentsApi.getAll).toHaveBeenLastCalledWith({ offset: 100, limit: 100 });
    expect(useAgentStore.getState().hasMore).toBe(false);
  });

  it("loadMoreAgents short-circuits when hasMore is false", async () => {
    agentsApi.getActive.mockResolvedValue([]);
    agentsApi.getAll.mockResolvedValue(makePage("p", 7)); // partial page → hasMore=false

    const { useAgentStore } = await import("../agent-store");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(useAgentStore.getState().hasMore).toBe(false);
    const callsBefore = agentsApi.getAll.mock.calls.length;

    await useAgentStore.getState().loadMoreAgents(7);
    expect(agentsApi.getAll.mock.calls.length).toBe(callsBefore);
  });
});
