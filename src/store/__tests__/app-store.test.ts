import { describe, it, expect, beforeEach } from "vitest";
import {
  useAppStore,
  selectActivePanelId,
  selectActiveWorkspace,
  selectFocusedPaneId,
  selectSelectedTabId,
  selectWebviewFocusVisible,
} from "../app-store";
import type { Tab, Panel, WorkspaceLayout } from "../app-store";
import { allPaneIds } from "../../lib/layout/pane-tree";
import { emptyViewport, reconcileViewport } from "../../lib/layout/viewport";
import {
  broadcastLayout,
  queuedCommands,
  removeWorkspace,
  resetFakeLayoutServer,
  seedLayout,
  sentCommands,
  serverCalls,
} from "./fake-layout-server";

// window is provided by the setup file (src/store/__tests__/setup.ts)
// with a minimal electronAPI mock. No additional stubbing needed here.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_PATH = "/test/workspace";

/** Build a minimal workspace layout with known IDs for predictable assertions. */
function makeLayout(overrides?: Partial<WorkspaceLayout>): WorkspaceLayout {
  const panelId = "panel-1";
  const paneId = "pane-1";
  const tabId = "tab-1";
  const tab: Tab = {
    id: tabId,
    title: "Terminal",
    rootNode: { type: "leaf", paneId },
  };
  const panel: Panel = {
    id: panelId,
    tabs: [tab],
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId },
    panels: { [panelId]: panel },
    ...overrides,
  };
}

function makeTwoTabLayout(): WorkspaceLayout {
  const panelId = "panel-1";
  const tab1: Tab = {
    id: "tab-1",
    title: "Tab 1",
    rootNode: { type: "leaf", paneId: "pane-1" },
  };
  const tab2: Tab = {
    id: "tab-2",
    title: "Tab 2",
    rootNode: { type: "leaf", paneId: "pane-2" },
  };
  return {
    panelTree: { type: "leaf", panelId },
    panels: {
      [panelId]: {
        id: panelId,
        tabs: [tab1, tab2],
        pinnedTabIds: [],
      },
    },
  };
}

function makeThreeTabLayout(): WorkspaceLayout {
  const panelId = "panel-1";
  const tabs: Tab[] = [1, 2, 3].map((n) => ({
    id: `tab-${n}`,
    title: `Tab ${n}`,
    rootNode: { type: "leaf" as const, paneId: `pane-${n}` },
  }));
  return {
    panelTree: { type: "leaf", panelId },
    panels: {
      [panelId]: {
        id: panelId,
        tabs,
        pinnedTabIds: [],
      },
    },
  };
}

function makeTwoPanelLayout(): WorkspaceLayout {
  const tab1: Tab = {
    id: "tab-1",
    title: "Tab 1",
    rootNode: { type: "leaf", paneId: "pane-1" },
  };
  const tab2: Tab = {
    id: "tab-2",
    title: "Tab 2",
    rootNode: { type: "leaf", paneId: "pane-2" },
  };
  return {
    panelTree: {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", panelId: "panel-1" },
      second: { type: "leaf", panelId: "panel-2" },
    },
    panels: {
      "panel-1": {
        id: "panel-1",
        tabs: [tab1],
        pinnedTabIds: [],
      },
      "panel-2": {
        id: "panel-2",
        tabs: [tab2],
        pinnedTabIds: [],
      },
    },
  };
}

/**
 * Set up the store with a known workspace layout — and give the Manor server
 * the same one, since that is where every layout action now lands (ADR-179
 * D1). The store's copy is a replica of it.
 */
function setupStore(layout?: WorkspaceLayout) {
  resetFakeLayoutServer();
  const start = layout ?? makeLayout();
  seedLayout(WS_PATH, start);
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: { [WS_PATH]: start },
    // The selection is this renderer's, and a freshly seeded layout gets the
    // one `reconcileViewport` would have written: first panel, first tab,
    // first pane (ADR-179 D3).
    viewports: { [WS_PATH]: reconcileViewport(start, emptyViewport()) },
    layoutVersions: {},
    serverLayouts: {},
    paneCwd: {},
    paneTitle: {},
    paneAgentStatus: {},
    paneContentType: {},
    paneUrl: {},
    panePickedElement: {},
    pendingCloseConfirmPaneId: null,
    pendingCloseConfirmTabId: null,
    webviewFocusedPaneId: null,
  });
}

