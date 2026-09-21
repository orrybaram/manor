import { describe, it, expect, beforeEach } from "vitest";
import {
  useAppStore,
  selectFocusedPaneId,
  selectPaneContentType,
  selectPaneUrl,
} from "../app-store";
import { emptyViewport, reconcileViewport } from "../../lib/layout/viewport";
import type { Panel, WorkspaceLayout } from "../app-store";
import {
  queuedCommands,
  resetFakeLayoutServer,
  seedLayout,
  settled,
} from "./fake-layout-server";

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

function getActiveTab() {
  const state = useAppStore.getState();
  return state.workspaceLayouts[WS_PATH].panels["panel-1"].tabs.find(
    (t) => t.id === "tab-1",
  )!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("splitPaneAt", () => {
  beforeEach(() => setupStore());

  it("returns the paneId it mints and grafts it into the tree", async () => {
    const newPane = useAppStore
      .getState()
      .splitPaneAt(ORIGINAL_PANE_ID, "horizontal", "second");
    await settled();

    expect(newPane).toBeTruthy();
    expect(newPane).not.toBe(ORIGINAL_PANE_ID);

    const tab = getActiveTab();
    expect(selectFocusedPaneId(useAppStore.getState(), tab.id)).toBe(newPane);
    expect(tab.rootNode).toEqual({
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: ORIGINAL_PANE_ID },
      second: { type: "leaf", paneId: newPane },
    });
  });

  it("returns null and changes nothing for an unknown target pane", async () => {
    const before = useAppStore.getState().workspaceLayouts[WS_PATH];

    const result = useAppStore
      .getState()
      .splitPaneAt("pane-nope", "horizontal", "second");
    await settled();

    expect(result).toBeNull();
    expect(useAppStore.getState().workspaceLayouts[WS_PATH]).toBe(before);
  });

  it("returns null when there is no active workspace", async () => {
    useAppStore.setState({ activeWorkspacePath: null });

    expect(
      useAppStore.getState().splitPaneAt(ORIGINAL_PANE_ID, "horizontal", "second"),
    ).toBeNull();
  });

  it("puts the url and content type on the new leaf when given", async () => {
    const newPane = useAppStore
      .getState()
      .splitPaneAt(ORIGINAL_PANE_ID, "horizontal", "second", {
        contentType: "browser",
        url: "https://example.com",
      })!;
    await settled();

    const state = useAppStore.getState();
    expect(selectPaneUrl(state, newPane)).toBe("https://example.com");
    expect(selectPaneContentType(state, newPane)).toBe("browser");

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

  it("gives the new pane no url when none is given", async () => {
    const newPane = useAppStore
      .getState()
      .splitPaneAt(ORIGINAL_PANE_ID, "horizontal", "second", {
        contentType: "browser",
      })!;
    await settled();

    expect(selectPaneUrl(useAppStore.getState(), newPane)).toBeNull();
  });

  it("does not persist contentType: 'agent' to the tree", async () => {
    const newPane = useAppStore
      .getState()
      .splitPaneAt(ORIGINAL_PANE_ID, "horizontal", "second", {
        contentType: "agent",
        paneCommand: "npm test",
      })!;
    await settled();

    const tab = getActiveTab();
    if (tab.rootNode.type !== "split") throw new Error("Expected split");
    expect(tab.rootNode.second).toEqual({ type: "leaf", paneId: newPane });
    expect(selectPaneContentType(useAppStore.getState(), newPane)).toBe(
      "terminal",
    );
    // The command is queued on the server for the minted pane (ADR-179
    // ticket 11), not held in this store.
    expect(queuedCommands).toEqual([
      { paneId: newPane, text: "npm test", kind: "agent-startup" },
    ]);
  });
});
