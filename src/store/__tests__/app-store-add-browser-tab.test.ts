import { describe, it, expect, beforeEach } from "vitest";
import {
  useAppStore,
  selectActivePanelId,
  selectFocusedPaneId,
  selectPaneContentType,
  selectPaneUrl,
  selectSelectedTabId,
} from "../app-store";
import { emptyViewport, reconcileViewport } from "../../lib/layout/viewport";
import type { Panel, WorkspaceLayout } from "../app-store";
import {
  resetFakeLayoutServer,
  seedLayout,
  sentCommands,
  settled,
} from "./fake-layout-server";

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
  };
  const panel: Panel = {
    id: panelId,
    tabs: [tab],
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId },
    panels: { [panelId]: panel },
  };
}

function setupStore(layout?: WorkspaceLayout) {
  // The server holds the same layout the store starts from: every
  // structural action goes through it now (ADR-179 D1).
  resetFakeLayoutServer();
  const start = layout ?? makeLayout();
  seedLayout(WS_PATH, start);
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: { [WS_PATH]: start },
    viewports: { [WS_PATH]: reconcileViewport(start, emptyViewport()) },
    layoutVersions: {},
    mountedWorkspaces: {},
    paneCwd: {},
    paneTitle: {},
    paneAgentStatus: {},
    paneLiveUrl: {},
    panePickedElement: {},
    pendingCloseConfirmPaneId: null,
    pendingCloseConfirmTabId: null,
    webviewFocusedPaneId: null,
  });
}

function getActivePanel(): Panel {
  const state = useAppStore.getState();
  return state.workspaceLayouts[WS_PATH].panels[selectActivePanelId(state)!];
}

/** This renderer's selected tab in the active panel (ADR-179 D3). */
function selectedTabId(): string | null {
  const state = useAppStore.getState();
  return selectSelectedTabId(state, selectActivePanelId(state));
}

// ---------------------------------------------------------------------------
// Tests: addBrowserTab background option
// ---------------------------------------------------------------------------

describe("addBrowserTab", () => {
  beforeEach(() => setupStore());

  it("creates a new browser tab in the active panel (foreground by default)", async () => {
    const panelBefore = getActivePanel();
    const originalSelectedTabId = selectedTabId();
    expect(panelBefore.tabs).toHaveLength(1);

    useAppStore.getState().addBrowserTab("https://example.com");
    await settled();

    const panel = getActivePanel();
    expect(panel.tabs).toHaveLength(2);

    const newTab = panel.tabs[1];
    expect(newTab.rootNode.type).toBe("leaf");
    // The new tab becomes selected (foreground)
    expect(selectedTabId()).toBe(newTab.id);
    expect(selectedTabId()).not.toBe(originalSelectedTabId);
  });

  it("creates a browser tab WITHOUT changing selection when background: true", async () => {
    const panelBefore = getActivePanel();
    const originalSelectedTabId = selectedTabId();
    expect(panelBefore.tabs).toHaveLength(1);

    useAppStore.getState().addBrowserTab("https://example.com", { background: true });
    await settled();

    const panel = getActivePanel();
    expect(panel.tabs).toHaveLength(2);

    // Selection must remain on the original tab
    expect(selectedTabId()).toBe(originalSelectedTabId);

    // The new tab is appended but not selected
    const newTab = panel.tabs[1];
    expect(newTab.id).not.toBe(originalSelectedTabId);
  });

  it("creates a browser tab AND selects it when background: false (explicit)", async () => {
    const panelBefore = getActivePanel();
    const originalSelectedTabId = selectedTabId();
    expect(panelBefore.tabs).toHaveLength(1);

    useAppStore.getState().addBrowserTab("https://example.com", { background: false });
    await settled();

    const panel = getActivePanel();
    expect(panel.tabs).toHaveLength(2);

    const newTab = panel.tabs[1];
    // Selection moves to the new tab
    expect(selectedTabId()).toBe(newTab.id);
    expect(selectedTabId()).not.toBe(originalSelectedTabId);
  });

  it("makes the new pane a browser, on its leaf", async () => {
    useAppStore.getState().addBrowserTab("https://example.com");
    await settled();

    const panel = getActivePanel();
    const newTab = panel.tabs[1];
    if (newTab.rootNode.type !== "leaf") throw new Error("Expected leaf");
    const paneId = newTab.rootNode.paneId;

    expect(selectPaneContentType(useAppStore.getState(), paneId)).toBe("browser");
  });

  it("gives the new pane its url, on its leaf", async () => {
    useAppStore.getState().addBrowserTab("https://example.com/path");
    await settled();

    const panel = getActivePanel();
    const newTab = panel.tabs[1];
    if (newTab.rootNode.type !== "leaf") throw new Error("Expected leaf");
    const paneId = newTab.rootNode.paneId;

    expect(selectPaneUrl(useAppStore.getState(), paneId)).toBe(
      "https://example.com/path",
    );
  });

  it("uses the URL host as the tab title", async () => {
    useAppStore.getState().addBrowserTab("https://example.com/some/path");
    await settled();

    const panel = getActivePanel();
    const newTab = panel.tabs[1];
    expect(newTab.title).toBe("example.com");
  });

  it("falls back to the full URL as title when URL is not parseable", async () => {
    const invalidUrl = "not-a-url";
    useAppStore.getState().addBrowserTab(invalidUrl);
    await settled();

    const panel = getActivePanel();
    const newTab = panel.tabs[1];
    expect(newTab.title).toBe(invalidUrl);
  });

  it("returns the tabId and paneId it minted", async () => {
    const created = useAppStore.getState().addBrowserTab("https://example.com");
    await settled();

    expect(created).not.toBeNull();
    const { tabId, paneId } = created!;

    const panel = getActivePanel();
    const newTab = panel.tabs[1];
    if (newTab.rootNode.type !== "leaf") throw new Error("Expected leaf");
    expect(newTab.id).toBe(tabId);
    expect(newTab.rootNode.paneId).toBe(paneId);
    expect(selectFocusedPaneId(useAppStore.getState(), newTab.id)).toBe(paneId);
    expect(selectPaneContentType(useAppStore.getState(), paneId)).toBe("browser");
    expect(selectPaneUrl(useAppStore.getState(), paneId)).toBe(
      "https://example.com",
    );
  });

  it("returns null and creates nothing when there is no active panel", async () => {
    useAppStore.setState({ activeWorkspacePath: null });

    expect(useAppStore.getState().addBrowserTab("https://example.com")).toBeNull();
    await settled();
    expect(sentCommands).toEqual([]);
  });

  it("background: true does not change selection even when multiple tabs exist", async () => {
    // Add a foreground tab first so we start with 2 tabs
    useAppStore.getState().addBrowserTab("https://first.com");
    await settled();
    const panelMid = getActivePanel();
    const selectedAfterFirst = selectedTabId();
    expect(panelMid.tabs).toHaveLength(2);

    // Now add a background tab — selection must remain on the second tab
    useAppStore.getState().addBrowserTab("https://second.com", { background: true });
    await settled();

    const panel = getActivePanel();
    expect(panel.tabs).toHaveLength(3);
    expect(selectedTabId()).toBe(selectedAfterFirst);
  });
});