function getLayout(): WorkspaceLayout {
  return useAppStore.getState().workspaceLayouts[WS_PATH];
}

function getActivePanel(): Panel {
  const layout = getLayout();
  return layout.panels[selectActivePanelId(useAppStore.getState())!];
}

/** This renderer's selected tab, in the active panel unless told otherwise. */
function selectedTabId(panelId?: string): string | null {
  const state = useAppStore.getState();
  return selectSelectedTabId(state, panelId ?? selectActivePanelId(state));
}

/** This renderer's focused pane, in the selected tab unless told otherwise. */
function focusedPaneId(tabId?: string): string | null {
  return selectFocusedPaneId(useAppStore.getState(), tabId ?? selectedTabId());
}

/** The tab the active panel is showing. */
function activeTab(): Tab {
  const panel = getActivePanel();
  return panel.tabs.find((t) => t.id === selectedTabId(panel.id))!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tab operations", () => {
  beforeEach(() => setupStore());

  it("addTab creates a new tab in the active panel with a single leaf pane", () => {
    const panelBefore = getActivePanel();
    expect(panelBefore.tabs).toHaveLength(1);

    useAppStore.getState().addTab();

    const panel = getActivePanel();
    expect(panel.tabs).toHaveLength(2);
    const newTab = panel.tabs[1];
    expect(newTab.rootNode.type).toBe("leaf");
    expect(selectedTabId()).toBe(newTab.id);
  });

  it("closeTab removes the tab", () => {
    // Start with two tabs so closing one does not remove the panel
    setupStore(makeTwoTabLayout());
    useAppStore.getState().closeTab("tab-1");

    const panel = getActivePanel();
    expect(panel.tabs).toHaveLength(1);
    expect(panel.tabs[0].id).toBe("tab-2");
    expect(selectedTabId()).toBe("tab-2");
  });

  it("closeTab on the only tab in a multi-panel layout removes the panel", () => {
    setupStore(makeTwoPanelLayout());
    // Make panel-1 the active panel (it already is), close its only tab
    useAppStore.getState().closeTab("tab-1");

    const layout = getLayout();
    // panel-1 should be removed since it was the only tab
    expect(layout.panels["panel-1"]).toBeUndefined();
    expect(Object.keys(layout.panels)).toHaveLength(1);
    expect(layout.panels["panel-2"]).toBeDefined();
  });

  it("selectTab moves this renderer's selection and nothing else", () => {
    setupStore(makeTwoTabLayout());
    const before = getLayout();

    useAppStore.getState().selectTab("tab-2");

    expect(selectedTabId()).toBe("tab-2");
    // Viewport only: no command, so the shared structure is untouched (D3).
    expect(getLayout()).toBe(before);
  });

  it("selectNextTab wraps around", () => {
    setupStore(makeThreeTabLayout());
    // Currently on tab-1, select tab-3 first
    useAppStore.getState().selectTab("tab-3");
    useAppStore.getState().selectNextTab();

    // Should wrap around to tab-1
    expect(selectedTabId()).toBe("tab-1");
  });

  it("selectPrevTab wraps around", () => {
    setupStore(makeThreeTabLayout());
    // Currently on tab-1
    useAppStore.getState().selectPrevTab();

    // Should wrap to tab-3
    expect(selectedTabId()).toBe("tab-3");
  });

  it("togglePinTab adds tab to pinnedTabIds", () => {
    setupStore(makeTwoTabLayout());
    useAppStore.getState().togglePinTab("tab-1");

    const panel = getActivePanel();
    expect(panel.pinnedTabIds).toContain("tab-1");
  });

  it("togglePinTab removes tab from pinnedTabIds when already pinned", () => {
    setupStore(makeTwoTabLayout());
    useAppStore.getState().togglePinTab("tab-1");
    useAppStore.getState().togglePinTab("tab-1");

    const panel = getActivePanel();
    expect(panel.pinnedTabIds).not.toContain("tab-1");
  });
});

