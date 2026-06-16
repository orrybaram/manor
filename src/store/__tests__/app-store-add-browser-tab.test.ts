import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../app-store";
import type { Panel, WorkspaceLayout } from "../app-store";

// window is provided by the setup file (src/store/__tests__/setup.ts)
// with a minimal electronAPI mock. No additional stubbing needed here.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS_PATH = "/test/workspace";

function makeLayout(): WorkspaceLayout {
  const panelId = "panel-1";
  const paneId = "pane-1";
  const tab = {
    id: "tab-1",
    title: "Terminal",
    rootNode: { type: "leaf" as const, paneId },
    focusedPaneId: paneId,
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

function getActivePanel(): Panel {
  const state = useAppStore.getState();
  const layout = state.workspaceLayouts[WS_PATH];
  return layout.panels[layout.activePanelId];
}

// ---------------------------------------------------------------------------
// Tests: addBrowserTab background option
// ---------------------------------------------------------------------------

describe("addBrowserTab", () => {
  beforeEach(() => setupStore());

  it("creates a new browser tab in the active panel (foreground by default)", () => {
    const panelBefore = getActivePanel();
    const originalSelectedTabId = panelBefore.selectedTabId;
    expect(panelBefore.tabs).toHaveLength(1);

    useAppStore.getState().addBrowserTab("https://example.com");

    const panel = getActivePanel();
    expect(panel.tabs).toHaveLength(2);

    const newTab = panel.tabs[1];
    expect(newTab.rootNode.type).toBe("leaf");
    // The new tab becomes selected (foreground)
    expect(panel.selectedTabId).toBe(newTab.id);
    expect(panel.selectedTabId).not.toBe(originalSelectedTabId);
  });

  it("creates a browser tab WITHOUT changing selection when background: true", () => {
    const panelBefore = getActivePanel();
    const originalSelectedTabId = panelBefore.selectedTabId;
    expect(panelBefore.tabs).toHaveLength(1);

    useAppStore.getState().addBrowserTab("https://example.com", { background: true });

    const panel = getActivePanel();
    expect(panel.tabs).toHaveLength(2);

    // Selection must remain on the original tab
    expect(panel.selectedTabId).toBe(originalSelectedTabId);

    // The new tab is appended but not selected
    const newTab = panel.tabs[1];
    expect(newTab.id).not.toBe(originalSelectedTabId);
  });

  it("creates a browser tab AND selects it when background: false (explicit)", () => {
    const panelBefore = getActivePanel();
    const originalSelectedTabId = panelBefore.selectedTabId;
    expect(panelBefore.tabs).toHaveLength(1);

    useAppStore.getState().addBrowserTab("https://example.com", { background: false });

    const panel = getActivePanel();
    expect(panel.tabs).toHaveLength(2);

    const newTab = panel.tabs[1];
    // Selection moves to the new tab
    expect(panel.selectedTabId).toBe(newTab.id);
    expect(panel.selectedTabId).not.toBe(originalSelectedTabId);
  });

  it("sets paneContentType to 'browser' for the new pane", () => {
    useAppStore.getState().addBrowserTab("https://example.com");

    const panel = getActivePanel();
    const newTab = panel.tabs[1];
    if (newTab.rootNode.type !== "leaf") throw new Error("Expected leaf");
    const paneId = newTab.rootNode.paneId;

    expect(useAppStore.getState().paneContentType[paneId]).toBe("browser");
  });

  it("sets paneUrl for the new pane", () => {
    useAppStore.getState().addBrowserTab("https://example.com/path");

    const panel = getActivePanel();
    const newTab = panel.tabs[1];
    if (newTab.rootNode.type !== "leaf") throw new Error("Expected leaf");
    const paneId = newTab.rootNode.paneId;

    expect(useAppStore.getState().paneUrl[paneId]).toBe("https://example.com/path");
  });

  it("uses the URL host as the tab title", () => {
    useAppStore.getState().addBrowserTab("https://example.com/some/path");

    const panel = getActivePanel();
    const newTab = panel.tabs[1];
    expect(newTab.title).toBe("example.com");
  });

  it("falls back to the full URL as title when URL is not parseable", () => {
    const invalidUrl = "not-a-url";
    useAppStore.getState().addBrowserTab(invalidUrl);

    const panel = getActivePanel();
    const newTab = panel.tabs[1];
    expect(newTab.title).toBe(invalidUrl);
  });

  it("background: true does not change selection even when multiple tabs exist", () => {
    // Add a foreground tab first so we start with 2 tabs
    useAppStore.getState().addBrowserTab("https://first.com");
    const panelMid = getActivePanel();
    const selectedAfterFirst = panelMid.selectedTabId;
    expect(panelMid.tabs).toHaveLength(2);

    // Now add a background tab — selection must remain on the second tab
    useAppStore.getState().addBrowserTab("https://second.com", { background: true });

    const panel = getActivePanel();
    expect(panel.tabs).toHaveLength(3);
    expect(panel.selectedTabId).toBe(selectedAfterFirst);
  });
});
