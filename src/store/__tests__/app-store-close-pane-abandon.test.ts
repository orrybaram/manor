import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import type { WorkspaceLayout, Tab, Panel } from "../app-store";

// window is provided by the setup file (src/store/__tests__/setup.ts)
// with a minimal electronAPI mock.  We extend it here with tasks.abandonForPane.

const WS_PATH = "/test/workspace";

function makeLayout(): WorkspaceLayout {
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
  };
}

function makeTwoPaneLayout(): WorkspaceLayout {
  const panelId = "panel-1";
  const tab: Tab = {
    id: "tab-1",
    title: "Terminal",
    rootNode: {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "pane-1" },
      second: { type: "leaf", paneId: "pane-2" },
    },
    focusedPaneId: "pane-1",
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

describe("closePaneById calls abandonForPane", () => {
  let abandonForPane: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    abandonForPane = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal("window", {
      ...window,
      electronAPI: {
        ...(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI,
        tasks: {
          abandonForPane,
        },
      },
    });
  });

  it("calls abandonForPane with the closed paneId", () => {
    setupStore(makeTwoPaneLayout());

    useAppStore.getState().closePaneById("pane-1");

    expect(abandonForPane).toHaveBeenCalledTimes(1);
    expect(abandonForPane).toHaveBeenCalledWith("pane-1");
  });
});