describe("Pane operations", () => {
  beforeEach(() => setupStore());

  it("splitPane('horizontal') splits the focused pane creating a split node", () => {
    useAppStore.getState().splitPane("horizontal");

    const tab = activeTab();
    expect(tab.rootNode.type).toBe("split");
    if (tab.rootNode.type === "split") {
      expect(tab.rootNode.direction).toBe("horizontal");
      expect(tab.rootNode.first.type).toBe("leaf");
      expect(tab.rootNode.second.type).toBe("leaf");
      // The command's hint came back to its sender and moved the focus here.
      if (tab.rootNode.second.type === "leaf") {
        expect(focusedPaneId()).toBe(tab.rootNode.second.paneId);
      }
    }
  });

  it("splitPane('vertical') splits the focused pane vertically", () => {
    useAppStore.getState().splitPane("vertical");

    const tab = activeTab();
    expect(tab.rootNode.type).toBe("split");
    if (tab.rootNode.type === "split") {
      expect(tab.rootNode.direction).toBe("vertical");
    }
  });

  it("closePane removes pane from tree; if last pane in tab, closes tab", () => {
    // Split first so we have two panes, then close one
    useAppStore.getState().splitPane("horizontal");

    const paneIds = allPaneIds(activeTab().rootNode);
    expect(paneIds).toHaveLength(2);

    // Close the focused pane (second one after split)
    useAppStore.getState().closePane();

    expect(allPaneIds(activeTab().rootNode)).toHaveLength(1);
  });

  it("closePane on last pane in only tab closes the tab", () => {
    // Single pane tab - closing it should close the tab
    // Need two tabs so we can observe the tab being removed
    setupStore(makeTwoTabLayout());
    useAppStore.getState().selectTab("tab-1");

    useAppStore.getState().closePane();

    const panel = getActivePanel();
    expect(panel.tabs.find((t) => t.id === "tab-1")).toBeUndefined();
    expect(selectedTabId()).toBe("tab-2");
  });

  it("reopenClosedPane puts back what the last close took", () => {
    setupStore(makeTwoTabLayout());
    useAppStore.getState().selectTab("tab-1");

    useAppStore.getState().closeTab("tab-1");
    expect(getActivePanel().tabs).toHaveLength(1);

    // The stack is the server's (ADR-179 D3): the command pops it, and the
    // broadcast is what puts the tab back here.
    useAppStore.getState().reopenClosedPane();

    const panel = getActivePanel();
    expect(panel.tabs).toHaveLength(2);
    expect(panel.tabs.some((t) => t.id === "tab-1")).toBe(true);
  });

  it("focusPane updates focusedPaneId", () => {
    useAppStore.getState().splitPane("horizontal");

    const paneIds = allPaneIds(activeTab().rootNode);
    const originalPane = paneIds[0]; // pane-1

    // Focus the original pane
    useAppStore.getState().focusPane(originalPane);

    expect(focusedPaneId()).toBe(originalPane);
  });

  it("focusNextPane cycles through panes", () => {
    useAppStore.getState().splitPane("horizontal");

    const paneIds = allPaneIds(activeTab().rootNode);

    // Currently focused on pane-ids[1] (new pane after split)
    expect(focusedPaneId()).toBe(paneIds[1]);

    // Focus next should cycle to pane-ids[0]
    useAppStore.getState().focusNextPane();

    expect(focusedPaneId()).toBe(paneIds[0]);
  });

  it("focusPrevPane cycles through panes", () => {
    useAppStore.getState().splitPane("horizontal");

    const paneIds = allPaneIds(activeTab().rootNode);

    // Currently focused on pane-ids[1] (new pane after split)
    expect(focusedPaneId()).toBe(paneIds[1]);

    // Focus prev should cycle to pane-ids[0]
    useAppStore.getState().focusPrevPane();

    expect(focusedPaneId()).toBe(paneIds[0]);
  });

  it("refocusActivePane bumps paneFocusNonce without moving focus", () => {
    const before = useAppStore.getState();
    const focusedBefore = focusedPaneId();

    useAppStore.getState().refocusActivePane();

    const after = useAppStore.getState();
    expect(after.paneFocusNonce).toBe(before.paneFocusNonce + 1);
    // The demand is "focus the pane that is already focused", so the layout
    // must come through untouched.
    expect(after.workspaceLayouts).toBe(before.workspaceLayouts);
    expect(focusedPaneId()).toBe(focusedBefore);
  });

  it("every refocusActivePane is a distinct nonce", () => {
    const start = useAppStore.getState().paneFocusNonce;

    useAppStore.getState().refocusActivePane();
    useAppStore.getState().refocusActivePane();

    expect(useAppStore.getState().paneFocusNonce).toBe(start + 2);
  });
});

