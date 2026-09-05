import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AgentInfo } from "../../electron.d";

// ── Mock electronAPI ──────────────────────────────────────────────────────────
// Mirrors the pattern in agent-store-pagination.test.ts: replace `electronAPI.agents`
// before importing the store, so its eager init picks up the stub.

let onUpdateCallback:
  | ((agent: AgentInfo, unseen: { responded: boolean; requires_input: boolean }) => void)
  | null = null;

const agentsApi = {
  getAll: vi.fn().mockResolvedValue([]),
  getActive: vi.fn().mockResolvedValue([]),
  getRecent: vi.fn().mockResolvedValue([]),
  getUnseen: vi.fn().mockResolvedValue({ responded: [], requires_input: [] }),
  consumePruneNotice: vi.fn().mockResolvedValue(0),
  get: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  setPaneContext: vi.fn(),
  markSeen: vi.fn(),
  markResumed: vi.fn(),
  reconcileStale: vi.fn(),
  abandonForPane: vi.fn(),
  onUpdate: vi.fn(
    (
      cb: (
        agent: AgentInfo,
        unseen: { responded: boolean; requires_input: boolean },
      ) => void,
    ) => {
      onUpdateCallback = cb;
      return () => {};
    },
  ),
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

function makeAgent(
  id: string,
  lastAgentStatus: string | null = null,
  paneId: string | null = null,
): AgentInfo {
  return {
    id,
    agentSessionId: `agent-${id}`,
    name: `Agent ${id}`,
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
    paneId,
    lastAgentStatus,
    resumedAt: null,
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("agent-store unseen-flag cache (ADR-136)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Re-prime defaults that vi.clearAllMocks erased.
    agentsApi.getAll.mockResolvedValue([]);
    agentsApi.getActive.mockResolvedValue([]);
    agentsApi.getRecent.mockResolvedValue([]);
    agentsApi.getUnseen.mockResolvedValue({ responded: [], requires_input: [] });
    agentsApi.consumePruneNotice.mockResolvedValue(0);
    onUpdateCallback = null;
  });

  it("primes unseen Sets from agents:getUnseen on init", async () => {
    agentsApi.getUnseen.mockResolvedValue({
      responded: ["t1", "t2"],
      requires_input: ["t3"],
    });

    const { useAgentStore } = await import("../agent-store");
    await flush();

    const state = useAgentStore.getState();
    expect(state.unseenRespondedAgentIds).toEqual(new Set(["t1", "t2"]));
    expect(state.unseenInputAgentIds).toEqual(new Set(["t3"]));
  });

  it("reconciles unseen Sets to broadcast flags on every agent-updated event", async () => {
    const { useAgentStore } = await import("../agent-store");
    await flush();
    expect(onUpdateCallback).not.toBeNull();

    // Status flip storm: responded -> requires_input -> responded.
    onUpdateCallback!(makeAgent("t1", "responded"), {
      responded: true,
      requires_input: false,
    });
    expect(useAgentStore.getState().unseenRespondedAgentIds.has("t1")).toBe(true);
    expect(useAgentStore.getState().unseenInputAgentIds.has("t1")).toBe(false);

    onUpdateCallback!(makeAgent("t1", "requires_input"), {
      responded: false,
      requires_input: true,
    });
    expect(useAgentStore.getState().unseenRespondedAgentIds.has("t1")).toBe(false);
    expect(useAgentStore.getState().unseenInputAgentIds.has("t1")).toBe(true);

    onUpdateCallback!(makeAgent("t1", "responded"), {
      responded: true,
      requires_input: false,
    });
    expect(useAgentStore.getState().unseenRespondedAgentIds.has("t1")).toBe(true);
    expect(useAgentStore.getState().unseenInputAgentIds.has("t1")).toBe(false);
  });

  it("markAgentSeen optimistically clears local cache and calls IPC", async () => {
    agentsApi.getUnseen.mockResolvedValue({
      responded: ["t1"],
      requires_input: ["t1"],
    });

    const { useAgentStore } = await import("../agent-store");
    await flush();

    useAgentStore.getState().markAgentSeen("t1");

    const state = useAgentStore.getState();
    expect(state.unseenRespondedAgentIds.has("t1")).toBe(false);
    expect(state.unseenInputAgentIds.has("t1")).toBe(false);
    expect(agentsApi.markSeen).toHaveBeenCalledWith("t1");
  });

  it("re-pulses on a subsequent status update after markAgentSeen", async () => {
    agentsApi.getUnseen.mockResolvedValue({
      responded: ["t1"],
      requires_input: [],
    });

    const { useAgentStore } = await import("../agent-store");
    await flush();

    // Mark seen — cache clears.
    useAgentStore.getState().markAgentSeen("t1");
    expect(useAgentStore.getState().unseenRespondedAgentIds.has("t1")).toBe(false);

    // A later broadcast (e.g. another responded after a new turn) puts the
    // agent back into the unseen Set, so the pulse predicate fires again.
    onUpdateCallback!(makeAgent("t1", "responded"), {
      responded: true,
      requires_input: false,
    });
    expect(useAgentStore.getState().unseenRespondedAgentIds.has("t1")).toBe(true);
  });

  it("leaves the cache untouched when the broadcast omits the unseen argument", async () => {
    agentsApi.getUnseen.mockResolvedValue({
      responded: ["t1"],
      requires_input: [],
    });

    const { useAgentStore } = await import("../agent-store");
    await flush();

    // Older preload — no unseen arg. Cache should not be wiped.
    onUpdateCallback!(makeAgent("t1", "responded"), undefined as never);
    expect(useAgentStore.getState().unseenRespondedAgentIds.has("t1")).toBe(true);
  });
});

