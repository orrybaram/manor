import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore, selectActiveWorkspace } from "../app-store";
import type { AppState, Tab, Panel, WorkspaceLayout } from "../app-store";
import type { PaneNode } from "../pane-tree";
import { allPaneIds } from "../pane-tree";
import { allPanelIds } from "../panel-tree";

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
    focusedPaneId: paneId,
  };
  const panel: Panel = {
    id: panelId,
    tabs: [tab],
    selectedTabId: tabId,
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId },
    panels: { [panelId]: panel },
    activePanelId: panelId,
    ...overrides,
  };
}

function makeTwoTabLayout(): WorkspaceLayout {
  const panelId = "panel-1";
  const tab1: Tab = {
    id: "tab-1",
    title: "Tab 1",
    rootNode: { type: "leaf", paneId: "pane-1" },
    focusedPaneId: "pane-1",
  };
  const tab2: Tab = {
    id: "tab-2",
    title: "Tab 2",
    rootNode: { type: "leaf", paneId: "pane-2" },
    focusedPaneId: "pane-2",
  };
  return {
    panelTree: { type: "leaf", panelId },
    panels: {
      [panelId]: {
        id: panelId,
        tabs: [tab1, tab2],
        selectedTabId: "tab-1",
        pinnedTabIds: [],
      },
    },
    activePanelId: panelId,
  };
}

function makeThreeTabLayout(): WorkspaceLayout {
  const panelId = "panel-1";
  const tabs: Tab[] = [1, 2, 3].map((n) => ({
    id: `tab-${n}`,
    title: `Tab ${n}`,
    rootNode: { type: "leaf" as const, paneId: `pane-${n}` },
    focusedPaneId: `pane-${n}`,
  }));
  return {
    panelTree: { type: "leaf", panelId },
    panels: {
      [panelId]: {
        id: panelId,
        tabs,
        selectedTabId: "tab-1",
        pinnedTabIds: [],
      },
    },
    activePanelId: panelId,
  };
}

function makeTwoPanelLayout(): WorkspaceLayout {
  const tab1: Tab = {
    id: "tab-1",
    title: "Tab 1",
    rootNode: { type: "leaf", paneId: "pane-1" },
    focusedPaneId: "pane-1",
  };
  const tab2: Tab = {
    id: "tab-2",
    title: "Tab 2",
    rootNode: { type: "leaf", paneId: "pane-2" },
    focusedPaneId: "pane-2",
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
        selectedTabId: "tab-1",
        pinnedTabIds: [],
      },
      "panel-2": {
        id: "panel-2",
        tabs: [tab2],
        selectedTabId: "tab-2",
        pinnedTabIds: [],
      },
    },
    activePanelId: "panel-1",
  };
}

