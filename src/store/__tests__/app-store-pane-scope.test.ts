/**
 * One paneId scope: `closePaneById` and `splitPaneAt` resolve a pane in *any*
 * panel, matching `focusPane`/`movePaneToTarget` and what `list_panes` reports.
 * They previously searched only the active panel and silently no-opped.
 *
 * Also covers what the mutating actions return, and the `pendingPaneCommands`
 * prune that keeps an undrained command from outliving its pane.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../app-store";
import type { Panel, Tab, WorkspaceLayout } from "../app-store";
import { hasPaneId } from "../pane-tree";

const WS_PATH = "/test/workspace";

const ACTIVE_PANEL = "panel-active";
const OTHER_PANEL = "panel-other";

function leafTab(id: string, paneId: string): Tab {
  return {
    id,
    title: "Terminal",
    rootNode: { type: "leaf", paneId },
    focusedPaneId: paneId,
  };
}

function splitTab(id: string, firstPane: string, secondPane: string): Tab {
  return {
    id,
    title: "Terminal",
    rootNode: {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: firstPane },
      second: { type: "leaf", paneId: secondPane },
    },
    focusedPaneId: firstPane,
  };
}

function panel(id: string, tabs: Tab[]): Panel {
  return { id, tabs, selectedTabId: tabs[0].id, pinnedTabIds: [] };
}

/** Two panels side by side. `panel-active` is active; `panel-other` is not. */
function twoPanelLayout(activeTabs: Tab[], otherTabs: Tab[]): WorkspaceLayout {
  return {
    panelTree: {
      type: "split",
      direction: "vertical",
      ratio: 0.5,
      first: { type: "leaf", panelId: ACTIVE_PANEL },
      second: { type: "leaf", panelId: OTHER_PANEL },
    },
    panels: {
      [ACTIVE_PANEL]: panel(ACTIVE_PANEL, activeTabs),
      [OTHER_PANEL]: panel(OTHER_PANEL, otherTabs),
    },
    activePanelId: ACTIVE_PANEL,
  };
}

function setupStore(layout: WorkspaceLayout) {
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: { [WS_PATH]: layout },
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

function getPanel(panelId: string): Panel {
  return useAppStore.getState().workspaceLayouts[WS_PATH].panels[panelId];
}

function tabHolding(paneId: string): { panelId: string; tab: Tab } | null {
  const layout = useAppStore.getState().workspaceLayouts[WS_PATH];
  for (const p of Object.values(layout.panels)) {
    const tab = p.tabs.find((t) => hasPaneId(t.rootNode, paneId));
    if (tab) return { panelId: p.id, tab };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Part A — panes in a non-active panel
// ---------------------------------------------------------------------------

describe("splitPaneAt across panels", () => {
  beforeEach(() => {
    setupStore(
      twoPanelLayout([leafTab("tab-a", "pane-a")], [leafTab("tab-b", "pane-b")]),
    );
  });

  it("splits a pane living in a non-active panel", () => {
    const newPane = useAppStore
      .getState()
      .splitPaneAt("pane-b", "horizontal", "second");

    expect(newPane).toBeTruthy();
    expect(tabHolding(newPane!)?.panelId).toBe(OTHER_PANEL);

    const otherTab = getPanel(OTHER_PANEL).tabs[0];
    expect(otherTab.focusedPaneId).toBe(newPane);
    expect(otherTab.rootNode).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "pane-b" },
      second: { type: "leaf", paneId: newPane },
    });
  });

  it("leaves the active panel untouched when splitting elsewhere", () => {
    const before = getPanel(ACTIVE_PANEL);

    useAppStore.getState().splitPaneAt("pane-b", "horizontal", "second");

    expect(getPanel(ACTIVE_PANEL)).toEqual(before);
    expect(
      useAppStore.getState().workspaceLayouts[WS_PATH].activePanelId,
    ).toBe(ACTIVE_PANEL);
  });
});