describe("Panel operations", () => {
  beforeEach(() => setupStore());

  it("splitPanel creates a new panel with a split", () => {
    useAppStore.getState().splitPanel("horizontal");

    const layout = getLayout();
    expect(layout.panelTree.type).toBe("split");
    if (layout.panelTree.type === "split") {
      expect(layout.panelTree.direction).toBe("horizontal");
    }
    expect(Object.keys(layout.panels)).toHaveLength(2);
    // The command hinted the sender to move to the new panel (D3).
    expect(selectActivePanelId(useAppStore.getState())).not.toBe("panel-1");
  });

  it("closePanel removes panel, moves focus to sibling", () => {
    setupStore(makeTwoPanelLayout());

    useAppStore.getState().closePanel("panel-1");

    const layout = getLayout();
    expect(layout.panels["panel-1"]).toBeUndefined();
    expect(Object.keys(layout.panels)).toHaveLength(1);
    expect(selectActivePanelId(useAppStore.getState())).toBe("panel-2");
  });

  it("moveTabToPanel moves tab between panels", () => {
    setupStore(makeTwoPanelLayout());

    // Add a second tab to panel-1 so it is not left empty and removed. Both
    // sides get it: the server is the authority, the store is its replica.
    const base = useAppStore.getState().workspaceLayouts[WS_PATH];
    const source = base.panels["panel-1"];
    const extraTab: Tab = {
      id: "tab-extra",
      title: "Extra",
      rootNode: { type: "leaf", paneId: "pane-extra" },
    };
    const withExtra: WorkspaceLayout = {
      ...base,
      panels: {
        ...base.panels,
        "panel-1": { ...source, tabs: [...source.tabs, extraTab] },
      },
    };
    seedLayout(WS_PATH, withExtra);
    useAppStore.setState((state) => ({
      workspaceLayouts: { ...state.workspaceLayouts, [WS_PATH]: withExtra },
    }));

    useAppStore.getState().moveTabToPanel("tab-1", "panel-2");

    const layout = getLayout();
    const panel1 = layout.panels["panel-1"];
    const panel2 = layout.panels["panel-2"];
    expect(panel1.tabs.find((t) => t.id === "tab-1")).toBeUndefined();
    expect(panel2.tabs.find((t) => t.id === "tab-1")).toBeDefined();
    expect(selectedTabId("panel-2")).toBe("tab-1");
  });
});