/** Set up the store with a known workspace layout. */
function setupStore(layout?: WorkspaceLayout) {
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: { [WS_PATH]: layout ?? makeLayout() },
    paneCwd: {},
    paneTitle: {},
    paneAgentStatus: {},
    paneContentType: {},
    paneUrl: {},
    panePickedElement: {},
    closedPaneIds: new Set(),
    closedPaneStack: [],
    pendingStartupCommands: {},
    pendingPaneCommands: {},
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
  return layout.panels[layout.activePanelId];
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
    expect(panel.selectedTabId).toBe(newTab.id);
  });

  it("closeTab removes the tab", () => {
    // Start with two tabs so closing one does not remove the panel
    setupStore(makeTwoTabLayout());
    useAppStore.getState().closeTab("tab-1");

    const panel = getActivePanel();
    expect(panel.tabs).toHaveLength(1);
    expect(panel.tabs[0].id).toBe("tab-2");
    expect(panel.selectedTabId).toBe("tab-2");
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

  it("selectTab updates selectedTabId on the active panel", () => {
    setupStore(makeTwoTabLayout());
    useAppStore.getState().selectTab("tab-2");

    const panel = getActivePanel();
    expect(panel.selectedTabId).toBe("tab-2");
  });

  it("selectNextTab wraps around", () => {
    setupStore(makeThreeTabLayout());
    // Currently on tab-1, select tab-3 first
    useAppStore.getState().selectTab("tab-3");
    useAppStore.getState().selectNextTab();

    const panel = getActivePanel();
    // Should wrap around to tab-1
    expect(panel.selectedTabId).toBe("tab-1");
  });

  it("selectPrevTab wraps around", () => {
    setupStore(makeThreeTabLayout());
    // Currently on tab-1
    useAppStore.getState().selectPrevTab();

    const panel = getActivePanel();
    // Should wrap to tab-3
    expect(panel.selectedTabId).toBe("tab-3");
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

    const panel = getActivePanel();
    const tab = panel.tabs.find((t) => t.id === panel.selectedTabId)!;
    expect(tab.rootNode.type).toBe("split");
    if (tab.rootNode.type === "split") {
      expect(tab.rootNode.direction).toBe("horizontal");
      expect(tab.rootNode.first.type).toBe("leaf");
      expect(tab.rootNode.second.type).toBe("leaf");
      // Focus should move to the new pane (second child)
      if (tab.rootNode.second.type === "leaf") {
        expect(tab.focusedPaneId).toBe(tab.rootNode.second.paneId);
      }
    }
  });

  it("splitPane('vertical') splits the focused pane vertically", () => {
    useAppStore.getState().splitPane("vertical");

    const panel = getActivePanel();
    const tab = panel.tabs.find((t) => t.id === panel.selectedTabId)!;
    expect(tab.rootNode.type).toBe("split");
    if (tab.rootNode.type === "split") {
      expect(tab.rootNode.direction).toBe("vertical");
    }
  });

  it("closePane removes pane from tree; if last pane in tab, closes tab", () => {
    // Split first so we have two panes, then close one
    useAppStore.getState().splitPane("horizontal");

    const panelBefore = getActivePanel();
    const tabBefore = panelBefore.tabs.find(
      (t) => t.id === panelBefore.selectedTabId,
    )!;
    const paneIds = allPaneIds(tabBefore.rootNode);
    expect(paneIds).toHaveLength(2);

    // Close the focused pane (second one after split)
    useAppStore.getState().closePane();

    const panelAfter = getActivePanel();
    const tabAfter = panelAfter.tabs.find(
      (t) => t.id === panelAfter.selectedTabId,
    )!;
    expect(allPaneIds(tabAfter.rootNode)).toHaveLength(1);
  });

  it("closePane on last pane in only tab closes the tab", () => {
    // Single pane tab - closing it should close the tab
    // Need two tabs so we can observe the tab being removed
    setupStore(makeTwoTabLayout());
    useAppStore.getState().selectTab("tab-1");

    useAppStore.getState().closePane();

    const panel = getActivePanel();
    expect(panel.tabs.find((t) => t.id === "tab-1")).toBeUndefined();
    expect(panel.selectedTabId).toBe("tab-2");
  });

  it("reopenClosedPane restores from closedPaneStack", () => {
    setupStore(makeTwoTabLayout());
    useAppStore.getState().selectTab("tab-1");

    // Close tab-1 - it should be pushed to closedPaneStack
    useAppStore.getState().closeTab("tab-1");

    const stackBefore = useAppStore.getState().closedPaneStack;
    expect(stackBefore).toHaveLength(1);

    // Reopen
    useAppStore.getState().reopenClosedPane();

    const stackAfter = useAppStore.getState().closedPaneStack;
    expect(stackAfter).toHaveLength(0);

    const panel = getActivePanel();
    // The restored tab should be back
    expect(panel.tabs).toHaveLength(2);
  });

  it("focusPane updates focusedPaneId", () => {
    useAppStore.getState().splitPane("horizontal");

    const panel = getActivePanel();
    const tab = panel.tabs.find((t) => t.id === panel.selectedTabId)!;
    const paneIds = allPaneIds(tab.rootNode);
    const originalPane = paneIds[0]; // pane-1

    // Focus the original pane
    useAppStore.getState().focusPane(originalPane);

    const panelAfter = getActivePanel();
    const tabAfter = panelAfter.tabs.find(
      (t) => t.id === panelAfter.selectedTabId,
    )!;
    expect(tabAfter.focusedPaneId).toBe(originalPane);
  });

  it("focusNextPane cycles through panes", () => {
    useAppStore.getState().splitPane("horizontal");

    const panel = getActivePanel();
    const tab = panel.tabs.find((t) => t.id === panel.selectedTabId)!;
    const paneIds = allPaneIds(tab.rootNode);

    // Currently focused on pane-ids[1] (new pane after split)
    expect(tab.focusedPaneId).toBe(paneIds[1]);

    // Focus next should cycle to pane-ids[0]
    useAppStore.getState().focusNextPane();

    const panelAfter = getActivePanel();
    const tabAfter = panelAfter.tabs.find(
      (t) => t.id === panelAfter.selectedTabId,
    )!;
    expect(tabAfter.focusedPaneId).toBe(paneIds[0]);
  });

  it("focusPrevPane cycles through panes", () => {
    useAppStore.getState().splitPane("horizontal");

    const panel = getActivePanel();
    const tab = panel.tabs.find((t) => t.id === panel.selectedTabId)!;
    const paneIds = allPaneIds(tab.rootNode);

    // Currently focused on pane-ids[1] (new pane after split)
    expect(tab.focusedPaneId).toBe(paneIds[1]);

    // Focus prev should cycle to pane-ids[0]
    useAppStore.getState().focusPrevPane();

    const panelAfter = getActivePanel();
    const tabAfter = panelAfter.tabs.find(
      (t) => t.id === panelAfter.selectedTabId,
    )!;
    expect(tabAfter.focusedPaneId).toBe(paneIds[0]);
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
    // Active panel should be the new one
    expect(layout.activePanelId).not.toBe("panel-1");
  });

  it("closePanel removes panel, moves focus to sibling", () => {
    setupStore(makeTwoPanelLayout());

    useAppStore.getState().closePanel("panel-1");

    const layout = getLayout();
    expect(layout.panels["panel-1"]).toBeUndefined();
    expect(Object.keys(layout.panels)).toHaveLength(1);
    expect(layout.activePanelId).toBe("panel-2");
  });

  it("moveTabToPanel moves tab between panels", () => {
    setupStore(makeTwoPanelLayout());

    // Add a second tab to panel-1 so it is not left empty and removed
    useAppStore.setState((state) => {
      const layout = state.workspaceLayouts[WS_PATH];
      const panel1 = layout.panels["panel-1"];
      const extraTab: Tab = {
        id: "tab-extra",
        title: "Extra",
        rootNode: { type: "leaf", paneId: "pane-extra" },
        focusedPaneId: "pane-extra",
      };
      return {
        workspaceLayouts: {
          ...state.workspaceLayouts,
          [WS_PATH]: {
            ...layout,
            panels: {
              ...layout.panels,
              "panel-1": {
                ...panel1,
                tabs: [...panel1.tabs, extraTab],
              },
            },
          },
        },
      };
    });

    useAppStore.getState().moveTabToPanel("tab-1", "panel-2");

    const layout = getLayout();
    const panel1 = layout.panels["panel-1"];
    const panel2 = layout.panels["panel-2"];
    expect(panel1.tabs.find((t) => t.id === "tab-1")).toBeUndefined();
    expect(panel2.tabs.find((t) => t.id === "tab-1")).toBeDefined();
    expect(panel2.selectedTabId).toBe("tab-1");
  });
});

