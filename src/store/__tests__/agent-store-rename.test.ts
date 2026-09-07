import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AgentInfo } from "../../electron.d";

// ── Mock electronAPI ──────────────────────────────────────────────────────────
// Same shape as agent-store-unseen.test.ts: stub `electronAPI.agents` before
// the store's eager init runs.

const agentsApi = {
  getAll: vi.fn().mockResolvedValue([]),
  getActive: vi.fn().mockResolvedValue([]),
  getRecent: vi.fn().mockResolvedValue([]),
  getUnseen: vi.fn().mockResolvedValue({ responded: [], requires_input: [] }),
  consumePruneNotice: vi.fn().mockResolvedValue(0),
  get: vi.fn(),
  update: vi.fn().mockResolvedValue(null),
  delete: vi.fn(),
  setPaneContext: vi.fn(),
  markSeen: vi.fn(),
  markResumed: vi.fn(),
  reconcileStale: vi.fn(),
  abandonForPane: vi.fn(),
  onUpdate: vi.fn(() => () => {}),
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

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "a1",
    agentSessionId: "s1",
    name: "synced-title",
    status: "active",
    createdAt: "2024-01-15T00:00:00Z",
    updatedAt: "2024-01-15T00:00:00Z",
    completedAt: null,
    activatedAt: null,
    projectId: null,
    projectName: null,
    workspacePath: null,
    cwd: "/",
    agentKind: "claude",
    agentCommand: null,
    paneId: "p1",
    lastAgentStatus: null,
    resumedAt: null,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("agent-store renameAgent", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    agentsApi.getAll.mockResolvedValue([]);
    agentsApi.getActive.mockResolvedValue([]);
    agentsApi.getRecent.mockResolvedValue([]);
    agentsApi.getUnseen.mockResolvedValue({ responded: [], requires_input: [] });
    agentsApi.consumePruneNotice.mockResolvedValue(0);
    agentsApi.update.mockResolvedValue(null);
  });

  it("pins a trimmed non-empty name, optimistically and in main", async () => {
    const { useAgentStore } = await import("../agent-store");
    await flush();
    useAgentStore.setState({ agents: [makeAgent()] });

    await useAgentStore.getState().renameAgent("a1", "  Fix login  ");

    expect(useAgentStore.getState().agents[0]).toMatchObject({
      name: "Fix login",
      namePinned: true,
    });
    expect(agentsApi.update).toHaveBeenCalledWith("a1", {
      name: "Fix login",
      namePinned: true,
    });
  });

  it("clearing unpins and restores the live agent title without waiting for main", async () => {
    const { useAgentStore } = await import("../agent-store");
    const { useAppStore } = await import("../app-store");
    await flush();
    useAgentStore.setState({
      agents: [makeAgent({ name: "Fix login", namePinned: true })],
    });
    useAppStore.setState({
      paneAgentStatus: {
        p1: {
          kind: "claude",
          status: "responded",
          processName: null,
          since: 0,
          title: "✳ synced-title",
        },
      },
    });

    await useAgentStore.getState().renameAgent("a1", "   ");

    expect(useAgentStore.getState().agents[0]).toMatchObject({
      name: "synced-title",
      namePinned: false,
    });
    expect(agentsApi.update).toHaveBeenCalledWith("a1", {
      name: "synced-title",
      namePinned: false,
    });
  });

  it("clearing with no usable live title falls back to null", async () => {
    const { useAgentStore } = await import("../agent-store");
    const { useAppStore } = await import("../app-store");
    await flush();
    useAgentStore.setState({
      agents: [makeAgent({ name: "Fix login", namePinned: true })],
    });
    useAppStore.setState({
      paneAgentStatus: {
        p1: { kind: "claude", status: "responded", processName: null, since: 0, title: "claude" },
      },
    });

    await useAgentStore.getState().renameAgent("a1", "");

    expect(useAgentStore.getState().agents[0]).toMatchObject({
      name: null,
      namePinned: false,
    });
  });

  it("keeps the optimistic name when main rejects the write", async () => {
    agentsApi.update.mockRejectedValue(new Error("nope"));
    const { useAgentStore } = await import("../agent-store");
    await flush();
    useAgentStore.setState({ agents: [makeAgent()] });

    await expect(
      useAgentStore.getState().renameAgent("a1", "Fix login"),
    ).resolves.toBeUndefined();
    expect(useAgentStore.getState().agents[0].name).toBe("Fix login");
  });
});