/**
 * A one-panel, one-tab layout showing `visiblePaneId`, with `hiddenPaneId` (if
 * given) parked in a second, unselected tab.
 */
function layoutWith(
  visiblePaneId: string,
  hiddenPaneId?: string,
): Record<string, unknown> {
  const tabs = [
    {
      id: "tab-visible",
      title: "visible",
      rootNode: { type: "leaf", paneId: visiblePaneId },
      focusedPaneId: visiblePaneId,
    },
  ];
  if (hiddenPaneId) {
    tabs.push({
      id: "tab-hidden",
      title: "hidden",
      rootNode: { type: "leaf", paneId: hiddenPaneId },
      focusedPaneId: hiddenPaneId,
    });
  }
  return {
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: {
      "panel-1": {
        id: "panel-1",
        tabs,
        selectedTabId: "tab-visible",
        pinnedTabIds: [],
      },
    },
    activePanelId: "panel-1",
  };
}

describe("read state follows what is on screen (issue #142)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    agentsApi.getAll.mockResolvedValue([]);
    agentsApi.getActive.mockResolvedValue([]);
    agentsApi.getRecent.mockResolvedValue([]);
    agentsApi.getUnseen.mockResolvedValue({ responded: [], requires_input: [] });
    agentsApi.consumePruneNotice.mockResolvedValue(0);
    onUpdateCallback = null;
  });

  it("marks an agent seen when navigation brings its pane on screen", async () => {
    const { useAgentStore } = await import("../agent-store");
    const { useAppStore } = await import("../app-store");
    await flush();

    // Agent responds while the user is elsewhere — no active workspace at all.
    onUpdateCallback!(makeAgent("t1", "responded", "pane-1"), {
      responded: true,
      requires_input: false,
    });
    expect(useAgentStore.getState().unseenRespondedAgentIds.has("t1")).toBe(true);
    expect(agentsApi.markSeen).not.toHaveBeenCalled();

    // The user navigates to the pane by any means: the layout mutation is the
    // only signal the store needs.
    useAppStore.setState({
      activeWorkspacePath: "/ws",
      workspaceLayouts: { "/ws": layoutWith("pane-1") } as never,
    });

    expect(agentsApi.markSeen).toHaveBeenCalledWith("t1");
    expect(useAgentStore.getState().unseenRespondedAgentIds.has("t1")).toBe(false);
  });

  it("leaves an agent unseen while its pane sits in a background tab", async () => {
    const { useAgentStore } = await import("../agent-store");
    const { useAppStore } = await import("../app-store");
    await flush();

    onUpdateCallback!(makeAgent("t1", "requires_input", "pane-hidden"), {
      responded: false,
      requires_input: true,
    });

    useAppStore.setState({
      activeWorkspacePath: "/ws",
      workspaceLayouts: {
        "/ws": layoutWith("pane-visible", "pane-hidden"),
      } as never,
    });

    // The tab is mounted but not selected, so nothing has been read.
    expect(agentsApi.markSeen).not.toHaveBeenCalled();
    expect(useAgentStore.getState().unseenInputAgentIds.has("t1")).toBe(true);
  });

  it("clears unseen flags that arrive for a pane already on screen", async () => {
    // Boot order matters here: the layout is restored before the unseen
    // snapshot lands, which is the ordinary case after a relaunch.
    const { useAppStore } = await import("../app-store");
    useAppStore.setState({
      activeWorkspacePath: "/ws",
      workspaceLayouts: { "/ws": layoutWith("pane-1") } as never,
    });

    agentsApi.getActive.mockResolvedValue([
      makeAgent("t1", "responded", "pane-1"),
    ]);
    agentsApi.getUnseen.mockResolvedValue({
      responded: ["t1"],
      requires_input: [],
    });

    const { useAgentStore } = await import("../agent-store");
    await flush();

    expect(agentsApi.markSeen).toHaveBeenCalledWith("t1");
    expect(useAgentStore.getState().unseenRespondedAgentIds.has("t1")).toBe(false);
  });
});