describe("Workspace management", () => {
  beforeEach(() => {
    useAppStore.setState({
      activeWorkspacePath: null,
      workspaceLayouts: {},
      paneCwd: {},
      paneTitle: {},
      paneAgentStatus: {},
      paneContentType: {},
      paneUrl: {},
      panePickedElement: {},
      closedPaneIds: new Set(),
      closedPaneStack: [],
      pendingStartupCommands: {},
      pendingPaneCommands: {},
    });
  });

  it("setActiveWorkspace initializes layout if new", () => {
    useAppStore.getState().setActiveWorkspace(WS_PATH);

    const state = useAppStore.getState();
    expect(state.activeWorkspacePath).toBe(WS_PATH);
    expect(state.workspaceLayouts[WS_PATH]).toBeDefined();
    const layout = state.workspaceLayouts[WS_PATH];
    expect(layout.panelTree.type).toBe("leaf");
    expect(Object.keys(layout.panels)).toHaveLength(1);
  });

  it("setActiveWorkspace reuses existing layout", () => {
    // Set up first
    useAppStore.getState().setActiveWorkspace(WS_PATH);
    const layoutRef = useAppStore.getState().workspaceLayouts[WS_PATH];

    // Switch away and back
    useAppStore.getState().setActiveWorkspace("/other");
    useAppStore.getState().setActiveWorkspace(WS_PATH);

    // Should still be the same layout object
    expect(useAppStore.getState().workspaceLayouts[WS_PATH]).toBe(layoutRef);
  });

  it("removeWorkspaceLayout cleans up", () => {
    setupStore();
    // Set some metadata
    useAppStore.setState({
      paneCwd: { "pane-1": "/some/path" },
      paneAgentStatus: {},
    });

    useAppStore.getState().removeWorkspaceLayout(WS_PATH);

    const state = useAppStore.getState();
    expect(state.workspaceLayouts[WS_PATH]).toBeUndefined();
    expect(state.paneCwd["pane-1"]).toBeUndefined();
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

describe("Startup commands", () => {
  beforeEach(() => setupStore());

  it("setPendingStartupCommand stores the command", () => {
    useAppStore.getState().setPendingStartupCommand(WS_PATH, "npm start");
    expect(useAppStore.getState().pendingStartupCommands[WS_PATH]).toBe(
      "npm start",
    );
  });

  it("consumePendingStartupCommand returns it once then null", () => {
    useAppStore.getState().setPendingStartupCommand(WS_PATH, "npm start");

    const first = useAppStore.getState().consumePendingStartupCommand(WS_PATH);
    expect(first).toBe("npm start");

    const second = useAppStore.getState().consumePendingStartupCommand(WS_PATH);
    expect(second).toBeNull();
  });

  it("consumePendingStartupCommand returns null when nothing set", () => {
    const result =
      useAppStore.getState().consumePendingStartupCommand("/nonexistent");
    expect(result).toBeNull();
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
