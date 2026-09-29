import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore, selectCurrentLocation } from "../app-store";
import type { WorkspaceLayout, Tab, Panel, ClosedPaneSnapshot } from "../app-store";
import type { PersistedLayout } from "../../electron.d";
import type { DetachedTabPayload } from "../detach-types";
import { HOME_PATH } from "../../lib/home-path";
import type { WorkspaceKey } from "../../lib/workspace-key";

// window is provided by the setup file (src/store/__tests__/setup.ts)

const WS_PATH = "/test/workspace";

function makeLayout(prefix: string): WorkspaceLayout {
  const tab: Tab = {
    id: `${prefix}-tab`,
    title: "Terminal",
    rootNode: { type: "leaf", paneId: `${prefix}-pane` },
    focusedPaneId: `${prefix}-pane`,
  };
  const panel: Panel = {
    id: `${prefix}-panel`,
    tabs: [tab],
    selectedTabId: tab.id,
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId: panel.id },
    panels: { [panel.id]: panel },
    activePanelId: panel.id,
  };
}

function payloadFrom(sourceWorkspaceKey: string): DetachedTabPayload {
  return {
    tab: {
      id: "incoming-tab",
      title: "Terminal",
      rootNode: { type: "leaf", paneId: "incoming-pane" },
      focusedPaneId: "incoming-pane",
    },
    paneState: {
      cwd: {},
      title: {},
      contentType: {},
      url: {},
      favicon: {},
      agentStatus: {},
      audioPlaying: {},
      audioMuted: {},
      pickedElement: {},
    },
    sourceWorkspaceKey: sourceWorkspaceKey as WorkspaceKey,
    themeName: null,
  };
}

const homeSnapshot: ClosedPaneSnapshot = {
  kind: "pane",
  paneId: "closed-pane",
  tabId: "home-tab",
  panelId: "home-panel",
  workspaceKey: HOME_PATH as WorkspaceKey,
};

/**
 * Home active, with a stale layout keyed to it and a closed-pane snapshot for
 * it — the worst case: even with something to act on, the central guard must
 * keep every creation path a no-op.
 */
function seedHome() {
  useAppStore.setState({
    activeWorkspacePath: HOME_PATH,
    activeWorkspaceHostId: "local",
    activeSurface: "workspace",
    workspaceLayouts: {
      [HOME_PATH]: makeLayout("home"),
      [WS_PATH]: makeLayout("ws"),
    },
    closedPaneStack: [homeSnapshot],
    paneContentType: {},
    paneUrl: {},
    pendingPaneCommands: {},
  });
}

describe("Home holds no tabs (ADR-197 §1)", () => {
  beforeEach(() => seedHome());

  const noOps: Array<[string, () => unknown]> = [
    ["addTab", () => useAppStore.getState().addTab()],
    ["addTerminalTab", () => useAppStore.getState().addTerminalTab("echo hi")],
    ["addBrowserTab", () => useAppStore.getState().addBrowserTab("https://example.com")],
    ["addDiffTab", () => useAppStore.getState().addDiffTab()],
    ["duplicateTab", () => useAppStore.getState().duplicateTab("home-tab")],
    ["openOrFocusDiff", () => useAppStore.getState().openOrFocusDiff()],
    ["openDiffInNewPanel", () => useAppStore.getState().openDiffInNewPanel()],
    ["splitPane", () => useAppStore.getState().splitPane("horizontal")],
    [
      "splitPaneAt",
      () => useAppStore.getState().splitPaneAt("home-pane", "horizontal", "second"),
    ],
    ["splitPanel", () => useAppStore.getState().splitPanel("horizontal")],
    ["reopenClosedPane", () => useAppStore.getState().reopenClosedPane()],
    [
      "receiveReattachedTab",
      () => useAppStore.getState().receiveReattachedTab(payloadFrom(WS_PATH)),
    ],
  ];

  for (const [name, run] of noOps) {
    it(`${name} leaves state unchanged`, () => {
      const before = useAppStore.getState();
      run();
      const after = useAppStore.getState();
      expect(after.workspaceLayouts).toBe(before.workspaceLayouts);
      expect(after.closedPaneStack).toBe(before.closedPaneStack);
      expect(after.pendingPaneCommands).toBe(before.pendingPaneCommands);
      expect(after.paneContentType).toBe(before.paneContentType);
    });
  }

  it("the creators that return a tab return null", () => {
    expect(useAppStore.getState().addTab()).toBeNull();
    expect(useAppStore.getState().addTerminalTab("echo hi")).toBeNull();
    expect(useAppStore.getState().addBrowserTab("https://example.com")).toBeNull();
  });
});

