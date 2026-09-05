import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../app-store";
import type { Panel, WorkspaceLayout } from "../app-store";

// window is provided by the setup file (src/store/__tests__/setup.ts)
// with a minimal electronAPI mock. No additional stubbing needed here.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_PATH = "/test/workspace";
const ORIGINAL_PANE_ID = "pane-1";

function makeLayout(): WorkspaceLayout {
  const panelId = "panel-1";
  const tab = {
    id: "tab-1",
    title: "Terminal",
    rootNode: { type: "leaf" as const, paneId: ORIGINAL_PANE_ID },
    focusedPaneId: ORIGINAL_PANE_ID,
  };
  const panel: Panel = {
    id: panelId,
    tabs: [tab],
    selectedTabId: "tab-1",
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId },
    panels: { [panelId]: panel },
    activePanelId: panelId,
  };
}

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

function getActiveTab() {
  const state = useAppStore.getState();
  const layout = state.workspaceLayouts[WS_PATH];
  const panel = layout.panels[layout.activePanelId];
  return panel.tabs.find((t) => t.id === "tab-1")!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("splitPaneAt", () => {
  beforeEach(() => setupStore());

  it("returns the paneId it mints and grafts it into the tree", () => {
    const newPane = useAppStore
      .getState()
      .splitPaneAt(ORIGINAL_PANE_ID, "horizontal", "second");

    expect(newPane).toBeTruthy();
    expect(newPane).not.toBe(ORIGINAL_PANE_ID);

    const tab = getActiveTab();
    expect(tab.focusedPaneId).toBe(newPane);
    expect(tab.rootNode).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: ORIGINAL_PANE_ID },
      second: { type: "leaf", paneId: newPane },
    });
  });

  it("returns null and changes nothing for an unknown target pane", () => {
    const before = useAppStore.getState().workspaceLayouts[WS_PATH];

    const result = useAppStore
      .getState()
      .splitPaneAt("pane-nope", "horizontal", "second");

    expect(result).toBeNull();
    expect(useAppStore.getState().workspaceLayouts[WS_PATH]).toBe(before);
  });

  it("returns null when there is no active workspace", () => {
    useAppStore.setState({ activeWorkspacePath: null });

    expect(
      useAppStore.getState().splitPaneAt(ORIGINAL_PANE_ID, "horizontal", "second"),
    ).toBeNull();
  });

  it("lands the url in paneUrl when given", () => {
    const newPane = useAppStore
      .getState()
      .splitPaneAt(ORIGINAL_PANE_ID, "horizontal", "second", {
        contentType: "browser",
        url: "https://example.com",
      })!;

    const state = useAppStore.getState();
    expect(state.paneUrl[newPane]).toBe("https://example.com");
    expect(state.paneContentType[newPane]).toBe("browser");

    const tab = getActiveTab();
    expect(tab.rootNode).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: ORIGINAL_PANE_ID },
      second: {
        type: "leaf",
        paneId: newPane,
        contentType: "browser",
        url: "https://example.com",
      },
    });
  });

  it("does not set paneUrl when no url is given", () => {
    const newPane = useAppStore
      .getState()
      .splitPaneAt(ORIGINAL_PANE_ID, "horizontal", "second", {
        contentType: "browser",
      })!;

    expect(useAppStore.getState().paneUrl[newPane]).toBeUndefined();
  });

  it("does not persist contentType: 'agent' to the tree or paneContentType map", () => {
    const newPane = useAppStore
      .getState()
      .splitPaneAt(ORIGINAL_PANE_ID, "horizontal", "second", {
        contentType: "agent",
        paneCommand: "npm test",
      })!;

    const tab = getActiveTab();
    if (tab.rootNode.type !== "split") throw new Error("Expected split");
    expect(tab.rootNode.second).toEqual({ type: "leaf", paneId: newPane });
    expect(useAppStore.getState().paneContentType[newPane]).toBeUndefined();
    expect(useAppStore.getState().pendingPaneCommands[newPane]).toBe("npm test");
  });
});
