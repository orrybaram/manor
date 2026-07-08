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

  it("uses a caller-supplied paneId verbatim", () => {
    useAppStore
      .getState()
      .splitPaneAt(ORIGINAL_PANE_ID, "horizontal", "second", {
        paneId: "custom-pane-id",
      });

    const tab = getActiveTab();
    expect(tab.focusedPaneId).toBe("custom-pane-id");
    expect(tab.rootNode).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: ORIGINAL_PANE_ID },
      second: { type: "leaf", paneId: "custom-pane-id" },
    });
  });

  it("generates a paneId when none is supplied", () => {
    useAppStore.getState().splitPaneAt(ORIGINAL_PANE_ID, "horizontal", "second");

    const tab = getActiveTab();
    expect(tab.focusedPaneId).toBeTruthy();
    expect(tab.focusedPaneId).not.toBe(ORIGINAL_PANE_ID);
  });

  it("lands the url in paneUrl when given", () => {
    useAppStore.getState().splitPaneAt(ORIGINAL_PANE_ID, "horizontal", "second", {
      contentType: "browser",
      url: "https://example.com",
      paneId: "browser-pane",
    });

    const state = useAppStore.getState();
    expect(state.paneUrl["browser-pane"]).toBe("https://example.com");
    expect(state.paneContentType["browser-pane"]).toBe("browser");

    const tab = getActiveTab();
    expect(tab.rootNode).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: ORIGINAL_PANE_ID },
      second: {
        type: "leaf",
        paneId: "browser-pane",
        contentType: "browser",
        url: "https://example.com",
      },
    });
  });

  it("does not set paneUrl when no url is given", () => {
    useAppStore.getState().splitPaneAt(ORIGINAL_PANE_ID, "horizontal", "second", {
      contentType: "browser",
      paneId: "browser-pane",
    });

    expect(useAppStore.getState().paneUrl["browser-pane"]).toBeUndefined();
  });

  it("does not persist contentType: 'task' to the tree or paneContentType map", () => {
    useAppStore.getState().splitPaneAt(ORIGINAL_PANE_ID, "horizontal", "second", {
      contentType: "task",
      paneCommand: "npm test",
      paneId: "task-pane",
    });

    const tab = getActiveTab();
    if (tab.rootNode.type !== "split") throw new Error("Expected split");
    expect(tab.rootNode.second).toEqual({ type: "leaf", paneId: "task-pane" });
    expect(useAppStore.getState().paneContentType["task-pane"]).toBeUndefined();
    expect(useAppStore.getState().pendingPaneCommands["task-pane"]).toBe(
      "npm test",
    );
  });
});
