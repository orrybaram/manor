import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import { useOpenFileStore } from "../open-file-store";
import { answerUnsavedGuard, useUnsavedGuardStore } from "../unsaved-guard-store";
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
    useUnsavedGuardStore.setState({ request: null, saving: false });
  });

  function editPane(paneId: string) {
    const files = useOpenFileStore.getState();
    files.open(paneId, { hostId: "local", path: WS_PATH }, "src/a.ts");
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

/** Three tabs in one panel: tab-1 (pane-1), tab-2 (pane-2), tab-3 (pane-3). */
function makeThreeTabLayout(): WorkspaceLayout {
  const tab = (n: number): Tab => ({
    id: `tab-${n}`,
    title: "Terminal",
    rootNode: { type: "leaf", paneId: `pane-${n}` },
  });
  const panel: Panel = { id: "panel-1", tabs: [tab(1), tab(2), tab(3)], pinnedTabIds: [] };
  return { panelTree: { type: "leaf", panelId: "panel-1" }, panels: { "panel-1": panel } };
}

describe("closing several tabs, or a panel, over unsaved edits asks first", () => {
  beforeEach(() => {
    useOpenFileStore.setState({ byPane: {} });
    useUnsavedGuardStore.setState({ request: null, saving: false, elsewhere: null });
  });

  function editPane(paneId: string, path: string) {
    const files = useOpenFileStore.getState();
    files.open(paneId, { hostId: "local", path: WS_PATH }, path);
    files.dispatch(paneId, { type: "read", content: "a", hash: "h", reason: "open" });
    files.dispatch(paneId, { type: "edited", dirty: true });
  }

  it("Close Other Tabs waits on the confirm, naming the tabs' files, and Discard goes ahead", async () => {
    setupStore(makeThreeTabLayout());
    editPane("pane-2", "src/b.ts");
    editPane("pane-3", "src/c.ts");

    useAppStore.getState().closeOtherTabs("tab-1");
    expect(sentCommands).toEqual([]);
    expect(useUnsavedGuardStore.getState().request).toMatchObject({
      verb: "close",
      paneIds: ["pane-2", "pane-3"],
    });

    await answerUnsavedGuard("discard");
    await Promise.resolve();
    expect(useUnsavedGuardStore.getState().request).toBeNull();
    expect(useOpenFileStore.getState().byPane["pane-2"].dirty).toBe(false);
    expect(sentCommands).toEqual([
      { workspacePath: WS_PATH, command: { type: "close-other-tabs", tabId: "tab-1" } },
    ]);
  });

  it("Cancel closes nothing and keeps the edits", async () => {
    setupStore(makeThreeTabLayout());
    editPane("pane-3", "src/c.ts");

    useAppStore.getState().closeTabsToRight("tab-2");
    await answerUnsavedGuard("cancel");
    expect(sentCommands).toEqual([]);
    expect(useOpenFileStore.getState().byPane["pane-3"].dirty).toBe(true);
  });

  it("asks only about the tabs that are closing", () => {
    setupStore(makeThreeTabLayout());
    editPane("pane-1", "src/a.ts");

    useAppStore.getState().closeTabsToRight("tab-1");
    expect(useUnsavedGuardStore.getState().request).toBeNull();
    expect(sentCommands).toEqual([
      { workspacePath: WS_PATH, command: { type: "close-tabs-to-right", tabId: "tab-1" } },
    ]);
  });

  it("Close Panel asks about every tab in it", () => {
    setupStore(makeThreeTabLayout());
    editPane("pane-2", "src/b.ts");

    useAppStore.getState().closePanel("panel-1");
    expect(sentCommands).toEqual([]);
    expect(useUnsavedGuardStore.getState().request?.paneIds).toEqual(["pane-2"]);
  });
});

describe("closing several tabs over another window's unsaved edits", () => {
  let unsavedPanesElsewhere: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useOpenFileStore.setState({ byPane: {} });
    useUnsavedGuardStore.setState({ request: null, saving: false, elsewhere: null });
    unsavedPanesElsewhere = vi.fn(async () => []);
    const base = (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI;
    vi.stubGlobal("window", {
      ...window,
      electronAPI: { ...base, window: { unsavedPanesElsewhere } },
    });
  });

  /** Three tabs, tab-3's pane a file pane (shown, say, in a detached window). */
  function layoutWithFilePane(): WorkspaceLayout {
    const layout = makeThreeTabLayout();
    const tab3 = layout.panels["panel-1"].tabs[2];
    tab3.rootNode = { type: "leaf", paneId: "pane-3", contentType: "file" };
    return layout;
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("asks main about the file panes it would close, and stops at the notice when another window holds edits", async () => {
    setupStore(layoutWithFilePane());
    unsavedPanesElsewhere.mockResolvedValue([{ paneId: "pane-3", path: "src/c.ts" }]);

    useAppStore.getState().closeOtherTabs("tab-1");
    await flush();
    expect(unsavedPanesElsewhere).toHaveBeenCalledWith(["pane-3"]);
    expect(sentCommands).toEqual([]);
    expect(useUnsavedGuardStore.getState()).toMatchObject({
      request: null,
      elsewhere: { verb: "close", files: ["src/c.ts"] },
    });
  });

  it("closes once main says no other window holds edits to them", async () => {
    setupStore(layoutWithFilePane());

    useAppStore.getState().closeTabsToRight("tab-1");
    await flush();
    expect(sentCommands).toEqual([
      { workspacePath: WS_PATH, command: { type: "close-tabs-to-right", tabId: "tab-1" } },
    ]);
    expect(useUnsavedGuardStore.getState().elsewhere).toBeNull();
  });
});