describe("Workspace management", () => {
  beforeEach(() => {
    resetFakeLayoutServer();
    useAppStore.setState({
      activeWorkspacePath: null,
      workspaceLayouts: {},
      viewports: {},
      layoutVersions: {},
      serverLayouts: {},
      paneCwd: {},
      paneTitle: {},
      paneAgentStatus: {},
      paneContentType: {},
      paneUrl: {},
      panePickedElement: {},
    });
  });

  it("setActiveWorkspace leaves a workspace the server never saw empty", () => {
    useAppStore.getState().setActiveWorkspace(WS_PATH);

    const state = useAppStore.getState();
    expect(state.activeWorkspacePath).toBe(WS_PATH);
    // No layout at all, rather than an invented one: the empty state renders,
    // and the first `new-tab` creates the panel on the server (ADR-179 D1).
    expect(state.workspaceLayouts[WS_PATH]).toBeUndefined();
  });

  it("setActiveWorkspace adopts what the server already holds", () => {
    const layout = makeLayout();
    broadcastLayout(WS_PATH, layout);

    useAppStore.getState().setActiveWorkspace(WS_PATH);

    expect(useAppStore.getState().workspaceLayouts[WS_PATH]).toBe(layout);
  });

  it("setActiveWorkspace reuses the replica it already has", () => {
    broadcastLayout(WS_PATH, makeLayout());
    useAppStore.getState().setActiveWorkspace(WS_PATH);
    const layoutRef = useAppStore.getState().workspaceLayouts[WS_PATH];

    // Switch away and back
    useAppStore.getState().setActiveWorkspace("/other");
    useAppStore.getState().setActiveWorkspace(WS_PATH);

    expect(useAppStore.getState().workspaceLayouts[WS_PATH]).toBe(layoutRef);
  });

  it("removeWorkspaceLayout drops the replica and its side maps", () => {
    setupStore();
    // Set some metadata
    useAppStore.setState({
      paneCwd: { "pane-1": "/some/path" },
      paneAgentStatus: {},
    });

    useAppStore.getState().removeWorkspaceLayout(WS_PATH);

    const state = useAppStore.getState();
    expect(state.workspaceLayouts[WS_PATH]).toBeUndefined();
    expect(state.viewports[WS_PATH]).toBeUndefined();
    expect(state.paneCwd["pane-1"]).toBeUndefined();
    // Local only: ending the panes is the server's, when the worktree goes.
    expect(sentCommands).toEqual([]);
  });

  it("a removed broadcast drops the replica rather than adopting it", () => {
    setupStore();
    broadcastLayout(WS_PATH, makeLayout(), 3);
    useAppStore.setState({ paneCwd: { "pane-1": "/some/path" } });

    removeWorkspace(WS_PATH);

    const state = useAppStore.getState();
    expect(state.workspaceLayouts[WS_PATH]).toBeUndefined();
    expect(state.serverLayouts[WS_PATH]).toBeUndefined();
    expect(state.layoutVersions[WS_PATH]).toBeUndefined();
    expect(state.paneCwd["pane-1"]).toBeUndefined();
  });

  it("a workspace recreated after its removal starts over at version 1", () => {
    setupStore();
    broadcastLayout(WS_PATH, makeLayout(), 3);
    removeWorkspace(WS_PATH);

    const fresh = makeLayout();
    broadcastLayout(WS_PATH, fresh, 1);

    expect(useAppStore.getState().workspaceLayouts[WS_PATH]).toBe(fresh);
  });
});

describe("Metadata tracking", () => {
  beforeEach(() => setupStore());

  it("setPaneCwd updates paneCwd", () => {
    useAppStore.getState().setPaneCwd("pane-1", "/home/user");
    expect(useAppStore.getState().paneCwd["pane-1"]).toBe("/home/user");
  });

  it("setPaneCwd deduplicates same value", () => {
    useAppStore.getState().setPaneCwd("pane-1", "/home/user");
    const stateRef = useAppStore.getState().paneCwd;

    useAppStore.getState().setPaneCwd("pane-1", "/home/user");
    // Should be the exact same object (no state update)
    expect(useAppStore.getState().paneCwd).toBe(stateRef);
  });

  it("setPaneAgentStatus updates paneAgentStatus", () => {
    useAppStore.getState().setPaneAgentStatus("pane-1", {
      kind: "claude",
      status: "thinking",
      processName: "claude",
      since: Date.now(),
      title: null,
    });
    expect(useAppStore.getState().paneAgentStatus["pane-1"]?.status).toBe(
      "thinking",
    );
  });

  it("setPaneContentType updates paneContentType", () => {
    useAppStore.getState().setPaneContentType("pane-1", "browser");
    expect(useAppStore.getState().paneContentType["pane-1"]).toBe("browser");
  });

  it("setPaneContentType with 'terminal' removes the entry (implicit default)", () => {
    useAppStore.getState().setPaneContentType("pane-1", "browser");
    expect(useAppStore.getState().paneContentType["pane-1"]).toBe("browser");

    useAppStore.getState().setPaneContentType("pane-1", "terminal");
    expect(useAppStore.getState().paneContentType["pane-1"]).toBeUndefined();
  });
});

/**
 * A tab whose terminal runs a command (ADR-179 ticket 11). The command is no
 * longer a store field: it is queued on the server against the pane the tab
 * mints, *before* the layout command that creates it, so whichever renderer
 * mounts the pane runs it — including one that is not this window.
 */
/**
 * A tab whose terminal runs a command (ADR-179 ticket 11). The command is no
 * longer a store field: it is queued on the server against the pane the tab
 * mints, *before* the layout command that creates it, so whichever renderer
 * mounts the pane runs it — including one that is not this window.
 */