describe("closePaneById across panels", () => {
  beforeEach(() => {
    setupStore(
      twoPanelLayout(
        [leafTab("tab-a", "pane-a")],
        [splitTab("tab-b", "pane-b1", "pane-b2")],
      ),
    );
  });

  it("closes a pane living in a non-active panel", () => {
    useAppStore.getState().closePaneById("pane-b1");

    expect(tabHolding("pane-b1")).toBeNull();
    expect(tabHolding("pane-b2")?.panelId).toBe(OTHER_PANEL);
    expect(getPanel(OTHER_PANEL).tabs[0].rootNode).toEqual({
      type: "leaf",
      paneId: "pane-b2",
    });
    expect(useAppStore.getState().closedPaneIds.has("pane-b1")).toBe(true);
  });

  it("does not move focus to the panel it mutated", () => {
    const activeBefore = getPanel(ACTIVE_PANEL);

    useAppStore.getState().closePaneById("pane-b1");

    expect(
      useAppStore.getState().workspaceLayouts[WS_PATH].activePanelId,
    ).toBe(ACTIVE_PANEL);
    expect(getPanel(ACTIVE_PANEL)).toEqual(activeBefore);
  });

  it("records the pane's own panel in the undo snapshot", () => {
    useAppStore.getState().closePaneById("pane-b1");

    const snapshot = useAppStore.getState().closedPaneStack[0];
    expect(snapshot.kind).toBe("pane");
    expect(snapshot.panelId).toBe(OTHER_PANEL);
  });

  it("closes the tab when the pane was the last one in a non-active panel's tab", () => {
    setupStore(
      twoPanelLayout(
        [leafTab("tab-a", "pane-a")],
        [leafTab("tab-b1", "pane-b1"), leafTab("tab-b2", "pane-b2")],
      ),
    );

    useAppStore.getState().closePaneById("pane-b1");

    expect(tabHolding("pane-b1")).toBeNull();
    expect(getPanel(OTHER_PANEL).tabs.map((t) => t.id)).toEqual(["tab-b2"]);
  });

  it("no-ops on an unknown paneId", () => {
    const before = useAppStore.getState().workspaceLayouts[WS_PATH];

    useAppStore.getState().closePaneById("pane-nope");

    expect(useAppStore.getState().workspaceLayouts[WS_PATH]).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Part B — actions return what they mint
// ---------------------------------------------------------------------------

describe("tab actions return their IDs", () => {
  beforeEach(() => {
    setupStore(
      twoPanelLayout([leafTab("tab-a", "pane-a")], [leafTab("tab-b", "pane-b")]),
    );
  });

  it("addTab returns the tabId and paneId it created", () => {
    const created = useAppStore.getState().addTab();

    expect(created).not.toBeNull();
    const tab = getPanel(ACTIVE_PANEL).tabs.find((t) => t.id === created!.tabId);
    expect(tab).toBeDefined();
    expect(tab!.focusedPaneId).toBe(created!.paneId);
  });

  it("addTab adopts a caller-supplied paneId (prewarmed PTY session)", () => {
    const created = useAppStore.getState().addTab("pane-prewarmed");

    expect(created!.paneId).toBe("pane-prewarmed");
    expect(tabHolding("pane-prewarmed")?.tab.id).toBe(created!.tabId);
  });

  it("addTerminalTab returns its IDs and queues the command on the new pane", () => {
    const created = useAppStore.getState().addTerminalTab("pnpm dev");

    expect(created).not.toBeNull();
    expect(useAppStore.getState().pendingPaneCommands[created!.paneId]).toBe(
      "pnpm dev",
    );
    expect(tabHolding(created!.paneId)?.tab.id).toBe(created!.tabId);
  });

  it("returns null from every creator when there is no active panel", () => {
    useAppStore.setState({ activeWorkspacePath: null });

    const state = useAppStore.getState();
    expect(state.addTab()).toBeNull();
    expect(state.addTerminalTab("pnpm dev")).toBeNull();
    expect(state.addBrowserTab("https://example.com")).toBeNull();
    expect(state.splitPaneAt("pane-a", "horizontal", "second")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Part C — pendingPaneCommands does not outlive its pane
// ---------------------------------------------------------------------------

describe("pendingPaneCommands pruning", () => {
  beforeEach(() => {
    setupStore(
      twoPanelLayout(
        [splitTab("tab-a", "pane-a1", "pane-a2")],
        [leafTab("tab-b", "pane-b")],
      ),
    );
  });

  it("prunes the pending command when the pane is closed", () => {
    const newPane = useAppStore
      .getState()
      .splitPaneAt("pane-a1", "horizontal", "second", {
        contentType: "agent",
        paneCommand: "pnpm test",
      })!;
    expect(useAppStore.getState().pendingPaneCommands[newPane]).toBe("pnpm test");

    useAppStore.getState().closePaneById(newPane);

    expect(useAppStore.getState().pendingPaneCommands).not.toHaveProperty(newPane);
  });

  it("keeps sibling panes' pending commands when one pane is closed", () => {
    useAppStore.setState({
      pendingPaneCommands: { "pane-a1": "keep me", "pane-a2": "drop me" },
    });

    useAppStore.getState().closePaneById("pane-a2");

    expect(useAppStore.getState().pendingPaneCommands).toEqual({
      "pane-a1": "keep me",
    });
  });

  it("prunes pending commands for every pane in a closed tab", () => {
    useAppStore.setState({
      pendingPaneCommands: {
        "pane-a1": "drop me",
        "pane-a2": "drop me too",
        "pane-b": "keep me",
      },
    });

    useAppStore.getState().closeTab("tab-a");

    expect(useAppStore.getState().pendingPaneCommands).toEqual({
      "pane-b": "keep me",
    });
  });
});