describe("setActiveWorkspace(HOME_PATH)", () => {
  beforeEach(() => {
    useAppStore.setState({
      activeWorkspacePath: WS_PATH,
      activeWorkspaceHostId: "local",
      activeSurface: "workspace",
      workspaceLayouts: { [WS_PATH]: makeLayout("ws") },
    });
  });

  it("makes Home active without creating a layout for it", () => {
    useAppStore.getState().setActiveWorkspace(HOME_PATH);
    const state = useAppStore.getState();
    expect(state.activeWorkspacePath).toBe(HOME_PATH);
    expect(state.workspaceLayouts[HOME_PATH]).toBeUndefined();
    expect(state.workspaceLayouts[WS_PATH]).toBeDefined();
  });

  it("reports the home surface for navigation history", () => {
    useAppStore.getState().setActiveWorkspace(HOME_PATH);
    expect(selectCurrentLocation(useAppStore.getState())).toEqual({
      kind: "surface",
      surface: "home",
    });
  });
});

describe("hydrateDetachedTab", () => {
  it("refuses a tab from Home", () => {
    useAppStore.setState({ workspaceLayouts: {}, activeWorkspacePath: null });
    useAppStore.getState().hydrateDetachedTab(payloadFrom(HOME_PATH));
    const state = useAppStore.getState();
    expect(state.workspaceLayouts).toEqual({});
    expect(state.activeWorkspacePath).toBeNull();
  });
});

describe("loadPersistedLayout drops a persisted Home layout (ADR-197 §2)", () => {
  const OTHER = "/test/other";

  function persistedWorkspace(path: string, prefix: string) {
    const paneId = `${prefix}-pane`;
    const browserId = `${prefix}-browser`;
    return {
      workspacePath: path as WorkspaceKey,
      panelTree: { type: "leaf" as const, panelId: `${prefix}-panel` },
      activePanelId: `${prefix}-panel`,
      panels: {
        [`${prefix}-panel`]: {
          id: `${prefix}-panel`,
          selectedTabId: `${prefix}-tab`,
          pinnedTabIds: [],
          tabs: [
            {
              id: `${prefix}-tab`,
              title: "Terminal",
              rootNode: {
                type: "split" as const,
                direction: "horizontal" as const,
                ratio: 0.5,
                first: { type: "leaf" as const, paneId },
                second: {
                  type: "leaf" as const,
                  paneId: browserId,
                  contentType: "browser" as const,
                  url: "https://example.com",
                },
              },
              focusedPaneId: paneId,
              paneSessions: {
                [paneId]: { daemonSessionId: paneId, lastCwd: `/cwd/${prefix}`, lastTitle: `${prefix} title` },
              },
            },
          ],
        },
      },
    };
  }

  let ptyClose: ReturnType<typeof vi.fn>;
  let abandon: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    ptyClose = vi.fn().mockResolvedValue(undefined);
    abandon = vi.fn().mockResolvedValue(undefined);
    const api = window.electronAPI as unknown as Record<string, Record<string, unknown>>;
    api.pty = { ...(api.pty ?? {}), close: ptyClose };
    api.agents = { ...api.agents, abandonForPane: abandon };
    const layout: PersistedLayout = {
      version: 3,
      workspaces: [persistedWorkspace(HOME_PATH, "home"), persistedWorkspace(OTHER, "other")],
      lastActiveWorkspacePath: HOME_PATH,
    };
    (window.electronAPI.layout.load as ReturnType<typeof vi.fn>).mockResolvedValueOnce(layout);
    useAppStore.setState({
      workspaceLayouts: {},
      activeWorkspacePath: null,
      paneCwd: {},
      paneTitle: {},
      paneContentType: {},
      paneUrl: {},
    });
    await useAppStore.getState().loadPersistedLayout();
  });

  it("does not restore a layout for Home", () => {
    useAppStore.getState().setActiveWorkspace(HOME_PATH);
    expect(useAppStore.getState().workspaceLayouts[HOME_PATH]).toBeUndefined();
  });

  it("still restores other workspaces", () => {
    useAppStore.getState().setActiveWorkspace(OTHER);
    expect(useAppStore.getState().workspaceLayouts[OTHER]?.panels["other-panel"]?.tabs).toHaveLength(1);
  });

  it("does not prime pane metadata from the Home layout", () => {
    const state = useAppStore.getState();
    expect(state.paneCwd["home-pane"]).toBeUndefined();
    expect(state.paneUrl["home-browser"]).toBeUndefined();
    expect(state.paneCwd["other-pane"]).toBe("/cwd/other");
  });

  it("ends the Home panes' sessions and nothing else", () => {
    expect(ptyClose).toHaveBeenCalledTimes(1);
    expect(ptyClose).toHaveBeenCalledWith("home-pane");
    expect(abandon).toHaveBeenCalledWith("home-pane", "home title");
    expect(abandon).toHaveBeenCalledWith("home-browser", null);
    expect(abandon).not.toHaveBeenCalledWith("other-pane", expect.anything());
  });
});