describe("addTerminalTab", () => {
  beforeEach(() => setupStore());

  it("queues the command for the new tab's pane before creating the tab", () => {
    const created = useAppStore.getState().addTerminalTab("npm start");

    expect(created).not.toBeNull();
    expect(queuedCommands).toEqual([
      { paneId: created!.paneId, text: "npm start", kind: "shell" },
    ]);
    // Queued first, tab second — a renderer that mounted the pane before the
    // entry landed would open a bare shell.
    expect(serverCalls).toEqual(["pending", "apply"]);
    expect(sentCommands[sentCommands.length - 1].command.type).toBe("new-tab");
  });

  it("passes the kind through for an agent launch", () => {
    useAppStore.getState().addTerminalTab("claude", "agent-startup");

    expect(queuedCommands[queuedCommands.length - 1].kind).toBe(
      "agent-startup",
    );
  });

  it("queues nothing when there is no workspace to open a tab in", () => {
    useAppStore.setState({ activeWorkspacePath: null });

    expect(useAppStore.getState().addTerminalTab("npm start")).toBeNull();
    expect(queuedCommands).toHaveLength(0);
  });
});

describe("selectActiveWorkspace selector", () => {
  it("returns the correct panel when workspace exists", () => {
    setupStore();
    const panel = selectActiveWorkspace(useAppStore.getState());
    expect(panel).not.toBeNull();
    expect(panel!.id).toBe("panel-1");
    expect(panel!.tabs).toHaveLength(1);
  });

  it("returns null when no active workspace", () => {
    useAppStore.setState({
      activeWorkspacePath: null,
      workspaceLayouts: {},
    });
    const panel = selectActiveWorkspace(useAppStore.getState());
    expect(panel).toBeNull();
  });

  it("returns null when active workspace path has no layout", () => {
    useAppStore.setState({
      activeWorkspacePath: "/nonexistent",
      workspaceLayouts: {},
    });
    const panel = selectActiveWorkspace(useAppStore.getState());
    expect(panel).toBeNull();
  });
});

describe("webview focus", () => {
  beforeEach(() => setupStore());

  it("setWebviewFocused records the focused pane", () => {
    useAppStore.getState().setWebviewFocused("pane-1", true);
    expect(useAppStore.getState().webviewFocusedPaneId).toBe("pane-1");
  });

  it("blur from a pane that does not own the focus is ignored", () => {
    useAppStore.getState().setWebviewFocused("pane-1", true);
    useAppStore.getState().setWebviewFocused("pane-2", false);
    expect(useAppStore.getState().webviewFocusedPaneId).toBe("pane-1");

    useAppStore.getState().setWebviewFocused("pane-1", false);
    expect(useAppStore.getState().webviewFocusedPaneId).toBeNull();
  });

  it("selectWebviewFocusVisible is false when nothing is focused", () => {
    expect(selectWebviewFocusVisible(useAppStore.getState())).toBe(false);
  });

  it("selectWebviewFocusVisible is true for a pane in a selected tab", () => {
    useAppStore.getState().setWebviewFocused("pane-1", true);
    expect(selectWebviewFocusVisible(useAppStore.getState())).toBe(true);
  });

  it("selectWebviewFocusVisible is false once the pane's tab is hidden", () => {
    useAppStore.getState().setWebviewFocused("pane-1", true);
    useAppStore.setState((s) => {
      const layout = s.workspaceLayouts[WS_PATH];
      const panel = layout.panels["panel-1"];
      return {
        workspaceLayouts: {
          [WS_PATH]: {
            ...layout,
            panels: {
              ...layout.panels,
              "panel-1": {
                ...panel,
                tabs: [
                  ...panel.tabs,
                  {
                    id: "tab-3",
                    title: "Tab 3",
                    rootNode: { type: "leaf" as const, paneId: "pane-3" },
                  },
                ],
              },
            },
          },
        },
        viewports: {
          [WS_PATH]: {
            ...s.viewports[WS_PATH],
            selectedTabIds: { "panel-1": "tab-3" },
          },
        },
      };
    });
    expect(selectWebviewFocusVisible(useAppStore.getState())).toBe(false);
  });

  it("selectWebviewFocusVisible is false in another workspace", () => {
    useAppStore.getState().setWebviewFocused("pane-1", true);
    useAppStore.setState({ activeWorkspacePath: "/other" });
    expect(selectWebviewFocusVisible(useAppStore.getState())).toBe(false);
  });
});
