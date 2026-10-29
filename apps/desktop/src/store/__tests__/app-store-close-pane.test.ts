import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import { useOpenFileStore } from "../open-file-store";
import type { WorkspaceLayout, Tab, Panel } from "../app-store";
import {
  resetFakeLayoutServer,
  seedLayout,
  sentCommands,
} from "./fake-layout-server";

// window is provided by the setup file (src/store/__tests__/setup.ts)
// with a minimal electronAPI mock.  We extend it here with agents.abandonForPane,
// to show nothing calls it: ending a closed pane's agent is the server's
// (`LayoutStore`), on every close path, not the renderer's on one.

const WS_PATH = "/test/workspace";

function makeLayout(): WorkspaceLayout {
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
  // structural action goes through it now.
  resetFakeLayoutServer();
  const start = layout ?? makeLayout();
  seedLayout(WS_PATH, start);
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: { [WS_PATH]: start },
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

describe("closePaneById leaves the agent to the server", () => {
  let abandonForPane: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    abandonForPane = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal("window", {
      ...window,
      electronAPI: {
        ...(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI,
        agents: {
          abandonForPane,
        },
      },
    });
  });

  it("sends close-pane and nothing else", () => {
    setupStore(makeTwoPaneLayout());

    useAppStore.getState().closePaneById("pane-1");

    expect(sentCommands).toEqual([
      { workspacePath: WS_PATH, command: { type: "close-pane", paneId: "pane-1" } },
    ]);
    expect(abandonForPane).not.toHaveBeenCalled();
  });

  it("ignores a pane the replica no longer holds", () => {
    setupStore(makeLayout());

    useAppStore.getState().closePaneById("pane-gone");

    expect(sentCommands).toEqual([]);
  });
});

describe("closing a file pane with unsaved edits asks first", () => {
  beforeEach(() => {
    useOpenFileStore.setState({ byPane: {} });
  });

  function editPane(paneId: string) {
    const files = useOpenFileStore.getState();
    files.open(paneId, "src/a.ts");
    files.dispatch(paneId, { type: "read", content: "a", hash: "h", reason: "open" });
    files.dispatch(paneId, { type: "edited", dirty: true });
  }

  it("asks before closing the pane, and closes a clean one at once", () => {
    setupStore(makeTwoPaneLayout());
    editPane("pane-1");

    useAppStore.getState().requestClosePaneById("pane-1");
    expect(useAppStore.getState().pendingCloseConfirmPaneId).toBe("pane-1");
    expect(sentCommands).toEqual([]);

    useAppStore.getState().requestClosePaneById("pane-2");
    expect(sentCommands).toEqual([
      { workspacePath: WS_PATH, command: { type: "close-pane", paneId: "pane-2" } },
    ]);
  });

  it("asks before closing a tab holding one", () => {
    setupStore(makeTwoPaneLayout());
    editPane("pane-2");

    useAppStore.getState().requestCloseTab("tab-1");
    expect(useAppStore.getState().pendingCloseConfirmTabId).toBe("tab-1");
    expect(sentCommands).toEqual([]);
  });
});
